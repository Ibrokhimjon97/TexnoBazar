-- Migration: 20261029061500_fix_branch_debt_payments_and_dashboard_currency.sql
-- Description:
-- 1. Allow debt_payments.transfer_id to be nullable so manual branch debts can be paid/reduced.
-- 2. Update record_branch_debt_payment to support manual debts (without transfer_id) and allow either branch to record payments.
-- 3. Enhance get_management_dashboard to return currency-specific debt_stats (USD and UZS).

BEGIN;

-- 1. Allow transfer_id in debt_payments to be NULL for manual debts
ALTER TABLE public.debt_payments ALTER COLUMN transfer_id DROP NOT NULL;

-- 2. Update record_branch_debt_payment
CREATE OR REPLACE FUNCTION public.record_branch_debt_payment(
  p_debt_id uuid,
  p_amount numeric,
  p_currency character,
  p_method text,
  p_reference text,
  p_notes text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_d public.branch_debts%rowtype;
  v_p public.debt_payments%rowtype;
  v_paid_at timestamptz;
  v_paid numeric(18,2);
  v_new_paid numeric(18,2);
  v_curr char(3);
BEGIN
  IF p_debt_id IS NULL THEN
    RAISE EXCEPTION 'Qarzdorlik ID talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT * INTO v_d FROM public.branch_debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Filial qarzi topilmadi' USING errcode = 'P0002';
  END IF;

  IF v_d.status = 'void' THEN
    RAISE EXCEPTION 'Bekor qilingan qarzga to‘lov kiritib bo‘lmaydi' USING errcode = 'P0001';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'To‘lov summasi musbat bo‘lishi kerak' USING errcode = '22023';
  END IF;

  v_curr := upper(btrim(coalesce(p_currency::text, v_d.currency::text)))::char(3);
  IF v_curr <> v_d.currency THEN
    RAISE EXCEPTION 'To‘lov valyutasi qarz valyutasiga mos emas' USING errcode = '22023';
  END IF;

  IF p_idempotency_key IS NULL THEN
    p_idempotency_key := gen_random_uuid();
  END IF;

  -- If this debt is linked to a transfer, use transfer logic
  IF v_d.transfer_id IS NOT NULL THEN
    SELECT paid_at INTO v_paid_at FROM public.debt_payments
    WHERE transfer_id = v_d.transfer_id AND idempotency_key = p_idempotency_key;

    PERFORM public.record_branch_transfer_payment(
      v_d.transfer_id, p_amount, p_currency, coalesce(v_paid_at, now()),
      p_method, p_reference, p_notes, p_idempotency_key
    );
    RETURN public.get_branch_debt(p_debt_id);
  END IF;

  -- Manual debt payment:
  -- Allow payment by creditor branch, debtor branch, superadmin, admin, or postgres/service_role
  IF NOT (
    current_user = 'postgres'
    OR auth.role() = 'service_role'
    OR public.can_access_branch(v_d.creditor_branch_id)
    OR (v_d.debtor_branch_id IS NOT NULL AND public.can_access_branch(v_d.debtor_branch_id))
    OR public.has_role(array['superadmin', 'admin']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'To‘lov kiritish uchun ruxsat yo‘q' USING errcode = '42501';
  END IF;

  -- Check idempotency
  SELECT * INTO v_p FROM public.debt_payments
  WHERE debt_id = p_debt_id AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    RETURN public.get_branch_debt(p_debt_id);
  END IF;

  -- Calculate current paid amount
  SELECT coalesce(sum(amount), 0) INTO v_paid
  FROM public.debt_payments
  WHERE debt_id = p_debt_id;

  IF p_amount > (v_d.amount - v_paid) THEN
    RAISE EXCEPTION 'To‘lov qoldiq summadan oshmasligi kerak' USING errcode = '22023';
  END IF;

  -- Insert payment record
  INSERT INTO public.debt_payments(
    id, debt_id, transfer_id, amount, currency, paid_at, method, reference, notes, idempotency_key, created_by
  ) VALUES (
    gen_random_uuid(), p_debt_id, NULL, p_amount, v_curr, now(),
    coalesce(nullif(btrim(p_method), ''), 'Naqd'),
    nullif(btrim(p_reference), ''),
    nullif(btrim(p_notes), ''),
    p_idempotency_key,
    coalesce(auth.uid(), v_d.created_by)
  );

  v_new_paid := v_paid + p_amount;

  UPDATE public.branch_debts
  SET paid_amount = v_new_paid,
      status = CASE
        WHEN v_new_paid >= amount THEN 'paid'::public.debt_status
        WHEN v_new_paid > 0 THEN 'partially_paid'::public.debt_status
        ELSE 'open'::public.debt_status
      END,
      updated_at = now()
  WHERE id = p_debt_id;

  RETURN public.get_branch_debt(p_debt_id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.record_branch_debt_payment(uuid, numeric, character, text, text, text, uuid) TO authenticated;

-- 3. Update get_management_dashboard to return currency-specific stats
CREATE OR REPLACE FUNCTION public.get_management_dashboard(p_from date, p_to date, p_branch_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_bname text;
BEGIN
  PERFORM public.require_report_access(p_branch_id);

  IF p_branch_id IS NOT NULL THEN
    SELECT lower(btrim(name)) INTO v_bname FROM public.branches WHERE id = p_branch_id;
  END IF;

  RETURN jsonb_build_object(
    'profit_loss', public.report_profit_loss(p_from, p_to, p_branch_id),
    'orders', jsonb_build_object(
      'total', (SELECT count(*) FROM public.orders WHERE placed_at >= public.business_day_start(p_from) AND placed_at < public.business_day_start(p_to + 1) AND (p_branch_id IS NULL OR branch_id = p_branch_id)),
      'new', (SELECT count(*) FROM public.orders WHERE status = 'new' AND placed_at >= public.business_day_start(p_from) AND placed_at < public.business_day_start(p_to + 1) AND (p_branch_id IS NULL OR branch_id = p_branch_id)),
      'delivered', (SELECT count(*) FROM public.orders WHERE status = 'delivered' AND placed_at >= public.business_day_start(p_from) AND placed_at < public.business_day_start(p_to + 1) AND (p_branch_id IS NULL OR branch_id = p_branch_id))
    ),
    'inventory', jsonb_build_object(
      'units', (SELECT coalesce(sum(ib.on_hand), 0) FROM public.inventory_balances ib JOIN public.locations l ON l.id = ib.location_id WHERE p_branch_id IS NULL OR l.branch_id = p_branch_id),
      'reserved', (SELECT coalesce(sum(ib.reserved), 0) FROM public.inventory_balances ib JOIN public.locations l ON l.id = ib.location_id WHERE p_branch_id IS NULL OR l.branch_id = p_branch_id)
    ),
    'receivables', (
      SELECT coalesce(sum(amount - paid_amount), 0)
      FROM public.branch_debts
      WHERE status IN ('open', 'partially_paid')
        AND (p_branch_id IS NULL OR creditor_branch_id = p_branch_id)
    ),
    'payables', (
      SELECT coalesce(sum(amount - paid_amount), 0)
      FROM public.branch_debts
      WHERE status IN ('open', 'partially_paid')
        AND (
          p_branch_id IS NULL 
          OR debtor_branch_id = p_branch_id 
          OR (debtor_branch_id IS NULL AND v_bname IS NOT NULL AND lower(btrim(target_branch_name)) = v_bname)
        )
    ),
    'debt_stats', jsonb_build_object(
      'payables_usd', (
        SELECT coalesce(sum(amount - paid_amount), 0)
        FROM public.branch_debts
        WHERE status IN ('open', 'partially_paid')
          AND currency = 'USD'
          AND (
            p_branch_id IS NULL 
            OR debtor_branch_id = p_branch_id 
            OR (debtor_branch_id IS NULL AND v_bname IS NOT NULL AND lower(btrim(target_branch_name)) = v_bname)
          )
      ),
      'payables_uzs', (
        SELECT coalesce(sum(amount - paid_amount), 0)
        FROM public.branch_debts
        WHERE status IN ('open', 'partially_paid')
          AND currency = 'UZS'
          AND (
            p_branch_id IS NULL 
            OR debtor_branch_id = p_branch_id 
            OR (debtor_branch_id IS NULL AND v_bname IS NOT NULL AND lower(btrim(target_branch_name)) = v_bname)
          )
      ),
      'receivables_usd', (
        SELECT coalesce(sum(amount - paid_amount), 0)
        FROM public.branch_debts
        WHERE status IN ('open', 'partially_paid')
          AND currency = 'USD'
          AND (p_branch_id IS NULL OR creditor_branch_id = p_branch_id)
      ),
      'receivables_uzs', (
        SELECT coalesce(sum(amount - paid_amount), 0)
        FROM public.branch_debts
        WHERE status IN ('open', 'partially_paid')
          AND currency = 'UZS'
          AND (p_branch_id IS NULL OR creditor_branch_id = p_branch_id)
      )
    )
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_management_dashboard(date, date, uuid) TO authenticated;

COMMIT;
