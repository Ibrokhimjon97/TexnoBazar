-- Migration: 20260970000000_fast_batch_delete_products_cascade.sql
-- 1. Fix delete_product_cascade foreign key ordering: product_variants must be deleted AFTER inventory_units and stock_batches.
-- 2. Optimize delete_products_cascade to perform set-based batch deletion instead of row-by-row loops with repetitive DDL trigger locks.

-- 1. Single product cascade delete
CREATE OR REPLACE FUNCTION public.delete_product_cascade(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (public.has_role(array['superadmin','admin']::public.app_role[], null) OR public.is_any_manager()) THEN
    RAISE EXCEPTION 'Mahsulotni o‘chirish uchun admin yoki menejer roli talab qilinadi' USING errcode = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id) THEN
    RETURN;
  END IF;

  -- 1. Immutable triggerlarni vaqtincha o'chirish
  BEGIN ALTER TABLE public.transfer_lines DISABLE TRIGGER transfer_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.order_reserved_units DISABLE TRIGGER order_reserved_units_guard; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.sale_lines DISABLE TRIGGER sale_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.pos_pending_sale_lines DISABLE TRIGGER pos_pending_sale_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.sale_return_lines DISABLE TRIGGER sale_return_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.supplier_return_lines DISABLE TRIGGER supplier_return_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.product_price_history DISABLE TRIGGER product_price_history_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;

  -- 2. Yordamchi jadvallar
  BEGIN DELETE FROM public.product_reviews WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.customer_favorites WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.customer_cart_items WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.cms_promotion_products WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.product_attribute_values WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.product_media WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.product_components WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 3. Buyurtma va rezervlar
  BEGIN DELETE FROM public.order_reserved_units WHERE order_line_id IN (SELECT id FROM public.order_lines WHERE product_id = p_product_id); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.order_reserved_units WHERE unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = p_product_id); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.order_lines WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 4. POS, sotuv va qaytarish
  BEGIN DELETE FROM public.pos_pending_sale_lines WHERE product_id = p_product_id OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = p_product_id); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sale_return_lines WHERE unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = p_product_id); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.supplier_return_lines WHERE product_id = p_product_id OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = p_product_id); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.repair_orders WHERE unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = p_product_id); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.writeoff_lines WHERE product_id = p_product_id OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = p_product_id); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.inventory_count_lines WHERE product_id = p_product_id OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = p_product_id); EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 5. Ombordagi harakatlar va transferlar
  BEGIN DELETE FROM public.inventory_movements WHERE product_id = p_product_id OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = p_product_id); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.transfer_lines WHERE product_id = p_product_id OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = p_product_id); EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 6. Inventory units va sotuv satrlari:
  BEGIN
    UPDATE public.inventory_units
    SET status = 'available', sold_sale_id = NULL, active_transfer_id = NULL
    WHERE product_id = p_product_id;
  EXCEPTION WHEN undefined_table THEN NULL; END;

  BEGIN DELETE FROM public.sale_lines WHERE product_id = p_product_id OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = p_product_id); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.inventory_units WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.stock_batches WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.product_price_history WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.inventory_balances WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 7. Variantlar: inventory_units va stock_batches o'chirilgandan so'ng xavfsiz o'chiriladi
  BEGIN DELETE FROM public.product_variants WHERE product_id = p_product_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 8. Mahsulotning o'zini o'chirish
  DELETE FROM public.products WHERE id = p_product_id;

  -- 9. Triggerlarni qayta yoqish
  BEGIN ALTER TABLE public.transfer_lines ENABLE TRIGGER transfer_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.order_reserved_units ENABLE TRIGGER order_reserved_units_guard; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.sale_lines ENABLE TRIGGER sale_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.pos_pending_sale_lines ENABLE TRIGGER pos_pending_sale_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.sale_return_lines ENABLE TRIGGER sale_return_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.supplier_return_lines ENABLE TRIGGER supplier_return_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.product_price_history ENABLE TRIGGER product_price_history_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;

EXCEPTION WHEN OTHERS THEN
  BEGIN ALTER TABLE public.transfer_lines ENABLE TRIGGER transfer_lines_immutable; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE public.order_reserved_units ENABLE TRIGGER order_reserved_units_guard; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE public.sale_lines ENABLE TRIGGER sale_lines_immutable; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE public.pos_pending_sale_lines ENABLE TRIGGER pos_pending_sale_lines_immutable; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE public.sale_return_lines ENABLE TRIGGER sale_return_lines_immutable; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE public.supplier_return_lines ENABLE TRIGGER supplier_return_lines_immutable; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE public.product_price_history ENABLE TRIGGER product_price_history_immutable; EXCEPTION WHEN OTHERS THEN NULL; END;
  RAISE;
END;
$$;

