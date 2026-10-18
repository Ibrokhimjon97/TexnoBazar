-- Migration 20260963500000: Bulk update batch & product prices from Excel import
-- Allows fast price adjustment for inventory batches and products while strictly preserving currency immutability.

CREATE OR REPLACE FUNCTION public.bulk_update_batch_prices(
  p_branch_id uuid,
  p_currency text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rate numeric;
  v_item jsonb;
  v_receipt_no text;
  v_qr_code text;
  v_prod_name text;
  v_curr text;
  v_batch_rec record;
  v_batch_id uuid;
  v_raw_cost numeric;
  v_raw_retail numeric;
  v_raw_wholesale numeric;
  v_raw_min numeric;
  v_cost_uzs numeric(18,2);
  v_cost_usd numeric(18,2);
  v_retail_uzs numeric(18,2);
  v_retail_usd numeric(18,2);
  v_wholesale_uzs numeric(18,2);
  v_wholesale_usd numeric(18,2);
  v_min_uzs numeric(18,2);
  v_min_usd numeric(18,2);
  v_updated_batches integer := 0;
  v_updated_products integer := 0;
  v_updated_variants integer := 0;
  v_not_found jsonb := '[]'::jsonb;
  v_affected_receipts uuid[] := '{}';
  v_rec_id uuid;
  v_seen_products uuid[] := '{}';
  v_seen_variants uuid[] := '{}';
BEGIN
  IF p_branch_id IS NOT NULL THEN
    PERFORM public.require_inventory_operator(p_branch_id);
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'updated_batches', 0,
      'updated_products', 0,
      'not_found_count', 0,
      'not_found', '[]'::jsonb
    );
  END IF;

  v_rate := coalesce(public.get_effective_exchange_rate('USD', 'UZS'), 12800);
  IF v_rate <= 0 THEN v_rate := 12800; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_receipt_no := nullif(btrim(v_item->>'receipt_no'), '');
    v_qr_code := nullif(btrim(v_item->>'qr_code'), '');
    v_prod_name := nullif(btrim(v_item->>'product_name'), '');

    v_batch_id := NULL;

    -- Match 1: Both qr_code (via inventory_units) AND receipt_no (via stock_receipts)
    IF v_qr_code IS NOT NULL AND v_receipt_no IS NOT NULL THEN
      SELECT sb.id, sb.product_id, sb.variant_id, sb.receipt_id, sb.quantity
      INTO v_batch_rec
      FROM public.stock_batches sb
      JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
      JOIN public.inventory_units iu ON iu.batch_id = sb.id
      WHERE (p_branch_id IS NULL OR sr.branch_id = p_branch_id)
        AND upper(btrim(iu.qr_code)) = upper(v_qr_code)
        AND upper(btrim(sr.receipt_no)) = upper(v_receipt_no)
      LIMIT 1;

      IF FOUND THEN
        v_batch_id := v_batch_rec.id;
      END IF;
    END IF;

    -- Match 2: qr_code alone
    IF v_batch_id IS NULL AND v_qr_code IS NOT NULL THEN
      SELECT sb.id, sb.product_id, sb.variant_id, sb.receipt_id, sb.quantity
      INTO v_batch_rec
      FROM public.stock_batches sb
      JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
      JOIN public.inventory_units iu ON iu.batch_id = sb.id
      WHERE (p_branch_id IS NULL OR sr.branch_id = p_branch_id)
        AND upper(btrim(iu.qr_code)) = upper(v_qr_code)
      LIMIT 1;

      IF FOUND THEN
        v_batch_id := v_batch_rec.id;
      END IF;
    END IF;

    -- Match 3: receipt_no and product name
    IF v_batch_id IS NULL AND v_receipt_no IS NOT NULL AND v_prod_name IS NOT NULL THEN
      SELECT sb.id, sb.product_id, sb.variant_id, sb.receipt_id, sb.quantity
      INTO v_batch_rec
      FROM public.stock_batches sb
      JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
      JOIN public.products p ON p.id = sb.product_id
      WHERE (p_branch_id IS NULL OR sr.branch_id = p_branch_id)
        AND upper(btrim(sr.receipt_no)) = upper(v_receipt_no)
        AND (
          upper(btrim(p.name)) = upper(v_prod_name)
          OR upper(v_prod_name) LIKE '%' || upper(btrim(p.name)) || '%'
          OR upper(btrim(p.name)) LIKE '%' || upper(v_prod_name) || '%'
        )
      LIMIT 1;

      IF FOUND THEN
        v_batch_id := v_batch_rec.id;
      END IF;
    END IF;

    -- If not found, add to not_found array
    IF v_batch_id IS NULL THEN
      v_not_found := v_not_found || jsonb_build_object(
        'receipt_no', coalesce(v_receipt_no, ''),
        'qr_code', coalesce(v_qr_code, ''),
        'product_name', coalesce(v_prod_name, '')
      );
      CONTINUE;
    END IF;

    -- Currency: check item-level currency, then fallback to p_currency, default to 'UZS'
    v_curr := upper(coalesce(nullif(btrim(v_item->>'currency'), ''), p_currency, 'UZS'));
    IF v_curr NOT IN ('UZS', 'USD') THEN
      v_curr := 'UZS';
    END IF;

    v_raw_cost := (v_item->>'unit_cost')::numeric;
    v_raw_retail := (v_item->>'retail_price')::numeric;
    v_raw_wholesale := nullif(v_item->>'wholesale_price', '')::numeric;
    v_raw_min := nullif(v_item->>'minimum_sale_price', '')::numeric;

    IF v_curr = 'UZS' THEN
      v_cost_uzs := round(coalesce(v_raw_cost, 0));
      v_cost_usd := CASE WHEN v_cost_uzs > 0 AND v_rate > 0 THEN round(v_cost_uzs / v_rate, 2) ELSE 0 END;

      v_retail_uzs := round(coalesce(v_raw_retail, 0));
      v_retail_usd := CASE WHEN v_retail_uzs > 0 AND v_rate > 0 THEN round(v_retail_uzs / v_rate, 2) ELSE 0 END;

      v_wholesale_uzs := CASE WHEN v_raw_wholesale IS NOT NULL AND v_raw_wholesale > 0 THEN round(v_raw_wholesale) ELSE 0 END;
      v_wholesale_usd := CASE WHEN v_wholesale_uzs > 0 AND v_rate > 0 THEN round(v_wholesale_uzs / v_rate, 2) ELSE 0 END;

      v_min_uzs := CASE WHEN v_raw_min IS NOT NULL AND v_raw_min > 0 THEN round(v_raw_min) ELSE 0 END;
      v_min_usd := CASE WHEN v_min_uzs > 0 AND v_rate > 0 THEN round(v_min_uzs / v_rate, 2) ELSE 0 END;
    ELSE
      -- USD
      v_cost_usd := round(coalesce(v_raw_cost, 0), 2);
      v_cost_uzs := round(v_cost_usd * v_rate);

      v_retail_usd := round(coalesce(v_raw_retail, 0), 2);
      v_retail_uzs := round(v_retail_usd * v_rate);

      v_wholesale_usd := CASE WHEN v_raw_wholesale IS NOT NULL AND v_raw_wholesale > 0 THEN round(v_raw_wholesale, 2) ELSE 0 END;
      v_wholesale_uzs := round(v_wholesale_usd * v_rate);

      v_min_usd := CASE WHEN v_raw_min IS NOT NULL AND v_raw_min > 0 THEN round(v_raw_min, 2) ELSE 0 END;
      v_min_uzs := round(v_min_usd * v_rate);
    END IF;

    -- Update stock_batches
    UPDATE public.stock_batches
    SET unit_cost = v_cost_uzs,
        unit_cost_usd = v_cost_usd,
        retail_price = v_retail_uzs,
        retail_price_usd = v_retail_usd,
        wholesale_price = v_wholesale_uzs,
        wholesale_price_usd = v_wholesale_usd,
        minimum_sale_price = coalesce(nullif(v_min_uzs, 0), nullif(v_wholesale_uzs, 0), v_retail_uzs),
        minimum_sale_price_usd = coalesce(nullif(v_min_usd, 0), nullif(v_wholesale_usd, 0), v_retail_usd),
        currency = v_curr
    WHERE id = v_batch_rec.id;

    v_updated_batches := v_updated_batches + 1;

    -- Update products
    UPDATE public.products
    SET cost_price = v_cost_uzs,
        cost_price_usd = v_cost_usd,
        retail_price = v_retail_uzs,
        retail_price_usd = v_retail_usd,
        wholesale_price = v_wholesale_uzs,
        wholesale_price_usd = v_wholesale_usd,
        minimum_sale_price = coalesce(nullif(v_min_uzs, 0), nullif(v_wholesale_uzs, 0), v_retail_uzs),
        minimum_sale_price_usd = coalesce(nullif(v_min_usd, 0), nullif(v_wholesale_usd, 0), v_retail_usd),
        currency = v_curr,
        updated_at = now()
    WHERE id = v_batch_rec.product_id;

    IF NOT (v_batch_rec.product_id = ANY(v_seen_products)) THEN
      v_seen_products := array_append(v_seen_products, v_batch_rec.product_id);
      v_updated_products := v_updated_products + 1;
    END IF;

    -- Update product_variants if variant_id is present
    IF v_batch_rec.variant_id IS NOT NULL THEN
      UPDATE public.product_variants
      SET cost_price = v_cost_uzs,
          cost_price_usd = v_cost_usd,
          retail_price = v_retail_uzs,
          retail_price_usd = v_retail_usd,
          wholesale_price = v_wholesale_uzs,
          wholesale_price_usd = v_wholesale_usd,
          minimum_sale_price = coalesce(nullif(v_min_uzs, 0), nullif(v_wholesale_uzs, 0), v_retail_uzs),
          minimum_sale_price_usd = coalesce(nullif(v_min_usd, 0), nullif(v_wholesale_usd, 0), v_retail_usd),
          updated_at = now()
      WHERE id = v_batch_rec.variant_id;

      IF NOT (v_batch_rec.variant_id = ANY(v_seen_variants)) THEN
        v_seen_variants := array_append(v_seen_variants, v_batch_rec.variant_id);
        v_updated_variants := v_updated_variants + 1;
      END IF;
    END IF;

    -- Track affected receipt
    IF v_batch_rec.receipt_id IS NOT NULL AND NOT (v_batch_rec.receipt_id = ANY(v_affected_receipts)) THEN
      v_affected_receipts := array_append(v_affected_receipts, v_batch_rec.receipt_id);
    END IF;
  END LOOP;

  -- Process affected receipts: update currency
  FOREACH v_rec_id IN ARRAY v_affected_receipts LOOP
    UPDATE public.stock_receipts
    SET currency = p_currency
    WHERE id = v_rec_id;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'currency', p_currency,
    'exchange_rate', v_rate,
    'updated_batches', v_updated_batches,
    'updated_products', v_updated_products,
    'updated_variants', v_updated_variants,
    'not_found_count', jsonb_array_length(v_not_found),
    'not_found', v_not_found
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bulk_update_batch_prices(uuid, text, jsonb) TO authenticated, service_role, anon;

-- Force postgrest cache reload
NOTIFY pgrst, 'reload schema';
