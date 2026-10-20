-- Migration: Fix product media column in get_pos_pending_sale (url -> public_url) and reload PostgREST schema cache
CREATE OR REPLACE FUNCTION public.get_pos_pending_sale(p_pending_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_s public.pos_pending_sales%rowtype;
  v_result jsonb;
  v_manager boolean;
BEGIN
  SELECT * INTO v_s FROM public.pos_pending_sales WHERE id = p_pending_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS so‘rovi topilmadi' USING errcode = 'P0002';
  END IF;

  IF current_user IN ('postgres', 'service_role') OR (current_setting('request.jwt.claim.role', true) = 'service_role') THEN
    v_manager := true;
  ELSE
    v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
      OR public.has_role(array['manager']::public.app_role[], v_s.branch_id);

    IF NOT v_manager AND NOT (v_s.seller_id = auth.uid() AND public.has_role(array['seller']::public.app_role[], v_s.branch_id)) THEN
      RAISE EXCEPTION 'POS so‘rovi uchun ruxsat yo‘q' USING errcode = '42501';
    END IF;
  END IF;

  IF v_s.status = 'pending' AND v_s.expires_at <= now() THEN
    PERFORM public.release_pos_reservation(v_s.id, 'expired', 'Rezerv muddati tugadi', auth.uid());
  END IF;

  SELECT to_jsonb(s) || jsonb_build_object(
    'seller_name', seller.full_name,
    'location_name', loc.name,
    'customer', (
      SELECT jsonb_build_object('id', c.id, 'full_name', c.full_name, 'phone', c.phone, 'address', c.address->>'address')
      FROM public.customers c WHERE c.id = s.customer_id
    ),
    'lines', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', x.id,
        'unit_id', x.unit_id,
        'product_id', x.product_id,
        'product_name', p.name,
        'sku', p.sku,
        'qr_code', u.qr_code,
        'serial_number', u.serial_number,
        'image', coalesce(
          (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = u.variant_id ORDER BY m.is_primary DESC, m.sort_order ASC LIMIT 1),
          (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order ASC LIMIT 1),
          p.seo_image_url
        ),
        'unit_price', x.unit_price,
        'discount', x.discount,
        'tax', x.tax,
        'line_total', x.line_total,
        'retail_price', p.retail_price,
        'minimum_sale_price', p.minimum_sale_price,
        'unit_cost', coalesce(sb.unit_cost, p.cost_price),
        'profit', x.line_total - x.tax - coalesce(sb.unit_cost, p.cost_price),
        'selected_components', coalesce(x.selected_components, '[]'::jsonb)
      ) ORDER BY x.created_at, x.id)
      FROM public.pos_pending_sale_lines x
      JOIN public.products p ON p.id = x.product_id
      JOIN public.inventory_units u ON u.id = x.unit_id
      LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
      WHERE x.pending_sale_id = s.id
    ), '[]'::jsonb),
    'payments', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'method_id', pm.id,
        'method_code', pm.code,
        'method_name', pm.name,
        'amount', pp.amount,
        'external_reference', pp.external_reference,
        'sort_order', pp.sort_order
      ) ORDER BY pp.sort_order)
      FROM public.pos_pending_sale_payments pp
      JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
      WHERE pp.pending_sale_id = s.id
    ), '[]'::jsonb),
    'can_confirm', s.status = 'pending' AND s.expires_at > now() AND v_manager,
    'can_reject', s.status = 'pending' AND v_manager,
    'remaining_seconds', greatest(0, floor(extract(epoch FROM (s.expires_at - now())))::integer)
  )
  INTO v_result
  FROM public.pos_pending_sales s
  JOIN public.profiles seller ON seller.id = s.seller_id
  JOIN public.locations loc ON loc.id = s.store_location_id
  WHERE s.id = p_pending_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pos_pending_sale(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