-- 2. Set-based bulk cascade delete
CREATE OR REPLACE FUNCTION public.delete_products_cascade(p_product_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF NOT (public.has_role(array['superadmin','admin']::public.app_role[], null) OR public.is_any_manager()) THEN
    RAISE EXCEPTION 'Mahsulotlarni o‘chirish uchun admin yoki menejer roli talab qilinadi' USING errcode = '42501';
  END IF;

  IF p_product_ids IS NULL OR array_length(p_product_ids, 1) IS NULL OR array_length(p_product_ids, 1) = 0 THEN
    RETURN jsonb_build_object('success', true, 'deleted_count', 0, 'errors', array[]::text[]);
  END IF;

  -- 1. Immutable triggerlarni vaqtincha bir marta o'chirish
  BEGIN ALTER TABLE public.transfer_lines DISABLE TRIGGER transfer_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.order_reserved_units DISABLE TRIGGER order_reserved_units_guard; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.sale_lines DISABLE TRIGGER sale_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.pos_pending_sale_lines DISABLE TRIGGER pos_pending_sale_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.sale_return_lines DISABLE TRIGGER sale_return_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.supplier_return_lines DISABLE TRIGGER supplier_return_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.product_price_history DISABLE TRIGGER product_price_history_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;

  -- 2. Bog'liq yordamchi jadvallarni set-based tozalash
  BEGIN DELETE FROM public.product_reviews WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.customer_favorites WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.customer_cart_items WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.cms_promotion_products WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.product_attribute_values WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.product_media WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.product_components WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 3. Buyurtma va rezervlar
  BEGIN DELETE FROM public.order_reserved_units WHERE order_line_id IN (SELECT id FROM public.order_lines WHERE product_id = ANY(p_product_ids)); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.order_reserved_units WHERE unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = ANY(p_product_ids)); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.order_lines WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 4. POS, sotuv va qaytarish
  BEGIN DELETE FROM public.pos_pending_sale_lines WHERE product_id = ANY(p_product_ids) OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = ANY(p_product_ids)); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sale_return_lines WHERE unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = ANY(p_product_ids)); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.supplier_return_lines WHERE product_id = ANY(p_product_ids) OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = ANY(p_product_ids)); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.repair_orders WHERE unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = ANY(p_product_ids)); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.writeoff_lines WHERE product_id = ANY(p_product_ids) OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = ANY(p_product_ids)); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.inventory_count_lines WHERE product_id = ANY(p_product_ids) OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = ANY(p_product_ids)); EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 5. Ombordagi harakatlar va transferlar
  BEGIN DELETE FROM public.inventory_movements WHERE product_id = ANY(p_product_ids) OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = ANY(p_product_ids)); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.transfer_lines WHERE product_id = ANY(p_product_ids) OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = ANY(p_product_ids)); EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 6. Inventory units va sotuv satrlari:
  BEGIN
    UPDATE public.inventory_units
    SET status = 'available', sold_sale_id = NULL, active_transfer_id = NULL
    WHERE product_id = ANY(p_product_ids);
  EXCEPTION WHEN undefined_table THEN NULL; END;

  BEGIN DELETE FROM public.sale_lines WHERE product_id = ANY(p_product_ids) OR unit_id IN (SELECT id FROM public.inventory_units WHERE product_id = ANY(p_product_ids)); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.inventory_units WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.stock_batches WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.product_price_history WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.inventory_balances WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 7. Variantlar: inventory_units va stock_batches o'chirilgandan so'ng xavfsiz o'chiriladi
  BEGIN DELETE FROM public.product_variants WHERE product_id = ANY(p_product_ids); EXCEPTION WHEN undefined_table THEN NULL; END;

  -- 8. Mahsulotlarning o'zini o'chirish
  DELETE FROM public.products WHERE id = ANY(p_product_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- 9. Triggerlarni qayta yoqish
  BEGIN ALTER TABLE public.transfer_lines ENABLE TRIGGER transfer_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.order_reserved_units ENABLE TRIGGER order_reserved_units_guard; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.sale_lines ENABLE TRIGGER sale_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.pos_pending_sale_lines ENABLE TRIGGER pos_pending_sale_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.sale_return_lines ENABLE TRIGGER sale_return_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.supplier_return_lines ENABLE TRIGGER supplier_return_lines_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;
  BEGIN ALTER TABLE public.product_price_history ENABLE TRIGGER product_price_history_immutable; EXCEPTION WHEN undefined_table OR undefined_object THEN NULL; END;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_count', v_count,
    'errors', array[]::text[]
  );

EXCEPTION WHEN OTHERS THEN
  BEGIN ALTER TABLE public.transfer_lines ENABLE TRIGGER transfer_lines_immutable; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE public.order_reserved_units ENABLE TRIGGER order_reserved_units_guard; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE public.sale_lines ENABLE TRIGGER sale_lines_immutable; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE public.pos_pending_sale_lines ENABLE TRIGGER pos_pending_sale_lines_immutable; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE public.sale_return_lines ENABLE TRIGGER sale_return_lines_immutable; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE public.supplier_return_lines ENABLE TRIGGER supplier_return_lines_immutable; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE public.product_price_history ENABLE TRIGGER product_price_history_immutable; EXCEPTION WHEN OTHERS THEN NULL; END;
  RAISE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_product_cascade(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_products_cascade(uuid[]) TO authenticated, service_role;
