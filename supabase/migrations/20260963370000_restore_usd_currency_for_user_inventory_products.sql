-- 20260963370000_restore_usd_currency_for_user_inventory_products.sql
-- Restore currency = 'USD' for inventory products that were created in USD.
-- User entered these prices in USD:
-- GANLAN 9188: cost 147.50 USD, retail 167.00 USD
-- 1155LAK: cost 187.50 USD, retail 205.00 USD
-- X1-9 KOLYASKA: cost 75.00 USD, retail 95.00 USD
-- S500D kolyaska: cost 21.50 USD, retail 30.00 USD
-- 168DRON: cost 49.00 USD, retail 57.00 USD
-- K304 KOLYASKA: cost 61.00 USD, retail 75.00 USD

UPDATE public.products
SET currency = 'USD',
    cost_price_usd = 147.50,
    retail_price_usd = 167.00
WHERE name = 'Bolalar mashinasi GANLAN 9188';

UPDATE public.products
SET currency = 'USD',
    cost_price_usd = 187.50,
    retail_price_usd = 205.00
WHERE name = 'Bolalar mashinasi 1155LAK';

UPDATE public.products
SET currency = 'USD',
    cost_price_usd = 75.00,
    retail_price_usd = 95.00
WHERE name = 'X1-9 KOLYASKA';

UPDATE public.products
SET currency = 'USD',
    cost_price_usd = 21.50,
    retail_price_usd = 30.00
WHERE name = 'S500D kolyaska';

UPDATE public.products
SET currency = 'USD',
    cost_price_usd = 49.00,
    retail_price_usd = 57.00
WHERE name = 'Bolalar uchun kolyaska 168DRON';

UPDATE public.products
SET currency = 'USD',
    cost_price_usd = 61.00,
    retail_price_usd = 75.00
WHERE name = 'K304 KOLYASKA';

-- Update their stock_batches:
UPDATE public.stock_batches b
SET currency = 'USD',
    unit_cost_usd = p.cost_price_usd,
    retail_price_usd = p.retail_price_usd
FROM public.products p
WHERE b.product_id = p.id
  AND p.name IN (
    'Bolalar mashinasi GANLAN 9188',
    'Bolalar mashinasi 1155LAK',
    'X1-9 KOLYASKA',
    'S500D kolyaska',
    'Bolalar uchun kolyaska 168DRON',
    'K304 KOLYASKA'
  );

-- Update their stock_receipts:
UPDATE public.stock_receipts
SET currency = 'USD'
WHERE receipt_no IN (
  'INV-20261017-093537',
  'INV-20261017-092349',
  'INV-20261017-091004',
  'INV-20261017-090535',
  'INV-20261017-090253',
  'INV-20261017-085830'
);

-- Sync with current exchange rate:
DO $$
DECLARE
  v_latest_rate numeric;
BEGIN
  SELECT rate INTO v_latest_rate
  FROM public.exchange_rates
  WHERE currency_from = 'USD'
  ORDER BY rate_date DESC, created_at DESC
  LIMIT 1;

  IF v_latest_rate IS NOT NULL AND v_latest_rate > 0 THEN
    PERFORM public.sync_usd_prices_on_rate_change(v_latest_rate);
  END IF;
END;
$$;
