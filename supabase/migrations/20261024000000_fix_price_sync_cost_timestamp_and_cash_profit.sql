-- ==============================================================================
-- Migration: 20261024000000_fix_price_sync_cost_timestamp_and_cash_profit.sql
-- Description:
-- 1. Tannarx oxirgi o'zgargan vaqti: Add cost_price_updated_at column and trigger
--    to public.products, return it in list_inventory_balances.
-- 2. Kassa sahifasida bugungi sof foyda: Add confirmed_today_cost, confirmed_today_profit
--    and confirmed_today_net_profit in list_pos_pending_sales summary.
-- 3. Minimal tan/sotish narxi saqlanganda sotish narxi bilan teng bo'lib qolishi:
--    Fix receive_stock, update_stock_receipt, and update_batch_prices so minimum_sale_price
--    defaults to existing minimum_sale_price or cost_price, NEVER blindly to retail_price.
-- 4. Managerda narx o'zgarganda Storefrontda eski narx qolib ketishi:
--    - Add AFTER UPDATE trigger on public.products to automatically cascade price changes
--      to public.stock_batches and public.product_variants.
--    - Update storefront_catalog_faceted, storefront_catalog and storefront_products_by_ids
--      to prioritize canonical product retail_price.
--    - Retroactively synchronize all batches and variants.
-- ==============================================================================
BEGIN;
-- ==============================================================================
-- 1. ADD cost_price_updated_at TO public.products & TRIGGER
-- ==============================================================================
ALTER TABLE public.products
ADD COLUMN IF NOT EXISTS cost_price_updated_at timestamptz DEFAULT now();
CREATE OR REPLACE FUNCTION public.handle_product_cost_price_timestamp() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' AS $$ BEGIN IF TG_OP = 'INSERT' THEN NEW.cost_price_updated_at := coalesce(NEW.cost_price_updated_at, now());
ELSIF TG_OP = 'UPDATE' THEN IF (
  OLD.cost_price IS DISTINCT
  FROM NEW.cost_price
    OR OLD.cost_price_usd IS DISTINCT
  FROM NEW.cost_price_usd
) THEN NEW.cost_price_updated_at := now();
ELSE NEW.cost_price_updated_at := coalesce(
  NEW.cost_price_updated_at,
  OLD.cost_price_updated_at,
  now()
);
END IF;
END IF;
RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_product_cost_price_timestamp ON public.products;
CREATE TRIGGER trg_product_cost_price_timestamp BEFORE
INSERT
  OR
UPDATE OF cost_price,
  cost_price_usd,
  cost_price_updated_at ON public.products FOR EACH ROW EXECUTE FUNCTION public.handle_product_cost_price_timestamp();
-- Backfill cost_price_updated_at
UPDATE public.products p
SET cost_price_updated_at = coalesce(
    (
      SELECT h.changed_at
      FROM public.product_price_history h
      WHERE h.product_id = p.id
        AND (
          h.previous_prices ? 'cost_price'
          AND (h.previous_prices->>'cost_price')::numeric IS DISTINCT
          FROM h.cost_price
        )
      ORDER BY h.changed_at DESC
      LIMIT 1
    ), (
      SELECT sb.created_at
      FROM public.stock_batches sb
      WHERE sb.product_id = p.id
        AND sb.unit_cost > 0
      ORDER BY sb.created_at DESC
      LIMIT 1
    ), p.updated_at, p.created_at, now()
  )
WHERE cost_price_updated_at IS NULL;
-- ==============================================================================
-- 2. CASCADE PRODUCT PRICE CHANGES TO ALL BATCHES AND VARIANTS
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.cascade_product_price_changes() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' AS $$ BEGIN IF (
    OLD.retail_price IS DISTINCT
    FROM NEW.retail_price
      OR OLD.retail_price_usd IS DISTINCT
    FROM NEW.retail_price_usd
      OR OLD.cost_price IS DISTINCT
    FROM NEW.cost_price
      OR OLD.cost_price_usd IS DISTINCT
    FROM NEW.cost_price_usd
      OR OLD.wholesale_price IS DISTINCT
    FROM NEW.wholesale_price
      OR OLD.wholesale_price_usd IS DISTINCT
    FROM NEW.wholesale_price_usd
      OR OLD.minimum_sale_price IS DISTINCT
    FROM NEW.minimum_sale_price
      OR OLD.minimum_sale_price_usd IS DISTINCT
    FROM NEW.minimum_sale_price_usd
  ) THEN -- 1. Cascade to all stock_batches
UPDATE public.stock_batches
SET retail_price = NEW.retail_price,
  retail_price_usd = coalesce(NEW.retail_price_usd, retail_price_usd),
  wholesale_price = coalesce(NEW.wholesale_price, wholesale_price),
  wholesale_price_usd = coalesce(NEW.wholesale_price_usd, wholesale_price_usd),
  minimum_sale_price = coalesce(NEW.minimum_sale_price, minimum_sale_price),
  minimum_sale_price_usd = coalesce(
    NEW.minimum_sale_price_usd,
    minimum_sale_price_usd
  ),
  unit_cost = NEW.cost_price,
  unit_cost_usd = coalesce(NEW.cost_price_usd, unit_cost_usd)
WHERE product_id = NEW.id;
-- 2. Cascade to all product_variants
UPDATE public.product_variants
SET retail_price = NEW.retail_price,
  retail_price_usd = coalesce(NEW.retail_price_usd, retail_price_usd),
  cost_price = NEW.cost_price,
  cost_price_usd = coalesce(NEW.cost_price_usd, cost_price_usd),
  wholesale_price = coalesce(NEW.wholesale_price, wholesale_price),
  wholesale_price_usd = coalesce(NEW.wholesale_price_usd, wholesale_price_usd),
  minimum_sale_price = coalesce(NEW.minimum_sale_price, minimum_sale_price),
  minimum_sale_price_usd = coalesce(
    NEW.minimum_sale_price_usd,
    minimum_sale_price_usd
  ),
  updated_at = now()
WHERE product_id = NEW.id;
END IF;
RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_cascade_product_price_changes ON public.products;
CREATE TRIGGER trg_cascade_product_price_changes
AFTER
UPDATE OF retail_price,
  retail_price_usd,
  cost_price,
  cost_price_usd,
  wholesale_price,
  wholesale_price_usd,
  minimum_sale_price,
  minimum_sale_price_usd ON public.products FOR EACH ROW EXECUTE FUNCTION public.cascade_product_price_changes();
-- ==============================================================================
-- 3. HARDEN normalize_product_minimum_sale_price
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.normalize_product_minimum_sale_price() RETURNS trigger LANGUAGE plpgsql
SET search_path = '' AS $$ BEGIN -- 1. If minimum_sale_price is NULL or 0, default to least of cost and retail
  IF new.minimum_sale_price IS NULL
  OR new.minimum_sale_price = 0 THEN new.minimum_sale_price := LEAST(
    COALESCE(new.cost_price, new.retail_price, 0),
    COALESCE(new.retail_price, 0)
  );
END IF;
-- 2. Always ensure minimum_sale_price >= 0
IF new.minimum_sale_price < 0 THEN new.minimum_sale_price := 0;
END IF;
-- 3. Always ensure minimum_sale_price <= retail_price
IF new.retail_price IS NOT NULL
AND new.retail_price >= 0
AND new.minimum_sale_price > new.retail_price THEN new.minimum_sale_price := new.retail_price;
END IF;
-- 4. If USD product, keep USD fields within bounds as well
IF new.currency = 'USD'
AND new.retail_price_usd IS NOT NULL
AND new.retail_price_usd > 0 THEN IF new.minimum_sale_price_usd IS NOT NULL
AND new.minimum_sale_price_usd > new.retail_price_usd THEN new.minimum_sale_price_usd := new.retail_price_usd;
END IF;
END IF;
RETURN new;
END $$;
-- ==============================================================================
-- 4. REPAIR CORRUPTED MINIMUM PRICES & SYNC EXISTING BATCHES AND VARIANTS
-- ==============================================================================
-- Where minimum_sale_price was corrupted to equal retail_price when cost_price < retail_price:
UPDATE public.products
SET minimum_sale_price = cost_price,
  minimum_sale_price_usd = coalesce(
    cost_price_usd,
    case
      when currency = 'USD' then cost_price
      else null
    end
  )
WHERE minimum_sale_price = retail_price
  AND retail_price > cost_price
  AND cost_price > 0;
-- Sync ALL variants to canonical product prices
UPDATE public.product_variants pv
SET cost_price = p.cost_price,
  cost_price_usd = p.cost_price_usd,
  retail_price = p.retail_price,
  retail_price_usd = p.retail_price_usd,
  wholesale_price = coalesce(pv.wholesale_price, p.wholesale_price),
  wholesale_price_usd = coalesce(pv.wholesale_price_usd, p.wholesale_price_usd),
  minimum_sale_price = coalesce(p.minimum_sale_price, pv.minimum_sale_price),
  minimum_sale_price_usd = coalesce(
    p.minimum_sale_price_usd,
    pv.minimum_sale_price_usd
  ),
  updated_at = now()
FROM public.products p
WHERE pv.product_id = p.id
  AND (
    p.cost_price > 0
    OR p.retail_price > 0
  );
-- Sync ALL stock_batches to canonical product prices
UPDATE public.stock_batches sb
SET retail_price = p.retail_price,
  retail_price_usd = p.retail_price_usd,
  wholesale_price = coalesce(p.wholesale_price, sb.wholesale_price),
  wholesale_price_usd = coalesce(p.wholesale_price_usd, sb.wholesale_price_usd),
  minimum_sale_price = coalesce(p.minimum_sale_price, sb.minimum_sale_price),
  minimum_sale_price_usd = coalesce(
    p.minimum_sale_price_usd,
    sb.minimum_sale_price_usd
  ),
  unit_cost = p.cost_price,
  unit_cost_usd = coalesce(p.cost_price_usd, sb.unit_cost_usd),
  currency = coalesce(p.currency, sb.currency, 'USD')
FROM public.products p
WHERE sb.product_id = p.id
  AND (
    p.cost_price > 0
    OR p.retail_price > 0
  );
