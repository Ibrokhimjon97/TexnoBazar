-- Migration: 20261029023000_supplier_manual_debt_and_branch_debt_fixes.sql
-- Description:
-- 1. Allow authenticated staff to read active branches so branch select dropdowns work.
-- 2. Create supplier_manual_debts table and register_supplier_debt RPC so managers can record manual supplier debt (with currency and notes).
-- 3. Enhance list_supplier_debts to return manual_debts history.
-- 4. Enhance register_branch_debt, list_branch_debts and get_branch_debt_summary to ensure debtor branch can view their debts seamlessly.

BEGIN;

-- 1. Branches table access for authenticated users
DROP POLICY IF EXISTS branches_active_read ON public.branches;
CREATE POLICY branches_active_read ON public.branches
  FOR SELECT TO authenticated
  USING (is_active = true);

-- Update list_active_branches RPC to allow all authenticated employees
CREATE OR REPLACE FUNCTION public.list_active_branches()
RETURNS TABLE(id uuid, code text, name text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Avtorizatsiyadan o‘ting' USING errcode = '42501';
  END IF;
  RETURN QUERY SELECT b.id, b.code, b.name FROM public.branches b WHERE b.is_active ORDER BY b.name;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.list_active_branches() TO authenticated;

-- 2. Manual supplier debts table
CREATE TABLE IF NOT EXISTS public.supplier_manual_debts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supplier_manual_debts_supplier ON public.supplier_manual_debts(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_manual_debts_branch ON public.supplier_manual_debts(branch_id);

ALTER TABLE public.supplier_manual_debts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS supplier_manual_debts_read ON public.supplier_manual_debts;
CREATE POLICY supplier_manual_debts_read ON public.supplier_manual_debts
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS supplier_manual_debts_write ON public.supplier_manual_debts;
CREATE POLICY supplier_manual_debts_write ON public.supplier_manual_debts
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT ALL ON public.supplier_manual_debts TO authenticated;
GRANT ALL ON public.supplier_manual_debts TO service_role;

-- 3. Register manual supplier debt RPC
CREATE OR REPLACE FUNCTION public.register_supplier_debt(
  p_supplier_id uuid DEFAULT NULL,
  p_supplier_name text DEFAULT NULL,
  p_amount numeric DEFAULT 0,
  p_currency text DEFAULT 'USD',
  p_notes text DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_supplier_id uuid := p_supplier_id;
  v_supplier_name text := btrim(coalesce(p_supplier_name, ''));
  v_currency char(3);
  v_debt_id uuid;
  v_code text;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Avtorizatsiyadan o‘ting' USING errcode = '42501';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Qarz summasi noldan katta bo‘lishi kerak' USING errcode = '22023';
  END IF;

  v_currency := upper(btrim(coalesce(p_currency, 'USD')));
  IF v_currency NOT IN ('USD', 'UZS') THEN
    v_currency := 'USD';
  END IF;

  -- If supplier_id provided, verify and get name
  IF v_supplier_id IS NOT NULL THEN
    SELECT id, name INTO v_supplier_id, v_supplier_name
    FROM public.suppliers
    WHERE id = v_supplier_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Bunday ta‘minotchi topilmadi' USING errcode = 'P0002';
    END IF;
  ELSE
    -- Try to find by name
    IF v_supplier_name = '' THEN
      RAISE EXCEPTION 'Ta‘minotchi nomini kiriting yoki tanlang' USING errcode = '22023';
    END IF;

    SELECT id, name INTO v_supplier_id, v_supplier_name
    FROM public.suppliers
    WHERE lower(btrim(name)) = lower(v_supplier_name)
    LIMIT 1;

    -- If still not found, create new supplier
    IF v_supplier_id IS NULL THEN
      v_code := upper(regexp_replace(v_supplier_name, '[^A-Za-z0-9]+', '-', 'g'));
      v_code := left(v_code, 20) || '-' || upper(substr(gen_random_uuid()::text, 1, 4));

      INSERT INTO public.suppliers (code, name, balance, balance_currency, is_active)
      VALUES (v_code, v_supplier_name, 0, v_currency, true)
      RETURNING id INTO v_supplier_id;
    END IF;
  END IF;

  -- Insert manual debt row
  v_debt_id := gen_random_uuid();
  INSERT INTO public.supplier_manual_debts (
    id, supplier_id, branch_id, amount, currency, notes, created_by, created_at, updated_at
  ) VALUES (
    v_debt_id, v_supplier_id, p_branch_id, p_amount, v_currency, nullif(btrim(p_notes), ''), auth.uid(), now(), now()
  );

  -- Update supplier balance
  UPDATE public.suppliers
  SET balance = coalesce(balance, 0) + p_amount,
      balance_currency = v_currency,
      updated_at = now()
  WHERE id = v_supplier_id;

  SELECT jsonb_build_object(
    'id', v_debt_id,
    'supplier_id', v_supplier_id,
    'supplier_name', v_supplier_name,
    'amount', p_amount,
    'currency', v_currency,
    'notes', p_notes,
    'created_at', now()
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.register_supplier_debt(uuid, text, numeric, text, text, uuid) TO authenticated;

-- 4. Update list_supplier_debts to include manual_debts
CREATE OR REPLACE FUNCTION public.list_supplier_debts(p_branch_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF p_branch_id IS NOT NULL AND NOT public.can_access_branch(p_branch_id) THEN
    RAISE EXCEPTION 'Filialga ruxsat yo‘q' USING errcode = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.supplier_name), '[]'::jsonb) INTO v_result FROM (
    SELECT
      s.id AS supplier_id,
      s.name AS supplier_name,
      s.code AS supplier_code,
      s.balance AS total_balance,
      s.balance_currency,
      (SELECT count(*) FROM public.stock_receipts r
        WHERE r.supplier_id = s.id
        AND (p_branch_id IS NULL OR r.branch_id = p_branch_id)) AS total_receipt_count,
      (SELECT count(*) FROM public.stock_receipts r
        WHERE r.supplier_id = s.id AND r.payment_status IN ('unpaid','partial')
        AND (p_branch_id IS NULL OR r.branch_id = p_branch_id)) AS open_receipt_count,
      (SELECT count(*) FROM public.supplier_manual_debts md
        WHERE md.supplier_id = s.id
        AND (p_branch_id IS NULL OR md.branch_id = p_branch_id OR md.branch_id IS NULL)) AS manual_debt_count,
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', md.id,
        'amount', md.amount,
        'currency', md.currency,
        'notes', md.notes,
        'created_at', md.created_at,
        'created_by_name', coalesce(p.full_name, 'Menejer')
      ) ORDER BY md.created_at DESC), '[]'::jsonb)
      FROM public.supplier_manual_debts md
      LEFT JOIN public.profiles p ON p.id = md.created_by
      WHERE md.supplier_id = s.id
        AND (p_branch_id IS NULL OR md.branch_id = p_branch_id OR md.branch_id IS NULL)) AS manual_debts,
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'receipt_no', r.receipt_no, 'received_at', r.received_at,
        'currency', r.currency, 'payment_status', r.payment_status, 'paid_amount', r.paid_amount,
        'total_cost', (SELECT coalesce(sum(b.quantity * b.unit_cost), 0) FROM public.stock_batches b WHERE b.receipt_id = r.id),
        'line_count', (SELECT count(*) FROM public.stock_batches b WHERE b.receipt_id = r.id),
        'unit_count', (SELECT coalesce(sum(b.quantity), 0) FROM public.stock_batches b WHERE b.receipt_id = r.id),
        'products', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'product_name', p.name, 'sku', p.sku, 'quantity', b.quantity,
          'unit_cost', b.unit_cost, 'line_total', b.quantity * b.unit_cost
        ) ORDER BY b.line_no), '[]'::jsonb)
        FROM public.stock_batches b JOIN public.products p ON p.id = b.product_id WHERE b.receipt_id = r.id)
      ) ORDER BY r.received_at DESC), '[]'::jsonb)
      FROM public.stock_receipts r
      WHERE r.supplier_id = s.id
        AND (p_branch_id IS NULL OR r.branch_id = p_branch_id)) AS receipts
    FROM public.suppliers s
    WHERE s.is_active AND (
      s.balance > 0
      OR EXISTS(SELECT 1 FROM public.stock_receipts r WHERE r.supplier_id = s.id
        AND (p_branch_id IS NULL OR r.branch_id = p_branch_id))
      OR EXISTS(SELECT 1 FROM public.supplier_manual_debts md WHERE md.supplier_id = s.id
        AND (p_branch_id IS NULL OR md.branch_id = p_branch_id OR md.branch_id IS NULL))
    )
  ) x;

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.list_supplier_debts(uuid) TO authenticated;

