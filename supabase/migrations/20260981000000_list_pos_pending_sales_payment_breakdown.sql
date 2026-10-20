-- Migration: Add payment breakdown (cash vs card/plastic) to list_pos_pending_sales and get_pos_pending_sale
CREATE OR REPLACE FUNCTION public.list_pos_pending_sales(
  p_branch_id uuid,
  p_status public.pending_sale_status DEFAULT null,
  p_query text DEFAULT null,
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_manager boolean;
  v_items jsonb;
  v_total bigint;
  v_summary jsonb;
  v_q text := nullif(btrim(p_query), '');
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  PERFORM public.release_expired_pos_sales(p_branch_id);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto‘g‘ri' USING errcode = '22023';
  END IF;

  v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], p_branch_id);

  SELECT count(*) INTO v_total
  FROM public.pos_pending_sales s
  WHERE s.branch_id = p_branch_id
    AND (v_manager OR s.seller_id = auth.uid())
    AND (p_status IS NULL OR s.status = p_status)
    AND (v_q IS NULL OR s.pending_no ILIKE '%' || v_q || '%' OR EXISTS(
      SELECT 1 FROM public.profiles p WHERE p.id = s.seller_id AND p.full_name ILIKE '%' || v_q || '%'
    ));

  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      s.id, s.pending_no, s.status, s.seller_id,
      p.full_name AS seller_name,
      s.store_location_id, l.name AS location_name,
      (SELECT count(*) FROM public.pos_pending_sale_lines x WHERE x.pending_sale_id = s.id) AS unit_count,
      s.total, s.created_at, s.updated_at, s.expires_at, s.notes,
      (s.updated_at > s.created_at + interval '1 second') AS is_edited,
      coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'code', pmt.method_code,
          'name', pmt.method_name,
          'amount', pmt.amount
        ) ORDER BY pmt.sort_order)
        FROM (
          SELECT pm.code AS method_code, pm.name AS method_name, sp.amount, pm.sort_order
          FROM public.sales sa
          JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status = 'paid'
          JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
          WHERE sa.pending_sale_id = s.id
          UNION ALL
          SELECT pm.code AS method_code, pm.name AS method_name, pp.amount, pp.sort_order
          FROM public.pos_pending_sale_payments pp
          JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
          WHERE pp.pending_sale_id = s.id
            AND NOT EXISTS (
              SELECT 1 FROM public.sales sa2
              JOIN public.sale_payments sp2 ON sp2.sale_id = sa2.id AND sp2.status = 'paid'
              WHERE sa2.pending_sale_id = s.id
            )
          UNION ALL
          SELECT 'cash' AS method_code, 'Naqd' AS method_name, s.total AS amount, 1 AS sort_order
          WHERE s.status = 'confirmed'
            AND NOT EXISTS (
              SELECT 1 FROM public.sales sa3
              JOIN public.sale_payments sp3 ON sp3.sale_id = sa3.id AND sp3.status = 'paid'
              WHERE sa3.pending_sale_id = s.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.pos_pending_sale_payments pp3
              WHERE pp3.pending_sale_id = s.id
            )
        ) pmt
      ), '[]'::jsonb) AS payments
    FROM public.pos_pending_sales s
    JOIN public.profiles p ON p.id = s.seller_id
    JOIN public.locations l ON l.id = s.store_location_id
    WHERE s.branch_id = p_branch_id
      AND (v_manager OR s.seller_id = auth.uid())
      AND (p_status IS NULL OR s.status = p_status)
      AND (v_q IS NULL OR s.pending_no ILIKE '%' || v_q || '%' OR p.full_name ILIKE '%' || v_q || '%')
    ORDER BY s.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) q;

  WITH today_confirmed AS (
    SELECT s.id, s.branch_id, s.total
    FROM public.pos_pending_sales s
    WHERE s.branch_id = p_branch_id
      AND (v_manager OR s.seller_id = auth.uid())
      AND s.status = 'confirmed'
      AND s.confirmed_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'
  ),
  sale_pmts AS (
    SELECT 
      tc.id AS pending_id,
      pm.code AS method_code,
      sum(sp.amount) AS amount
    FROM today_confirmed tc
    JOIN public.sales sa ON sa.pending_sale_id = tc.id
    JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status = 'paid'
    JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
    GROUP BY tc.id, pm.code
  ),
  fallback_pmts AS (
    SELECT 
      tc.id AS pending_id,
      pm.code AS method_code,
      sum(pp.amount) AS amount
    FROM today_confirmed tc
    JOIN public.pos_pending_sale_payments pp ON pp.pending_sale_id = tc.id
    JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
    WHERE NOT EXISTS (SELECT 1 FROM sale_pmts WHERE sale_pmts.pending_id = tc.id)
    GROUP BY tc.id, pm.code
  ),
  default_cash AS (
    SELECT
      tc.id AS pending_id,
      'cash' AS method_code,
      tc.total AS amount
    FROM today_confirmed tc
    WHERE NOT EXISTS (SELECT 1 FROM sale_pmts WHERE sale_pmts.pending_id = tc.id)
      AND NOT EXISTS (SELECT 1 FROM fallback_pmts WHERE fallback_pmts.pending_id = tc.id)
  ),
  all_today_pmts AS (
    SELECT * FROM sale_pmts
    UNION ALL
    SELECT * FROM fallback_pmts
    UNION ALL
    SELECT * FROM default_cash
  )
  SELECT jsonb_build_object(
    'pending_count', count(*) FILTER (WHERE status = 'pending'),
    'pending_amount', coalesce(sum(total) FILTER (WHERE status = 'pending'), 0),
    'confirmed_today_count', (SELECT count(*) FROM today_confirmed),
    'confirmed_today_amount', (SELECT coalesce(sum(total), 0) FROM today_confirmed),
    'confirmed_today_cash', coalesce((SELECT sum(amount) FROM all_today_pmts WHERE method_code = 'cash'), 0),
    'confirmed_today_card', coalesce((SELECT sum(amount) FROM all_today_pmts WHERE method_code IN ('card', 'terminal')), 0),
    'confirmed_today_other', coalesce((SELECT sum(amount) FROM all_today_pmts WHERE method_code NOT IN ('cash', 'card', 'terminal')), 0)
  )
  INTO v_summary
  FROM public.pos_pending_sales
  WHERE branch_id = p_branch_id AND (v_manager OR seller_id = auth.uid());

  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'summary', v_summary);
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_pos_pending_sales(uuid, public.pending_sale_status, text, integer, integer) TO authenticated, service_role;


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
        'method_id', pmt.method_id,
        'method_code', pmt.method_code,
        'method_name', pmt.method_name,
        'amount', pmt.amount,
        'external_reference', pmt.external_reference,
        'sort_order', pmt.sort_order
      ) ORDER BY pmt.sort_order)
      FROM (
        SELECT pm.id AS method_id, pm.code AS method_code, pm.name AS method_name, sp.amount, sp.external_reference, pm.sort_order
        FROM public.sales sa
        JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status = 'paid'
        JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
        WHERE sa.pending_sale_id = s.id
        UNION ALL
        SELECT pm.id AS method_id, pm.code AS method_code, pm.name AS method_name, pp.amount, pp.external_reference, pp.sort_order
        FROM public.pos_pending_sale_payments pp
        JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
        WHERE pp.pending_sale_id = s.id
          AND NOT EXISTS (
            SELECT 1 FROM public.sales sa2
            JOIN public.sale_payments sp2 ON sp2.sale_id = sa2.id AND sp2.status = 'paid'
            WHERE sa2.pending_sale_id = s.id
          )
        UNION ALL
        SELECT pm.id AS method_id, pm.code AS method_code, pm.name AS method_name, s.total AS amount, null AS external_reference, 1 AS sort_order
        FROM public.payment_methods pm
        WHERE pm.code = 'cash' AND s.status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM public.sales sa3
            JOIN public.sale_payments sp3 ON sp3.sale_id = sa3.id AND sp3.status = 'paid'
            WHERE sa3.pending_sale_id = s.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.pos_pending_sale_payments pp3
            WHERE pp3.pending_sale_id = s.id
          )
      ) pmt
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
