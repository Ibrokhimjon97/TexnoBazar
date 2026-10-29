-- Migration: 20261029065500_fix_branch_debt_generated_column_and_payer.sql
-- Description:
-- 1. Fix: column "remaining_amount" is GENERATED ALWAYS AS (amount - paid_amount) STORED in branch_debts.
--    Do not assign to it in UPDATE statements in record_branch_debt_payment and confirm_branch_debt_payment.
-- 2. Add p_payer_branch_id parameter to record_branch_debt_payment so the UI can explicitly indicate
--    whether the payment was initiated by the debtor branch (which requires creditor confirmation) or creditor branch.

BEGIN;

DROP FUNCTION IF EXISTS public.record_branch_debt_payment(uuid, numeric, character, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.record_branch_debt_payment(uuid, numeric, character, text, text, text, uuid, uuid);

CREATE OR REPLACE FUNCTION public.record_branch_debt_payment(
  p_debt_id uuid,
  p_amount numeric,
  p_currency character,
  p_method text,
  p_reference text,
  p_notes text,
  p_idempotency_key uuid DEFAULT NULL,
  p_payer_branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_d public.branch_debts%rowtype;
  v_p public.debt_payments%rowtype;
  v_curr char(3);
  v_is_creditor boolean;
  v_is_debtor boolean;
  v_is_admin boolean;
  v_confirmed_paid numeric(18,2);
  v_pending_paid numeric(18,2);
  v_status text;
  v_is_confirmed boolean;
  v_confirmed_at timestamptz;
  v_confirmed_by uuid;
  v_payment_id uuid;
  v_new_paid numeric(18,2);
  v_payer_branch uuid;
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

  -- Determine caller permissions
  v_is_admin := (
    current_user = 'postgres'
    OR auth.role() = 'service_role'
    OR public.has_role(array['superadmin', 'admin']::public.app_role[], null)
  );

  v_is_creditor := v_is_admin OR (
    v_d.creditor_branch_id IS NOT NULL AND (
      public.can_access_branch(v_d.creditor_branch_id)
      OR public.has_role(array['manager', 'accountant']::public.app_role[], v_d.creditor_branch_id)
    )
  );

  v_is_debtor := (
    v_d.debtor_branch_id IS NOT NULL AND (
      public.can_access_branch(v_d.debtor_branch_id)
      OR public.has_role(array['manager', 'accountant']::public.app_role[], v_d.debtor_branch_id)
    )
  );

  IF NOT (v_is_creditor OR v_is_debtor) THEN
    RAISE EXCEPTION 'To‘lov kiritish uchun ruxsat yo‘q' USING errcode = '42501';
  END IF;

  -- Check idempotency
  SELECT * INTO v_p FROM public.debt_payments
  WHERE debt_id = p_debt_id AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    RETURN public.get_branch_debt(p_debt_id);
  END IF;

  -- Calculate current confirmed and pending paid amounts
  SELECT coalesce(sum(amount), 0) INTO v_confirmed_paid
  FROM public.debt_payments
  WHERE debt_id = p_debt_id AND is_confirmed = true AND status = 'confirmed';

  SELECT coalesce(sum(amount), 0) INTO v_pending_paid
  FROM public.debt_payments
  WHERE debt_id = p_debt_id AND is_confirmed = false AND status = 'pending';

  IF (v_confirmed_paid + v_pending_paid + p_amount) > v_d.amount THEN
    RAISE EXCEPTION 'To‘lov summasi qoldiq qarzdan oshmasligi kerak (Kutilayotgan to‘lovlar: %)', v_pending_paid USING errcode = '22023';
  END IF;

  -- Confirmation status:
  -- If explicitly marked as debtor branch or user is only debtor branch -> pending confirmation by creditor!
  IF p_payer_branch_id IS NOT NULL AND v_d.debtor_branch_id IS NOT NULL AND p_payer_branch_id = v_d.debtor_branch_id THEN
    v_status := 'pending';
    v_is_confirmed := false;
    v_confirmed_at := NULL;
    v_confirmed_by := NULL;
    v_payer_branch := v_d.debtor_branch_id;
  ELSIF p_payer_branch_id IS NOT NULL AND v_d.creditor_branch_id IS NOT NULL AND p_payer_branch_id = v_d.creditor_branch_id THEN
    -- Creditor manager entered payment that they received -> confirmed
    v_status := 'confirmed';
    v_is_confirmed := true;
    v_confirmed_at := now();
    v_confirmed_by := coalesce(auth.uid(), v_d.created_by);
    v_payer_branch := v_d.debtor_branch_id;
  ELSIF v_is_debtor AND NOT v_is_creditor THEN
    -- Debtor branch manager entered payment -> pending confirmation
    v_status := 'pending';
    v_is_confirmed := false;
    v_confirmed_at := NULL;
    v_confirmed_by := NULL;
    v_payer_branch := v_d.debtor_branch_id;
  ELSIF v_is_creditor THEN
    v_status := 'confirmed';
    v_is_confirmed := true;
    v_confirmed_at := now();
    v_confirmed_by := coalesce(auth.uid(), v_d.created_by);
    v_payer_branch := v_d.debtor_branch_id;
  ELSE
    v_status := 'pending';
    v_is_confirmed := false;
    v_confirmed_at := NULL;
    v_confirmed_by := NULL;
    v_payer_branch := v_d.debtor_branch_id;
  END IF;

  v_payment_id := gen_random_uuid();

  INSERT INTO public.debt_payments(
    id, debt_id, transfer_id, amount, currency, paid_at, method, reference, notes,
    idempotency_key, created_by, status, is_confirmed, confirmed_at, confirmed_by, payer_branch_id
  ) VALUES (
    v_payment_id,
    p_debt_id,
    v_d.transfer_id,
    p_amount,
    v_curr,
    now(),
    coalesce(nullif(btrim(p_method), ''), 'Naqd'),
    nullif(btrim(p_reference), ''),
    nullif(btrim(p_notes), ''),
    p_idempotency_key,
    coalesce(auth.uid(), v_d.created_by),
    v_status,
    v_is_confirmed,
    v_confirmed_at,
    v_confirmed_by,
    v_payer_branch
  );

  -- Only if confirmed, update the debt's paid_amount
  -- NOTE: remaining_amount is a GENERATED ALWAYS column in Postgres, so DO NOT update it explicitly!
  IF v_is_confirmed THEN
    v_new_paid := v_confirmed_paid + p_amount;
    UPDATE public.branch_debts
    SET paid_amount = v_new_paid,
        status = CASE
          WHEN v_new_paid >= amount THEN 'paid'::public.debt_status
          WHEN v_new_paid > 0 THEN 'partially_paid'::public.debt_status
          ELSE 'open'::public.debt_status
        END,
        updated_at = now()
    WHERE id = p_debt_id;
  END IF;

  RETURN public.get_branch_debt(p_debt_id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.record_branch_debt_payment(uuid, numeric, character, text, text, text, uuid, uuid) TO authenticated, service_role;

-- Update confirm_branch_debt_payment to omit remaining_amount as well
CREATE OR REPLACE FUNCTION public.confirm_branch_debt_payment(p_payment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_p public.debt_payments%rowtype;
  v_d public.branch_debts%rowtype;
  v_new_paid numeric(18,2);
  v_confirmed_paid numeric(18,2);
  v_is_creditor boolean;
BEGIN
  IF p_payment_id IS NULL THEN
    RAISE EXCEPTION 'To‘lov ID talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT * INTO v_p FROM public.debt_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'To‘lov topilmadi' USING errcode = 'P0002';
  END IF;

  IF v_p.debt_id IS NULL THEN
    RAISE EXCEPTION 'To‘lov qarzga biriktirilmagan' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_d FROM public.branch_debts WHERE id = v_p.debt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Filial qarzi topilmadi' USING errcode = 'P0002';
  END IF;

  -- Permission check: only creditor branch manager or superadmin/admin can confirm!
  v_is_creditor := (
    current_user = 'postgres'
    OR auth.role() = 'service_role'
    OR public.has_role(array['superadmin', 'admin']::public.app_role[], null)
    OR (
      v_d.creditor_branch_id IS NOT NULL AND (
        public.can_access_branch(v_d.creditor_branch_id)
        OR public.has_role(array['manager', 'accountant']::public.app_role[], v_d.creditor_branch_id)
      )
    )
  );

  IF NOT v_is_creditor THEN
    RAISE EXCEPTION 'To‘lovni qabul qilib tasdiqlash uchun faqat haqdor (kreditor) filial menejeriga ruxsat berilgan' USING errcode = '42501';
  END IF;

  IF v_p.is_confirmed AND v_p.status = 'confirmed' THEN
    RETURN public.get_branch_debt(v_d.id);
  END IF;

  IF v_p.status = 'rejected' THEN
    RAISE EXCEPTION 'Rad etilgan to‘lovni tasdiqlab bo‘lmaydi' USING errcode = 'P0001';
  END IF;

  -- Calculate current confirmed sum
  SELECT coalesce(sum(amount), 0) INTO v_confirmed_paid
  FROM public.debt_payments
  WHERE debt_id = v_d.id AND is_confirmed = true AND status = 'confirmed';

  v_new_paid := v_confirmed_paid + v_p.amount;
  IF v_new_paid > v_d.amount THEN
    RAISE EXCEPTION 'To‘lov summasi qarz qoldig‘idan oshib ketadi' USING errcode = '22023';
  END IF;

  -- Mark payment confirmed
  UPDATE public.debt_payments
  SET status = 'confirmed',
      is_confirmed = true,
      confirmed_at = now(),
      confirmed_by = coalesce(auth.uid(), v_d.created_by)
  WHERE id = p_payment_id;

  -- Update branch_debts
  -- NOTE: remaining_amount is a GENERATED ALWAYS column in Postgres, so DO NOT update it explicitly!
  UPDATE public.branch_debts
  SET paid_amount = v_new_paid,
      status = CASE
        WHEN v_new_paid >= amount THEN 'paid'::public.debt_status
        WHEN v_new_paid > 0 THEN 'partially_paid'::public.debt_status
        ELSE 'open'::public.debt_status
      END,
      updated_at = now()
  WHERE id = v_d.id;

  RETURN public.get_branch_debt(v_d.id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.confirm_branch_debt_payment(uuid) TO authenticated, service_role;

COMMIT;