-- ==============================================================================
-- 5. UPDATE receive_stock (SAFE MINIMUM PRICE & COST TIMESTAMP)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.receive_stock(
    p_header jsonb,
    p_lines jsonb,
    p_idempotency_key uuid DEFAULT NULL::uuid
  ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' AS $$
DECLARE v_receipt uuid;
v_existing uuid;
v_existing_hash text;
v_request_hash text;
v_branch uuid;
v_location uuid;
v_supplier uuid;
v_line jsonb;
v_batch uuid;
v_unit uuid;
v_product record;
v_variant_id uuid;
v_currency text;
v_line_currency text;
v_branch_currency text;
v_rate numeric;
v_receipt_no text;
v_line_no integer := 0;
v_qty integer;
v_cost numeric(18, 2);
v_cost_usd numeric(18, 2);
v_retail numeric(18, 2);
v_retail_usd numeric(18, 2);
v_wholesale numeric(18, 2);
v_wholesale_usd numeric(18, 2);
v_minimum numeric(18, 2);
v_minimum_usd numeric(18, 2);
v_effective_minimum numeric(18, 2);
v_effective_minimum_usd numeric(18, 2);
v_serials jsonb;
v_serial text;
v_line_qr text;
v_unit_seq integer;
v_created_units integer := 0;
v_is_inventory boolean := false;
v_actor_id uuid;
v_paid_amount numeric(18, 2) := 0;
v_payment_status text := 'unpaid';
v_total_cost numeric(18, 2) := 0;
v_debt numeric(18, 2) := 0;
v_receipt_record jsonb;
v_retry_count integer := 0;
v_unique_receipt_no text;
BEGIN IF p_header IS NULL
OR jsonb_typeof(p_header) <> 'object' THEN RAISE EXCEPTION 'Partiya sarlavhasi (p_header) noto‘g‘ri' USING errcode = '22023';
END IF;
IF p_lines IS NULL
OR jsonb_typeof(p_lines) <> 'array'
OR jsonb_array_length(p_lines) = 0 THEN RAISE EXCEPTION 'Kamida bitta tovar qatori kiritilishi shart' USING errcode = '22023';
END IF;
v_branch := (p_header->>'branch_id')::uuid;
v_location := coalesce(
  (p_header->>'receiving_location_id')::uuid,
  (p_header->>'location_id')::uuid
);
v_supplier := nullif(btrim(p_header->>'supplier_id'), '')::uuid;
v_currency := upper(
  coalesce(nullif(btrim(p_header->>'currency'), ''), 'USD')
);
IF v_currency NOT IN ('UZS', 'USD') THEN v_currency := 'USD';
END IF;
IF v_branch IS NULL
OR v_location IS NULL THEN RAISE EXCEPTION 'Filial va qabul joylashuvi talab qilinadi' USING errcode = '22023';
END IF;
SELECT currency INTO v_branch_currency
FROM public.branches
WHERE id = v_branch;
IF v_branch_currency IS NULL THEN v_branch_currency := 'UZS';
END IF;
IF (p_header->>'notes') ILIKE '%inventarizatsiya%'
OR (p_header->>'notes') ILIKE '%inventar%'
OR (p_header->>'receipt_no') ILIKE 'INV-%' THEN v_is_inventory := true;
END IF;
v_rate := coalesce(
  nullif((p_header->>'exchange_rate')::numeric, 0),
  public.get_effective_exchange_rate('USD', 'UZS'),
  12800
);
IF v_rate <= 0 THEN v_rate := 12800;
END IF;
IF v_is_inventory THEN v_supplier := NULL;
v_paid_amount := 0;
v_payment_status := 'paid';
ELSE v_paid_amount := coalesce((p_header->>'paid_amount')::numeric, 0);
v_payment_status := coalesce(
  nullif(btrim(p_header->>'payment_status'), ''),
  'unpaid'
);
IF v_payment_status NOT IN ('unpaid', 'partial', 'paid') THEN v_payment_status := 'unpaid';
END IF;
END IF;
v_receipt_no := nullif(btrim(p_header->>'receipt_no'), '');
IF v_receipt_no IS NULL THEN IF v_is_inventory THEN v_receipt_no := 'INV-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || substr(md5(random()::text), 1, 4);
ELSE v_receipt_no := 'REC-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || substr(md5(random()::text), 1, 4);
END IF;
END IF;
v_request_hash := encode(
  sha256(
    concat_ws('|', p_header::text, coalesce(p_lines::text, ''))::bytea
  ),
  'hex'
);
IF p_idempotency_key IS NOT NULL THEN
SELECT id,
  request_hash INTO v_existing,
  v_existing_hash
FROM public.stock_receipts
WHERE idempotency_key = p_idempotency_key;
IF v_existing IS NOT NULL THEN IF v_existing_hash IS DISTINCT
FROM v_request_hash THEN RAISE EXCEPTION 'Takroriy so‘rov: idempotency_key boshqa ma''lumotlar bilan yuborilgan' USING errcode = '22023';
END IF;
v_receipt_record := public.get_stock_receipt(v_existing);
RETURN v_receipt_record || jsonb_build_object(
  'receipt_id',
  v_existing,
  'receipt',
  v_receipt_record
);
END IF;
END IF;
v_unique_receipt_no := v_receipt_no;
WHILE EXISTS(
  SELECT 1
  FROM public.stock_receipts
  WHERE receipt_no = v_unique_receipt_no
) LOOP v_retry_count := v_retry_count + 1;
IF v_is_inventory THEN v_unique_receipt_no := 'INV-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || substr(md5(random()::text || v_retry_count::text), 1, 4);
ELSE v_unique_receipt_no := 'REC-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || substr(md5(random()::text || v_retry_count::text), 1, 4);
END IF;
END LOOP;
v_receipt_no := v_unique_receipt_no;
-- Resolve actor safely
v_actor_id := auth.uid();
IF v_actor_id IS NULL THEN
SELECT id INTO v_actor_id
FROM public.profiles
WHERE is_active
LIMIT 1;
END IF;
IF v_actor_id IS NULL THEN
SELECT id INTO v_actor_id
FROM public.profiles
LIMIT 1;
END IF;
-- Create stock_receipts record
INSERT INTO public.stock_receipts(
    idempotency_key,
    branch_id,
    receiving_location_id,
    supplier_id,
    received_at,
    created_by,
    receipt_no,
    paid_amount,
    currency,
    request_hash,
    notes,
    payment_status
  )
VALUES (
    p_idempotency_key,
    v_branch,
    v_location,
    v_supplier,
    coalesce(
      (p_header->>'received_at')::timestamptz,
      clock_timestamp()
    ),
    v_actor_id,
    upper(btrim(v_receipt_no)),
    v_paid_amount,
    v_currency,
    v_request_hash,
    nullif(btrim(p_header->>'notes'), ''),
    v_payment_status
  )
RETURNING id INTO v_receipt;
-- Process lines
FOR v_line IN
SELECT *
FROM jsonb_array_elements(p_lines) LOOP v_line_no := v_line_no + 1;
v_qty := (v_line->>'quantity')::integer;
IF v_qty <= 0 THEN RAISE EXCEPTION '%-qatordagi mahsulot miqdori 0 dan katta bo‘lishi kerak',
v_line_no USING errcode = '22023';
END IF;
SELECT * INTO v_product
FROM public.products
WHERE id = (v_line->>'product_id')::uuid;
IF NOT FOUND THEN RAISE EXCEPTION '%-qatordagi mahsulot topilmadi',
v_line_no USING errcode = 'P0002';
END IF;
v_line_currency := upper(
  coalesce(
    nullif(btrim(v_line->>'currency'), ''),
    v_product.currency,
    v_currency
  )
);
IF v_line_currency NOT IN ('UZS', 'USD') THEN v_line_currency := 'USD';
END IF;
v_cost := (v_line->>'unit_cost')::numeric;
v_cost_usd := (v_line->>'unit_cost_usd')::numeric;
IF v_line_currency = 'USD' THEN IF v_cost_usd IS NOT NULL
AND v_cost_usd > 0 THEN v_cost := round(v_cost_usd * v_rate);
ELSIF v_cost < 20000 THEN v_cost_usd := v_cost;
v_cost := round(v_cost_usd * v_rate);
ELSE v_cost_usd := round(v_cost / v_rate, 2);
v_cost := round(v_cost);
END IF;
ELSE v_cost := round(v_cost);
IF v_cost_usd IS NULL THEN v_cost_usd := round(v_cost / v_rate, 2);
END IF;
END IF;
v_retail := nullif((v_line->>'retail_price')::numeric, 0);
v_retail_usd := nullif((v_line->>'retail_price_usd')::numeric, 0);
IF v_retail IS NOT NULL THEN IF v_line_currency = 'USD' THEN IF v_retail_usd IS NOT NULL
AND v_retail_usd > 0 THEN v_retail := round(v_retail_usd * v_rate);
ELSIF v_retail < 20000 THEN v_retail_usd := v_retail;
v_retail := round(v_retail_usd * v_rate);
ELSE v_retail_usd := round(v_retail / v_rate, 2);
v_retail := round(v_retail);
END IF;
ELSE v_retail := round(v_retail);
IF v_retail_usd IS NULL THEN v_retail_usd := round(v_retail / v_rate, 2);
END IF;
END IF;
END IF;
v_wholesale := nullif((v_line->>'wholesale_price')::numeric, 0);
v_wholesale_usd := nullif((v_line->>'wholesale_price_usd')::numeric, 0);
IF v_wholesale IS NOT NULL THEN IF v_line_currency = 'USD' THEN IF v_wholesale_usd IS NOT NULL
AND v_wholesale_usd > 0 THEN v_wholesale := round(v_wholesale_usd * v_rate);
ELSIF v_wholesale < 20000 THEN v_wholesale_usd := v_wholesale;
v_wholesale := round(v_wholesale_usd * v_rate);
ELSE v_wholesale_usd := round(v_wholesale / v_rate, 2);
v_wholesale := round(v_wholesale);
END IF;
ELSE v_wholesale := round(v_wholesale);
IF v_wholesale_usd IS NULL THEN v_wholesale_usd := round(v_wholesale / v_rate, 2);
END IF;
END IF;
END IF;
v_minimum := nullif((v_line->>'minimum_sale_price')::numeric, 0);
v_minimum_usd := nullif((v_line->>'minimum_sale_price_usd')::numeric, 0);
IF v_minimum IS NOT NULL THEN IF v_line_currency = 'USD' THEN IF v_minimum_usd IS NOT NULL
AND v_minimum_usd > 0 THEN v_minimum := round(v_minimum_usd * v_rate);
ELSIF v_minimum < 20000 THEN v_minimum_usd := v_minimum;
v_minimum := round(v_minimum_usd * v_rate);
ELSE v_minimum_usd := round(v_minimum / v_rate, 2);
v_minimum := round(v_minimum);
END IF;
ELSE v_minimum := round(v_minimum);
IF v_minimum_usd IS NULL THEN v_minimum_usd := round(v_minimum / v_rate, 2);
END IF;
END IF;
END IF;
-- CRITICAL FIX: Do NOT blindly coalesce to v_retail!
-- Default to existing product minimum sale price, or unit cost, but never default to retail price.
v_effective_minimum := coalesce(
  v_minimum,
  nullif(v_product.minimum_sale_price, 0),
  nullif(v_cost, 0),
  v_retail,
  0
);
IF v_retail IS NOT NULL
AND v_retail > 0
AND v_effective_minimum > v_retail THEN v_effective_minimum := v_retail;
END IF;
v_effective_minimum_usd := coalesce(
  v_minimum_usd,
  nullif(v_product.minimum_sale_price_usd, 0),
  nullif(v_cost_usd, 0),
  v_retail_usd,
  0
);
IF v_retail_usd IS NOT NULL
AND v_retail_usd > 0
AND v_effective_minimum_usd > v_retail_usd THEN v_effective_minimum_usd := v_retail_usd;
END IF;
v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
IF v_variant_id IS NULL
AND nullif(btrim(v_line->>'color_name'), '') IS NOT NULL THEN
SELECT id INTO v_variant_id
FROM public.product_variants
WHERE product_id = v_product.id
  AND lower(color_name) = lower(btrim(v_line->>'color_name'))
LIMIT 1;
IF v_variant_id IS NULL THEN
INSERT INTO public.product_variants(
    product_id,
    color_name,
    cost_price,
    cost_price_usd,
    retail_price,
    retail_price_usd,
    wholesale_price,
    wholesale_price_usd,
    minimum_sale_price,
    minimum_sale_price_usd
  )
VALUES (
    v_product.id,
    btrim(v_line->>'color_name'),
    v_cost,
    v_cost_usd,
    v_retail,
    v_retail_usd,
    v_wholesale,
    v_wholesale_usd,
    v_effective_minimum,
    v_effective_minimum_usd
  )
RETURNING id INTO v_variant_id;
END IF;
END IF;
v_serials := coalesce(v_line->'serials', '[]'::jsonb);
-- Create stock batch
INSERT INTO public.stock_batches(
    receipt_id,
    line_no,
    supplier_id,
    product_id,
    location_id,
    variant_id,
    quantity,
    unit_cost,
    unit_cost_usd,
    retail_price,
    retail_price_usd,
    wholesale_price,
    wholesale_price_usd,
    minimum_sale_price,
    minimum_sale_price_usd,
    currency,
    created_by,
    received_at,
    reference
  )
VALUES (
    v_receipt,
    v_line_no,
    v_supplier,
    v_product.id,
    v_location,
    v_variant_id,
    v_qty,
    v_cost,
    v_cost_usd,
    v_retail,
    v_retail_usd,
    v_wholesale,
    v_wholesale_usd,
    v_effective_minimum,
    v_effective_minimum_usd,
    v_line_currency,
    v_actor_id,
    coalesce(
      (p_header->>'received_at')::timestamptz,
      clock_timestamp()
    ),
    upper(btrim(v_receipt_no))
  )
RETURNING id INTO v_batch;
-- Update product prices and cascade to ALL existing batches and ALL variants for this product
IF v_retail IS NOT NULL THEN
UPDATE public.products
SET cost_price = v_cost,
  cost_price_usd = coalesce(v_cost_usd, cost_price_usd),
  retail_price = v_retail,
  retail_price_usd = coalesce(v_retail_usd, retail_price_usd),
  wholesale_price = coalesce(v_wholesale, wholesale_price),
  wholesale_price_usd = coalesce(v_wholesale_usd, wholesale_price_usd),
  minimum_sale_price = v_effective_minimum,
  minimum_sale_price_usd = v_effective_minimum_usd,
  currency = v_line_currency,
  cost_price_updated_at = now(),
  updated_at = now()
WHERE id = v_product.id;
UPDATE public.stock_batches
SET retail_price = v_retail,
  retail_price_usd = coalesce(v_retail_usd, retail_price_usd),
  wholesale_price = coalesce(v_wholesale, wholesale_price),
  wholesale_price_usd = coalesce(v_wholesale_usd, wholesale_price_usd),
  minimum_sale_price = v_effective_minimum,
  minimum_sale_price_usd = v_effective_minimum_usd,
  unit_cost = v_cost,
  unit_cost_usd = coalesce(v_cost_usd, unit_cost_usd)
WHERE product_id = v_product.id;
UPDATE public.product_variants
SET cost_price = v_cost,
  cost_price_usd = coalesce(v_cost_usd, cost_price_usd),
  retail_price = v_retail,
  retail_price_usd = coalesce(v_retail_usd, retail_price_usd),
  wholesale_price = coalesce(v_wholesale, wholesale_price),
  wholesale_price_usd = coalesce(v_wholesale_usd, wholesale_price_usd),
  minimum_sale_price = v_effective_minimum,
  minimum_sale_price_usd = v_effective_minimum_usd,
  updated_at = now()
WHERE product_id = v_product.id;
END IF;
-- Generate single unified QR for the batch
v_line_qr := public.generate_short_qr();
FOR v_unit_seq IN 1..v_qty LOOP v_serial := null;
IF jsonb_array_length(v_serials) >= v_unit_seq THEN v_serial := nullif(btrim(v_serials->>(v_unit_seq - 1)), '');
END IF;
INSERT INTO public.inventory_units(
    product_id,
    variant_id,
    batch_id,
    location_id,
    serial_number,
    status,
    qr_code,
    unit_sequence,
    created_at
  )
VALUES (
    v_product.id,
    v_variant_id,
    v_batch,
    v_location,
    v_serial,
    'available',
    v_line_qr,
    v_unit_seq,
    coalesce(
      (p_header->>'received_at')::timestamptz,
      clock_timestamp()
    )
  )
RETURNING id INTO v_unit;
v_created_units := v_created_units + 1;
-- Inventory movement
INSERT INTO public.inventory_movements(
    movement_type,
    product_id,
    unit_id,
    batch_id,
    to_location_id,
    quantity,
    unit_cost,
    actor_id,
    reason,
    reference_type,
    reference_id,
    metadata
  )
VALUES (
    'received'::public.movement_type,
    v_product.id,
    v_unit,
    v_batch,
    v_location,
    1,
    v_cost,
    v_actor_id,
    CASE
      WHEN v_is_inventory THEN 'Inventarizatsiya qabuli'
      ELSE 'Tovarlar qabuli'
    END,
    'stock_receipt',
    v_receipt,
    jsonb_build_object(
      'receipt_no',
      v_receipt_no,
      'line_no',
      v_line_no,
      'unit_sequence',
      v_unit_seq,
      'qr_code',
      v_line_qr
    )
  );
END LOOP;
v_total_cost := v_total_cost + (v_cost * v_qty);
END LOOP;
-- Supplier balance tracking if applicable
IF NOT v_is_inventory AND v_supplier IS NOT NULL THEN
  IF v_payment_status = 'unpaid' THEN
    v_debt := v_total_cost;
  ELSIF v_payment_status = 'partial' THEN
    v_debt := greatest(0, v_total_cost - v_paid_amount);
  ELSE
    v_debt := 0;
  END IF;

  IF v_debt > 0 THEN
    UPDATE public.suppliers
    SET balance = coalesce(balance, 0) + v_debt,
      updated_at = clock_timestamp()
    WHERE id = v_supplier;
  END IF;
END IF;
v_receipt_record := public.get_stock_receipt(v_receipt);
RETURN v_receipt_record || jsonb_build_object(
  'receipt_id',
  v_receipt,
  'receipt',
  v_receipt_record,
  'created_units',
  v_created_units
);
END;
$$;
GRANT EXECUTE ON FUNCTION public.receive_stock(jsonb, jsonb, uuid) TO authenticated,
  service_role;
-- ==============================================================================
-- 6. UPDATE STOREFRONT PROCEDURES TO GUARANTEE LATEST PRODUCT RETAIL PRICE
-- ==============================================================================
-- 6A. storefront_catalog_faceted
CREATE OR REPLACE FUNCTION public.storefront_catalog_faceted(
    p_filters jsonb default '{}'::jsonb,
    p_limit integer default 24,
    p_offset integer default 0
  ) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '' AS $$ WITH input AS (
    SELECT public.validate_storefront_catalog_filters(p_filters) f
  ),
  active_price_tiers AS (
    SELECT u.product_id,
      coalesce(p.retail_price, sb.retail_price) AS tier_price,
      coalesce(p.retail_price_usd, sb.retail_price_usd) AS tier_price_usd,
      count(u.id) AS tier_stock,
      (array_agg(sb.id)) [1] AS tier_batch_id,
      string_agg(distinct sr.receipt_no, ', ') AS tier_receipt_no
    FROM public.inventory_units u
      JOIN public.locations l ON l.id = u.location_id
      AND l.is_active
      AND l.type IN ('store', 'warehouse')
      JOIN public.products p ON p.id = u.product_id
      LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
      LEFT JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
    WHERE u.status = 'available'
      AND u.active_transfer_id IS NULL
    GROUP BY u.product_id,
      coalesce(p.retail_price, sb.retail_price),
      coalesce(p.retail_price_usd, sb.retail_price_usd)
    HAVING count(u.id) > 0
  ),
  product_tier_counts AS (
    SELECT product_id,
      count(*) AS tier_count
    FROM active_price_tiers
    GROUP BY product_id
  ),
  base AS (
    SELECT CASE
        WHEN coalesce(ptc.tier_count, 0) > 1 THEN p.id::text || '_' || round(apt.tier_price)::bigint::text
        ELSE p.id::text
      END AS id,
      p.id AS product_id,
      apt.tier_batch_id AS batch_id,
      apt.tier_receipt_no AS receipt_no,
      p.sku,
      p.barcode,
      p.category_id,
      p.brand_id,
      p.name,
      p.slug,
      p.description,
      p.retail_price AS retail_price,
      p.compare_at_price,
      CASE
        WHEN p.promotion_price IS NOT NULL
        AND p.promotion_price < p.retail_price THEN p.promotion_price
        ELSE null
      END AS promotion_price,
      coalesce(
        CASE
          WHEN p.promotion_price IS NOT NULL
          AND p.promotion_price < p.retail_price THEN p.promotion_price
          ELSE null
        END,
        p.retail_price
      ) AS effective_price,
      p.tax_rate,
      p.created_at,
      coalesce(
        (
          SELECT m.public_url
          FROM public.product_media m
          WHERE m.product_id = p.id
            AND m.variant_id IS NULL
          ORDER BY m.is_primary DESC,
            m.sort_order,
            m.id
          LIMIT 1
        ), p.seo_image_url
      ) AS primary_media_url,
      (
        SELECT coalesce(
            jsonb_agg(
              jsonb_build_object(
                'code',
                a.code,
                'name',
                a.name,
                'value',
                v.value,
                'is_filterable',
                a.is_filterable
              )
              ORDER BY a.sort_order,
                a.code
            ),
            '[]'::jsonb
          )
        FROM public.product_attribute_values v
          JOIN public.attribute_definitions a ON a.id = v.attribute_id
        WHERE v.product_id = p.id
      ) AS attributes,
      coalesce(apt.tier_stock, 0) AS available_stock,
      (
        SELECT round(avg(r.rating), 1)
        FROM public.product_reviews r
        WHERE r.product_id = p.id
          AND r.is_visible
      ) AS avg_rating,
      (
        SELECT count(*)
        FROM public.product_reviews r
        WHERE r.product_id = p.id
          AND r.is_visible
      ) AS review_count,
      (
        SELECT coalesce(
            jsonb_agg(
              to_jsonb(v)
              ORDER BY v.sort_order,
                v.id
            ),
            '[]'::jsonb
          )
        FROM (
            SELECT 'standard'::text AS id,
              'Standart'::text AS color_name,
              '#94A3B8'::text AS color_hex,
              coalesce(p.promotion_price, p.retail_price) AS price,
              (
                SELECT count(*)
                FROM public.inventory_units u
                WHERE u.product_id = p.id
                  AND u.variant_id IS NULL
                  AND u.status = 'available'
                  AND u.active_transfer_id IS NULL
              ) AS stock,
              coalesce(
                (
                  SELECT m.public_url
                  FROM public.product_media m
                  WHERE m.product_id = p.id
                    AND m.variant_id IS NULL
                  ORDER BY m.is_primary DESC,
                    m.sort_order,
                    m.id
                  LIMIT 1
                ), p.seo_image_url
              ) AS image,
              0 AS sort_order
            WHERE EXISTS (
                SELECT 1
                FROM public.product_variants pv
                WHERE pv.product_id = p.id
                  AND pv.is_active
              )
              AND EXISTS (
                SELECT 1
                FROM public.inventory_units u
                WHERE u.product_id = p.id
                  AND u.variant_id IS NULL
              )
              AND NOT EXISTS (
                SELECT 1
                FROM public.product_variants pv
                WHERE pv.product_id = p.id
                  AND lower(btrim(pv.color_name)) IN ('standart', 'standard', 'baza', 'asosiy')
              )
            UNION ALL
            SELECT pv.id::text AS id,
              pv.color_name,
              public.resolve_color_hex(pv.color_name, pv.color_hex) AS color_hex,
              coalesce(
                pv.promotion_price,
                p.retail_price,
                pv.retail_price
              ) AS price,
              (
                SELECT count(*)
                FROM public.inventory_units u
                WHERE u.variant_id = pv.id
                  AND u.status = 'available'
                  AND u.active_transfer_id IS NULL
              ) AS stock,
              (
                SELECT m.public_url
                FROM public.product_media m
                WHERE m.variant_id = pv.id
                ORDER BY m.is_primary DESC,
                  m.sort_order,
                  m.id
                LIMIT 1
              ) AS image,
              pv.sort_order + 1 AS sort_order
            FROM public.product_variants pv
            WHERE pv.product_id = p.id
              AND pv.is_active
          ) v
      ) AS variants
    FROM public.products p
      JOIN public.categories c ON c.id = p.category_id
      AND c.is_active
      LEFT JOIN public.brands br ON br.id = p.brand_id
      LEFT JOIN active_price_tiers apt ON apt.product_id = p.id
      LEFT JOIN product_tier_counts ptc ON ptc.product_id = p.id
    WHERE p.status = 'active'
      AND p.is_published
      AND (
        p.brand_id IS NULL
        OR br.is_active
      )
  ),
  searched AS (
    SELECT b.*
    FROM base b
      CROSS JOIN input i
    WHERE (
        nullif(btrim(i.f->>'query'), '') IS NULL
        OR concat_ws(
          ' ',
          b.name,
          b.sku,
          b.barcode,
          b.description,
          b.attributes::text
        ) ilike '%' || btrim(i.f->>'query') || '%'
      )
      AND (
        coalesce((i.f->>'in_stock')::boolean, false) = false
        OR b.available_stock > 0
      )
  ),
  priced AS (
    SELECT s.*
    FROM searched s
      CROSS JOIN input i
    WHERE (
        nullif(i.f->>'min_price', '') IS NULL
        OR s.effective_price >=(i.f->>'min_price')::numeric
      )
      AND (
        nullif(i.f->>'max_price', '') IS NULL
        OR s.effective_price <=(i.f->>'max_price')::numeric
      )
  ),
  category_scope AS (
    SELECT s.*
    FROM priced s
      CROSS JOIN input i
    WHERE coalesce(jsonb_array_length(i.f->'category_ids'), 0) = 0
      OR s.category_id::text IN (
        SELECT jsonb_array_elements_text(i.f->'category_ids')
      )
  ),
  brand_scope AS (
    SELECT s.*
    FROM priced s
      CROSS JOIN input i
    WHERE coalesce(jsonb_array_length(i.f->'brand_ids'), 0) = 0
      OR s.brand_id::text IN (
        SELECT jsonb_array_elements_text(i.f->'brand_ids')
      )
  ),
  selected_dimensions AS (
    SELECT s.*
    FROM priced s
      CROSS JOIN input i
    WHERE (
        coalesce(jsonb_array_length(i.f->'category_ids'), 0) = 0
        OR s.category_id::text IN (
          SELECT jsonb_array_elements_text(i.f->'category_ids')
        )
      )
      AND (
        coalesce(jsonb_array_length(i.f->'brand_ids'), 0) = 0
        OR s.brand_id::text IN (
          SELECT jsonb_array_elements_text(i.f->'brand_ids')
        )
      )
      AND (
        coalesce(
          (
            SELECT bool_and(
                EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(s.attributes) a
                  WHERE a->>'code' = kv.key
                    AND a->>'value' = kv.value
                )
              )
            FROM jsonb_each_text(i.f->'attributes') kv
          ),
          true
        )
      )
  ),
  total AS (
    SELECT count(*) c
    FROM selected_dimensions
  ),
  paged AS (
    SELECT d.*
    FROM selected_dimensions d
      CROSS JOIN input i
    ORDER BY CASE
        WHEN (i.f->>'sort') = 'price_asc' THEN d.effective_price
      END ASC NULLS LAST,
      CASE
        WHEN (i.f->>'sort') = 'price_desc' THEN d.effective_price
      END DESC NULLS LAST,
      CASE
        WHEN (i.f->>'sort') = 'newest' THEN d.created_at
      END DESC NULLS LAST,
      CASE
        WHEN (i.f->>'sort') = 'rating' THEN d.avg_rating
      END DESC NULLS LAST,
      CASE
        WHEN (i.f->>'sort') = 'popular' THEN d.available_stock
      END DESC NULLS LAST,
      d.name ASC
    LIMIT p_limit OFFSET p_offset
  )
