-- ==============================================================================
-- Migration: 20261016000000_fix_exchange_rate_sync_minimum_price_constraint.sql
-- Description: Fix "products_minimum_sale_price_chk" check constraint violation
--              when saving USD exchange rate.
--              1. Hardens normalize_product_minimum_sale_price() trigger function
--                 to always ensure minimum_sale_price <= retail_price and >= 0.
--              2. Updates sync_usd_prices_on_rate_change() to safely calculate
--                 minimum_sale_price without exceeding retail_price.
--              3. Repairs any existing product, batch or variant where
--                 minimum_sale_price_usd > retail_price_usd or minimum > retail.
-- ==============================================================================

-- 1. Repair any existing inconsistent data in products, stock_batches, and variants
UPDATE public.products
SET minimum_sale_price = LEAST(minimum_sale_price, retail_price),
    minimum_sale_price_usd = CASE
      WHEN retail_price_usd IS NOT NULL AND retail_price_usd > 0 AND minimum_sale_price_usd > retail_price_usd
      THEN retail_price_usd
      ELSE minimum_sale_price_usd
    END
WHERE (minimum_sale_price > retail_price AND retail_price IS NOT NULL)
   OR (retail_price_usd IS NOT NULL AND retail_price_usd > 0 AND minimum_sale_price_usd > retail_price_usd);

UPDATE public.stock_batches
SET minimum_sale_price = LEAST(minimum_sale_price, retail_price),
    minimum_sale_price_usd = CASE
      WHEN retail_price_usd IS NOT NULL AND retail_price_usd > 0 AND minimum_sale_price_usd > retail_price_usd
      THEN retail_price_usd
      ELSE minimum_sale_price_usd
    END
WHERE (minimum_sale_price > retail_price AND retail_price IS NOT NULL)
   OR (retail_price_usd IS NOT NULL AND retail_price_usd > 0 AND minimum_sale_price_usd > retail_price_usd);

UPDATE public.product_variants
SET minimum_sale_price = LEAST(minimum_sale_price, retail_price),
    minimum_sale_price_usd = CASE
      WHEN retail_price_usd IS NOT NULL AND retail_price_usd > 0 AND minimum_sale_price_usd > retail_price_usd
      THEN retail_price_usd
      ELSE minimum_sale_price_usd
    END
WHERE (minimum_sale_price > retail_price AND retail_price IS NOT NULL)
   OR (retail_price_usd IS NOT NULL AND retail_price_usd > 0 AND minimum_sale_price_usd > retail_price_usd);

-- 2. Harden normalize_product_minimum_sale_price trigger
CREATE OR REPLACE FUNCTION public.normalize_product_minimum_sale_price()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- 1. If minimum_sale_price is NULL, default to least of cost and retail
  IF new.minimum_sale_price IS NULL THEN
    new.minimum_sale_price := LEAST(COALESCE(new.cost_price, new.retail_price, 0), COALESCE(new.retail_price, 0));
  END IF;

  -- 2. Always ensure minimum_sale_price >= 0
  IF new.minimum_sale_price < 0 THEN
    new.minimum_sale_price := 0;
  END IF;

  -- 3. Always ensure minimum_sale_price <= retail_price
  IF new.retail_price IS NOT NULL AND new.retail_price >= 0 AND new.minimum_sale_price > new.retail_price THEN
    new.minimum_sale_price := new.retail_price;
  END IF;

  -- 4. If USD product, keep USD fields within bounds as well
  IF new.currency = 'USD' AND new.retail_price_usd IS NOT NULL AND new.retail_price_usd > 0 THEN
    IF new.minimum_sale_price_usd IS NOT NULL AND new.minimum_sale_price_usd > new.retail_price_usd THEN
      new.minimum_sale_price_usd := new.retail_price_usd;
    END IF;
  END IF;

  RETURN new;
END $$;

