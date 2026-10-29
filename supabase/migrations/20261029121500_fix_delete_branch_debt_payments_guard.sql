-- Migration: 20261029121500_fix_delete_branch_debt_payments_guard.sql
-- Description: Allow bypassing guard_transfer_debt_payment when deleting a branch debt with existing payments.

BEGIN;

-- 1. Update guard_transfer_debt_payment to respect app.bypass_transfer_guard
CREATE OR REPLACE FUNCTION public.guard_transfer_debt_payment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  -- Respect bypass setting for authorized admin/manager operations
  IF current_setting('app.bypass_transfer_guard', true) = 'on' THEN
    RETURN coalesce(new, old);
  END IF;

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
END $function$;

-- 2. Update delete_branch_debt to enable bypass prior to deleting child payments
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

  -- Enable bypass before deleting payments, links, and debt
  PERFORM set_config('app.bypass_transfer_guard', 'on', true);

  -- Delete associated payments from debt_payments
  DELETE FROM public.debt_payments
  WHERE debt_id = p_debt_id;

  -- Delete associated transfer links from branch_debt_transfers
  DELETE FROM public.branch_debt_transfers
  WHERE debt_id = p_debt_id;

  -- Delete the branch debt
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

-- 3. Ensure permissions
GRANT EXECUTE ON FUNCTION public.delete_branch_debt(uuid) TO authenticated, service_role;

-- 4. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;
