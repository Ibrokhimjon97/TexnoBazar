-- Migration: Support COD filter tab and cod_count in list_pos_pending_sales
DROP FUNCTION IF EXISTS public.list_pos_pending_sales(uuid, public.pending_sale_status, text, integer, integer);
DROP FUNCTION IF EXISTS public.list_pos_pending_sales(uuid, text, text, integer, integer);

CREATE OR REPLACE FUNCTION public.list_pos_pending_sales(
  p_branch_id uuid,
  p_status text DEFAULT null,
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
  v_is_cod_filter boolean := (lower(btrim(coalesce(p_status, ''))) = 'cod');
  v_status_filter text := CASE 
    WHEN p_status IS NULL OR lower(btrim(p_status)) IN ('', 'all', 'cod') THEN null 
    ELSE lower(btrim(p_status)) 
  END;
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto‘g‘ri' USING errcode = '22023';
  END IF;

  v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], p_branch_id);

  SELECT count(*) INTO v_total
  FROM public.pos_pending_sales s
  WHERE s.branch_id = p_branch_id
    AND (v_manager OR s.seller_id = auth.uid())
    AND (
      CASE
        WHEN v_is_cod_filter THEN (
          EXISTS (
            SELECT 1 FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
            WHERE sa.pending_sale_id = s.id AND pm.code = 'cod' AND sp.amount > 0
          )
          OR EXISTS (
            SELECT 1 FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
            WHERE pp.pending_sale_id = s.id AND pm.code = 'cod' AND pp.amount > 0
              AND NOT EXISTS (SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = s.id)
          )
        )
        WHEN v_status_filter IS NOT NULL THEN (s.status::text = v_status_filter)
        ELSE true
      END
    )
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
          JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
          JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
          WHERE sa.pending_sale_id = s.id
          UNION ALL
          SELECT pm.code AS method_code, pm.name AS method_name, pp.amount, pp.sort_order
          FROM public.pos_pending_sale_payments pp
          JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
          WHERE pp.pending_sale_id = s.id
            AND NOT EXISTS (
              SELECT 1 FROM public.sales sa2
              JOIN public.sale_payments sp2 ON sp2.sale_id = sa2.id AND sp2.status IN ('paid', 'pending')
              WHERE sa2.pending_sale_id = s.id
            )
          UNION ALL
          SELECT 'cash' AS method_code, 'Naqd' AS method_name, s.total AS amount, 1 AS sort_order
          WHERE s.status = 'confirmed'
            AND NOT EXISTS (
              SELECT 1 FROM public.sales sa3
              JOIN public.sale_payments sp3 ON sp3.sale_id = sa3.id AND sp3.status IN ('paid', 'pending')
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
      AND (
        CASE
          WHEN v_is_cod_filter THEN (
            EXISTS (
              SELECT 1 FROM public.sales sa
              JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
              JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
              WHERE sa.pending_sale_id = s.id AND pm.code = 'cod' AND sp.amount > 0
            )
            OR EXISTS (
              SELECT 1 FROM public.pos_pending_sale_payments pp
              JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
              WHERE pp.pending_sale_id = s.id AND pm.code = 'cod' AND pp.amount > 0
                AND NOT EXISTS (SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = s.id)
            )
          )
          WHEN v_status_filter IS NOT NULL THEN (s.status::text = v_status_filter)
          ELSE true
        END
      )
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
    JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
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
    'confirmed_today_cod', coalesce((SELECT sum(amount) FROM all_today_pmts WHERE method_code = 'cod'), 0),
    'confirmed_today_other', coalesce((SELECT sum(amount) FROM all_today_pmts WHERE method_code NOT IN ('cash', 'card', 'terminal', 'cod')), 0),
    'cod_count', (
      SELECT count(*) FROM public.pos_pending_sales s2
      WHERE s2.branch_id = p_branch_id
        AND (v_manager OR s2.seller_id = auth.uid())
        AND (
          EXISTS (
            SELECT 1 FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
            WHERE sa.pending_sale_id = s2.id AND pm.code = 'cod' AND sp.amount > 0
          )
          OR EXISTS (
            SELECT 1 FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
            WHERE pp.pending_sale_id = s2.id AND pm.code = 'cod' AND pp.amount > 0
              AND NOT EXISTS (SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = s2.id)
          )
        )
    ),
    'cod_total_amount', coalesce((
      SELECT sum(sp.amount)
      FROM public.sales sa
      JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
      JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
      JOIN public.pos_pending_sales s2 ON s2.id = sa.pending_sale_id
      WHERE s2.branch_id = p_branch_id
        AND (v_manager OR s2.seller_id = auth.uid())
        AND pm.code = 'cod' AND sp.amount > 0
    ), 0)
  )
  INTO v_summary
  FROM public.pos_pending_sales
  WHERE branch_id = p_branch_id AND (v_manager OR seller_id = auth.uid());

  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'summary', v_summary);
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_pos_pending_sales(uuid, text, text, integer, integer) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
