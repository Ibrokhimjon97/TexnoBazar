-- Migration: Add cancel, delete, and edit functions for external branch transfers
-- Ensures that when a transfer is cancelled or deleted, all transferred inventory units
-- immediately return to 'available' status in the source store/warehouse.

BEGIN;

-- 1. RPC: cancel_external_branch_transfer
CREATE OR REPLACE FUNCTION public.cancel_external_branch_transfer(
  p_transfer_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_transfer record;
  v_all_unit_ids uuid[];
  v_actor_id uuid;
BEGIN
  IF p_transfer_id IS NULL THEN
    RAISE EXCEPTION 'Transfer ID ko‘rsatilmadi' USING errcode = '22023';
  END IF;

  SELECT * INTO v_transfer
  FROM public.external_branch_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF v_transfer.id IS NULL THEN
    RAISE EXCEPTION 'Transfer topilmadi: %', p_transfer_id USING errcode = 'P0002';
  END IF;

  IF v_transfer.status = 'cancelled' THEN
    RAISE EXCEPTION 'Ushbu transfer allaqachon bekor qilingan' USING errcode = '22023';
  END IF;

  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    v_actor_id := v_transfer.seller_id;
  END IF;

  -- Collect all unit IDs linked to this transfer
  SELECT array_agg(DISTINCT u_id) INTO v_all_unit_ids
  FROM (
    SELECT unnest(unit_ids) AS u_id
    FROM public.external_branch_transfer_lines
    WHERE transfer_id = p_transfer_id
    UNION
    SELECT id AS u_id
    FROM public.inventory_units
    WHERE external_transfer_id = p_transfer_id
  ) sub
  WHERE u_id IS NOT NULL;

  -- Restore units to 'available' in their location
  IF v_all_unit_ids IS NOT NULL AND cardinality(v_all_unit_ids) > 0 THEN
    UPDATE public.inventory_units
    SET status = 'available'::public.unit_status,
        external_transfer_id = NULL,
        active_transfer_id = NULL,
        updated_at = now()
    WHERE id = ANY(v_all_unit_ids);

    -- Log movement back into the store/warehouse
    INSERT INTO public.inventory_movements (
      unit_id, product_id, batch_id, movement_type,
      from_location_id, to_location_id, quantity, unit_cost,
      reference_type, reference_id, reason, actor_id, metadata
    )
    SELECT
      u.id, u.product_id, u.batch_id, 'transfer_in'::public.movement_type,
      NULL, v_transfer.from_location_id, 1, 0,
      'external_branch_transfer_cancel', p_transfer_id,
      'Filialga transfer bekor qilindi, tovar ombor/do‘konga qaytarildi' || coalesce(': ' || p_reason, ''),
      v_actor_id,
      jsonb_build_object(
        'transfer_no', v_transfer.transfer_no,
        'cancelled_at', now(),
        'reason', p_reason,
        'restored_to_location_id', v_transfer.from_location_id
      )
    FROM public.inventory_units u
    WHERE u.id = ANY(v_all_unit_ids);
  END IF;

  -- Update transfer status
  UPDATE public.external_branch_transfers
  SET status = 'cancelled',
      notes = CASE
        WHEN nullif(btrim(p_reason), '') IS NOT NULL THEN
          coalesce(notes || E'\n', '') || '[BEKOR QILINDI: ' || btrim(p_reason) || ']'
        ELSE
          coalesce(notes || E'\n', '') || '[BEKOR QILINDI: tovarlar ombor/do‘kon hisobiga qaytarildi]'
      END,
      updated_at = now()
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object(
    'success', true,
    'transfer_id', p_transfer_id,
    'transfer_no', v_transfer.transfer_no,
    'returned_units_count', coalesce(cardinality(v_all_unit_ids), 0)
  );
END;
$$;

-- 2. RPC: delete_external_branch_transfer
CREATE OR REPLACE FUNCTION public.delete_external_branch_transfer(
  p_transfer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_transfer record;
  v_all_unit_ids uuid[];
BEGIN
  IF p_transfer_id IS NULL THEN
    RAISE EXCEPTION 'Transfer ID ko‘rsatilmadi' USING errcode = '22023';
  END IF;

  SELECT * INTO v_transfer
  FROM public.external_branch_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF v_transfer.id IS NULL THEN
    RAISE EXCEPTION 'Transfer topilmadi: %', p_transfer_id USING errcode = 'P0002';
  END IF;

  -- Collect all unit IDs linked to this transfer
  SELECT array_agg(DISTINCT u_id) INTO v_all_unit_ids
  FROM (
    SELECT unnest(unit_ids) AS u_id
    FROM public.external_branch_transfer_lines
    WHERE transfer_id = p_transfer_id
    UNION
    SELECT id AS u_id
    FROM public.inventory_units
    WHERE external_transfer_id = p_transfer_id
  ) sub
  WHERE u_id IS NOT NULL;

  -- Restore units to 'available' if they were still transferred
  IF v_all_unit_ids IS NOT NULL AND cardinality(v_all_unit_ids) > 0 THEN
    UPDATE public.inventory_units
    SET status = 'available'::public.unit_status,
        external_transfer_id = NULL,
        active_transfer_id = NULL,
        updated_at = now()
    WHERE id = ANY(v_all_unit_ids);
  END IF;

  -- Delete child lines and header
  DELETE FROM public.external_branch_transfer_lines WHERE transfer_id = p_transfer_id;
  DELETE FROM public.external_branch_transfers WHERE id = p_transfer_id;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_transfer_id', p_transfer_id,
    'transfer_no', v_transfer.transfer_no,
    'restored_units_count', coalesce(cardinality(v_all_unit_ids), 0)
  );
END;
$$;

-- 3. RPC: update_external_branch_transfer
CREATE OR REPLACE FUNCTION public.update_external_branch_transfer(
  p_transfer_id uuid,
  p_target_branch_name text,
  p_target_manager_name text,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_transfer record;
BEGIN
  IF p_transfer_id IS NULL THEN
    RAISE EXCEPTION 'Transfer ID ko‘rsatilmadi' USING errcode = '22023';
  END IF;

  IF nullif(btrim(p_target_branch_name), '') IS NULL THEN
    RAISE EXCEPTION 'Filial nomini kiriting' USING errcode = '22023';
  END IF;

  IF nullif(btrim(p_target_manager_name), '') IS NULL THEN
    RAISE EXCEPTION 'Filial boshlig‘i ismini kiriting' USING errcode = '22023';
  END IF;

  UPDATE public.external_branch_transfers
  SET target_branch_name = btrim(p_target_branch_name),
      target_manager_name = btrim(p_target_manager_name),
      notes = nullif(btrim(p_notes), ''),
      updated_at = now()
  WHERE id = p_transfer_id
  RETURNING * INTO v_transfer;

  IF v_transfer.id IS NULL THEN
    RAISE EXCEPTION 'Transfer topilmadi: %', p_transfer_id USING errcode = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_transfer.id,
    'transfer_no', v_transfer.transfer_no,
    'target_branch_name', v_transfer.target_branch_name,
    'target_manager_name', v_transfer.target_manager_name,
    'notes', v_transfer.notes
  );
END;
$$;

COMMIT;
