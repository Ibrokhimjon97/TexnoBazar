-- Migration: 20261015000000_fix_cash_period_stats_and_all_time_filter.sql
-- Description:
-- 1. Fix list_pos_pending_sales summary stats:
--    - cod_count and cod_total_amount now respect the selected date range (p_start_date, p_end_date).
--    - nasiya_count and nasiya_total_amount now respect the selected date range.
--    - pending_count and pending_amount now respect the selected date range.
--    - rejected_count and total_count added to summary matching the date filter.
--    - period_confirmed properly includes all confirmed sales when p_start_date and p_end_date are NULL (All time / Barcha davr).

CREATE OR REPLACE FUNCTION public.list_pos_pending_sales(
  p_branch_id uuid,
  p_status text DEFAULT null,
  p_query text DEFAULT null,
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0,
  p_start_date date DEFAULT null,
  p_end_date date DEFAULT null
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
  v_is_nasiya_filter boolean := (lower(btrim(coalesce(p_status, ''))) = 'nasiya');
  v_status_filter text := CASE 
    WHEN p_status IS NULL OR lower(btrim(p_status)) IN ('', 'all', 'cod', 'nasiya') THEN null 
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
      (p_start_date IS NULL OR (coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
      AND
      (p_end_date IS NULL OR (coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
    )
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
        WHEN v_is_nasiya_filter THEN (
          EXISTS (
            SELECT 1 FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
            WHERE sa.pending_sale_id = s.id AND pm.code = 'nasiya' AND sp.amount > 0
          )
          OR EXISTS (
            SELECT 1 FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
            WHERE pp.pending_sale_id = s.id AND pm.code = 'nasiya' AND pp.amount > 0
              AND NOT EXISTS (SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = s.id)
          )
        )
        WHEN v_status_filter IS NOT NULL THEN (s.status::text = v_status_filter)
        ELSE true
      END
    )
    AND (
      v_q IS NULL 
      OR s.pending_no ILIKE '%' || v_q || '%' 
      OR EXISTS(SELECT 1 FROM public.profiles p WHERE p.id = s.seller_id AND p.full_name ILIKE '%' || v_q || '%')
      OR EXISTS(SELECT 1 FROM public.customers c2 WHERE c2.id = s.customer_id AND (c2.full_name ILIKE '%' || v_q || '%' OR c2.phone ILIKE '%' || v_q || '%'))
    );

  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      s.id, s.pending_no, s.status, s.seller_id,
      p.full_name AS seller_name,
      s.store_location_id, l.name AS location_name,
      (SELECT count(*) FROM public.pos_pending_sale_lines x WHERE x.pending_sale_id = s.id) AS unit_count,
      (
        SELECT string_agg(
          CASE 
            WHEN count > 1 THEN name || ' (' || count || ')' 
            ELSE name 
          END, 
          ', '
        )
        FROM (
          SELECT pr.name, count(*) AS count
          FROM public.pos_pending_sale_lines x
          JOIN public.products pr ON pr.id = x.product_id
          WHERE x.pending_sale_id = s.id
          GROUP BY pr.id, pr.name
          ORDER BY min(x.created_at), pr.name
        ) sub
      ) AS product_names,
      (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', x.id,
          'product_id', x.product_id,
          'product_name', pr.name,
          'unit_id', x.unit_id,
          'unit_price', x.unit_price,
          'line_total', x.line_total
        ) ORDER BY x.created_at, x.id), '[]'::jsonb)
        FROM public.pos_pending_sale_lines x
        JOIN public.products pr ON pr.id = x.product_id
        WHERE x.pending_sale_id = s.id
      ) AS lines,
      s.total, s.created_at, s.updated_at, s.expires_at, s.notes,
      (s.updated_at > s.created_at + interval '1 second') AS is_edited,
      (
        SELECT jsonb_build_object('id', c.id, 'full_name', c.full_name, 'phone', c.phone, 'address', c.address->>'address')
        FROM public.customers c WHERE c.id = s.customer_id
      ) AS customer,
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
        (p_start_date IS NULL OR (coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
        AND
        (p_end_date IS NULL OR (coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
      )
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
          WHEN v_is_nasiya_filter THEN (
            EXISTS (
              SELECT 1 FROM public.sales sa
              JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
              JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
              WHERE sa.pending_sale_id = s.id AND pm.code = 'nasiya' AND sp.amount > 0
            )
            OR EXISTS (
              SELECT 1 FROM public.pos_pending_sale_payments pp
              JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
              WHERE pp.pending_sale_id = s.id AND pm.code = 'nasiya' AND pp.amount > 0
                AND NOT EXISTS (SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = s.id)
            )
          )
          WHEN v_status_filter IS NOT NULL THEN (s.status::text = v_status_filter)
          ELSE true
        END
      )
      AND (
        v_q IS NULL 
        OR s.pending_no ILIKE '%' || v_q || '%' 
        OR p.full_name ILIKE '%' || v_q || '%'
        OR EXISTS (SELECT 1 FROM public.customers c2 WHERE c2.id = s.customer_id AND (c2.full_name ILIKE '%' || v_q || '%' OR c2.phone ILIKE '%' || v_q || '%'))
      )
    ORDER BY s.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) q;

  WITH period_confirmed AS (
    SELECT s.id, s.branch_id, s.total
    FROM public.pos_pending_sales s
    WHERE s.branch_id = p_branch_id
      AND (v_manager OR s.seller_id = auth.uid())
      AND s.status = 'confirmed'
      AND (
        (p_start_date IS NULL OR (coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
        AND
        (p_end_date IS NULL OR (coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
      )
  ),
  sale_pmts AS (
    SELECT 
      pc.id AS pending_id,
      pm.code AS method_code,
      sum(sp.amount) AS amount
    FROM period_confirmed pc
    JOIN public.sales sa ON sa.pending_sale_id = pc.id
    JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
    JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
    GROUP BY pc.id, pm.code
  ),
  fallback_pmts AS (
    SELECT 
      pc.id AS pending_id,
      pm.code AS method_code,
      sum(pp.amount) AS amount
    FROM period_confirmed pc
    JOIN public.pos_pending_sale_payments pp ON pp.pending_sale_id = pc.id
    JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
    WHERE NOT EXISTS (SELECT 1 FROM sale_pmts WHERE sale_pmts.pending_id = pc.id)
    GROUP BY pc.id, pm.code
  ),
  default_cash AS (
    SELECT
      pc.id AS pending_id,
      'cash' AS method_code,
      pc.total AS amount
    FROM period_confirmed pc
    WHERE NOT EXISTS (SELECT 1 FROM sale_pmts WHERE sale_pmts.pending_id = pc.id)
      AND NOT EXISTS (SELECT 1 FROM fallback_pmts WHERE fallback_pmts.pending_id = pc.id)
  ),
  all_period_pmts AS (
    SELECT * FROM sale_pmts
    UNION ALL
    SELECT * FROM fallback_pmts
    UNION ALL
    SELECT * FROM default_cash
  )
  SELECT jsonb_build_object(
    'total_count', (
      SELECT count(*) FROM public.pos_pending_sales s5
      WHERE s5.branch_id = p_branch_id
        AND (v_manager OR s5.seller_id = auth.uid())
        AND (
          (p_start_date IS NULL OR (coalesce(s5.confirmed_at, s5.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
          AND
          (p_end_date IS NULL OR (coalesce(s5.confirmed_at, s5.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
        )
    ),
    'pending_count', (
      SELECT count(*) FROM public.pos_pending_sales s3
      WHERE s3.branch_id = p_branch_id
        AND (v_manager OR s3.seller_id = auth.uid())
        AND s3.status = 'pending'
        AND (
          (p_start_date IS NULL OR (s3.created_at AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
          AND
          (p_end_date IS NULL OR (s3.created_at AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
        )
    ),
    'pending_amount', coalesce((
      SELECT sum(s3.total) FROM public.pos_pending_sales s3
      WHERE s3.branch_id = p_branch_id
        AND (v_manager OR s3.seller_id = auth.uid())
        AND s3.status = 'pending'
        AND (
          (p_start_date IS NULL OR (s3.created_at AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
          AND
          (p_end_date IS NULL OR (s3.created_at AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
        )
    ), 0),
    'rejected_count', (
      SELECT count(*) FROM public.pos_pending_sales s4
      WHERE s4.branch_id = p_branch_id
        AND (v_manager OR s4.seller_id = auth.uid())
        AND s4.status = 'rejected'
        AND (
          (p_start_date IS NULL OR (coalesce(s4.confirmed_at, s4.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
          AND
          (p_end_date IS NULL OR (coalesce(s4.confirmed_at, s4.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
        )
    ),
    'confirmed_today_count', (SELECT count(*) FROM period_confirmed),
    'confirmed_today_amount', (SELECT coalesce(sum(total), 0) FROM period_confirmed),
    'confirmed_today_cash', coalesce((SELECT sum(amount) FROM all_period_pmts WHERE method_code = 'cash'), 0),
    'confirmed_today_card', coalesce((SELECT sum(amount) FROM all_period_pmts WHERE method_code IN ('card', 'terminal', 'click', 'payme', 'uzum')), 0),
    'confirmed_today_cod', coalesce((SELECT sum(amount) FROM all_period_pmts WHERE method_code = 'cod'), 0),
    'confirmed_today_nasiya', coalesce((SELECT sum(amount) FROM all_period_pmts WHERE method_code = 'nasiya'), 0),
    'confirmed_today_other', coalesce((SELECT sum(amount) FROM all_period_pmts WHERE method_code NOT IN ('cash', 'card', 'terminal', 'click', 'payme', 'uzum', 'cod', 'nasiya')), 0),
    'cod_count', (
      SELECT count(*) FROM public.pos_pending_sales s2
      WHERE s2.branch_id = p_branch_id
        AND (v_manager OR s2.seller_id = auth.uid())
        AND s2.status <> 'rejected'
        AND (
          (p_start_date IS NULL OR (coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
          AND
          (p_end_date IS NULL OR (coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
        )
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
      SELECT sum(
        CASE
          WHEN sa.id IS NOT NULL THEN sp.amount
          ELSE pp.amount
        END
      )
      FROM public.pos_pending_sales s2
      LEFT JOIN public.sales sa ON sa.pending_sale_id = s2.id
      LEFT JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
        AND sp.payment_method_id = (SELECT id FROM public.payment_methods WHERE code = 'cod')
      LEFT JOIN public.pos_pending_sale_payments pp ON pp.pending_sale_id = s2.id AND sa.id IS NULL
        AND pp.payment_method_id = (SELECT id FROM public.payment_methods WHERE code = 'cod')
      WHERE s2.branch_id = p_branch_id
        AND (v_manager OR s2.seller_id = auth.uid())
        AND s2.status <> 'rejected'
        AND (
          (p_start_date IS NULL OR (coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
          AND
          (p_end_date IS NULL OR (coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
        )
        AND (coalesce(sp.amount, 0) > 0 OR coalesce(pp.amount, 0) > 0)
    ), 0),
    'nasiya_count', (
      SELECT count(*) FROM public.pos_pending_sales s2
      WHERE s2.branch_id = p_branch_id
        AND (v_manager OR s2.seller_id = auth.uid())
        AND s2.status <> 'rejected'
        AND (
          (p_start_date IS NULL OR (coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
          AND
          (p_end_date IS NULL OR (coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
        )
        AND (
          EXISTS (
            SELECT 1 FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
            WHERE sa.pending_sale_id = s2.id AND pm.code = 'nasiya' AND sp.amount > 0
          )
          OR EXISTS (
            SELECT 1 FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
            WHERE pp.pending_sale_id = s2.id AND pm.code = 'nasiya' AND pp.amount > 0
              AND NOT EXISTS (SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = s2.id)
          )
        )
    ),
    'nasiya_total_amount', coalesce((
      SELECT sum(
        CASE
          WHEN sa.id IS NOT NULL THEN sp.amount
          ELSE pp.amount
        END
      )
      FROM public.pos_pending_sales s2
      LEFT JOIN public.sales sa ON sa.pending_sale_id = s2.id
      LEFT JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
        AND sp.payment_method_id = (SELECT id FROM public.payment_methods WHERE code = 'nasiya')
      LEFT JOIN public.pos_pending_sale_payments pp ON pp.pending_sale_id = s2.id AND sa.id IS NULL
        AND pp.payment_method_id = (SELECT id FROM public.payment_methods WHERE code = 'nasiya')
      WHERE s2.branch_id = p_branch_id
        AND (v_manager OR s2.seller_id = auth.uid())
        AND s2.status <> 'rejected'
        AND (
          (p_start_date IS NULL OR (coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
          AND
          (p_end_date IS NULL OR (coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
        )
        AND (coalesce(sp.amount, 0) > 0 OR coalesce(pp.amount, 0) > 0)
    ), 0),
    'period_start', p_start_date,
    'period_end', p_end_date
  ) INTO v_summary;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'summary', v_summary
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_pos_pending_sales(uuid, text, text, integer, integer, date, date) TO authenticated, service_role;