SELECT jsonb_build_object(
    'total',
    coalesce(
      (
        SELECT c
        FROM total
      ),
      0
    ),
    'items',
    coalesce(
      (
        SELECT jsonb_agg(to_jsonb(p))
        FROM paged p
      ),
      '[]'::jsonb
    ),
    'facets',
    jsonb_build_object(
      'categories',
      coalesce(
        (
          SELECT jsonb_agg(
              jsonb_build_object(
                'id',
                c.id,
                'name',
                c.name,
                'slug',
                c.slug,
                'count',
                agg.cnt
              )
              ORDER BY agg.cnt DESC,
                c.name
            )
          FROM (
              SELECT s.category_id,
                count(DISTINCT s.product_id) cnt
              FROM brand_scope s
              GROUP BY s.category_id
            ) agg
            JOIN public.categories c ON c.id = agg.category_id
          WHERE c.is_active
        ),
        '[]'::jsonb
      ),
      'brands',
      coalesce(
        (
          SELECT jsonb_agg(
              jsonb_build_object(
                'id',
                b.id,
                'name',
                b.name,
                'slug',
                b.slug,
                'count',
                agg.cnt
              )
              ORDER BY agg.cnt DESC,
                b.name
            )
          FROM (
              SELECT s.brand_id,
                count(DISTINCT s.product_id) cnt
              FROM category_scope s
              WHERE s.brand_id IS NOT NULL
              GROUP BY s.brand_id
            ) agg
            JOIN public.brands b ON b.id = agg.brand_id
          WHERE b.is_active
        ),
        '[]'::jsonb
      ),
      'attributes',
      coalesce(
        (
          SELECT jsonb_object_agg(code, vals)
          FROM (
              SELECT a.code,
                jsonb_agg(
                  jsonb_build_object('value', a.val, 'count', a.cnt)
                  ORDER BY a.cnt DESC
                ) vals
              FROM (
                  SELECT attr->>'code' AS code,
                    attr->>'value' AS val,
                    count(DISTINCT s.product_id) cnt
                  FROM category_scope s,
                    jsonb_array_elements(s.attributes) attr
                  WHERE (attr->>'is_filterable')::boolean = true
                  GROUP BY attr->>'code',
                    attr->>'value'
                ) a
              GROUP BY a.code
            ) att
        ),
        '{}'::jsonb
      ),
      'price',
      (
        SELECT jsonb_build_object(
            'min',
            coalesce(min(effective_price), 0),
            'max',
            coalesce(max(effective_price), 0)
          )
        FROM searched
      )
    )
  );
