-- Migration: 20261029120000_update_and_delete_branch_debts.sql
-- Description: Allow creditor branches to edit and delete branch debts, syncing across both creditor and debtor branches.
-- Production safe: Only adds RPC functions and ensures RLS / permissions are granted.

BEGIN;

-- 1. RPC: update_branch_debt
CREATE OR REPLACE FUNCTION public.update_branch_debt(
  p_debt_id uuid,
  p_debtor_branch_id uuid DEFAULT NULL,
  p_target_branch_name text DEFAULT NULL,
  p_amount numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_debt record;
  v_new_currency char(3);
  v_new_amount numeric;
  v_debtor_id uuid;
  v_target_name text;
BEGIN
  -- 1. Find debt and lock for update
  SELECT * INTO v_debt
  FROM public.branch_debts
  WHERE id = p_debt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Filial qarzdorligi topilmadi: %', p_debt_id USING errcode = 'P0002';
  END IF;

  -- 2. Validation
  v_new_amount := coalesce(p_amount, v_debt.amount);
  IF v_new_amount <= 0 THEN
    RAISE EXCEPTION 'Qarz summasi noldan katta bo‘lishi kerak' USING errcode = '22023';
  END IF;

  IF v_new_amount < v_debt.paid_amount THEN
    RAISE EXCEPTION 'Qarz summasi allaqachon to‘langan summadan (%) kam bo‘lishi mumkin emas', v_debt.paid_amount USING errcode = '22023';
  END IF;

  -- Currency validation
  IF p_currency IS NOT NULL THEN
    v_new_currency := upper(btrim(p_currency));
    IF v_new_currency NOT IN ('USD', 'UZS') THEN
      v_new_currency := v_debt.currency;
    END IF;
  ELSE
    v_new_currency := v_debt.currency;
  END IF;

  -- Target branch resolution
  v_debtor_id := coalesce(p_debtor_branch_id, v_debt.debtor_branch_id);
  IF v_debtor_id IS NOT NULL THEN
    SELECT name INTO v_target_name FROM public.branches WHERE id = v_debtor_id;
  END IF;

  IF nullif(btrim(v_target_name), '') IS NULL AND nullif(btrim(p_target_branch_name), '') IS NOT NULL THEN
    v_target_name := btrim(p_target_branch_name);
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
    v_target_name := coalesce(v_debt.target_branch_name, 'Qarzdor filial');
  END IF;

  -- Prevent debtor from being creditor
  IF v_debtor_id IS NOT NULL AND v_debtor_id = v_debt.creditor_branch_id THEN
    RAISE EXCEPTION 'Filial o‘ziga o‘zi qarzdorlik yozolmaydi' USING errcode = '22023';
  END IF;

  -- 3. Update branch_debts with app.bypass_transfer_guard = 'on'
  PERFORM set_config('app.bypass_transfer_guard', 'on', true);

  UPDATE public.branch_debts
  SET 
    debtor_branch_id = v_debtor_id,
    target_branch_name = v_target_name,
    amount = v_new_amount,
    currency = v_new_currency,
    notes = coalesce(p_notes, notes),
    status = CASE 
      WHEN v_debt.paid_amount >= v_new_amount THEN 'paid'::public.debt_status
      WHEN v_debt.paid_amount > 0 THEN 'partially_paid'::public.debt_status
      ELSE 'open'::public.debt_status
    END,
    updated_at = now()
  WHERE id = p_debt_id;

  PERFORM set_config('app.bypass_transfer_guard', 'off', true);

  -- Return updated debt object
  RETURN public.get_branch_debt(p_debt_id);
END;
$$;

-- 2. RPC: delete_branch_debt
CREATE OR REPLACE FUNCTION public.delete_branch_debt(
  p_debt_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_debt record;
BEGIN
  SELECT * INTO v_debt
  FROM public.branch_debts
  WHERE id = p_debt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Filial qarzdorligi topilmadi: %', p_debt_id USING errcode = 'P0002';
  END IF;

  -- Delete associated payments from debt_payments (fk has RESTRICT)
  DELETE FROM public.debt_payments
  WHERE debt_id = p_debt_id;

  -- Delete associated transfer links from branch_debt_transfers
  DELETE FROM public.branch_debt_transfers
  WHERE debt_id = p_debt_id;

  -- Bypass guard trigger and delete from branch_debts
  PERFORM set_config('app.bypass_transfer_guard', 'on', true);

  DELETE FROM public.branch_debts
  WHERE id = p_debt_id;

  PERFORM set_config('app.bypass_transfer_guard', 'off', true);

  RETURN jsonb_build_object(
    'success', true,
    'id', p_debt_id,
    'debt_no', v_debt.debt_no
  );
END;
$$;

-- 3. Permissions
GRANT EXECUTE ON FUNCTION public.update_branch_debt(uuid, uuid, text, numeric, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_branch_debt(uuid) TO authenticated, service_role;

-- 4. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
