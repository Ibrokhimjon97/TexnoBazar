-- Safe delete branch migration:
-- 1. Updates locations.branch_id foreign key constraint to ON DELETE CASCADE
-- 2. Adds delete_branch RPC to validate and safely remove branch if no active inventory/sales/transfers exist

ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_branch_id_fkey;
ALTER TABLE locations ADD CONSTRAINT locations_branch_id_fkey 
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION delete_branch(p_branch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit_count int;
  v_sales_count int;
  v_receipts_count int;
  v_expenses_count int;
  v_fin_count int;
  v_transfer_count int;
  v_debt_count int;
  v_branch_name text;
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

  -- 1. Check inventory units
  SELECT count(*) INTO v_unit_count 
  FROM inventory_units u 
  JOIN locations l ON u.location_id = l.id 
  WHERE l.branch_id = p_branch_id;
  
  IF v_unit_count > 0 THEN
    RAISE EXCEPTION '"%" filialida % ta tovar mavjud. Filialni o‘chirishdan oldin tovarlarni boshqa filialga o‘tkazing yoki hisobdan chiqaring.', v_branch_name, v_unit_count;
  END IF;

  -- 2. Check stock batches
  SELECT count(*) INTO v_unit_count 
  FROM stock_batches b 
  JOIN locations l ON b.location_id = l.id 
  WHERE l.branch_id = p_branch_id;
  
  IF v_unit_count > 0 THEN
    RAISE EXCEPTION '"%" filialida tovar partiyalari mavjud.', v_branch_name;
  END IF;

  -- 3. Check sales
  SELECT count(*) INTO v_sales_count FROM sales WHERE branch_id = p_branch_id;
  IF v_sales_count > 0 THEN
    RAISE EXCEPTION '"%" filialida % ta savdo amaliyoti mavjud. Tarixiy ma’lumotlarni saqlash maqsadida ushbu filialni butunlay o‘chirib bo‘lmaydi. Uni nofaol (is_active: false) qilib qo‘yishingiz mumkin.', v_branch_name, v_sales_count;
  END IF;

  -- 4. Check stock receipts
  SELECT count(*) INTO v_receipts_count FROM stock_receipts WHERE branch_id = p_branch_id;
  IF v_receipts_count > 0 THEN
    RAISE EXCEPTION '"%" filialida partiya qabullari mavjud. Tarixni saqlash uchun filialni nofaol qilib qo‘ying.', v_branch_name;
  END IF;

  -- 5. Check expenses / salary
  SELECT count(*) INTO v_expenses_count FROM expenses WHERE branch_id = p_branch_id;
  IF v_expenses_count > 0 THEN
    RAISE EXCEPTION '"%" filialida harajatlar mavjud. Filialni nofaol qilib qo‘ying.', v_branch_name;
  END IF;

  -- 6. Check finance transactions
  SELECT count(*) INTO v_fin_count FROM finance_transactions WHERE branch_id = p_branch_id;
  IF v_fin_count > 0 THEN
    RAISE EXCEPTION '"%" filialida moliya operatsiyalari mavjud. Filialni nofaol qilib qo‘ying.', v_branch_name;
  END IF;

  -- 7. Check transfers
  SELECT count(*) INTO v_transfer_count 
  FROM transfers t 
  WHERE t.from_branch_id = p_branch_id OR t.to_branch_id = p_branch_id;
  
  IF v_transfer_count > 0 THEN
    RAISE EXCEPTION '"%" filialida % ta tovar o‘tkazmasi mavjud. Filialni o‘chirish o‘rniga nofaol (is_active: false) qilib qo‘yishingiz mumkin.', v_branch_name, v_transfer_count;
  END IF;

  -- 8. Check branch debts
  SELECT count(*) INTO v_debt_count 
  FROM branch_debts 
  WHERE debtor_branch_id = p_branch_id OR creditor_branch_id = p_branch_id;
  
  IF v_debt_count > 0 THEN
    RAISE EXCEPTION '"%" filialida qarz yozuvlari mavjud. Filialni nofaol qilib qo‘ying.', v_branch_name;
  END IF;

  -- Clean up safe references
  DELETE FROM pos_pending_sales WHERE branch_id = p_branch_id;
  DELETE FROM profile_roles WHERE branch_id = p_branch_id;
  DELETE FROM telegram_chat_links WHERE branch_id = p_branch_id;
  UPDATE employee_attendance SET branch_id = NULL WHERE branch_id = p_branch_id;
  UPDATE ai_conversations SET branch_scope = NULL WHERE branch_scope = p_branch_id;

  -- Delete locations of this branch
  DELETE FROM locations WHERE branch_id = p_branch_id;

  -- Delete the branch itself
  DELETE FROM branches WHERE id = p_branch_id;

  RETURN jsonb_build_object('success', true, 'message', 'Filial muvaffaqiyatli o‘chirildi');
END;
$$;

GRANT EXECUTE ON FUNCTION delete_branch(uuid) TO authenticated, service_role, anon;