$$;
GRANT EXECUTE ON FUNCTION public.storefront_catalog_faceted(jsonb, integer, integer) TO anon,
  authenticated,
  service_role;
-- 6B. storefront_catalog
CREATE OR REPLACE FUNCTION public.storefront_catalog(
    p_query text default null::text,
    p_category_id uuid default null::uuid,
    p_limit integer default 24,
    p_offset integer default 0
  ) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '' AS $function$ WITH active_price_tiers AS (
    SELECT u.product_id,
      coalesce(p.retail_price, sb.retail_price) AS tier_price,
      coalesce(p.retail_price_usd, sb.retail_price_usd) AS tier_price_usd,
      count(u.id) AS tier_stock,
      (array_agg(sb.id)) [1] AS tier_batch_id,
      string_agg(distinct sr.receipt_no, ', ') AS tier_receipt_no
    FROM public.inventory_units u
      JOIN public.locations l ON l.id = u.location_id
      AND l.is_active
      AND l.type IN ('store', 'warehouse')
      JOIN public.products p ON p.id = u.product_id
      LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
      LEFT JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
    WHERE u.status = 'available'
      AND u.active_transfer_id IS NULL
    GROUP BY u.product_id,
      coalesce(p.retail_price, sb.retail_price),
      coalesce(p.retail_price_usd, sb.retail_price_usd)
    HAVING count(u.id) > 0
  ),
  product_tier_counts AS (
    SELECT product_id,
      count(*) AS tier_count
    FROM active_price_tiers
    GROUP BY product_id
  ),
  base AS (
    SELECT CASE
        WHEN coalesce(ptc.tier_count, 0) > 1 THEN p.id::text || '_' || round(apt.tier_price)::bigint::text
        ELSE p.id::text
      END AS id,
      p.id AS product_id,
      apt.tier_batch_id AS batch_id,
      apt.tier_receipt_no AS receipt_no,
      p.sku,
      p.barcode,
      p.category_id,
      p.brand_id,
      br.name AS brand_name,
      p.name,
      p.slug,
      p.description,
      p.video_url,
      p.seo_title,
      p.seo_description,
      p.seo_image_url,
      p.retail_price AS retail_price,
      p.compare_at_price,
      CASE
        WHEN p.promotion_price IS NOT NULL
        AND p.promotion_price < p.retail_price THEN p.promotion_price
        ELSE null
      END AS promotion_price,
      coalesce(
        CASE
          WHEN p.promotion_price IS NOT NULL
          AND p.promotion_price < p.retail_price THEN p.promotion_price
          ELSE null
        END,
        p.retail_price
      ) AS effective_price,
      p.tax_rate,
      p.created_at,
      coalesce(
        (
          SELECT m.public_url
          FROM public.product_media m
          WHERE m.product_id = p.id
            AND m.variant_id IS NULL
          ORDER BY m.is_primary DESC,
            m.sort_order,
            m.id
          LIMIT 1
        ), p.seo_image_url
      ) AS primary_media_url,
      (
        SELECT coalesce(
            jsonb_agg(
              jsonb_build_object('code', a.code, 'name', a.name, 'value', v.value)
              ORDER BY a.sort_order,
                a.code
            ),
            '[]'::jsonb
          )
        FROM public.product_attribute_values v
          JOIN public.attribute_definitions a ON a.id = v.attribute_id
        WHERE v.product_id = p.id
      ) AS attributes,
      coalesce(apt.tier_stock, 0) AS available_stock,
      (
        SELECT coalesce(
            jsonb_agg(
              to_jsonb(v)
              ORDER BY v.sort_order,
                v.id
            ),
            '[]'::jsonb
          )
        FROM (
            SELECT 'standard'::text AS id,
              'Standart'::text AS color_name,
              '#94A3B8'::text AS color_hex,
              coalesce(p.promotion_price, p.retail_price) AS price,
              (
                SELECT count(*)
                FROM public.inventory_units u
                WHERE u.product_id = p.id
                  AND u.variant_id IS NULL
                  AND u.status = 'available'
                  AND u.active_transfer_id IS NULL
              ) AS stock,
              coalesce(
                (
                  SELECT m.public_url
                  FROM public.product_media m
                  WHERE m.product_id = p.id
                    AND m.variant_id IS NULL
                  ORDER BY m.is_primary DESC,
                    m.sort_order,
                    m.id
                  LIMIT 1
                ), p.seo_image_url
              ) AS image,
              0 AS sort_order
            WHERE EXISTS (
                SELECT 1
                FROM public.product_variants pv
                WHERE pv.product_id = p.id
                  AND pv.is_active
              )
              AND EXISTS (
                SELECT 1
                FROM public.inventory_units u
                WHERE u.product_id = p.id
                  AND u.variant_id IS NULL
              )
              AND NOT EXISTS (
                SELECT 1
                FROM public.product_variants pv
                WHERE pv.product_id = p.id
                  AND lower(btrim(pv.color_name)) IN ('standart', 'standard', 'baza', 'asosiy')
              )
            UNION ALL
            SELECT pv.id::text AS id,
              pv.color_name,
              public.resolve_color_hex(pv.color_name, pv.color_hex) AS color_hex,
              coalesce(
                pv.promotion_price,
                p.retail_price,
                pv.retail_price
              ) AS price,
              (
                SELECT count(*)
                FROM public.inventory_units u
                WHERE u.variant_id = pv.id
                  AND u.status = 'available'
                  AND u.active_transfer_id IS NULL
              ) AS stock,
              (
                SELECT m.public_url
                FROM public.product_media m
                WHERE m.variant_id = pv.id
                ORDER BY m.is_primary DESC,
                  m.sort_order,
                  m.id
                LIMIT 1
              ) AS image,
              pv.sort_order + 1 AS sort_order
            FROM public.product_variants pv
            WHERE pv.product_id = p.id
              AND pv.is_active
          ) v
      ) AS variants
    FROM public.products p
      JOIN public.categories c ON c.id = p.category_id
      AND c.is_active
      LEFT JOIN public.brands br ON br.id = p.brand_id
      LEFT JOIN active_price_tiers apt ON apt.product_id = p.id
      LEFT JOIN product_tier_counts ptc ON ptc.product_id = p.id
    WHERE p.status = 'active'
      AND p.is_published
      AND (
        p.brand_id IS NULL
        OR br.is_active
      )
      AND (
        p_category_id IS NULL
        OR p.category_id = p_category_id
      )
      AND (
        p_query IS NULL
        OR btrim(p_query) = ''
        OR p.name ILIKE ('%' || btrim(p_query) || '%')
        OR p.sku ILIKE ('%' || btrim(p_query) || '%')
      )
  )
SELECT jsonb_build_object(
    'total',
    coalesce(
      (
        SELECT count(*)
        FROM base
      ),
      0
    ),
    'items',
    coalesce(
      (
        SELECT jsonb_agg(
            to_jsonb(p)
            ORDER BY p.name
          )
        FROM (
            SELECT *
            FROM base
            LIMIT p_limit OFFSET p_offset
          ) p
      ),
      '[]'::jsonb
    )
  );
$function$;
GRANT EXECUTE ON FUNCTION public.storefront_catalog(text, uuid, integer, integer) TO anon,
  authenticated,
  service_role;
