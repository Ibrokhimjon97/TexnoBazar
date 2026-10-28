-- Migration: Include seller_name in list_pos_deliveries for Manager Delivery Workspace
CREATE OR REPLACE FUNCTION public.list_pos_deliveries(
  p_branch_id uuid,
  p_status text DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
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

  -- Summary counts
  SELECT
    count(*) FILTER (WHERE delivery_status = 'pending'),
    count(*) FILTER (WHERE delivery_status = 'in_transit'),
    count(*) FILTER (WHERE delivery_status = 'delivered'),
    count(*) FILTER (WHERE payment_status = 'pending_courier'),
    coalesce(sum(cod_amount) FILTER (WHERE payment_status = 'pending_courier'), 0)
  INTO
    v_pending_count, v_in_transit_count, v_delivered_count, v_cod_pending_count, v_cod_pending_amount
  FROM public.pos_deliveries
  WHERE branch_id = p_branch_id;

  -- Filtered total
  SELECT count(*) INTO v_total
  FROM public.pos_deliveries d
  LEFT JOIN public.sales s ON s.id = d.sale_id
  LEFT JOIN public.pos_pending_sales ps ON ps.id = d.pending_sale_id
  LEFT JOIN public.profiles seller_s ON seller_s.id = s.seller_id
  LEFT JOIN public.profiles seller_ps ON seller_ps.id = ps.seller_id
  WHERE d.branch_id = p_branch_id
    AND (p_status IS NULL OR p_status = '' OR p_status = 'all' OR d.delivery_status = p_status)
    AND (p_query IS NULL OR p_query = '' OR (
      d.delivery_no ILIKE '%' || p_query || '%'
      OR d.customer_name ILIKE '%' || p_query || '%'
      OR d.customer_phone ILIKE '%' || p_query || '%'
      OR d.delivery_address ILIKE '%' || p_query || '%'
      OR coalesce(seller_s.full_name, seller_ps.full_name, '') ILIKE '%' || p_query || '%'
    ));

  -- Filtered items with seller_name
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
      AND (p_status IS NULL OR p_status = '' OR p_status = 'all' OR d.delivery_status = p_status)
      AND (p_query IS NULL OR p_query = '' OR (
        d.delivery_no ILIKE '%' || p_query || '%'
        OR d.customer_name ILIKE '%' || p_query || '%'
        OR d.customer_phone ILIKE '%' || p_query || '%'
        OR d.delivery_address ILIKE '%' || p_query || '%'
        OR coalesce(seller_s.full_name, seller_ps.full_name, '') ILIKE '%' || p_query || '%'
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
