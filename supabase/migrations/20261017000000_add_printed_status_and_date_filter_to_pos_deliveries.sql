-- ==============================================================================
-- Migration: 20261017000000_add_printed_status_and_date_filter_to_pos_deliveries.sql
-- Description:
--   1. Adds printed_at and printed_by columns to public.pos_deliveries.
--   2. Adds RPC mark_pos_deliveries_printed(p_delivery_ids uuid[]).
--   3. Updates list_pos_deliveries to support p_date filtering (by local date),
--      enhanced p_query search (including product names and QR codes inside items),
--      and includes printed_at in returned fields.
-- ==============================================================================

-- 1. Add printed columns to pos_deliveries
ALTER TABLE public.pos_deliveries
  ADD COLUMN IF NOT EXISTS printed_at timestamptz,
  ADD COLUMN IF NOT EXISTS printed_by uuid REFERENCES public.profiles(id);

CREATE INDEX IF NOT EXISTS idx_pos_deliveries_printed_at ON public.pos_deliveries(printed_at);
CREATE INDEX IF NOT EXISTS idx_pos_deliveries_created_date ON public.pos_deliveries(((created_at AT TIME ZONE 'Asia/Tashkent')::date));

-- 2. RPC to mark deliveries as printed
CREATE OR REPLACE FUNCTION public.mark_pos_deliveries_printed(p_delivery_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.current_user_active() THEN
    RAISE EXCEPTION 'Foydalanuvchi faol emas' USING errcode = '42501';
  END IF;

  UPDATE public.pos_deliveries
  SET printed_at = now(),
      printed_by = auth.uid(),
      updated_at = now()
  WHERE id = ANY(p_delivery_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'count', v_count, 'printed_at', now());
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_pos_deliveries_printed(uuid[]) TO authenticated, service_role;

-- 3. Drop old 5-arg list_pos_deliveries if present to avoid overload collision
DROP FUNCTION IF EXISTS public.list_pos_deliveries(uuid, text, text, integer, integer);

-- 4. Update list_pos_deliveries with p_date and deep item search
CREATE OR REPLACE FUNCTION public.list_pos_deliveries(
  p_branch_id uuid,
  p_status text DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_items jsonb;
  v_total integer;
  v_pending_count integer;
  v_in_transit_count integer;
  v_delivered_count integer;
  v_cod_pending_count integer;
  v_cod_pending_amount numeric;
BEGIN
  IF NOT public.current_user_active() OR NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager','seller']::public.app_role[], p_branch_id)
  ) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  -- Summary counts (filtered by date if provided, matching user's selected day)
  SELECT
    count(*) FILTER (WHERE delivery_status = 'pending'),
    count(*) FILTER (WHERE delivery_status = 'in_transit'),
    count(*) FILTER (WHERE delivery_status = 'delivered'),
    count(*) FILTER (WHERE payment_status = 'pending_courier'),
    coalesce(sum(cod_amount) FILTER (WHERE payment_status = 'pending_courier'), 0)
  INTO
    v_pending_count, v_in_transit_count, v_delivered_count, v_cod_pending_count, v_cod_pending_amount
  FROM public.pos_deliveries
  WHERE branch_id = p_branch_id
    AND (p_date IS NULL OR (created_at AT TIME ZONE 'Asia/Tashkent')::date = p_date);

  -- Filtered total
  SELECT count(*) INTO v_total
  FROM public.pos_deliveries d
  LEFT JOIN public.sales s ON s.id = d.sale_id
  LEFT JOIN public.pos_pending_sales ps ON ps.id = d.pending_sale_id
  LEFT JOIN public.profiles seller_s ON seller_s.id = s.seller_id
  LEFT JOIN public.profiles seller_ps ON seller_ps.id = ps.seller_id
  WHERE d.branch_id = p_branch_id
    AND (p_date IS NULL OR (d.created_at AT TIME ZONE 'Asia/Tashkent')::date = p_date)
    AND (p_status IS NULL OR p_status = '' OR p_status = 'all' OR d.delivery_status = p_status)
    AND (p_query IS NULL OR p_query = '' OR (
      d.delivery_no ILIKE '%' || p_query || '%'
      OR d.customer_name ILIKE '%' || p_query || '%'
      OR d.customer_phone ILIKE '%' || p_query || '%'
      OR d.delivery_address ILIKE '%' || p_query || '%'
      OR coalesce(seller_s.full_name, seller_ps.full_name, '') ILIKE '%' || p_query || '%'
      OR coalesce(s.sale_no, '') ILIKE '%' || p_query || '%'
      OR d.items::text ILIKE '%' || p_query || '%'
    ));

  -- Filtered items with seller_name and printed status
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      d.*,
      s.sale_no,
      p.full_name AS courier_display_name,
      p.phone AS courier_display_phone,
      coalesce(
        seller_s.full_name,
        seller_ps.full_name,
        'Sotuvchi'
      ) AS seller_name
    FROM public.pos_deliveries d
    LEFT JOIN public.sales s ON s.id = d.sale_id
    LEFT JOIN public.pos_pending_sales ps ON ps.id = d.pending_sale_id
    LEFT JOIN public.profiles seller_s ON seller_s.id = s.seller_id
    LEFT JOIN public.profiles seller_ps ON seller_ps.id = ps.seller_id
    LEFT JOIN public.profiles p ON p.id = d.courier_id
    WHERE d.branch_id = p_branch_id
      AND (p_date IS NULL OR (d.created_at AT TIME ZONE 'Asia/Tashkent')::date = p_date)
      AND (p_status IS NULL OR p_status = '' OR p_status = 'all' OR d.delivery_status = p_status)
      AND (p_query IS NULL OR p_query = '' OR (
        d.delivery_no ILIKE '%' || p_query || '%'
        OR d.customer_name ILIKE '%' || p_query || '%'
        OR d.customer_phone ILIKE '%' || p_query || '%'
        OR d.delivery_address ILIKE '%' || p_query || '%'
        OR coalesce(seller_s.full_name, seller_ps.full_name, '') ILIKE '%' || p_query || '%'
        OR coalesce(s.sale_no, '') ILIKE '%' || p_query || '%'
        OR d.items::text ILIKE '%' || p_query || '%'
      ))
    ORDER BY d.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) q;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'summary', jsonb_build_object(
      'pending_count', coalesce(v_pending_count, 0),
      'in_transit_count', coalesce(v_in_transit_count, 0),
      'delivered_count', coalesce(v_delivered_count, 0),
      'cod_pending_count', coalesce(v_cod_pending_count, 0),
      'cod_pending_amount', coalesce(v_cod_pending_amount, 0)
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_pos_deliveries(uuid, text, text, integer, integer, date) TO authenticated, service_role;