-- 6C. storefront_products_by_ids
CREATE OR REPLACE FUNCTION public.storefront_products_by_ids(p_product_ids uuid []) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '' AS $function$ WITH active_price_tiers AS (
    SELECT u.product_id,
      coalesce(p.retail_price, sb.retail_price) AS tier_price,
      coalesce(p.retail_price_usd, sb.retail_price_usd) AS tier_price_usd,
      count(u.id) AS tier_stock,
      (array_agg(sb.id)) [1] AS tier_batch_id,
      string_agg(distinct sr.receipt_no, ', ') AS tier_receipt_no
    FROM public.inventory_units u
      JOIN public.locations l ON l.id = u.location_id
      AND l.is_active
      AND l.type IN ('store', 'warehouse')
      JOIN public.products p ON p.id = u.product_id
      LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
      LEFT JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
    WHERE u.status = 'available'
      AND u.active_transfer_id IS NULL
      AND u.product_id = ANY(p_product_ids)
    GROUP BY u.product_id,
      coalesce(p.retail_price, sb.retail_price),
      coalesce(p.retail_price_usd, sb.retail_price_usd)
    HAVING count(u.id) > 0
  ),
  product_tier_counts AS (
    SELECT product_id,
      count(*) AS tier_count
    FROM active_price_tiers
    GROUP BY product_id
  ),
  base AS (
    SELECT p.id::text AS id,
      p.id AS product_id,
      apt.tier_batch_id AS batch_id,
      apt.tier_receipt_no AS receipt_no,
      p.sku,
      p.barcode,
      p.category_id,
      p.brand_id,
      br.name AS brand_name,
      p.name,
      p.slug,
      p.description,
      p.video_url,
      p.seo_title,
      p.seo_description,
      p.seo_image_url,
      p.retail_price AS retail_price,
      p.compare_at_price,
      CASE
        WHEN p.promotion_price IS NOT NULL
        AND p.promotion_price < p.retail_price THEN p.promotion_price
        ELSE null
      END AS promotion_price,
      coalesce(
        CASE
          WHEN p.promotion_price IS NOT NULL
          AND p.promotion_price < p.retail_price THEN p.promotion_price
          ELSE null
        END,
        p.retail_price
      ) AS effective_price,
      p.tax_rate,
      p.created_at,
      coalesce(
        (
          SELECT m.public_url
          FROM public.product_media m
          WHERE m.product_id = p.id
            AND m.variant_id IS NULL
          ORDER BY m.is_primary DESC,
            m.sort_order,
            m.id
          LIMIT 1
        ), p.seo_image_url
      ) AS primary_media_url,
      (
        SELECT coalesce(
            jsonb_agg(
              jsonb_build_object('code', a.code, 'name', a.name, 'value', v.value)
              ORDER BY a.sort_order,
                a.code
            ),
            '[]'::jsonb
          )
        FROM public.product_attribute_values v
          JOIN public.attribute_definitions a ON a.id = v.attribute_id
        WHERE v.product_id = p.id
      ) AS attributes,
      coalesce(apt.tier_stock, 0) AS available_stock,
      (
        SELECT coalesce(
            jsonb_agg(
              to_jsonb(v)
              ORDER BY v.sort_order,
                v.id
            ),
            '[]'::jsonb
          )
        FROM (
            SELECT 'standard'::text AS id,
              'Standart'::text AS color_name,
              '#94A3B8'::text AS color_hex,
              coalesce(p.promotion_price, p.retail_price) AS price,
              (
                SELECT count(*)
                FROM public.inventory_units u
                WHERE u.product_id = p.id
                  AND u.variant_id IS NULL
                  AND u.status = 'available'
                  AND u.active_transfer_id IS NULL
              ) AS stock,
              coalesce(
                (
                  SELECT m.public_url
                  FROM public.product_media m
                  WHERE m.product_id = p.id
                    AND m.variant_id IS NULL
                  ORDER BY m.is_primary DESC,
                    m.sort_order,
                    m.id
                  LIMIT 1
                ), p.seo_image_url
              ) AS image,
              0 AS sort_order
            WHERE EXISTS (
                SELECT 1
                FROM public.product_variants pv
                WHERE pv.product_id = p.id
                  AND pv.is_active
              )
              AND EXISTS (
                SELECT 1
                FROM public.inventory_units u
                WHERE u.product_id = p.id
                  AND u.variant_id IS NULL
              )
              AND NOT EXISTS (
                SELECT 1
                FROM public.product_variants pv
                WHERE pv.product_id = p.id
                  AND lower(btrim(pv.color_name)) IN ('standart', 'standard', 'baza', 'asosiy')
              )
            UNION ALL
            SELECT pv.id::text AS id,
              pv.color_name,
              public.resolve_color_hex(pv.color_name, pv.color_hex) AS color_hex,
              coalesce(
                pv.promotion_price,
                p.retail_price,
                pv.retail_price
              ) AS price,
              (
                SELECT count(*)
                FROM public.inventory_units u
                WHERE u.variant_id = pv.id
                  AND u.status = 'available'
                  AND u.active_transfer_id IS NULL
              ) AS stock,
              (
                SELECT m.public_url
                FROM public.product_media m
                WHERE m.variant_id = pv.id
                ORDER BY m.is_primary DESC,
                  m.sort_order,
                  m.id
                LIMIT 1
              ) AS image,
              pv.sort_order + 1 AS sort_order
            FROM public.product_variants pv
            WHERE pv.product_id = p.id
              AND pv.is_active
          ) v
      ) AS variants
    FROM public.products p
      JOIN public.categories c ON c.id = p.category_id
      AND c.is_active
      LEFT JOIN public.brands br ON br.id = p.brand_id
      LEFT JOIN active_price_tiers apt ON apt.product_id = p.id
      LEFT JOIN product_tier_counts ptc ON ptc.product_id = p.id
    WHERE p.id = ANY(p_product_ids)
      AND p.status = 'active'
      AND p.is_published
      AND (
        p.brand_id IS NULL
        OR br.is_active
      )
  )
SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
FROM base p;
$function$;
GRANT EXECUTE ON FUNCTION public.storefront_products_by_ids(uuid []) TO anon,
  authenticated,
  service_role;
-- ==============================================================================
-- 7. UPDATE list_inventory_balances TO INCLUDE cost_price_updated_at
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.list_inventory_balances(
    p_branch_id uuid DEFAULT NULL::uuid,
    p_location_id uuid DEFAULT NULL::uuid,
    p_query text DEFAULT NULL::text,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0,
    p_category_id uuid DEFAULT NULL::uuid,
    p_min_price numeric DEFAULT NULL::numeric,
    p_max_price numeric DEFAULT NULL::numeric,
    p_availability text DEFAULT NULL::text,
    p_has_image text DEFAULT NULL::text,
    p_sort_by text DEFAULT NULL::text
  ) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO '' AS $$
declare v_items jsonb;
v_total bigint;
v_total_on_hand numeric;
v_total_reserved numeric;
v_total_value numeric;
v_total_cost numeric;
v_target_branch uuid;
v_default_loc record;
begin if p_limit not between 1 and 5000
or p_offset < 0 then raise exception 'Sahifalash noto''g''ri';
end if;
v_target_branch := coalesce(
  p_branch_id,
  (
    select id
    from public.branches
    limit 1
  )
);
select l.id,
  l.name,
  l.type,
  br.name as branch_name into v_default_loc
from public.locations l
  join public.branches br on br.id = l.branch_id
where l.branch_id = v_target_branch
order by case
    when l.type = 'warehouse' then 1
    else 2
  end,
  l.created_at
limit 1;
with combined as (
  -- 1. Products that have explicit entries in inventory_balances
  select ib.location_id,
    l.name as location_name,
    l.type as location_type,
    l.branch_id,
    br.name as branch_name,
    p.id as product_id,
    p.name as product_name,
    p.sku,
    p.barcode,
    p.retail_price,
    p.cost_price,
    p.cost_price_updated_at,
    p.retail_price_usd,
    p.cost_price_usd,
    p.wholesale_price,
    p.wholesale_price_usd,
    p.minimum_sale_price,
    p.minimum_sale_price_usd,
    p.currency,
    p.category_id,
    c.name as category_name,
    ib.on_hand,
    ib.reserved,
    (ib.on_hand - ib.reserved) as available,
    ib.updated_at,
    p.created_at
  from public.inventory_balances ib
    join public.locations l on l.id = ib.location_id
    join public.branches br on br.id = l.branch_id
    join public.products p on p.id = ib.product_id
    left join public.categories c on c.id = p.category_id
  where public.can_access_branch(l.branch_id)
    and (
      v_target_branch is null
      or l.branch_id = v_target_branch
    )
    and (
      p_location_id is null
      or l.id = p_location_id
    )
    and p.status <> 'archived'
  union all
  -- 2. Products in catalog that have NO balance in this branch yet
  select v_default_loc.id as location_id,
    coalesce(v_default_loc.name, 'Asosiy ombor') as location_name,
    coalesce(v_default_loc.type, 'warehouse') as location_type,
    v_target_branch as branch_id,
    coalesce(v_default_loc.branch_name, 'Filial') as branch_name,
    p.id as product_id,
    p.name as product_name,
    p.sku,
    p.barcode,
    p.retail_price,
    p.cost_price,
    p.cost_price_updated_at,
    p.retail_price_usd,
    p.cost_price_usd,
    p.wholesale_price,
    p.wholesale_price_usd,
    p.minimum_sale_price,
    p.minimum_sale_price_usd,
    p.currency,
    p.category_id,
    c.name as category_name,
    0::numeric as on_hand,
    0::numeric as reserved,
    0::numeric as available,
    p.updated_at,
    p.created_at
  from public.products p
    left join public.categories c on c.id = p.category_id
  where p.status <> 'archived'
    and (
      p_location_id is null
      or p_location_id = v_default_loc.id
    )
    and not exists (
      select 1
      from public.inventory_balances ib2
        join public.locations l2 on l2.id = ib2.location_id
      where ib2.product_id = p.id
        and (
          v_target_branch is null
          or l2.branch_id = v_target_branch
        )
    )
),
filtered as (
  select c.*,
    (
      select m.public_url
      from public.product_media m
      where m.product_id = c.product_id
      order by m.is_primary desc,
        m.sort_order
      limit 1
    ) as image
  from combined c
  where (
      p_query is null
      or c.product_name ilike '%' || btrim(p_query) || '%'
      or c.sku ilike '%' || btrim(p_query) || '%'
      or coalesce(c.barcode, '') ilike '%' || btrim(p_query) || '%'
    )
    and (
      p_category_id is null
      or c.category_id = p_category_id
    )
    and (
      p_min_price is null
      or c.retail_price >= p_min_price
    )
    and (
      p_max_price is null
      or c.retail_price <= p_max_price
    )
    and (
      p_availability is null
      or (
        p_availability in ('in_stock', 'available')
        and c.available > 0
      )
      or (
        p_availability in ('out_of_stock', 'empty')
        and c.available <= 0
      )
    )
),
with_image_filter as (
  select f.*
  from filtered f
  where (
      p_has_image is null
      or p_has_image = ''
      or p_has_image = 'all'
      or (
        p_has_image in ('with_image', 'true', 'has_image')
        and f.image is not null
      )
      or (
        p_has_image in ('without_image', 'false', 'no_image')
        and f.image is null
      )
    )
),
aggregates as (
  select count(*)::bigint as cnt,
    coalesce(sum(on_hand), 0)::numeric as total_on_hand,
    coalesce(sum(reserved), 0)::numeric as total_reserved,
    coalesce(sum(on_hand * retail_price), 0)::numeric as total_value,
    coalesce(sum(on_hand * coalesce(cost_price, 0)), 0)::numeric as total_cost
  from with_image_filter
),
paged as (
  select *
  from with_image_filter
  order by case
      when p_sort_by = 'image_first' then (
        case
          when image is not null then 0
          else 1
        end
      )
    end asc,
    case
      when p_sort_by = 'no_image_first' then (
        case
          when image is null then 0
          else 1
        end
      )
    end asc,
    case
      when p_sort_by = 'price_desc' then retail_price
    end desc,
    case
      when p_sort_by = 'price_asc' then retail_price
    end asc,
    case
      when p_sort_by = 'qty_desc' then available
    end desc,
    case
      when p_sort_by = 'qty_asc' then available
    end asc,
    case
      when p_sort_by = 'name_asc' then product_name
    end asc,
    created_at desc,
    product_name asc
  limit p_limit offset p_offset
)
select coalesce(
    (
      select cnt
      from aggregates
    ),
    0
  ),
  coalesce(
    (
      select total_on_hand
      from aggregates
    ),
    0
  ),
  coalesce(
    (
      select total_reserved
      from aggregates
    ),
    0
  ),
  coalesce(
    (
      select total_value
      from aggregates
    ),
    0
  ),
  coalesce(
    (
      select total_cost
      from aggregates
    ),
    0
  ),
  coalesce(
    (
      select jsonb_agg(to_jsonb(p))
      from paged p
    ),
    '[]'::jsonb
  ) into v_total,
  v_total_on_hand,
  v_total_reserved,
  v_total_value,
  v_total_cost,
  v_items;
