-- ==============================================================================
-- Migration: 20261026000000_get_pos_confirmed_profit_details.sql
-- Description:
-- Function to retrieve item-by-item breakdown of confirmed sales for profit analysis,
-- including product name, SKU, QR code, unit_cost (tan narx), retail_price (aytish narx),
-- unit_price (sotilgan narx), discount, remaining profit, seller name, timestamp, and payment method.
-- ==============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_pos_confirmed_profit_details(
  p_branch_id uuid,
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_manager boolean;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    v_manager := true;
  ELSE
    v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
      OR public.has_role(array['manager']::public.app_role[], p_branch_id);
  END IF;

  WITH period_confirmed AS (
    SELECT 
      s.id,
      s.branch_id,
      s.total,
      s.pending_no,
      coalesce(s.confirmed_at, s.created_at) as confirmed_at,
      s.seller_id,
      coalesce(prof.full_name, 'Noma’lum') as seller_name
    FROM public.pos_pending_sales s
    LEFT JOIN public.profiles prof ON prof.id = s.seller_id
    WHERE s.branch_id = p_branch_id
      AND (v_manager OR s.seller_id = auth.uid())
      AND s.status = 'confirmed'
      AND (
        (p_start_date IS NULL OR (coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date)
        AND
        (p_end_date IS NULL OR (coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date)
      )
  ),
  pending_pmts AS (
    SELECT 
      pc.id as pending_id,
      coalesce(
        string_agg(distinct coalesce(pm.name, pm.code), ', '),
        (
          SELECT string_agg(distinct coalesce(pm2.name, pm2.code), ', ')
          FROM public.pos_pending_sale_payments pp2
          JOIN public.payment_methods pm2 ON pm2.id = pp2.payment_method_id
          WHERE pp2.pending_sale_id = pc.id
        ),
        'Naqd'
      ) as payment_methods
    FROM period_confirmed pc
    LEFT JOIN public.sales sa ON sa.pending_sale_id = pc.id
    LEFT JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
    LEFT JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
    GROUP BY pc.id
  ),
  sale_items AS (
    -- 1. Lines from confirmed public.sales
    SELECT
      pc.id as pending_id,
      coalesce(sa.sale_no, pc.pending_no) as sale_no,
      pc.confirmed_at,
      pc.seller_name,
      coalesce(ppm.payment_methods, 'Naqd') as payment_methods,
      sl.product_id,
      coalesce(p.name, 'Noma’lum tovar') as product_name,
      coalesce(p.sku, '') as sku,
      coalesce(u.qr_code, '') as qr_code,
      coalesce(sl.quantity, 1) as quantity,
      coalesce(sl.unit_cost, p.cost_price, 0) as unit_cost,
      coalesce(p.retail_price, sl.unit_price) as retail_price,
      sl.unit_price,
      coalesce(sl.discount, 0) as discount,
      coalesce(sl.tax, 0) as tax,
      coalesce(sl.line_total, sl.unit_price * coalesce(sl.quantity, 1)) as line_total,
      (coalesce(sl.line_total, sl.unit_price * coalesce(sl.quantity, 1)) - coalesce(sl.tax, 0) - (coalesce(sl.unit_cost, p.cost_price, 0) * coalesce(sl.quantity, 1))) as profit
    FROM period_confirmed pc
    JOIN public.sales sa ON sa.pending_sale_id = pc.id
    JOIN public.sale_lines sl ON sl.sale_id = sa.id
    LEFT JOIN public.products p ON p.id = sl.product_id
    LEFT JOIN public.inventory_units u ON u.id = sl.unit_id
    LEFT JOIN pending_pmts ppm ON ppm.pending_id = pc.id

    UNION ALL

    -- 2. Fallback lines from pos_pending_sale_lines where sales record is not created
    SELECT
      pc.id as pending_id,
      pc.pending_no as sale_no,
      pc.confirmed_at,
      pc.seller_name,
      coalesce(ppm.payment_methods, 'Naqd') as payment_methods,
      psl.product_id,
      coalesce(p.name, 'Noma’lum tovar') as product_name,
      coalesce(p.sku, '') as sku,
      coalesce(u.qr_code, '') as qr_code,
      coalesce(psl.quantity, 1) as quantity,
      coalesce(sb.unit_cost, p.cost_price, 0) as unit_cost,
      coalesce(p.retail_price, psl.unit_price) as retail_price,
      psl.unit_price,
      coalesce(psl.discount, 0) as discount,
      coalesce(psl.tax, 0) as tax,
      coalesce(psl.line_total, psl.unit_price * coalesce(psl.quantity, 1)) as line_total,
      (coalesce(psl.line_total, psl.unit_price * coalesce(psl.quantity, 1)) - coalesce(psl.tax, 0) - (coalesce(sb.unit_cost, p.cost_price, 0) * coalesce(psl.quantity, 1))) as profit
    FROM period_confirmed pc
    JOIN public.pos_pending_sale_lines psl ON psl.pending_sale_id = pc.id
    LEFT JOIN public.inventory_units u ON u.id = psl.unit_id
    LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
    LEFT JOIN public.products p ON p.id = psl.product_id
    LEFT JOIN pending_pmts ppm ON ppm.pending_id = pc.id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.sales sa2 WHERE sa2.pending_sale_id = pc.id
    )
  )
  SELECT jsonb_build_object(
    'items', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'pending_id', pending_id,
          'sale_no', sale_no,
          'sold_at', confirmed_at,
          'seller_name', seller_name,
          'payment_methods', payment_methods,
          'product_id', product_id,
          'product_name', product_name,
          'sku', sku,
          'qr_code', qr_code,
          'quantity', quantity,
          'unit_cost', unit_cost,
          'retail_price', retail_price,
          'unit_price', unit_price,
          'discount', discount,
          'tax', tax,
          'line_total', line_total,
          'profit', profit
        ) ORDER BY confirmed_at DESC, sale_no DESC
      )
      FROM sale_items
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'total_items', coalesce((SELECT count(*) FROM sale_items), 0),
      'total_quantity', coalesce((SELECT sum(quantity) FROM sale_items), 0),
      'total_revenue', coalesce((SELECT sum(line_total) FROM sale_items), 0),
      'total_cost', coalesce((SELECT sum(unit_cost * quantity) FROM sale_items), 0),
      'total_profit', coalesce((SELECT sum(profit) FROM sale_items), 0)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pos_confirmed_profit_details(uuid, date, date) TO authenticated, service_role;

COMMIT;