-- 5. Enhanced register_branch_debt
CREATE OR REPLACE FUNCTION public.register_branch_debt(
  p_creditor_branch_id uuid,
  p_debtor_branch_id uuid,
  p_target_branch_name text,
  p_amount numeric,
  p_currency text DEFAULT 'USD'::text,
  p_notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_debt_id uuid;
  v_debt_no text;
  v_currency char(3);
  v_target_name text;
  v_debtor_id uuid := p_debtor_branch_id;
  v_user_id uuid;
  v_result jsonb;
BEGIN
  IF p_creditor_branch_id IS NULL THEN
    RAISE EXCEPTION 'Kreditor filial ko‘rsatilmadi' USING errcode = '22023';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Qarz summasi noldan katta bo‘lishi kerak' USING errcode = '22023';
  END IF;

  v_currency := upper(btrim(coalesce(p_currency, 'USD')));
  IF v_currency NOT IN ('USD', 'UZS') THEN
    v_currency := 'USD';
  END IF;

  -- Resolve target branch name & debtor_branch_id
  IF v_debtor_id IS NOT NULL THEN
    SELECT name INTO v_target_name FROM public.branches WHERE id = v_debtor_id;
  END IF;

  IF nullif(btrim(v_target_name), '') IS NULL AND nullif(btrim(p_target_branch_name), '') IS NOT NULL THEN
    v_target_name := btrim(p_target_branch_name);
    -- Try to match system branch by name or code if debtor id wasn't passed directly
    IF v_debtor_id IS NULL THEN
      SELECT id, name INTO v_debtor_id, v_target_name
      FROM public.branches
      WHERE is_active = true
        AND (lower(btrim(name)) = lower(v_target_name) OR lower(btrim(code)) = lower(v_target_name))
      LIMIT 1;
      IF v_target_name IS NULL THEN
        v_target_name := btrim(p_target_branch_name);
      END IF;
    END IF;
  END IF;

  IF v_target_name IS NULL THEN
    RAISE EXCEPTION 'Qarzdor filial nomini kiriting yoki ro‘yxatdan tanlang' USING errcode = '22023';
  END IF;

  -- Prevent a branch from registering debt against itself
  IF v_debtor_id IS NOT NULL AND v_debtor_id = p_creditor_branch_id THEN
    RAISE EXCEPTION 'Filial o‘ziga o‘zi qarzdorlik yozolmaydi' USING errcode = '22023';
  END IF;

  v_user_id := auth.uid();
  v_debt_id := gen_random_uuid();
  v_debt_no := 'QARZ-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  INSERT INTO public.branch_debts (
    id, debt_no, creditor_branch_id, debtor_branch_id, target_branch_name,
    amount, paid_amount, currency, status, notes, debt_type,
    is_confirmed, confirmed_at, created_by, created_at, updated_at
  ) VALUES (
    v_debt_id, v_debt_no, p_creditor_branch_id, v_debtor_id, v_target_name,
    p_amount, 0, v_currency, 'open'::public.debt_status, nullif(btrim(p_notes), ''), 'manual',
    false, NULL, v_user_id, now(), now()
  );

  SELECT jsonb_build_object(
    'id', d.id,
    'debt_no', d.debt_no,
    'transfer_no', d.debt_no,
    'creditor_branch_id', d.creditor_branch_id,
    'creditor_branch_name', cb.name,
    'debtor_branch_id', d.debtor_branch_id,
    'debtor_branch_name', coalesce(db.name, d.target_branch_name),
    'amount', d.amount,
    'paid_amount', d.paid_amount,
    'remaining_amount', (d.amount - d.paid_amount),
    'currency', d.currency,
    'status', d.status,
    'is_confirmed', d.is_confirmed,
    'notes', d.notes,
    'created_at', d.created_at
  ) INTO v_result
  FROM public.branch_debts d
  LEFT JOIN public.branches cb ON cb.id = d.creditor_branch_id
  LEFT JOIN public.branches db ON db.id = d.debtor_branch_id
  WHERE d.id = v_debt_id;

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.register_branch_debt(uuid, uuid, text, numeric, text, text) TO authenticated;