return jsonb_build_object(
  'items',
  v_items,
  'total',
  v_total,
  'total_on_hand',
  v_total_on_hand,
  'total_reserved',
  v_total_reserved,
  'total_value',
  v_total_value,
  'total_cost',
  v_total_cost
);
end;
$$;
GRANT EXECUTE ON FUNCTION public.list_inventory_balances(
    uuid,
    uuid,
    text,
    integer,
    integer,
    uuid,
    numeric,
    numeric,
    text,
    text,
    text
  ) TO authenticated,
  service_role;
-- ==============================================================================
-- 8. UPDATE list_pos_pending_sales TO INCLUDE SOF FOYDA (NET PROFIT)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.list_pos_pending_sales(
    p_branch_id uuid,
    p_status text DEFAULT NULL::text,
    p_query text DEFAULT NULL::text,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0,
    p_start_date date DEFAULT NULL::date,
    p_end_date date DEFAULT NULL::date,
    p_payment_filter text DEFAULT NULL::text,
    p_sort_by text DEFAULT 'created_desc'::text
  ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' AS $$
DECLARE v_items jsonb;
v_total bigint;
v_summary jsonb;
v_manager boolean;
v_q text := nullif(btrim(p_query), '');
v_status_filter text := nullif(btrim(p_status), '');
v_is_cod_filter boolean := (v_status_filter = 'cod');
v_is_nasiya_filter boolean := (v_status_filter = 'nasiya');
v_pay_filter text := lower(btrim(coalesce(p_payment_filter, 'all')));
v_sort_by text := lower(btrim(coalesce(p_sort_by, 'created_desc')));
v_total_revenue numeric := 0;
v_total_cost numeric := 0;
v_total_expense numeric := 0;
v_gross_profit numeric := 0;
v_net_profit numeric := 0;
BEGIN PERFORM public.require_pos_seller(p_branch_id);
IF p_limit NOT BETWEEN 1 AND 100
OR p_offset < 0 THEN RAISE EXCEPTION 'Sahifalash noto‘g‘ri' USING errcode = '22023';
END IF;
v_manager := public.has_role(
  array ['superadmin','admin']::public.app_role [],
  null
)
OR public.has_role(array ['manager']::public.app_role [], p_branch_id);
SELECT count(*) INTO v_total
FROM public.pos_pending_sales s
  LEFT JOIN public.profiles p ON p.id = s.seller_id
WHERE s.branch_id = p_branch_id
  AND (
    v_manager
    OR s.seller_id = auth.uid()
  )
  AND (
    (
      p_start_date IS NULL
      OR (
        coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent'
      )::date >= p_start_date
    )
    AND (
      p_end_date IS NULL
      OR (
        coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent'
      )::date <= p_end_date
    )
  )
  AND (
    CASE
      WHEN v_is_cod_filter THEN (
        EXISTS (
          SELECT 1
          FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id
            AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
          WHERE sa.pending_sale_id = s.id
            AND pm.code = 'cod'
            AND sp.amount > 0
        )
        OR EXISTS (
          SELECT 1
          FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
          WHERE pp.pending_sale_id = s.id
            AND pm.code = 'cod'
            AND pp.amount > 0
            AND NOT EXISTS (
              SELECT 1
              FROM public.sales sa2
              WHERE sa2.pending_sale_id = s.id
            )
        )
      )
      WHEN v_is_nasiya_filter THEN (
        EXISTS (
          SELECT 1
          FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id
            AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
          WHERE sa.pending_sale_id = s.id
            AND pm.code = 'nasiya'
            AND sp.amount > 0
        )
        OR EXISTS (
          SELECT 1
          FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
          WHERE pp.pending_sale_id = s.id
            AND pm.code = 'nasiya'
            AND pp.amount > 0
            AND NOT EXISTS (
              SELECT 1
              FROM public.sales sa2
              WHERE sa2.pending_sale_id = s.id
            )
        )
      )
      WHEN v_status_filter IS NOT NULL THEN (s.status::text = v_status_filter)
      ELSE true
    END
  )
  AND (
    CASE
      WHEN v_pay_filter = 'cod' THEN (
        EXISTS (
          SELECT 1
          FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id
            AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
          WHERE sa.pending_sale_id = s.id
            AND pm.code = 'cod'
            AND sp.amount > 0
        )
        OR EXISTS (
          SELECT 1
          FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
          WHERE pp.pending_sale_id = s.id
            AND pm.code = 'cod'
            AND pp.amount > 0
            AND NOT EXISTS (
              SELECT 1
              FROM public.sales sa2
              WHERE sa2.pending_sale_id = s.id
            )
        )
      )
      WHEN v_pay_filter = 'cash' THEN (
        EXISTS (
          SELECT 1
          FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id
            AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
          WHERE sa.pending_sale_id = s.id
            AND pm.code = 'cash'
            AND sp.amount > 0
        )
        OR EXISTS (
          SELECT 1
          FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
          WHERE pp.pending_sale_id = s.id
            AND pm.code = 'cash'
            AND pp.amount > 0
            AND NOT EXISTS (
              SELECT 1
              FROM public.sales sa2
              WHERE sa2.pending_sale_id = s.id
            )
        )
        OR (
          s.status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1
            FROM public.sales sa3
            WHERE sa3.pending_sale_id = s.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.pos_pending_sale_payments pp3
            WHERE pp3.pending_sale_id = s.id
          )
        )
      )
      WHEN v_pay_filter = 'card' THEN (
        EXISTS (
          SELECT 1
          FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id
            AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
          WHERE sa.pending_sale_id = s.id
            AND pm.code IN ('card', 'terminal', 'click', 'payme', 'uzum')
            AND sp.amount > 0
        )
        OR EXISTS (
          SELECT 1
          FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
          WHERE pp.pending_sale_id = s.id
            AND pm.code IN ('card', 'terminal', 'click', 'payme', 'uzum')
            AND pp.amount > 0
            AND NOT EXISTS (
              SELECT 1
              FROM public.sales sa2
              WHERE sa2.pending_sale_id = s.id
            )
        )
      )
      ELSE true
    END
  )
  AND (
    v_q IS NULL
    OR s.pending_no ILIKE '%' || v_q || '%'
    OR p.full_name ILIKE '%' || v_q || '%'
    OR EXISTS (
      SELECT 1
      FROM public.pos_pending_sale_lines xl
        JOIN public.products xpr ON xpr.id = xl.product_id
      WHERE xl.pending_sale_id = s.id
        AND xpr.name ILIKE '%' || v_q || '%'
    )
    OR EXISTS (
      SELECT 1
      FROM public.sales xsa
        JOIN public.sale_lines xsi ON xsi.sale_id = xsa.id
        JOIN public.products xpr2 ON xpr2.id = xsi.product_id
      WHERE xsa.pending_sale_id = s.id
        AND xpr2.name ILIKE '%' || v_q || '%'
    )
  );
SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) INTO v_items
FROM (
    SELECT s.id,
      s.pending_no,
      s.branch_id,
      s.store_location_id,
      l.name AS location_name,
      s.seller_id,
      p.full_name AS seller_name,
      s.customer_id,
      s.status,
      s.subtotal,
      s.discount,
      s.tax,
      s.total,
      s.notes,
      s.expires_at,
      s.created_at,
      s.updated_at,
      s.confirmed_at,
      (
        s.updated_at > s.created_at + interval '1 second'
      ) AS is_edited,
      (
        SELECT sa.id
        FROM public.sales sa
        WHERE sa.pending_sale_id = s.id
        LIMIT 1
      ) AS sale_id,
      (
        SELECT count(*)
        FROM public.pos_pending_sale_lines x
        WHERE x.pending_sale_id = s.id
      ) AS unit_count,
      (
        SELECT string_agg(
            CASE
              WHEN count > 1 THEN name || ' (' || count || ')'
              ELSE name
            END,
            ', '
          )
        FROM (
            SELECT pr.name,
              count(*) AS count
            FROM public.pos_pending_sale_lines x
              JOIN public.products pr ON pr.id = x.product_id
            WHERE x.pending_sale_id = s.id
            GROUP BY pr.id,
              pr.name
            ORDER BY min(x.created_at),
              pr.name
          ) sub
      ) AS product_names,
      (
        SELECT coalesce(
            jsonb_agg(
              jsonb_build_object(
                'id',
                x.id,
                'product_id',
                x.product_id,
                'product_name',
                pr.name,
                'unit_id',
                x.unit_id,
                'unit_price',
                x.unit_price,
                'line_total',
                x.line_total
              )
              ORDER BY x.created_at,
                x.id
            ),
            '[]'::jsonb
          )
        FROM public.pos_pending_sale_lines x
          JOIN public.products pr ON pr.id = x.product_id
        WHERE x.pending_sale_id = s.id
      ) AS lines,
      (
        SELECT jsonb_build_object(
            'id',
            c.id,
            'full_name',
            c.full_name,
            'phone',
            c.phone,
            'address',
            c.address->>'address'
          )
        FROM public.customers c
        WHERE c.id = s.customer_id
      ) AS customer,
      coalesce(
        (
          SELECT jsonb_agg(
              jsonb_build_object(
                'id',
                pmt.method_code,
                'method_code',
                pmt.method_code,
                'name',
                pmt.method_name,
                'amount',
                pmt.amount
              )
              ORDER BY pmt.sort_order
            )
          FROM (
              SELECT pm.code AS method_code,
                pm.name AS method_name,
                sp.amount,
                pm.sort_order
              FROM public.sales sa
                JOIN public.sale_payments sp ON sp.sale_id = sa.id
                AND sp.status IN ('paid', 'pending')
                JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
              WHERE sa.pending_sale_id = s.id
              UNION ALL
              SELECT pm.code AS method_code,
                pm.name AS method_name,
                pp.amount,
                pm.sort_order
              FROM public.pos_pending_sale_payments pp
                JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
              WHERE pp.pending_sale_id = s.id
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.sales sa2
                    JOIN public.sale_payments sp2 ON sp2.sale_id = sa2.id
                    AND sp2.status IN ('paid', 'pending')
                  WHERE sa2.pending_sale_id = s.id
                )
              UNION ALL
              SELECT 'cash' AS method_code,
                'Naqd' AS method_name,
                s.total AS amount,
                1 AS sort_order
              WHERE s.status = 'confirmed'
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.sales sa3
                    JOIN public.sale_payments sp3 ON sp3.sale_id = sa3.id
                    AND sp3.status IN ('paid', 'pending')
                  WHERE sa3.pending_sale_id = s.id
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.pos_pending_sale_payments pp3
                  WHERE pp3.pending_sale_id = s.id
                )
            ) pmt
        ),
        '[]'::jsonb
      ) AS payments,
      coalesce(
        (
          SELECT sum(sp.amount)
          FROM public.sales sa
            JOIN public.sale_payments sp ON sp.sale_id = sa.id
            AND sp.status IN ('paid', 'pending')
            JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
          WHERE sa.pending_sale_id = s.id
            AND pm.code = 'cash'
        ),
        (
          SELECT sum(pp.amount)
          FROM public.pos_pending_sale_payments pp
            JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
          WHERE pp.pending_sale_id = s.id
            AND pm.code = 'cash'
            AND NOT EXISTS (
              SELECT 1
              FROM public.sales sa2
              WHERE sa2.pending_sale_id = s.id
            )
        ),
        (
          CASE
            WHEN s.status = 'confirmed'
            AND NOT EXISTS (
              SELECT 1
              FROM public.sales sa3
              WHERE sa3.pending_sale_id = s.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.pos_pending_sale_payments pp3
              WHERE pp3.pending_sale_id = s.id
            ) THEN s.total
            ELSE 0
          END
        ),
        0
      ) AS cash_amount
    FROM public.pos_pending_sales s
      JOIN public.locations l ON l.id = s.store_location_id
      JOIN public.profiles p ON p.id = s.seller_id
    WHERE s.branch_id = p_branch_id
      AND (
        v_manager
        OR s.seller_id = auth.uid()
      )
      AND (
        (
          p_start_date IS NULL
          OR (
            coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent'
          )::date >= p_start_date
        )
        AND (
          p_end_date IS NULL
          OR (
            coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent'
          )::date <= p_end_date
        )
      )
      AND (
        CASE
          WHEN v_is_cod_filter THEN (
            EXISTS (
              SELECT 1
              FROM public.sales sa
                JOIN public.sale_payments sp ON sp.sale_id = sa.id
                AND sp.status IN ('paid', 'pending')
                JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
              WHERE sa.pending_sale_id = s.id
                AND pm.code = 'cod'
                AND sp.amount > 0
            )
            OR EXISTS (
              SELECT 1
              FROM public.pos_pending_sale_payments pp
                JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
              WHERE pp.pending_sale_id = s.id
                AND pm.code = 'cod'
                AND pp.amount > 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.sales sa2
                  WHERE sa2.pending_sale_id = s.id
                )
            )
          )
          WHEN v_is_nasiya_filter THEN (
            EXISTS (
              SELECT 1
              FROM public.sales sa
                JOIN public.sale_payments sp ON sp.sale_id = sa.id
                AND sp.status IN ('paid', 'pending')
                JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
              WHERE sa.pending_sale_id = s.id
                AND pm.code = 'nasiya'
                AND sp.amount > 0
            )
            OR EXISTS (
              SELECT 1
              FROM public.pos_pending_sale_payments pp
                JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
              WHERE pp.pending_sale_id = s.id
                AND pm.code = 'nasiya'
                AND pp.amount > 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.sales sa2
                  WHERE sa2.pending_sale_id = s.id
                )
            )
          )
          WHEN v_status_filter IS NOT NULL THEN (s.status::text = v_status_filter)
          ELSE true
        END
      )
      AND (
        CASE
          WHEN v_pay_filter = 'cod' THEN (
            EXISTS (
              SELECT 1
              FROM public.sales sa
                JOIN public.sale_payments sp ON sp.sale_id = sa.id
                AND sp.status IN ('paid', 'pending')
                JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
              WHERE sa.pending_sale_id = s.id
                AND pm.code = 'cod'
                AND sp.amount > 0
            )
            OR EXISTS (
              SELECT 1
              FROM public.pos_pending_sale_payments pp
                JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
              WHERE pp.pending_sale_id = s.id
                AND pm.code = 'cod'
                AND pp.amount > 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.sales sa2
                  WHERE sa2.pending_sale_id = s.id
                )
            )
          )
          WHEN v_pay_filter = 'cash' THEN (
            EXISTS (
              SELECT 1
              FROM public.sales sa
                JOIN public.sale_payments sp ON sp.sale_id = sa.id
                AND sp.status IN ('paid', 'pending')
                JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
              WHERE sa.pending_sale_id = s.id
                AND pm.code = 'cash'
                AND sp.amount > 0
            )
            OR EXISTS (
              SELECT 1
              FROM public.pos_pending_sale_payments pp
                JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
              WHERE pp.pending_sale_id = s.id
                AND pm.code = 'cash'
                AND pp.amount > 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.sales sa2
                  WHERE sa2.pending_sale_id = s.id
                )
            )
            OR (
              s.status = 'confirmed'
              AND NOT EXISTS (
                SELECT 1
                FROM public.sales sa3
                WHERE sa3.pending_sale_id = s.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM public.pos_pending_sale_payments pp3
                WHERE pp3.pending_sale_id = s.id
              )
            )
          )
          WHEN v_pay_filter = 'card' THEN (
            EXISTS (
              SELECT 1
              FROM public.sales sa
                JOIN public.sale_payments sp ON sp.sale_id = sa.id
                AND sp.status IN ('paid', 'pending')
                JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
              WHERE sa.pending_sale_id = s.id
                AND pm.code IN ('card', 'terminal', 'click', 'payme', 'uzum')
                AND sp.amount > 0
            )
            OR EXISTS (
              SELECT 1
              FROM public.pos_pending_sale_payments pp
                JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
              WHERE pp.pending_sale_id = s.id
                AND pm.code IN ('card', 'terminal', 'click', 'payme', 'uzum')
                AND pp.amount > 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.sales sa2
                  WHERE sa2.pending_sale_id = s.id
                )
            )
          )
          ELSE true
        END
      )
      AND (
        v_q IS NULL
        OR s.pending_no ILIKE '%' || v_q || '%'
        OR p.full_name ILIKE '%' || v_q || '%'
        OR EXISTS (
          SELECT 1
          FROM public.pos_pending_sale_lines xl
            JOIN public.products xpr ON xpr.id = xl.product_id
          WHERE xl.pending_sale_id = s.id
            AND xpr.name ILIKE '%' || v_q || '%'
        )
        OR EXISTS (
          SELECT 1
          FROM public.sales xsa
            JOIN public.sale_lines xsi ON xsi.sale_id = xsa.id
            JOIN public.products xpr2 ON xpr2.id = xsi.product_id
          WHERE xsa.pending_sale_id = s.id
            AND xpr2.name ILIKE '%' || v_q || '%'
        )
      )
    ORDER BY CASE
        WHEN v_sort_by = 'cash_desc' THEN coalesce(
          (
            SELECT sum(sp.amount)
            FROM public.sales sa
              JOIN public.sale_payments sp ON sp.sale_id = sa.id
              AND sp.status IN ('paid', 'pending')
              JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
            WHERE sa.pending_sale_id = s.id
              AND pm.code = 'cash'
          ),
          (
            SELECT sum(pp.amount)
            FROM public.pos_pending_sale_payments pp
              JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
            WHERE pp.pending_sale_id = s.id
              AND pm.code = 'cash'
              AND NOT EXISTS (
                SELECT 1
                FROM public.sales sa2
                WHERE sa2.pending_sale_id = s.id
              )
          ),
          (
            CASE
              WHEN s.status = 'confirmed'
              AND NOT EXISTS (
                SELECT 1
                FROM public.sales sa3
                WHERE sa3.pending_sale_id = s.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM public.pos_pending_sale_payments pp3
                WHERE pp3.pending_sale_id = s.id
              ) THEN s.total
              ELSE 0
            END
          ),
          0
        )
      END DESC NULLS LAST,
      CASE
        WHEN v_sort_by = 'cash_asc' THEN coalesce(
          (
            SELECT sum(sp.amount)
            FROM public.sales sa
              JOIN public.sale_payments sp ON sp.sale_id = sa.id
              AND sp.status IN ('paid', 'pending')
              JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
            WHERE sa.pending_sale_id = s.id
              AND pm.code = 'cash'
          ),
          (
            SELECT sum(pp.amount)
            FROM public.pos_pending_sale_payments pp
              JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
            WHERE pp.pending_sale_id = s.id
              AND pm.code = 'cash'
              AND NOT EXISTS (
                SELECT 1
                FROM public.sales sa2
                WHERE sa2.pending_sale_id = s.id
              )
          ),
          (
            CASE
              WHEN s.status = 'confirmed'
              AND NOT EXISTS (
                SELECT 1
                FROM public.sales sa3
                WHERE sa3.pending_sale_id = s.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM public.pos_pending_sale_payments pp3
                WHERE pp3.pending_sale_id = s.id
              ) THEN s.total
              ELSE 0
            END
          ),
          0
        )
      END ASC NULLS LAST,
      CASE
        WHEN v_sort_by = 'total_desc' THEN s.total
      END DESC NULLS LAST,
      CASE
        WHEN v_sort_by = 'total_asc' THEN s.total
      END ASC NULLS LAST,
      s.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) q;
WITH period_confirmed AS (
  SELECT s.id,
    s.branch_id,
    s.total
  FROM public.pos_pending_sales s
  WHERE s.branch_id = p_branch_id
    AND (
      v_manager
      OR s.seller_id = auth.uid()
    )
    AND s.status = 'confirmed'
    AND (
      (
        p_start_date IS NULL
        OR (
          coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent'
        )::date >= p_start_date
      )
      AND (
        p_end_date IS NULL
        OR (
          coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent'
        )::date <= p_end_date
      )
    )
),
sale_pmts AS (
  SELECT pc.id AS pending_id,
    pm.code AS method_code,
    sum(sp.amount) AS amount
  FROM period_confirmed pc
    JOIN public.sales sa ON sa.pending_sale_id = pc.id
    JOIN public.sale_payments sp ON sp.sale_id = sa.id
    AND sp.status IN ('paid', 'pending')
    JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
  GROUP BY pc.id,
    pm.code
),
fallback_pmts AS (
  SELECT pc.id AS pending_id,
    pm.code AS method_code,
    sum(pp.amount) AS amount
  FROM period_confirmed pc
    JOIN public.pos_pending_sale_payments pp ON pp.pending_sale_id = pc.id
    JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
  WHERE NOT EXISTS (
      SELECT 1
      FROM sale_pmts
      WHERE sale_pmts.pending_id = pc.id
    )
  GROUP BY pc.id,
    pm.code
),
default_cash AS (
  SELECT pc.id AS pending_id,
    'cash' AS method_code,
    pc.total AS amount
  FROM period_confirmed pc
  WHERE NOT EXISTS (
      SELECT 1
      FROM sale_pmts
      WHERE sale_pmts.pending_id = pc.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM fallback_pmts
      WHERE fallback_pmts.pending_id = pc.id
    )
),
all_period_pmts AS (
  SELECT *
  FROM sale_pmts
  UNION ALL
  SELECT *
  FROM fallback_pmts
  UNION ALL
  SELECT *
  FROM default_cash
),
confirmed_costs AS (
  SELECT coalesce(
      (
        SELECT sum(
            coalesce(sl.unit_cost, p.cost_price, 0) * coalesce(sl.quantity, 1)
          )
        FROM period_confirmed pc
          JOIN public.sales sa ON sa.pending_sale_id = pc.id
          JOIN public.sale_lines sl ON sl.sale_id = sa.id
          LEFT JOIN public.products p ON p.id = sl.product_id
      ),
      (
        SELECT sum(
            coalesce(sb.unit_cost, p.cost_price, 0) * coalesce(psl.quantity, 1)
          )
        FROM period_confirmed pc
          JOIN public.pos_pending_sale_lines psl ON psl.pending_sale_id = pc.id
          LEFT JOIN public.inventory_units u ON u.id = psl.unit_id
          LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
          LEFT JOIN public.products p ON p.id = psl.product_id
        WHERE NOT EXISTS (
            SELECT 1
            FROM public.sales sa2
            WHERE sa2.pending_sale_id = pc.id
          )
      ),
      0
    ) AS total_cost
)
SELECT coalesce(
    (
      SELECT sum(total)
      FROM period_confirmed
    ),
    0
  ),
  coalesce(
    (
      SELECT total_cost
      FROM confirmed_costs
    ),
    0
  ),
  coalesce(
    (
      SELECT sum(e.paid_amount)
      FROM public.expenses e
      WHERE e.branch_id = p_branch_id
        AND (
          (
            p_start_date IS NULL
            OR (
              coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent'
            )::date >= p_start_date
          )
          AND (
            p_end_date IS NULL
            OR (
              coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent'
            )::date <= p_end_date
          )
        )
    ),
    0
  ) INTO v_total_revenue,
  v_total_cost,
  v_total_expense;
