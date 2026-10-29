-- Migration: 20261029064500_branch_debt_payment_confirmation.sql
-- Description:
-- 1. Add status, is_confirmed, confirmed_at, confirmed_by, payer_branch_id to public.debt_payments.
-- 2. Update guard_transfer_debt_payment() trigger function to allow updating confirmation metadata while keeping financial integrity.
-- 3. Update record_branch_debt_payment: if payment is submitted by debtor branch, mark status='pending' and is_confirmed=false without reducing paid_amount. If submitted by creditor branch or admin, immediately confirm.
-- 4. Create confirm_branch_debt_payment(uuid): allows creditor branch manager or admin to confirm a pending payment, which updates debt.paid_amount and status.
-- 5. Create reject_branch_debt_payment(uuid, text): allows creditor branch manager or admin to reject an unconfirmed payment.
-- 6. Update get_branch_debt and list_branch_debts to include pending payment indicators.

BEGIN;

-- 1. Alter debt_payments table to include confirmation workflow columns
ALTER TABLE public.debt_payments ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'confirmed';
ALTER TABLE public.debt_payments ADD COLUMN IF NOT EXISTS is_confirmed boolean NOT NULL DEFAULT true;
ALTER TABLE public.debt_payments ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE public.debt_payments ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.debt_payments ADD COLUMN IF NOT EXISTS payer_branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS debt_payments_status_idx ON public.debt_payments(status, is_confirmed);
CREATE INDEX IF NOT EXISTS debt_payments_payer_branch_idx ON public.debt_payments(payer_branch_id);

-- 2. Update guard_transfer_debt_payment() trigger
CREATE OR REPLACE FUNCTION public.guard_transfer_debt_payment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'debt_payments is immutable' USING errcode = '55000';
  END IF;

  -- Core financial columns must NEVER change
  IF old.amount IS DISTINCT FROM new.amount
    OR old.currency IS DISTINCT FROM new.currency
    OR old.idempotency_key IS DISTINCT FROM new.idempotency_key
    OR old.created_by IS DISTINCT FROM new.created_by
    OR (old.transfer_id IS NOT NULL AND old.transfer_id IS DISTINCT FROM new.transfer_id)
    OR (old.debt_id IS NOT NULL AND old.debt_id IS DISTINCT FROM new.debt_id) THEN
    RAISE EXCEPTION 'To‘lovning asosiy parametrlarini o‘zgartirib bo‘lmaydi' USING errcode = '55000';
  END IF;

  -- Allow attaching debt_id when old.debt_id IS NULL and transfer_id matches
  IF old.debt_id IS NULL AND new.debt_id IS NOT NULL THEN
    IF old.transfer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.branch_debts d
      WHERE d.id = new.debt_id AND d.transfer_id = old.transfer_id
    ) THEN
      RAISE EXCEPTION 'To‘lovni qarzga noto‘g‘ri biriktirish' USING errcode = '55000';
    END IF;
  END IF;

  RETURN new;
END $$;

-- 3. Update record_branch_debt_payment
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
  -- If creditor or admin is entering payment, they have received the money -> immediate confirmation
  -- If debtor is entering payment, creditor must confirm receipt -> pending confirmation!
  IF v_is_creditor THEN
    v_status := 'confirmed';
    v_is_confirmed := true;
    v_confirmed_at := now();
    v_confirmed_by := coalesce(auth.uid(), v_d.created_by);
  ELSE
    v_status := 'pending';
    v_is_confirmed := false;
    v_confirmed_at := NULL;
    v_confirmed_by := NULL;
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
    CASE WHEN v_is_debtor THEN v_d.debtor_branch_id ELSE v_d.creditor_branch_id END
  );

  -- Only if confirmed, update the debt's paid_amount
  IF v_is_confirmed THEN
    v_new_paid := v_confirmed_paid + p_amount;
    UPDATE public.branch_debts
    SET paid_amount = v_new_paid,
        remaining_amount = v_d.amount - v_new_paid,
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

GRANT EXECUTE ON FUNCTION public.record_branch_debt_payment(uuid, numeric, character, text, text, text, uuid) TO authenticated, service_role;

-- 4. Create confirm_branch_debt_payment
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
  UPDATE public.branch_debts
  SET paid_amount = v_new_paid,
      remaining_amount = v_d.amount - v_new_paid,
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

