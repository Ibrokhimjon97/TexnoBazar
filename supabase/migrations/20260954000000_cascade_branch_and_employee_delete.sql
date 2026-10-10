-- Migration: Full cascade branch & employee deletion while preserving report & debt archives for admin
-- 1. Drop NOT NULL on historical reference columns so they gracefully unlink on delete
-- 2. Allow transfer guard bypass during admin cleanup
-- 3. Implement full delete_branch and delete_employee functions

-- Sales & Returns
ALTER TABLE sales ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_branch_id_fkey;
ALTER TABLE sales ADD CONSTRAINT sales_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE sale_returns ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE sale_returns DROP CONSTRAINT IF EXISTS sale_returns_branch_id_fkey;
ALTER TABLE sale_returns ADD CONSTRAINT sale_returns_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

-- Stock receipts
ALTER TABLE stock_receipts ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE stock_receipts ALTER COLUMN receiving_location_id DROP NOT NULL;
ALTER TABLE stock_receipts DROP CONSTRAINT IF EXISTS stock_receipts_branch_id_fkey;
ALTER TABLE stock_receipts ADD CONSTRAINT stock_receipts_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE stock_receipts DROP CONSTRAINT IF EXISTS stock_receipts_receiving_location_id_fkey;
ALTER TABLE stock_receipts ADD CONSTRAINT stock_receipts_receiving_location_id_fkey FOREIGN KEY (receiving_location_id) REFERENCES locations(id) ON DELETE SET NULL;

-- Transfers
ALTER TABLE transfers ALTER COLUMN from_branch_id DROP NOT NULL;
ALTER TABLE transfers ALTER COLUMN to_branch_id DROP NOT NULL;
ALTER TABLE transfers ALTER COLUMN from_location_id DROP NOT NULL;
ALTER TABLE transfers ALTER COLUMN to_location_id DROP NOT NULL;
ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_from_branch_id_fkey;
ALTER TABLE transfers ADD CONSTRAINT transfers_from_branch_id_fkey FOREIGN KEY (from_branch_id) REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_to_branch_id_fkey;
ALTER TABLE transfers ADD CONSTRAINT transfers_to_branch_id_fkey FOREIGN KEY (to_branch_id) REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_from_location_id_fkey;
ALTER TABLE transfers ADD CONSTRAINT transfers_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES locations(id) ON DELETE SET NULL;
ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_to_location_id_fkey;
ALTER TABLE transfers ADD CONSTRAINT transfers_to_location_id_fkey FOREIGN KEY (to_location_id) REFERENCES locations(id) ON DELETE SET NULL;

-- Branch debts
ALTER TABLE branch_debts ALTER COLUMN debtor_branch_id DROP NOT NULL;
ALTER TABLE branch_debts ALTER COLUMN creditor_branch_id DROP NOT NULL;
ALTER TABLE branch_debts DROP CONSTRAINT IF EXISTS branch_debts_debtor_branch_id_fkey;
ALTER TABLE branch_debts ADD CONSTRAINT branch_debts_debtor_branch_id_fkey FOREIGN KEY (debtor_branch_id) REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE branch_debts DROP CONSTRAINT IF EXISTS branch_debts_creditor_branch_id_fkey;
ALTER TABLE branch_debts ADD CONSTRAINT branch_debts_creditor_branch_id_fkey FOREIGN KEY (creditor_branch_id) REFERENCES branches(id) ON DELETE SET NULL;

