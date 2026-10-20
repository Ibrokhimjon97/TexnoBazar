-- Migration 20260976000000: get_all_batch_prices_for_excel
-- Returns all batch and product pricing items across the store/branch for Excel template export and instant bulk price matching.

CREATE OR REPLACE FUNCTION public.get_all_batch_prices_for_excel(
  p_branch_id uuid DEFAULT NULL,
  p_currency text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_res jsonb;
  v_curr text;
BEGIN
  IF p_branch_id IS NOT NULL THEN
    PERFORM public.require_inventory_operator(p_branch_id);
  END IF;

  v_curr := NULLIF(upper(btrim(p_currency)), '');

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'batch_id', sb.id,
      'receipt_id', sr.id,
      'receipt_no', sr.receipt_no,
      'currency', sr.currency,
      'product_id', sb.product_id,
      'product_name', p.name,
      'sku', p.sku,
      'variant_id', sb.variant_id,
      'variant_color', sv.color_name,
      'quantity', sb.quantity,
      'unit_cost', coalesce(sb.unit_cost, p.cost_price, 0),
      'unit_cost_usd', coalesce(sb.unit_cost_usd, p.cost_price_usd, 0),
      'retail_price', coalesce(sb.retail_price, p.retail_price, 0),
      'retail_price_usd', coalesce(sb.retail_price_usd, p.retail_price_usd, 0),
      'wholesale_price', coalesce(sb.wholesale_price, p.wholesale_price, 0),
      'wholesale_price_usd', coalesce(sb.wholesale_price_usd, p.wholesale_price_usd, 0),
      'minimum_sale_price', coalesce(sb.minimum_sale_price, p.minimum_sale_price, p.retail_price, 0),
      'minimum_sale_price_usd', coalesce(sb.minimum_sale_price_usd, p.minimum_sale_price_usd, p.retail_price_usd, 0),
      'qr_code', coalesce((SELECT iu.qr_code FROM public.inventory_units iu WHERE iu.batch_id = sb.id LIMIT 1), '')
    )
    ORDER BY sr.created_at DESC, sb.line_no ASC
  ), '[]'::jsonb)
  INTO v_res
  FROM public.stock_batches sb
  JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
  JOIN public.products p ON p.id = sb.product_id
  LEFT JOIN public.product_variants sv ON sv.id = sb.variant_id
  WHERE (p_branch_id IS NULL OR sr.branch_id = p_branch_id)
    AND (v_curr IS NULL OR sr.currency = v_curr);

  RETURN v_res;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_all_batch_prices_for_excel(uuid, text) TO authenticated, service_role;
