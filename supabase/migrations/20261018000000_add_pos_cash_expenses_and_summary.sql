-- Migration: Add POS cash expenses management and integrate into Kassa summary
-- 1. Function to record a cash expense from branch cash register
CREATE OR REPLACE FUNCTION public.add_pos_cash_expense(
  p_branch_id uuid,
  p_amount numeric,
  p_note text,
  p_category text DEFAULT 'other',
  p_date date DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_manager boolean;
  v_title text;
  v_cat text;
  v_period text;
  v_paid_at timestamptz;
  v_row record;
  v_date date;
BEGIN
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'Filial tanlanmagan' USING errcode = '22023';
  END IF;

  v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], p_branch_id);

  IF NOT v_manager THEN
    RAISE EXCEPTION 'Faqat menejer yoki admin xarajat kiritishi mumkin' USING errcode = '42501';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Xarajat summasi 0 dan katta bo‘lishi kerak' USING errcode = '22023';
  END IF;

  v_date := coalesce(p_date, (now() AT TIME ZONE 'Asia/Tashkent')::date);
  v_period := to_char(v_date, 'YYYY-MM');

  -- Ensure category is in allowed check constraint
  IF p_category IN ('tax','rent','electricity','water','gas','llc','sole_trader','salary','transport','other') THEN
    v_cat := p_category;
  ELSE
    v_cat := 'other';
  END IF;

  -- Title must be between 2 and 300 chars for check constraint
  v_title := coalesce(nullif(btrim(p_note), ''), 'Kassa xarajati');
  IF length(v_title) < 2 THEN
    v_title := 'Kassa xarajati';
  ELSIF length(v_title) > 280 THEN
    v_title := substr(v_title, 1, 280);
  END IF;

  IF p_date IS NOT NULL THEN
    v_paid_at := (p_date::text || ' ' || to_char(now() AT TIME ZONE 'Asia/Tashkent', 'HH24:MI:SS'))::timestamptz;
  ELSE
    v_paid_at := now();
  END IF;

  INSERT INTO public.expenses (
    branch_id,
    category,
    title,
    amount,
    paid_amount,
    currency,
    period_month,
    paid_at,
    note,
    created_by,
    created_at,
    updated_at
  ) VALUES (
    p_branch_id,
    v_cat,
    v_title,
    p_amount,
    p_amount,
    'UZS',
    v_period,
    v_paid_at,
    nullif(btrim(p_note), ''),
    auth.uid(),
    now(),
    now()
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'branch_id', v_row.branch_id,
    'amount', v_row.amount,
    'title', v_row.title,
    'note', v_row.note,
    'category', v_row.category,
    'paid_at', v_row.paid_at,
    'created_at', v_row.created_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_pos_cash_expense(uuid, numeric, text, text, date) TO authenticated, service_role;

-- 2. Function to list expenses for a branch and date range
CREATE OR REPLACE FUNCTION public.list_pos_cash_expenses(
  p_branch_id uuid,
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
  v_list jsonb;
BEGIN
  v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], p_branch_id);

  IF NOT v_manager THEN
    RAISE EXCEPTION 'Ruxsat berilmagan' USING errcode = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.paid_at DESC, q.created_at DESC), '[]'::jsonb)
  INTO v_list
  FROM (
    SELECT
      e.id,
      e.branch_id,
      e.category,
      e.title,
      e.amount,
      e.paid_amount,
      e.currency,
      e.paid_at,
      e.note,
      e.created_at,
      e.created_by,
      coalesce(p.full_name, 'Menejer') AS created_by_name
    FROM public.expenses e
    LEFT JOIN public.profiles p ON p.id = e.created_by
    WHERE e.branch_id = p_branch_id
      AND (
        (p_start_date IS NULL OR (coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
        AND
        (p_end_date IS NULL OR (coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
      )
    ORDER BY coalesce(e.paid_at, e.created_at) DESC, e.created_at DESC
  ) q;

  RETURN v_list;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_pos_cash_expenses(uuid, date, date) TO authenticated, service_role;

-- 3. Function to delete a cash expense
CREATE OR REPLACE FUNCTION public.delete_pos_cash_expense(
  p_expense_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_branch_id uuid;
  v_manager boolean;
BEGIN
  SELECT branch_id INTO v_branch_id FROM public.expenses WHERE id = p_expense_id;
  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'Xarajat topilmadi' USING errcode = 'P0002';
  END IF;

  v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], v_branch_id);

  IF NOT v_manager THEN
    RAISE EXCEPTION 'Faqat menejer yoki admin xarajatni o‘chira oladi' USING errcode = '42501';
  END IF;

  DELETE FROM public.expenses WHERE id = p_expense_id;

  RETURN jsonb_build_object('ok', true, 'id', p_expense_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_pos_cash_expense(uuid) TO authenticated, service_role;

-- 4. Update list_pos_pending_sales to include confirmed_today_expense and confirmed_today_expense_count
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
          SELECT pm.code AS method_code, pm.name AS method_name, pp.amount, pm.sort_order
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
    JOIN public.locations l ON l.id = s.store_location_id
    JOIN public.profiles p ON p.id = s.seller_id
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
    'confirmed_today_expense', coalesce((
      SELECT sum(e.paid_amount)
      FROM public.expenses e
      WHERE e.branch_id = p_branch_id
        AND (
          (p_start_date IS NULL OR (coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
          AND
          (p_end_date IS NULL OR (coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
        )
    ), 0),
    'confirmed_today_expense_count', (
      SELECT count(*)
      FROM public.expenses e
      WHERE e.branch_id = p_branch_id
        AND (
          (p_start_date IS NULL OR (coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
          AND
          (p_end_date IS NULL OR (coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
        )
    ),
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