-- 5. Create reject_branch_debt_payment
CREATE OR REPLACE FUNCTION public.reject_branch_debt_payment(p_payment_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_p public.debt_payments%rowtype;
  v_d public.branch_debts%rowtype;
  v_is_creditor boolean;
  v_reason text;
BEGIN
  IF p_payment_id IS NULL THEN
    RAISE EXCEPTION 'To‘lov ID talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT * INTO v_p FROM public.debt_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'To‘lov topilmadi' USING errcode = 'P0002';
  END IF;

  SELECT * INTO v_d FROM public.branch_debts WHERE id = v_p.debt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Filial qarzi topilmadi' USING errcode = 'P0002';
  END IF;

  -- Permission check: only creditor branch manager or superadmin/admin can reject!
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
    RAISE EXCEPTION 'To‘lovni rad etish uchun faqat haqdor (kreditor) filial menejeriga ruxsat berilgan' USING errcode = '42501';
  END IF;

  IF v_p.is_confirmed AND v_p.status = 'confirmed' THEN
    RAISE EXCEPTION 'Allaqachon tasdiqlangan to‘lovni rad etib bo‘lmaydi' USING errcode = 'P0001';
  END IF;

  v_reason := coalesce(nullif(btrim(p_reason), ''), 'Haqdor menejer tomonidan rad etildi');

  -- Update payment to rejected
  UPDATE public.debt_payments
  SET status = 'rejected',
      is_confirmed = false,
      notes = CASE
        WHEN notes IS NULL OR notes = '' THEN 'Rad etildi: ' || v_reason
        ELSE notes || ' [Rad etildi: ' || v_reason || ']'
      END
  WHERE id = p_payment_id;

  RETURN public.get_branch_debt(v_d.id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reject_branch_debt_payment(uuid, text) TO authenticated, service_role;

-- 6. Update get_branch_debt to include pending payment metrics and payment status details
CREATE OR REPLACE FUNCTION public.get_branch_debt(p_debt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_d public.branch_debts%rowtype;
  v_result jsonb;
  v_is_creditor boolean;
BEGIN
  SELECT * INTO v_d FROM public.branch_debts WHERE id = p_debt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Filial qarzi topilmadi' USING errcode = 'P0002';
  END IF;

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

  SELECT 
    to_jsonb(d) || jsonb_build_object(
      'debtor_branch_name', coalesce(db.name, d.target_branch_name, 'Qarzdor filial'),
      'creditor_branch_name', coalesce(cb.name, 'Kreditor filial'),
      'transfer_no', coalesce(t.transfer_no, d.debt_no, 'QARZ-' || substr(d.id::text, 1, 8)),
      'remaining_amount', (d.amount - d.paid_amount),
      'pending_payments_count', coalesce((
        SELECT count(*)
        FROM public.debt_payments p
        WHERE p.debt_id = d.id AND p.is_confirmed = false AND p.status = 'pending'
      ), 0),
      'pending_payments_total', coalesce((
        SELECT sum(p.amount)
        FROM public.debt_payments p
        WHERE p.debt_id = d.id AND p.is_confirmed = false AND p.status = 'pending'
      ), 0),
      'payments', coalesce((
        SELECT jsonb_agg(
          to_jsonb(p) || jsonb_build_object(
            'payer_branch_name', pb.name,
            'confirmed_by_name', cp.full_name
          ) ORDER BY p.paid_at DESC, p.id
        )
        FROM public.debt_payments p
        LEFT JOIN public.branches pb ON pb.id = p.payer_branch_id
        LEFT JOIN public.profiles cp ON cp.id = p.confirmed_by
        WHERE p.debt_id = d.id
      ), '[]'::jsonb),
      'transfers_history', coalesce((
        SELECT jsonb_agg(to_jsonb(bdt) ORDER BY bdt.created_at DESC)
        FROM public.branch_debt_transfers bdt WHERE bdt.debt_id = d.id
      ), '[]'::jsonb),
      'can_record_payment', (d.status <> 'paid' AND d.status <> 'void'),
      'can_confirm_payment', v_is_creditor
    )
  INTO v_result
  FROM public.branch_debts d
  LEFT JOIN public.branches db ON db.id = d.debtor_branch_id
  LEFT JOIN public.branches cb ON cb.id = d.creditor_branch_id
  LEFT JOIN public.transfers t ON t.id = d.transfer_id
  WHERE d.id = p_debt_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_branch_debt(uuid) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.list_branch_debts(uuid, text, public.debt_status, integer, integer);
CREATE OR REPLACE FUNCTION public.list_branch_debts(
  p_branch_id uuid,
  p_direction text DEFAULT 'all',
  p_status public.debt_status DEFAULT null,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_items jsonb;
  v_total bigint;
  v_summary jsonb;
  v_direction text := lower(coalesce(p_direction, 'all'));
BEGIN
  IF v_direction NOT IN ('all', 'debtor', 'creditor') THEN
    RAISE EXCEPTION 'Yo‘nalish all, debtor yoki creditor bo‘lishi kerak' USING errcode = '22023';
  END IF;

  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto‘g‘ri' USING errcode = '22023';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.branch_debts d
  WHERE (
    (v_direction = 'all' AND (d.debtor_branch_id = p_branch_id OR d.creditor_branch_id = p_branch_id))
    OR (v_direction = 'debtor' AND d.debtor_branch_id = p_branch_id)
    OR (v_direction = 'creditor' AND d.creditor_branch_id = p_branch_id)
  ) AND (p_status IS NULL OR d.status = p_status);

  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC), '[]'::jsonb) INTO v_items
  FROM (
    SELECT 
      d.id,
      d.debtor_branch_id,
      d.creditor_branch_id,
      d.transfer_id,
      d.amount,
      d.paid_amount,
      (d.amount - d.paid_amount) AS remaining_amount,
      d.currency,
      d.status,
      d.due_at,
      d.notes,
      d.debt_type,
      d.is_confirmed,
      d.confirmed_at,
      d.created_at,
      d.updated_at,
      coalesce(db.name, d.target_branch_name, 'Qarzdor filial') AS debtor_branch_name,
      coalesce(cb.name, 'Kreditor filial') AS creditor_branch_name,
      coalesce(t.transfer_no, d.debt_no, 'QARZ-' || substr(d.id::text, 1, 8)) AS transfer_no,
      coalesce((
        SELECT count(*)
        FROM public.debt_payments p
        WHERE p.debt_id = d.id AND p.is_confirmed = false AND p.status = 'pending'
      ), 0) AS pending_payments_count,
      coalesce((
        SELECT sum(p.amount)
        FROM public.debt_payments p
        WHERE p.debt_id = d.id AND p.is_confirmed = false AND p.status = 'pending'
      ), 0) AS pending_payments_total
    FROM public.branch_debts d
    LEFT JOIN public.branches db ON db.id = d.debtor_branch_id
    LEFT JOIN public.branches cb ON cb.id = d.creditor_branch_id
    LEFT JOIN public.transfers t ON t.id = d.transfer_id
    WHERE (
      (v_direction = 'all' AND (d.debtor_branch_id = p_branch_id OR d.creditor_branch_id = p_branch_id))
      OR (v_direction = 'debtor' AND d.debtor_branch_id = p_branch_id)
      OR (v_direction = 'creditor' AND d.creditor_branch_id = p_branch_id)
    ) AND (p_status IS NULL OR d.status = p_status)
    ORDER BY d.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) q;

  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.currency), '[]'::jsonb) INTO v_summary
  FROM (
    SELECT 
      d.currency,
      sum(d.amount) AS amount,
      sum(d.paid_amount) AS paid_amount,
      sum(d.amount - d.paid_amount) AS remaining_amount,
      count(*) AS debt_count
    FROM public.branch_debts d
    WHERE (
      (v_direction = 'all' AND (d.debtor_branch_id = p_branch_id OR d.creditor_branch_id = p_branch_id))
      OR (v_direction = 'debtor' AND d.debtor_branch_id = p_branch_id)
      OR (v_direction = 'creditor' AND d.creditor_branch_id = p_branch_id)
    ) AND (p_status IS NULL OR d.status = p_status)
    GROUP BY d.currency
  ) s;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'summary', coalesce(v_summary, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_branch_debts(uuid, text, public.debt_status, integer, integer) TO authenticated, service_role;

COMMIT;