-- 3. Update sync_usd_prices_on_rate_change with defensive bounds
CREATE OR REPLACE FUNCTION public.sync_usd_prices_on_rate_change(p_new_rate numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prod_usd_count integer := 0;
  v_prod_uzs_count integer := 0;
  v_batch_usd_count integer := 0;
  v_batch_uzs_count integer := 0;
  v_var_count integer := 0;
BEGIN
  IF p_new_rate IS NULL OR p_new_rate <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid rate');
  END IF;

  -- 1. FAQAT USD bo'lgan tovarlar: USD narxi o'zgarmaydi, faqat so'mdagi narxi yangi kurs bo'yicha yangilanadi!
  WITH u AS (
    UPDATE public.products
    SET
      cost_price = CASE
        WHEN cost_price_usd IS NOT NULL AND cost_price_usd > 0 THEN round(cost_price_usd * p_new_rate)
        ELSE cost_price
      END,
      retail_price = CASE
        WHEN retail_price_usd IS NOT NULL AND retail_price_usd > 0 THEN round(retail_price_usd * p_new_rate)
        ELSE retail_price
      END,
      wholesale_price = CASE
        WHEN wholesale_price_usd IS NOT NULL AND wholesale_price_usd > 0 THEN round(wholesale_price_usd * p_new_rate)
        ELSE wholesale_price
      END,
      minimum_sale_price = CASE
        WHEN minimum_sale_price_usd IS NOT NULL AND minimum_sale_price_usd > 0 THEN
          LEAST(
            round(minimum_sale_price_usd * p_new_rate),
            CASE WHEN retail_price_usd IS NOT NULL AND retail_price_usd > 0 THEN round(retail_price_usd * p_new_rate) ELSE retail_price END
          )
        ELSE
          LEAST(
            minimum_sale_price,
            CASE WHEN retail_price_usd IS NOT NULL AND retail_price_usd > 0 THEN round(retail_price_usd * p_new_rate) ELSE retail_price END
          )
      END,
      minimum_sale_price_usd = CASE
        WHEN retail_price_usd IS NOT NULL AND retail_price_usd > 0 AND minimum_sale_price_usd > retail_price_usd THEN retail_price_usd
        ELSE minimum_sale_price_usd
      END,
      updated_at = now()
    WHERE currency = 'USD'
    RETURNING 1
  )
  SELECT count(*) INTO v_prod_usd_count FROM u;

  -- 2. UZS bo'lgan tovarlar: So'mdagi narxi 1 TIYINGA HAM O'ZGARMAYDI! Faqat USD ekvivalenti yangilanadi!
  WITH u AS (
    UPDATE public.products
    SET
      cost_price_usd = CASE
        WHEN cost_price IS NOT NULL AND cost_price > 0 THEN round(cost_price / p_new_rate, 2)
        ELSE cost_price_usd
      END,
      retail_price_usd = CASE
        WHEN retail_price IS NOT NULL AND retail_price > 0 THEN round(retail_price / p_new_rate, 2)
        ELSE retail_price_usd
      END,
      wholesale_price_usd = CASE
        WHEN wholesale_price IS NOT NULL AND wholesale_price > 0 THEN round(wholesale_price / p_new_rate, 2)
        ELSE wholesale_price_usd
      END,
      minimum_sale_price_usd = CASE
        WHEN minimum_sale_price IS NOT NULL AND minimum_sale_price > 0 THEN round(minimum_sale_price / p_new_rate, 2)
        ELSE minimum_sale_price_usd
      END,
      updated_at = now()
    WHERE currency = 'UZS' OR currency IS NULL OR currency != 'USD'
    RETURNING 1
  )
  SELECT count(*) INTO v_prod_uzs_count FROM u;

  -- 3. Variantlar: agar mahsulot USD bo'lsa so'm narxi, agar UZS bo'lsa faqat USD narxi yangilanadi
  WITH u AS (
    UPDATE public.product_variants pv
    SET
      retail_price = CASE
        WHEN p.currency = 'USD' AND pv.retail_price_usd IS NOT NULL AND pv.retail_price_usd > 0 THEN round(pv.retail_price_usd * p_new_rate)
        ELSE pv.retail_price
      END,
      retail_price_usd = CASE
        WHEN p.currency = 'USD' THEN pv.retail_price_usd
        WHEN pv.retail_price IS NOT NULL AND pv.retail_price > 0 THEN round(pv.retail_price / p_new_rate, 2)
        ELSE pv.retail_price_usd
      END,
      wholesale_price = CASE
        WHEN p.currency = 'USD' AND pv.wholesale_price_usd IS NOT NULL AND pv.wholesale_price_usd > 0 THEN round(pv.wholesale_price_usd * p_new_rate)
        ELSE pv.wholesale_price
      END,
      wholesale_price_usd = CASE
        WHEN p.currency = 'USD' THEN pv.wholesale_price_usd
        WHEN pv.wholesale_price IS NOT NULL AND pv.wholesale_price > 0 THEN round(pv.wholesale_price / p_new_rate, 2)
        ELSE pv.wholesale_price_usd
      END,
      minimum_sale_price = CASE
        WHEN p.currency = 'USD' AND pv.minimum_sale_price_usd IS NOT NULL AND pv.minimum_sale_price_usd > 0 THEN
          LEAST(
            round(pv.minimum_sale_price_usd * p_new_rate),
            CASE WHEN pv.retail_price_usd IS NOT NULL AND pv.retail_price_usd > 0 THEN round(pv.retail_price_usd * p_new_rate) ELSE pv.retail_price END
          )
        ELSE pv.minimum_sale_price
      END,
      minimum_sale_price_usd = CASE
        WHEN p.currency = 'USD' THEN
          CASE
            WHEN pv.retail_price_usd IS NOT NULL AND pv.retail_price_usd > 0 AND pv.minimum_sale_price_usd > pv.retail_price_usd THEN pv.retail_price_usd
            ELSE pv.minimum_sale_price_usd
          END
        WHEN pv.minimum_sale_price IS NOT NULL AND pv.minimum_sale_price > 0 THEN round(pv.minimum_sale_price / p_new_rate, 2)
        ELSE pv.minimum_sale_price_usd
      END,
      cost_price = CASE
        WHEN p.currency = 'USD' AND pv.cost_price_usd IS NOT NULL AND pv.cost_price_usd > 0 THEN round(pv.cost_price_usd * p_new_rate)
        ELSE pv.cost_price
      END,
      cost_price_usd = CASE
        WHEN p.currency = 'USD' THEN pv.cost_price_usd
        WHEN pv.cost_price IS NOT NULL AND pv.cost_price > 0 THEN round(pv.cost_price / p_new_rate, 2)
        ELSE pv.cost_price_usd
      END,
      updated_at = now()
    FROM public.products p
    WHERE pv.product_id = p.id
    RETURNING 1
  )
  SELECT count(*) INTO v_var_count FROM u;

  -- 4. Partiyalar (stock_batches): USD partiyalar faqat so'm narxlarini yangilaydi
  WITH u AS (
    UPDATE public.stock_batches
    SET
      unit_cost = CASE
        WHEN unit_cost_usd IS NOT NULL AND unit_cost_usd > 0 THEN round(unit_cost_usd * p_new_rate)
        ELSE unit_cost
      END,
      retail_price = CASE
        WHEN retail_price_usd IS NOT NULL AND retail_price_usd > 0 THEN round(retail_price_usd * p_new_rate)
        ELSE retail_price
      END,
      wholesale_price = CASE
        WHEN wholesale_price_usd IS NOT NULL AND wholesale_price_usd > 0 THEN round(wholesale_price_usd * p_new_rate)
        ELSE wholesale_price
      END,
      minimum_sale_price = CASE
        WHEN minimum_sale_price_usd IS NOT NULL AND minimum_sale_price_usd > 0 THEN
          LEAST(
            round(minimum_sale_price_usd * p_new_rate),
            CASE WHEN retail_price_usd IS NOT NULL AND retail_price_usd > 0 THEN round(retail_price_usd * p_new_rate) ELSE retail_price END
          )
        ELSE
          LEAST(
            minimum_sale_price,
            CASE WHEN retail_price_usd IS NOT NULL AND retail_price_usd > 0 THEN round(retail_price_usd * p_new_rate) ELSE retail_price END
          )
      END,
      minimum_sale_price_usd = CASE
        WHEN retail_price_usd IS NOT NULL AND retail_price_usd > 0 AND minimum_sale_price_usd > retail_price_usd THEN retail_price_usd
        ELSE minimum_sale_price_usd
      END
    WHERE currency = 'USD'
    RETURNING 1
  )
  SELECT count(*) INTO v_batch_usd_count FROM u;

  -- UZS partiyalar: So'm narxi o'zgarmaydi, faqat USD ekvivalenti yangilanadi
  WITH u AS (
    UPDATE public.stock_batches
    SET
      unit_cost_usd = CASE
        WHEN unit_cost IS NOT NULL AND unit_cost > 0 THEN round(unit_cost / p_new_rate, 2)
        ELSE unit_cost_usd
      END,
      retail_price_usd = CASE
        WHEN retail_price IS NOT NULL AND retail_price > 0 THEN round(retail_price / p_new_rate, 2)
        ELSE retail_price_usd
      END,
      wholesale_price_usd = CASE
        WHEN wholesale_price IS NOT NULL AND wholesale_price > 0 THEN round(wholesale_price / p_new_rate, 2)
        ELSE wholesale_price_usd
      END,
      minimum_sale_price_usd = CASE
        WHEN minimum_sale_price IS NOT NULL AND minimum_sale_price > 0 THEN round(minimum_sale_price / p_new_rate, 2)
        ELSE minimum_sale_price_usd
      END
    WHERE currency = 'UZS' OR currency IS NULL OR currency != 'USD'
    RETURNING 1
  )
  SELECT count(*) INTO v_batch_uzs_count FROM u;

  RETURN jsonb_build_object(
    'ok', true,
    'rate', p_new_rate,
    'usd_products_updated', v_prod_usd_count,
    'uzs_products_updated', v_prod_uzs_count,
    'variants_updated', v_var_count,
    'usd_batches_updated', v_batch_usd_count,
    'uzs_batches_updated', v_batch_uzs_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_usd_prices_on_rate_change(numeric) TO authenticated, service_role;
