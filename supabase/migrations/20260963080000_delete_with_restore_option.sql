-- Migration: 20260963080000_delete_with_restore_option.sql
-- Adds p_restore_stock parameter to delete_pos_pending_sale so callers can choose
-- whether to return stock to warehouse (normal delete) or just purge the record (test delete).

-- 1. Recreate delete_pos_pending_sale with p_restore_stock parameter
CREATE OR REPLACE FUNCTION public.delete_pos_pending_sale(p_pending_id uuid, p_restore_stock boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_pending public.pos_pending_sales%rowtype;
  v_sale_id uuid;
  v_x record;
BEGIN
  SELECT * INTO v_pending FROM public.pos_pending_sales WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kassa so''rovi topilmadi.' USING errcode = 'P0002';
  END IF;

  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin', 'admin', 'manager']::public.app_role[], null)
    OR (v_pending.branch_id IS NOT NULL AND public.has_role(array['manager']::public.app_role[], v_pending.branch_id))
    OR public.has_role(array['manager']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat administrator yoki menejer kassa so''rovini o''chira oladi.' USING errcode = '42501';
  END IF;

  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

  -- Check if finalized into a sale
  SELECT id INTO v_sale_id FROM public.sales WHERE pending_sale_id = p_pending_id LIMIT 1;

  IF v_sale_id IS NOT NULL THEN
    -- Call delete_sale, passing through the restore_stock flag
    PERFORM public.delete_sale(v_sale_id, p_restore_stock);
  ELSE
    IF p_restore_stock THEN
      -- Restore reserved units back to available
      UPDATE public.inventory_units
      SET status = 'available', reserved_until = NULL, version = version + 1
      WHERE id IN (
        SELECT unit_id FROM public.pos_pending_sale_lines WHERE pending_sale_id = p_pending_id
      ) AND status = 'reserved';
    END IF;

    -- Remove pos pending lines, payments, and record
    DELETE FROM public.pos_pending_sale_payments WHERE pending_sale_id = p_pending_id;
    DELETE FROM public.pos_pending_sale_lines WHERE pending_sale_id = p_pending_id;
    DELETE FROM public.pos_pending_sales WHERE id = p_pending_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 
    'message', 
    CASE WHEN p_restore_stock 
      THEN 'Kassa kirimi o''chirildi va tovar omborga qaytarildi.'
      ELSE 'Kassa kirimi butunlay o''chirildi (tovar omborga qaytarilmadi).'
    END
  );
END;
$$;

-- Grant for the new signature (uuid, boolean)
GRANT EXECUTE ON FUNCTION public.delete_pos_pending_sale(uuid, boolean) TO authenticated, service_role;