-- Other operations
ALTER TABLE repair_orders ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE repair_orders DROP CONSTRAINT IF EXISTS repair_orders_branch_id_fkey;
ALTER TABLE repair_orders ADD CONSTRAINT repair_orders_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE exchange_transactions ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE exchange_transactions DROP CONSTRAINT IF EXISTS exchange_transactions_branch_id_fkey;
ALTER TABLE exchange_transactions ADD CONSTRAINT exchange_transactions_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE business_corrections ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE business_corrections DROP CONSTRAINT IF EXISTS business_corrections_branch_id_fkey;
ALTER TABLE business_corrections ADD CONSTRAINT business_corrections_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE supplier_payments ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE supplier_payments DROP CONSTRAINT IF EXISTS supplier_payments_branch_id_fkey;
ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE supplier_returns ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE supplier_returns DROP CONSTRAINT IF EXISTS supplier_returns_branch_id_fkey;
ALTER TABLE supplier_returns ADD CONSTRAINT supplier_returns_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE delivery_attempts ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE delivery_attempts DROP CONSTRAINT IF EXISTS delivery_attempts_branch_id_fkey;
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE courier_cash_handovers ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE courier_cash_handovers DROP CONSTRAINT IF EXISTS courier_cash_handovers_branch_id_fkey;
ALTER TABLE courier_cash_handovers ADD CONSTRAINT courier_cash_handovers_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE pos_pending_sales ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE pos_pending_sales ALTER COLUMN store_location_id DROP NOT NULL;
ALTER TABLE pos_pending_sales DROP CONSTRAINT IF EXISTS pos_pending_sales_branch_id_fkey;
ALTER TABLE pos_pending_sales ADD CONSTRAINT pos_pending_sales_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;
ALTER TABLE pos_pending_sales DROP CONSTRAINT IF EXISTS pos_pending_sales_store_location_id_fkey;
ALTER TABLE pos_pending_sales ADD CONSTRAINT pos_pending_sales_store_location_id_fkey FOREIGN KEY (store_location_id) REFERENCES locations(id) ON DELETE CASCADE;

ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_branch_id_fkey;
ALTER TABLE expenses ADD CONSTRAINT expenses_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE salary_payments DROP CONSTRAINT IF EXISTS salary_payments_branch_id_fkey;
ALTER TABLE salary_payments ADD CONSTRAINT salary_payments_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE finance_transactions DROP CONSTRAINT IF EXISTS finance_transactions_branch_id_fkey;
ALTER TABLE finance_transactions ADD CONSTRAINT finance_transactions_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE finance_accounts DROP CONSTRAINT IF EXISTS finance_accounts_branch_id_fkey;
ALTER TABLE finance_accounts ADD CONSTRAINT finance_accounts_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_branch_id_fkey;
ALTER TABLE orders ADD CONSTRAINT orders_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;

-- Allow transfer guard bypass during admin branch cleanup
CREATE OR REPLACE FUNCTION public.guard_branch_transfer_data()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_old jsonb:=to_jsonb(old); v_new jsonb:=to_jsonb(new);
begin
  if current_setting('app.bypass_transfer_guard', true) = 'on' then
    return coalesce(new, old);
  end if;

  if tg_table_name='transfers' and (v_old->>'transfer_no' is distinct from v_new->>'transfer_no'
    or v_old->>'from_location_id' is distinct from v_new->>'from_location_id' or v_old->>'to_location_id' is distinct from v_new->>'to_location_id'
    or v_old->>'from_branch_id' is distinct from v_new->>'from_branch_id' or v_old->>'to_branch_id' is distinct from v_new->>'to_branch_id'
    or v_old->>'currency' is distinct from v_new->>'currency' or v_old->>'total_amount' is distinct from v_new->>'total_amount'
    or v_old->>'idempotency_key' is distinct from v_new->>'idempotency_key' or v_old->>'request_hash' is distinct from v_new->>'request_hash'
    or v_old->>'created_by' is distinct from v_new->>'created_by') then
    raise exception 'Transferning asosiy ma’lumotlarini o‘zgartirib bo‘lmaydi' using errcode='55000';
  elsif tg_table_name='transfer_lines' and (tg_op='DELETE' or v_old->>'transfer_id' is distinct from v_new->>'transfer_id'
    or v_old->>'product_id' is distinct from v_new->>'product_id' or v_old->>'unit_id' is distinct from v_new->>'unit_id'
    or v_old->>'quantity' is distinct from v_new->>'quantity' or v_old->>'unit_price' is distinct from v_new->>'unit_price') then
    raise exception 'Transfer qatorlari o‘zgarmas' using errcode='55000';
  elsif tg_table_name='branch_debts' and (v_old->>'debtor_branch_id' is distinct from v_new->>'debtor_branch_id'
    or v_old->>'creditor_branch_id' is distinct from v_new->>'creditor_branch_id' or v_old->>'transfer_id' is distinct from v_new->>'transfer_id'
    or v_old->>'amount' is distinct from v_new->>'amount' or v_old->>'currency' is distinct from v_new->>'currency') then
    raise exception 'Qarzning asosiy ma’lumotlarini o‘zgartirib bo‘lmaydi' using errcode='55000';
  end if;
  return coalesce(new,old);
end $function$;