-- 6. Retroactive data fix for branch_debts if any have NULL debtor_branch_id matching existing branch
UPDATE public.branch_debts d
SET debtor_branch_id = b.id
FROM public.branches b
WHERE d.debtor_branch_id IS NULL
  AND (lower(btrim(d.target_branch_name)) = lower(btrim(b.name)) OR lower(btrim(d.target_branch_name)) = lower(btrim(b.code)));

-- 7. Enhanced list_branch_debts so debtor branch matches by ID or matched name
CREATE OR REPLACE FUNCTION public.list_branch_debts(
  p_branch_id uuid DEFAULT NULL::uuid,
  p_direction text DEFAULT 'all'::text,
  p_status debt_status DEFAULT NULL::debt_status,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_bid uuid := p_branch_id;
  v_bname text;
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

  IF v_bid IS NOT NULL THEN
    SELECT lower(btrim(name)) INTO v_bname FROM public.branches WHERE id = v_bid;
  END IF;

  SELECT count(*) INTO v_total
  FROM public.branch_debts d
  WHERE (
    v_bid IS NULL
    OR (v_direction = 'all' AND (
      d.debtor_branch_id = v_bid 
      OR d.creditor_branch_id = v_bid
      OR (d.debtor_branch_id IS NULL AND v_bname IS NOT NULL AND lower(btrim(d.target_branch_name)) = v_bname)
    ))
    OR (v_direction = 'debtor' AND (
      d.debtor_branch_id = v_bid
      OR (d.debtor_branch_id IS NULL AND v_bname IS NOT NULL AND lower(btrim(d.target_branch_name)) = v_bname)
    ))
    OR (v_direction = 'creditor' AND d.creditor_branch_id = v_bid)
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
      coalesce(t.transfer_no, d.debt_no, 'QARZ-' || substr(d.id::text, 1, 8)) AS transfer_no
    FROM public.branch_debts d
    LEFT JOIN public.branches db ON db.id = d.debtor_branch_id
    LEFT JOIN public.branches cb ON cb.id = d.creditor_branch_id
    LEFT JOIN public.transfers t ON t.id = d.transfer_id
    WHERE (
      v_bid IS NULL
      OR (v_direction = 'all' AND (
        d.debtor_branch_id = v_bid 
        OR d.creditor_branch_id = v_bid
        OR (d.debtor_branch_id IS NULL AND v_bname IS NOT NULL AND lower(btrim(d.target_branch_name)) = v_bname)
      ))
      OR (v_direction = 'debtor' AND (
        d.debtor_branch_id = v_bid
        OR (d.debtor_branch_id IS NULL AND v_bname IS NOT NULL AND lower(btrim(d.target_branch_name)) = v_bname)
      ))
      OR (v_direction = 'creditor' AND d.creditor_branch_id = v_bid)
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
      v_bid IS NULL
      OR (v_direction = 'all' AND (
        d.debtor_branch_id = v_bid 
        OR d.creditor_branch_id = v_bid
        OR (d.debtor_branch_id IS NULL AND v_bname IS NOT NULL AND lower(btrim(d.target_branch_name)) = v_bname)
      ))
      OR (v_direction = 'debtor' AND (
        d.debtor_branch_id = v_bid
        OR (d.debtor_branch_id IS NULL AND v_bname IS NOT NULL AND lower(btrim(d.target_branch_name)) = v_bname)
      ))
      OR (v_direction = 'creditor' AND d.creditor_branch_id = v_bid)
    ) AND (p_status IS NULL OR d.status = p_status)
    GROUP BY d.currency
  ) s;

  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'summary', v_summary);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.list_branch_debts(uuid, text, debt_status, integer, integer) TO authenticated;