v_gross_profit := v_total_revenue - v_total_cost;
v_net_profit := v_gross_profit - v_total_expense;
WITH period_confirmed AS (
  SELECT s.id,
    s.branch_id,
    s.total
  FROM public.pos_pending_sales s
  WHERE s.branch_id = p_branch_id
    AND (
      v_manager
      OR s.seller_id = auth.uid()
    )
    AND s.status = 'confirmed'
    AND (
      (
        p_start_date IS NULL
        OR (
          coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent'
        )::date >= p_start_date
      )
      AND (
        p_end_date IS NULL
        OR (
          coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent'
        )::date <= p_end_date
      )
    )
),
sale_pmts AS (
  SELECT pc.id AS pending_id,
    pm.code AS method_code,
    sum(sp.amount) AS amount
  FROM period_confirmed pc
    JOIN public.sales sa ON sa.pending_sale_id = pc.id
    JOIN public.sale_payments sp ON sp.sale_id = sa.id
    AND sp.status IN ('paid', 'pending')
    JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
  GROUP BY pc.id,
    pm.code
),
fallback_pmts AS (
  SELECT pc.id AS pending_id,
    pm.code AS method_code,
    sum(pp.amount) AS amount
  FROM period_confirmed pc
    JOIN public.pos_pending_sale_payments pp ON pp.pending_sale_id = pc.id
    JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
  WHERE NOT EXISTS (
      SELECT 1
      FROM sale_pmts
      WHERE sale_pmts.pending_id = pc.id
    )
  GROUP BY pc.id,
    pm.code
),
default_cash AS (
  SELECT pc.id AS pending_id,
    'cash' AS method_code,
    pc.total AS amount
  FROM period_confirmed pc
  WHERE NOT EXISTS (
      SELECT 1
      FROM sale_pmts
      WHERE sale_pmts.pending_id = pc.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM fallback_pmts
      WHERE fallback_pmts.pending_id = pc.id
    )
),
all_period_pmts AS (
  SELECT *
  FROM sale_pmts
  UNION ALL
  SELECT *
  FROM fallback_pmts
  UNION ALL
  SELECT *
  FROM default_cash
)
SELECT jsonb_build_object(
    'total_count',
    (
      SELECT count(*)
      FROM public.pos_pending_sales s5
      WHERE s5.branch_id = p_branch_id
        AND (
          v_manager
          OR s5.seller_id = auth.uid()
        )
        AND (
          (
            p_start_date IS NULL
            OR (
              coalesce(s5.confirmed_at, s5.created_at) AT TIME ZONE 'Asia/Tashkent'
            )::date >= p_start_date
          )
          AND (
            p_end_date IS NULL
            OR (
              coalesce(s5.confirmed_at, s5.created_at) AT TIME ZONE 'Asia/Tashkent'
            )::date <= p_end_date
          )
        )
    ),
    'pending_count',
    (
      SELECT count(*)
      FROM public.pos_pending_sales s3
      WHERE s3.branch_id = p_branch_id
        AND (
          v_manager
          OR s3.seller_id = auth.uid()
        )
        AND s3.status = 'pending'
        AND (
          (
            p_start_date IS NULL
            OR (s3.created_at AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date
          )
          AND (
            p_end_date IS NULL
            OR (s3.created_at AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date
          )
        )
    ),
    'pending_amount',
    coalesce(
      (
        SELECT sum(s3.total)
        FROM public.pos_pending_sales s3
        WHERE s3.branch_id = p_branch_id
          AND (
            v_manager
            OR s3.seller_id = auth.uid()
          )
          AND s3.status = 'pending'
          AND (
            (
              p_start_date IS NULL
              OR (s3.created_at AT TIME ZONE 'Asia/Tashkent')::date >= p_start_date
            )
            AND (
              p_end_date IS NULL
              OR (s3.created_at AT TIME ZONE 'Asia/Tashkent')::date <= p_end_date
            )
          )
      ),
      0
    ),
    'rejected_count',
    (
      SELECT count(*)
      FROM public.pos_pending_sales s4
      WHERE s4.branch_id = p_branch_id
        AND (
          v_manager
          OR s4.seller_id = auth.uid()
        )
        AND s4.status = 'rejected'
        AND (
          (
            p_start_date IS NULL
            OR (
              coalesce(s4.confirmed_at, s4.created_at) AT TIME ZONE 'Asia/Tashkent'
            )::date >= p_start_date
          )
          AND (
            p_end_date IS NULL
            OR (
              coalesce(s4.confirmed_at, s4.created_at) AT TIME ZONE 'Asia/Tashkent'
            )::date <= p_end_date
          )
        )
    ),
    'confirmed_today_count',
    (
      SELECT count(*)
      FROM period_confirmed
    ),
    'confirmed_today_amount',
    v_total_revenue,
    'confirmed_today_cost',
    v_total_cost,
    'confirmed_today_gross_profit',
    v_gross_profit,
    'confirmed_today_profit',
    v_gross_profit,
    'confirmed_today_net_profit',
    v_net_profit,
    'confirmed_today_cash',
    coalesce(
      (
        SELECT sum(amount)
        FROM all_period_pmts
        WHERE method_code = 'cash'
      ),
      0
    ),
    'confirmed_today_card',
    coalesce(
      (
        SELECT sum(amount)
        FROM all_period_pmts
        WHERE method_code IN ('card', 'terminal', 'click', 'payme', 'uzum')
      ),
      0
    ),
    'confirmed_today_cod',
    coalesce(
      (
        SELECT sum(amount)
        FROM all_period_pmts
        WHERE method_code = 'cod'
      ),
      0
    ),
    'confirmed_today_nasiya',
    coalesce(
      (
        SELECT sum(amount)
        FROM all_period_pmts
        WHERE method_code = 'nasiya'
      ),
      0
    ),
    'confirmed_today_other',
    coalesce(
      (
        SELECT sum(amount)
        FROM all_period_pmts
        WHERE method_code NOT IN (
            'cash',
            'card',
            'terminal',
            'click',
            'payme',
            'uzum',
            'cod',
            'nasiya'
          )
      ),
      0
    ),
    'confirmed_today_expense',
    v_total_expense,
    'confirmed_today_expense_count',
    (
      SELECT count(*)
      FROM public.expenses e
      WHERE e.branch_id = p_branch_id
        AND (
          (
            p_start_date IS NULL
            OR (
              coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent'
            )::date >= p_start_date
          )
          AND (
            p_end_date IS NULL
            OR (
              coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent'
            )::date <= p_end_date
          )
        )
    ),
    'confirmed_today_expense_cash',
    coalesce(
      (
        SELECT sum(e.paid_amount)
        FROM public.expenses e
        WHERE e.branch_id = p_branch_id
          AND coalesce(e.payment_method, 'cash') = 'cash'
          AND (
            (
              p_start_date IS NULL
              OR (
                coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent'
              )::date >= p_start_date
            )
            AND (
              p_end_date IS NULL
              OR (
                coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent'
              )::date <= p_end_date
            )
          )
      ),
      0
    ),
    'confirmed_today_expense_card',
    coalesce(
      (
        SELECT sum(e.paid_amount)
        FROM public.expenses e
        WHERE e.branch_id = p_branch_id
          AND coalesce(e.payment_method, 'cash') = 'card'
          AND (
            (
              p_start_date IS NULL
              OR (
                coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent'
              )::date >= p_start_date
            )
            AND (
              p_end_date IS NULL
              OR (
                coalesce(e.paid_at, e.created_at) AT TIME ZONE 'Asia/Tashkent'
              )::date <= p_end_date
            )
          )
      ),
      0
    ),
    'cod_count',
    (
      SELECT count(*)
      FROM public.pos_pending_sales s2
      WHERE s2.branch_id = p_branch_id
        AND (
          v_manager
          OR s2.seller_id = auth.uid()
        )
        AND s2.status <> 'rejected'
        AND (
          (
            p_start_date IS NULL
            OR (
              coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent'
            )::date >= p_start_date
          )
          AND (
            p_end_date IS NULL
            OR (
              coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent'
            )::date <= p_end_date
          )
        )
        AND (
          EXISTS (
            SELECT 1
            FROM public.sales sa
              JOIN public.sale_payments sp ON sp.sale_id = sa.id
              AND sp.status IN ('paid', 'pending')
              JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
            WHERE sa.pending_sale_id = s2.id
              AND pm.code = 'cod'
              AND sp.amount > 0
          )
          OR EXISTS (
            SELECT 1
            FROM public.pos_pending_sale_payments pp
              JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
            WHERE pp.pending_sale_id = s2.id
              AND pm.code = 'cod'
              AND pp.amount > 0
              AND NOT EXISTS (
                SELECT 1
                FROM public.sales sa2
                WHERE sa2.pending_sale_id = s2.id
              )
          )
        )
    ),
    'cod_total_amount',
    coalesce(
      (
        SELECT sum(
            CASE
              WHEN sa.id IS NOT NULL THEN sp.amount
              ELSE pp.amount
            END
          )
        FROM public.pos_pending_sales s2
          LEFT JOIN public.sales sa ON sa.pending_sale_id = s2.id
          LEFT JOIN public.sale_payments sp ON sp.sale_id = sa.id
          AND sp.status IN ('paid', 'pending')
          AND sp.payment_method_id = (
            SELECT id
            FROM public.payment_methods
            WHERE code = 'cod'
          )
          LEFT JOIN public.pos_pending_sale_payments pp ON pp.pending_sale_id = s2.id
          AND sa.id IS NULL
          AND pp.payment_method_id = (
            SELECT id
            FROM public.payment_methods
            WHERE code = 'cod'
          )
        WHERE s2.branch_id = p_branch_id
          AND (
            v_manager
            OR s2.seller_id = auth.uid()
          )
          AND s2.status <> 'rejected'
          AND (
            (
              p_start_date IS NULL
              OR (
                coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent'
              )::date >= p_start_date
            )
            AND (
              p_end_date IS NULL
              OR (
                coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent'
              )::date <= p_end_date
            )
          )
          AND (
            coalesce(sp.amount, 0) > 0
            OR coalesce(pp.amount, 0) > 0
          )
      ),
      0
    ),
    'nasiya_count',
    (
      SELECT count(*)
      FROM public.pos_pending_sales s2
      WHERE s2.branch_id = p_branch_id
        AND (
          v_manager
          OR s2.seller_id = auth.uid()
        )
        AND s2.status <> 'rejected'
        AND (
          (
            p_start_date IS NULL
            OR (
              coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent'
            )::date >= p_start_date
          )
          AND (
            p_end_date IS NULL
            OR (
              coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent'
            )::date <= p_end_date
          )
        )
        AND (
          EXISTS (
            SELECT 1
            FROM public.sales sa
              JOIN public.sale_payments sp ON sp.sale_id = sa.id
              AND sp.status IN ('paid', 'pending')
              JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
            WHERE sa.pending_sale_id = s2.id
              AND pm.code = 'nasiya'
              AND sp.amount > 0
          )
          OR EXISTS (
            SELECT 1
            FROM public.pos_pending_sale_payments pp
              JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
            WHERE pp.pending_sale_id = s2.id
              AND pm.code = 'nasiya'
              AND pp.amount > 0
              AND NOT EXISTS (
                SELECT 1
                FROM public.sales sa2
                WHERE sa2.pending_sale_id = s2.id
              )
          )
        )
    ),
    'nasiya_total_amount',
    coalesce(
      (
        SELECT sum(
            CASE
              WHEN sa.id IS NOT NULL THEN sp.amount
              ELSE pp.amount
            END
          )
        FROM public.pos_pending_sales s2
          LEFT JOIN public.sales sa ON sa.pending_sale_id = s2.id
          LEFT JOIN public.sale_payments sp ON sp.sale_id = sa.id
          AND sp.status IN ('paid', 'pending')
          AND sp.payment_method_id = (
            SELECT id
            FROM public.payment_methods
            WHERE code = 'nasiya'
          )
          LEFT JOIN public.pos_pending_sale_payments pp ON pp.pending_sale_id = s2.id
          AND sa.id IS NULL
          AND pp.payment_method_id = (
            SELECT id
            FROM public.payment_methods
            WHERE code = 'nasiya'
          )
        WHERE s2.branch_id = p_branch_id
          AND (
            v_manager
            OR s2.seller_id = auth.uid()
          )
          AND s2.status <> 'rejected'
          AND (
            (
              p_start_date IS NULL
              OR (
                coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent'
              )::date >= p_start_date
            )
            AND (
              p_end_date IS NULL
              OR (
                coalesce(s2.confirmed_at, s2.created_at) AT TIME ZONE 'Asia/Tashkent'
              )::date <= p_end_date
            )
          )
          AND (
            coalesce(sp.amount, 0) > 0
            OR coalesce(pp.amount, 0) > 0
          )
      ),
      0
    ),
    'period_start',
    p_start_date,
    'period_end',
    p_end_date
  ) INTO v_summary;
RETURN jsonb_build_object(
  'items',
  v_items,
  'total',
  v_total,
  'summary',
  v_summary
);
END;
$$;
GRANT EXECUTE ON FUNCTION public.list_pos_pending_sales(
    uuid,
    text,
    text,
    integer,
    integer,
    date,
    date,
    text,
    text
  ) TO authenticated,
  service_role;

NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';

COMMIT;