-- Redefine delete_branch RPC to completely delete branch while preserving archives
CREATE OR REPLACE FUNCTION delete_branch(p_branch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch_name text;
  v_loc_ids uuid[];
BEGIN
  -- Admin check
  IF auth.uid() IS NOT NULL AND NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null) OR 
    public.is_any_manager()
  ) THEN
    RAISE EXCEPTION 'Faqat administrator filialni o‘chira oladi.' USING errcode = '42501';
  END IF;

  SELECT name INTO v_branch_name FROM branches WHERE id = p_branch_id;
  IF v_branch_name IS NULL THEN
    RAISE EXCEPTION 'Filial topilmadi.';
  END IF;

  -- Bypass transfer immutability guard during administrative deletion
  PERFORM set_config('app.bypass_transfer_guard', 'on', true);

  -- 1. Find all locations of this branch
  SELECT array_agg(id) INTO v_loc_ids FROM locations WHERE branch_id = p_branch_id;

  -- 2. Clean up active inventory belonging to this branch's locations
  IF v_loc_ids IS NOT NULL AND array_length(v_loc_ids, 1) > 0 THEN
    DELETE FROM inventory_movements WHERE from_location_id = ANY(v_loc_ids) OR to_location_id = ANY(v_loc_ids);
    DELETE FROM inventory_units WHERE location_id = ANY(v_loc_ids);
    DELETE FROM stock_batches WHERE location_id = ANY(v_loc_ids);
    DELETE FROM inventory_balances WHERE location_id = ANY(v_loc_ids);
    DELETE FROM inventory_counts WHERE location_id = ANY(v_loc_ids);
    DELETE FROM writeoffs WHERE location_id = ANY(v_loc_ids);
    DELETE FROM pos_pending_sales WHERE store_location_id = ANY(v_loc_ids);
    UPDATE transfers SET from_location_id = NULL WHERE from_location_id = ANY(v_loc_ids);
    UPDATE transfers SET to_location_id = NULL WHERE to_location_id = ANY(v_loc_ids);
    UPDATE stock_receipts SET receiving_location_id = NULL WHERE receiving_location_id = ANY(v_loc_ids);
    DELETE FROM locations WHERE id = ANY(v_loc_ids);
  END IF;

  -- 3. Disconnect branch_id on historical records so reports and debts are preserved for admin
  UPDATE sales SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE sale_returns SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE stock_receipts SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE transfers SET from_branch_id = NULL WHERE from_branch_id = p_branch_id;
  UPDATE transfers SET to_branch_id = NULL WHERE to_branch_id = p_branch_id;
  UPDATE expenses SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE salary_payments SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE finance_transactions SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE finance_accounts SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE orders SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE payroll_runs SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE branch_debts SET debtor_branch_id = NULL WHERE debtor_branch_id = p_branch_id;
  UPDATE branch_debts SET creditor_branch_id = NULL WHERE creditor_branch_id = p_branch_id;
  UPDATE repair_orders SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE exchange_transactions SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE business_corrections SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE supplier_payments SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE supplier_returns SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE delivery_attempts SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE courier_cash_handovers SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE employee_attendance SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE ai_conversations SET branch_scope = NULL WHERE branch_scope = p_branch_id;

  -- 4. Clean up active roles & connections for this branch
  DELETE FROM pos_pending_sales WHERE branch_id = p_branch_id;
  DELETE FROM profile_roles WHERE branch_id = p_branch_id;
  DELETE FROM telegram_chat_links WHERE branch_id = p_branch_id;

  -- 5. Delete the branch itself
  DELETE FROM branches WHERE id = p_branch_id;

  RETURN jsonb_build_object('success', true, 'message', 'Filial va unga tegishli barcha ma’lumotlar o‘chirildi. Hisobot va qarz ma’lumotlari arxivda saqlandi.');
END;
$$;

GRANT EXECUTE ON FUNCTION delete_branch(uuid) TO authenticated, service_role, anon;

-- Redefine delete_employee RPC to cleanly remove employee while keeping past sales & attendance in report archive
CREATE OR REPLACE FUNCTION delete_employee(p_employee_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
BEGIN
  -- Superadmin check
  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat superadmin xodimlarni o‘chira oladi.' USING errcode = '42501';
  END IF;

  IF v_caller_id IS NOT NULL AND v_caller_id = p_employee_id THEN
    RAISE EXCEPTION 'O‘zingizning profilingizni o‘chira olmaysiz.';
  END IF;

  -- 1. Remove active roles & logins
  DELETE FROM public.profile_roles WHERE profile_id = p_employee_id;
  DELETE FROM public.telegram_chat_links WHERE profile_id = p_employee_id;
  
  -- 2. Deactivate profile (archive for reports)
  UPDATE public.profiles SET is_active = false WHERE id = p_employee_id;

  -- 3. Delete auth.users user so they can never log in
  BEGIN
    DELETE FROM auth.users WHERE id = p_employee_id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE auth.users SET banned_until = '2099-01-01 00:00:00+00' WHERE id = p_employee_id;
  END;

  -- 4. Try hard delete profile if no foreign keys reference it
  BEGIN
    DELETE FROM public.profiles WHERE id = p_employee_id;
  EXCEPTION WHEN foreign_key_violation THEN
    -- Historical records (sales, receipts, attendance) are preserved in reports archive!
    NULL;
  END;

  RETURN jsonb_build_object('success', true, 'message', 'Xodim o‘chirildi va uning amallari hisobot arxivida saqlandi');
END;
$$;

GRANT EXECUTE ON FUNCTION delete_employee(uuid) TO authenticated, service_role, anon;