-- 8. Enhanced get_branch_debt_summary
CREATE OR REPLACE FUNCTION public.get_branch_debt_summary(p_branch_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_bid uuid := coalesce(p_branch_id, (SELECT id FROM public.branches WHERE is_active = true LIMIT 1));
  v_bname text;
  v_debtor jsonb;
  v_creditor jsonb;
BEGIN
  IF v_bid IS NULL THEN
    RETURN jsonb_build_object('debtor', '[]'::jsonb, 'creditor', '[]'::jsonb);
  END IF;

  SELECT lower(btrim(name)) INTO v_bname FROM public.branches WHERE id = v_bid;

  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.currency), '[]'::jsonb) INTO v_debtor
  FROM (
    SELECT 
      d.currency,
      sum(d.amount) AS amount,
      sum(d.paid_amount) AS paid_amount,
      sum(d.amount - d.paid_amount) AS remaining_amount,
      count(*) AS debt_count
    FROM public.branch_debts d
    WHERE (
      d.debtor_branch_id = v_bid
      OR (d.debtor_branch_id IS NULL AND v_bname IS NOT NULL AND lower(btrim(d.target_branch_name)) = v_bname)
    ) AND d.status = 'open'
    GROUP BY d.currency
  ) s;

  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.currency), '[]'::jsonb) INTO v_creditor
  FROM (
    SELECT 
      d.currency,
      sum(d.amount) AS amount,
      sum(d.paid_amount) AS paid_amount,
      sum(d.amount - d.paid_amount) AS remaining_amount,
      count(*) AS debt_count
    FROM public.branch_debts d
    WHERE d.creditor_branch_id = v_bid AND d.status = 'open'
    GROUP BY d.currency
  ) s;

  RETURN jsonb_build_object('debtor', v_debtor, 'creditor', v_creditor);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_branch_debt_summary(uuid) TO authenticated;

COMMIT;
