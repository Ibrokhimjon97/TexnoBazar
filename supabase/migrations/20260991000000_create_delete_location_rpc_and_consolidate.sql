-- Migration: Create safe delete_location RPC and consolidate Asosiy ombor into Asosiy do'kon
-- 1. Create delete_location function
CREATE OR REPLACE FUNCTION public.delete_location(
  p_location_id uuid,
  p_target_location_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_branch_id uuid;
  v_location_name text;
  v_location_type text;
  v_target_id uuid := p_target_location_id;
  v_target_name text;
  v_batches_count integer := 0;
  v_units_count integer := 0;
  v_movements_count integer := 0;
  r RECORD;
BEGIN
  -- Permission check
  IF auth.uid() IS NOT NULL AND auth.role() <> 'service_role' AND current_user <> 'postgres' AND session_user <> 'postgres' AND NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null) OR
    public.is_any_manager()
  ) THEN
    RAISE EXCEPTION 'Faqat administrator yoki menejer joylashuvni o‘chira oladi.' USING errcode = '42501';
  END IF;

  -- 1. Find source location
  SELECT branch_id, name, type INTO v_branch_id, v_location_name, v_location_type
  FROM public.locations
  WHERE id = p_location_id;

  IF v_location_name IS NULL THEN
    RAISE EXCEPTION 'Joylashuv topilmadi.' USING errcode = 'P0002';
  END IF;

  -- 2. Resolve target location if not specified
  IF v_target_id IS NULL THEN
    SELECT id, name INTO v_target_id, v_target_name
    FROM public.locations
    WHERE branch_id = v_branch_id
      AND id <> p_location_id
      AND is_active = true
    ORDER BY (type = 'store') DESC, created_at ASC
    LIMIT 1;
  ELSE
    SELECT name INTO v_target_name
    FROM public.locations
    WHERE id = v_target_id
      AND id <> p_location_id;
    IF v_target_name IS NULL THEN
      RAISE EXCEPTION 'Tanlangan maqsad joylashuvi topilmadi yoki yaroqsiz.' USING errcode = '22023';
    END IF;
  END IF;

  -- 3. If there is a target location, migrate all records to it
  IF v_target_id IS NOT NULL THEN
    -- Bypass transfer guard during administrative location merge/deletion
    PERFORM set_config('app.bypass_transfer_guard', 'on', true);

    -- Stock batches
    UPDATE public.stock_batches
    SET location_id = v_target_id
    WHERE location_id = p_location_id;
    GET DIAGNOSTICS v_batches_count = ROW_COUNT;

    -- Inventory units
    UPDATE public.inventory_units
    SET location_id = v_target_id
    WHERE location_id = p_location_id;
    GET DIAGNOSTICS v_units_count = ROW_COUNT;

    -- Inventory movements
    UPDATE public.inventory_movements
    SET from_location_id = v_target_id
    WHERE from_location_id = p_location_id;

    UPDATE public.inventory_movements
    SET to_location_id = v_target_id
    WHERE to_location_id = p_location_id;
    GET DIAGNOSTICS v_movements_count = ROW_COUNT;

    -- Transfers
    UPDATE public.transfers
    SET from_location_id = CASE WHEN to_location_id = v_target_id THEN NULL ELSE v_target_id END
    WHERE from_location_id = p_location_id;

    UPDATE public.transfers
    SET to_location_id = CASE WHEN from_location_id = v_target_id THEN NULL ELSE v_target_id END
    WHERE to_location_id = p_location_id;

    -- Stock receipts
    UPDATE public.stock_receipts
    SET receiving_location_id = v_target_id
    WHERE receiving_location_id = p_location_id;

    -- Inventory counts
    UPDATE public.inventory_counts
    SET location_id = v_target_id
    WHERE location_id = p_location_id;

    -- Writeoffs
    UPDATE public.writeoffs
    SET location_id = v_target_id
    WHERE location_id = p_location_id;

    -- Repair orders
    UPDATE public.repair_orders
    SET source_location_id = v_target_id
    WHERE source_location_id = p_location_id;

    UPDATE public.repair_orders
    SET repair_location_id = v_target_id
    WHERE repair_location_id = p_location_id;

    UPDATE public.repair_orders
    SET destination_location_id = v_target_id
    WHERE destination_location_id = p_location_id;

    -- Supplier returns
    UPDATE public.supplier_returns
    SET from_location_id = v_target_id
    WHERE from_location_id = p_location_id;

    -- POS pending sales
    UPDATE public.pos_pending_sales
    SET store_location_id = v_target_id
    WHERE store_location_id = p_location_id;

    -- Balances
    DELETE FROM public.inventory_balances
    WHERE location_id = p_location_id;

    -- Refresh balances for moved products in target location
    FOR r IN (
      SELECT DISTINCT product_id
      FROM public.inventory_units
      WHERE location_id = v_target_id
    ) LOOP
      PERFORM public.refresh_inventory_balance(v_target_id, r.product_id);
    END LOOP;
  ELSE
    -- No target location exists in this branch. Check if any data exists:
    IF EXISTS (SELECT 1 FROM public.stock_batches WHERE location_id = p_location_id)
       OR EXISTS (SELECT 1 FROM public.inventory_units WHERE location_id = p_location_id) THEN
      RAISE EXCEPTION 'Ushbu joylashuvda tovarlar mavjud. Filialda boshqa joylashuv yo‘qligi sababli uni o‘chirib bo‘lmaydi. Avval yangi joy yarating.' USING errcode = '23503';
    END IF;
  END IF;

  -- 4. Delete the location
  DELETE FROM public.locations WHERE id = p_location_id;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_location_id', p_location_id,
    'deleted_location_name', v_location_name,
    'target_location_id', v_target_id,
    'target_location_name', v_target_name,
    'batches_moved', v_batches_count,
    'units_moved', v_units_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_location(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_location(uuid, uuid) TO service_role;

-- 2. Execute deletion/consolidation of Asosiy ombor into Asosiy do'kon immediately
DO $$
DECLARE
  v_wh_id uuid;
  v_res jsonb;
BEGIN
  SELECT id INTO v_wh_id
  FROM public.locations
  WHERE type = 'warehouse'
    AND name ILIKE '%ombor%'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_wh_id IS NOT NULL THEN
    v_res := public.delete_location(v_wh_id);
    RAISE NOTICE 'Consolidated and deleted warehouse: %', v_res;
  END IF;
END $$;
