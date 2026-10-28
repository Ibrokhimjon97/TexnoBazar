-- Migration: 20261009000000_unify_latest_prices_across_batches_and_pos.sql
-- Description:
-- 1. Retroactively align all existing products and all their stock_batches to their latest batch/intake prices.
-- 2. Cascading price sync in receive_stock and update_stock_receipt: any new batch intake or price update
--    automatically updates all previous batches of that product in stock_batches.
-- 3. In get_pos_unit_context and find_pos_unit: POS scanner always applies the unified latest price of the product
--    (coalesce(pv.retail_price, p.retail_price, sb.retail_price)), regardless of which batch unit QR was scanned.
-- 4. Expose sync_all_batch_prices_to_latest() RPC for manual or automated re-synchronization.

BEGIN;

-- ============================================================================
-- 1. RETROACTIVE SYNC: Align all existing products and batches to latest prices
-- ============================================================================

-- A. Update products whose latest stock_batch has a newer or valid price
WITH latest_batches AS (
  SELECT DISTINCT ON (product_id)
    product_id,
    unit_cost,
    unit_cost_usd,
    retail_price,
    retail_price_usd,
    wholesale_price,
    wholesale_price_usd,
    minimum_sale_price,
    minimum_sale_price_usd,
    currency,
    created_at as batch_created_at
  FROM public.stock_batches
  WHERE retail_price > 0
  ORDER BY product_id, created_at DESC
)
UPDATE public.products p
SET 
  cost_price = CASE 
    WHEN lb.batch_created_at >= p.updated_at OR p.cost_price IS NULL OR p.cost_price = 0 THEN lb.unit_cost 
    ELSE p.cost_price 
  END,
  cost_price_usd = CASE 
    WHEN lb.batch_created_at >= p.updated_at OR p.cost_price_usd IS NULL OR p.cost_price_usd = 0 THEN lb.unit_cost_usd 
    ELSE p.cost_price_usd 
  END,
  retail_price = CASE 
    WHEN lb.batch_created_at >= p.updated_at OR p.retail_price IS NULL OR p.retail_price = 0 THEN lb.retail_price 
    ELSE p.retail_price 
  END,
  retail_price_usd = CASE 
    WHEN lb.batch_created_at >= p.updated_at OR p.retail_price_usd IS NULL OR p.retail_price_usd = 0 THEN lb.retail_price_usd 
    ELSE p.retail_price_usd 
  END,
  wholesale_price = coalesce(p.wholesale_price, lb.wholesale_price),
  wholesale_price_usd = coalesce(p.wholesale_price_usd, lb.wholesale_price_usd),
  minimum_sale_price = coalesce(p.minimum_sale_price, lb.minimum_sale_price),
  minimum_sale_price_usd = coalesce(p.minimum_sale_price_usd, lb.minimum_sale_price_usd),
  currency = coalesce(p.currency, lb.currency, 'UZS'),
  updated_at = now()
FROM latest_batches lb
WHERE p.id = lb.product_id;

-- B. Update all stock_batches to match the canonical latest product prices
UPDATE public.stock_batches sb
SET 
  retail_price = p.retail_price,
  retail_price_usd = p.retail_price_usd,
  wholesale_price = coalesce(p.wholesale_price, sb.wholesale_price),
  wholesale_price_usd = coalesce(p.wholesale_price_usd, sb.wholesale_price_usd),
  minimum_sale_price = coalesce(p.minimum_sale_price, sb.minimum_sale_price),
  minimum_sale_price_usd = coalesce(p.minimum_sale_price_usd, sb.minimum_sale_price_usd),
  unit_cost = p.cost_price,
  unit_cost_usd = coalesce(p.cost_price_usd, sb.unit_cost_usd),
  currency = coalesce(p.currency, sb.currency, 'UZS')
FROM public.products p
WHERE sb.product_id = p.id
  AND p.retail_price > 0
  AND (sb.retail_price <> p.retail_price OR sb.unit_cost <> p.cost_price);


-- ============================================================================
-- 2. HELPER RPC: sync_all_batch_prices_to_latest()
-- ============================================================================
CREATE OR REPLACE FUNCTION public.sync_all_batch_prices_to_latest()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF current_user <> 'postgres' 
     AND coalesce(current_setting('role', true), '') <> 'service_role'
     AND NOT (public.has_role(array['superadmin','admin']::public.app_role[], null) OR public.is_any_manager()) THEN
    RAISE EXCEPTION 'Ruxsat berilmagan' USING errcode = '42501';
  END IF;

  WITH updated AS (
    UPDATE public.stock_batches sb
    SET 
      retail_price = p.retail_price,
      retail_price_usd = p.retail_price_usd,
      wholesale_price = coalesce(p.wholesale_price, sb.wholesale_price),
      wholesale_price_usd = coalesce(p.wholesale_price_usd, sb.wholesale_price_usd),
      minimum_sale_price = coalesce(p.minimum_sale_price, sb.minimum_sale_price),
      minimum_sale_price_usd = coalesce(p.minimum_sale_price_usd, sb.minimum_sale_price_usd),
      unit_cost = p.cost_price,
      unit_cost_usd = coalesce(p.cost_price_usd, sb.unit_cost_usd),
      currency = coalesce(p.currency, sb.currency, 'UZS')
    FROM public.products p
    WHERE sb.product_id = p.id
      AND p.retail_price > 0
      AND (sb.retail_price <> p.retail_price OR sb.unit_cost <> p.cost_price)
    RETURNING sb.id
  )
  SELECT count(*) INTO v_count FROM updated;

  RETURN jsonb_build_object('ok', true, 'synced_batches_count', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_all_batch_prices_to_latest() TO authenticated, service_role;


-- ============================================================================
-- 3. UPDATE receive_stock: Cascade new batch prices to all existing batches
-- ============================================================================
CREATE OR REPLACE FUNCTION public.receive_stock(
  p_header jsonb,
  p_lines jsonb,
  p_idempotency_key uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_receipt uuid;
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
  v_cost numeric(18,2);
  v_cost_usd numeric(18,2);
  v_retail numeric(18,2);
  v_retail_usd numeric(18,2);
  v_wholesale numeric(18,2);
  v_wholesale_usd numeric(18,2);
  v_minimum numeric(18,2);
  v_minimum_usd numeric(18,2);
  v_effective_minimum numeric(18,2);
  v_serials jsonb;
  v_serial text;
  v_line_qr text;
  v_unit_seq integer;
  v_created_units integer := 0;
  v_seq integer := 0;
  v_is_inventory boolean := false;
  v_paid_amount numeric(18,2) := 0;
  v_supplier_payable numeric(18,2) := 0;
  v_receipt_total numeric(18,2) := 0;
  v_receipt_total_usd numeric(18,2) := 0;
  v_retry_count integer := 0;
  v_unique_receipt_no text;
BEGIN
  IF current_user <> 'postgres' 
     AND coalesce(current_setting('role', true), '') <> 'service_role'
     AND NOT (public.has_role(array['superadmin','admin']::public.app_role[], null) OR public.is_any_manager()) THEN
    RAISE EXCEPTION 'Partiya qabul qilish uchun ruxsat berilmagan' USING errcode = '42501';
  END IF;

  IF p_header IS NULL OR jsonb_typeof(p_header) <> 'object' THEN
    RAISE EXCEPTION 'Partiya sarlavhasi (p_header) noto‘g‘ri' USING errcode = '22023';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Kamida bitta tovar qatori kiritilishi shart' USING errcode = '22023';
  END IF;

  v_branch := (p_header->>'branch_id')::uuid;
  v_location := (p_header->>'receiving_location_id')::uuid;
  v_supplier := nullif(p_header->>'supplier_id', '')::uuid;
  v_currency := upper(coalesce(nullif(btrim(p_header->>'currency'), ''), 'USD'));
  IF v_currency NOT IN ('UZS', 'USD') THEN
    v_currency := 'USD';
  END IF;

  SELECT currency INTO v_branch_currency FROM public.branches WHERE id = v_branch;
  IF v_branch_currency IS NULL THEN
    v_branch_currency := 'UZS';
  END IF;

  IF (p_header->>'notes') ILIKE '%inventarizatsiya%' 
     OR (p_header->>'notes') ILIKE '%inventar%' 
     OR (p_header->>'receipt_no') ILIKE 'INV-%' THEN
    v_is_inventory := true;
  END IF;

  v_rate := coalesce(nullif((p_header->>'exchange_rate')::numeric, 0), public.get_effective_exchange_rate('USD', 'UZS'), 12800);
  IF v_rate <= 0 THEN v_rate := 12800; END IF;

  IF v_is_inventory THEN
    v_supplier := NULL;
    v_paid_amount := 0;
  ELSE
    IF v_supplier IS NULL THEN
      RAISE EXCEPTION 'Ta''minotchi tanlanishi shart' USING errcode = '22023';
    END IF;
    v_paid_amount := coalesce((p_header->>'paid_amount')::numeric, 0);
  END IF;

  v_receipt_no := nullif(btrim(p_header->>'receipt_no'), '');
  IF v_receipt_no IS NULL THEN
    IF v_is_inventory THEN
      v_receipt_no := 'INV-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || substr(md5(random()::text), 1, 4);
    ELSE
      v_receipt_no := 'REC-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || substr(md5(random()::text), 1, 4);
    END IF;
  END IF;

  v_request_hash := encode(extensions.digest(
    convert_to(jsonb_build_object(
      'branch_id', v_branch::text,
      'receiving_location_id', v_location::text,
      'supplier_id', v_supplier::text,
      'receipt_no', v_receipt_no,
      'lines', p_lines
    )::text, 'UTF8'),
    'sha256'
  ), 'hex');

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, request_hash INTO v_existing, v_existing_hash 
    FROM public.stock_receipts 
    WHERE idempotency_key = p_idempotency_key;

    IF v_existing IS NOT NULL THEN
      IF v_existing_hash <> v_request_hash THEN
        RAISE EXCEPTION 'Takroriy so‘rov: idempotency_key boshqa ma''lumotlar bilan yuborilgan' USING errcode = '22023';
      END IF;
      RETURN public.get_stock_receipt(v_existing);
    END IF;
  END IF;

  v_unique_receipt_no := v_receipt_no;
  WHILE EXISTS(SELECT 1 FROM public.stock_receipts WHERE receipt_no = v_unique_receipt_no) LOOP
    v_retry_count := v_retry_count + 1;
    IF v_is_inventory THEN
      v_unique_receipt_no := 'INV-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || substr(md5(random()::text || v_retry_count::text), 1, 4);
    ELSE
      v_unique_receipt_no := 'REC-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || substr(md5(random()::text || v_retry_count::text), 1, 4);
    END IF;
  END LOOP;
  v_receipt_no := v_unique_receipt_no;

  -- Stock Receipt yaratish
  BEGIN
    INSERT INTO public.stock_receipts(
      branch_id, receiving_location_id, supplier_id, receipt_no,
      invoice_number, received_at, status, total_cost, total_cost_usd,
      currency, exchange_rate, notes, idempotency_key, created_by,
      request_hash
    ) VALUES (
      v_branch, v_location, v_supplier, upper(btrim(v_receipt_no)),
      nullif(btrim(p_header->>'invoice_number'), ''),
      coalesce((p_header->>'received_at')::timestamptz, clock_timestamp()),
      'completed', 0, 0,
      v_currency, v_rate,
      nullif(btrim(p_header->>'notes'), ''),
      p_idempotency_key, auth.uid(),
      v_request_hash
    ) RETURNING id INTO v_receipt;
  EXCEPTION WHEN unique_violation THEN
    v_receipt_no := CASE WHEN v_is_inventory THEN 'INV-' ELSE 'REC-' END || 
                    to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || substr(md5(clock_timestamp()::text || random()::text), 1, 6);
    INSERT INTO public.stock_receipts(
      branch_id, receiving_location_id, supplier_id, receipt_no,
      invoice_number, received_at, status, total_cost, total_cost_usd,
      currency, exchange_rate, notes, idempotency_key, created_by,
      request_hash
    ) VALUES (
      v_branch, v_location, v_supplier, upper(btrim(v_receipt_no)),
      nullif(btrim(p_header->>'invoice_number'), ''),
      coalesce((p_header->>'received_at')::timestamptz, clock_timestamp()),
      'completed', 0, 0,
      v_currency, v_rate,
      nullif(btrim(p_header->>'notes'), ''),
      p_idempotency_key, auth.uid(),
      v_request_hash
    ) RETURNING id INTO v_receipt;
  END;

  -- Qatorlarni birma-bir qayta ishlash
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_line_no := v_line_no + 1;
    v_qty := (v_line->>'quantity')::integer;
    IF v_qty <= 0 THEN
      RAISE EXCEPTION '%-qatordagi mahsulot miqdori 0 dan katta bo‘lishi kerak', v_line_no USING errcode = '22023';
    END IF;

    SELECT * INTO v_product FROM public.products WHERE id = (v_line->>'product_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION '%-qatordagi mahsulot topilmadi', v_line_no USING errcode = 'P0002';
    END IF;

    v_line_currency := upper(coalesce(nullif(btrim(v_line->>'currency'), ''), v_product.currency, v_currency));
    IF v_line_currency NOT IN ('UZS', 'USD') THEN
      v_line_currency := 'USD';
    END IF;

    v_cost := (v_line->>'unit_cost')::numeric;
    v_cost_usd := (v_line->>'unit_cost_usd')::numeric;

    IF v_line_currency = 'USD' THEN
      IF v_cost_usd IS NOT NULL AND v_cost_usd > 0 THEN
        v_cost := round(v_cost_usd * v_rate);
      ELSIF v_cost < 20000 THEN
        v_cost_usd := v_cost;
        v_cost := round(v_cost_usd * v_rate);
      ELSE
        v_cost_usd := round(v_cost / v_rate, 2);
        v_cost := round(v_cost);
      END IF;
    ELSE
      v_cost := round(v_cost);
      IF v_cost_usd IS NULL THEN
        v_cost_usd := round(v_cost / v_rate, 2);
      END IF;
    END IF;

    v_retail := nullif((v_line->>'retail_price')::numeric, 0);
    v_retail_usd := nullif((v_line->>'retail_price_usd')::numeric, 0);
    IF v_retail IS NOT NULL THEN
      IF v_line_currency = 'USD' THEN
        IF v_retail_usd IS NOT NULL AND v_retail_usd > 0 THEN
          v_retail := round(v_retail_usd * v_rate);
        ELSIF v_retail < 20000 THEN
          v_retail_usd := v_retail;
          v_retail := round(v_retail_usd * v_rate);
        ELSE
          v_retail_usd := round(v_retail / v_rate, 2);
          v_retail := round(v_retail);
        END IF;
      ELSE
        v_retail := round(v_retail);
        IF v_retail_usd IS NULL THEN
          v_retail_usd := round(v_retail / v_rate, 2);
        END IF;
      END IF;
    END IF;

    v_wholesale := nullif((v_line->>'wholesale_price')::numeric, 0);
    v_wholesale_usd := nullif((v_line->>'wholesale_price_usd')::numeric, 0);
    IF v_wholesale IS NOT NULL THEN
      IF v_line_currency = 'USD' THEN
        IF v_wholesale_usd IS NOT NULL AND v_wholesale_usd > 0 THEN
          v_wholesale := round(v_wholesale_usd * v_rate);
        ELSIF v_wholesale < 20000 THEN
          v_wholesale_usd := v_wholesale;
          v_wholesale := round(v_wholesale_usd * v_rate);
        ELSE
          v_wholesale_usd := round(v_wholesale / v_rate, 2);
          v_wholesale := round(v_wholesale);
        END IF;
      ELSE
        v_wholesale := round(v_wholesale);
        IF v_wholesale_usd IS NULL THEN
          v_wholesale_usd := round(v_wholesale / v_rate, 2);
        END IF;
      END IF;
    END IF;

    v_minimum := nullif((v_line->>'minimum_sale_price')::numeric, 0);
    v_minimum_usd := nullif((v_line->>'minimum_sale_price_usd')::numeric, 0);
    IF v_minimum IS NOT NULL THEN
      IF v_line_currency = 'USD' THEN
        IF v_minimum_usd IS NOT NULL AND v_minimum_usd > 0 THEN
          v_minimum := round(v_minimum_usd * v_rate);
        ELSIF v_minimum < 20000 THEN
          v_minimum_usd := v_minimum;
          v_minimum := round(v_minimum_usd * v_rate);
        ELSE
          v_minimum_usd := round(v_minimum / v_rate, 2);
          v_minimum := round(v_minimum);
        END IF;
      ELSE
        v_minimum := round(v_minimum);
        IF v_minimum_usd IS NULL THEN
          v_minimum_usd := round(v_minimum / v_rate, 2);
        END IF;
      END IF;
    END IF;

    v_effective_minimum := coalesce(v_minimum, v_wholesale, v_retail, 0);
    IF v_retail IS NOT NULL AND v_retail > 0 AND v_effective_minimum > v_retail THEN
      v_effective_minimum := v_retail;
    END IF;

    v_receipt_total := v_receipt_total + (v_cost * v_qty);
    v_receipt_total_usd := v_receipt_total_usd + (v_cost_usd * v_qty);

    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    IF v_variant_id IS NULL AND nullif(btrim(v_line->>'color_name'), '') IS NOT NULL THEN
      SELECT id INTO v_variant_id FROM public.product_variants
      WHERE product_id = v_product.id AND lower(color_name) = lower(btrim(v_line->>'color_name'))
      LIMIT 1;

      IF v_variant_id IS NULL THEN
        INSERT INTO public.product_variants(
          product_id, color_name, cost_price, cost_price_usd,
          retail_price, retail_price_usd, wholesale_price, wholesale_price_usd,
          minimum_sale_price, minimum_sale_price_usd
        ) VALUES (
          v_product.id, btrim(v_line->>'color_name'), v_cost, v_cost_usd,
          v_retail, v_retail_usd, v_wholesale, v_wholesale_usd,
          v_effective_minimum, coalesce(v_minimum_usd, v_wholesale_usd, v_retail_usd, 0)
        ) RETURNING id INTO v_variant_id;
      END IF;
    END IF;

    v_serials := coalesce(v_line->'serials', '[]'::jsonb);

    -- Partiya (stock_batch) yaratish
    INSERT INTO public.stock_batches(
      receipt_id, line_no, supplier_id, product_id, location_id,
      variant_id, quantity, unit_cost, unit_cost_usd,
      retail_price, retail_price_usd, wholesale_price, wholesale_price_usd,
      minimum_sale_price, minimum_sale_price_usd, currency, created_by,
      received_at, reference
    ) VALUES (
      v_receipt, v_line_no, v_supplier, v_product.id, v_location,
      v_variant_id, v_qty, v_cost, v_cost_usd,
      v_retail, v_retail_usd, v_wholesale, v_wholesale_usd,
      v_effective_minimum, coalesce(v_minimum_usd, v_wholesale_usd, v_retail_usd, 0),
      v_line_currency, auth.uid(),
      coalesce((p_header->>'received_at')::timestamptz, clock_timestamp()),
      upper(btrim(v_receipt_no))
    ) RETURNING id INTO v_batch;

    -- Mahsulot narxlarini va valyutasini yangilash
    IF v_retail IS NOT NULL THEN
      UPDATE public.products
      SET cost_price = v_cost,
          cost_price_usd = coalesce(v_cost_usd, cost_price_usd),
          retail_price = v_retail,
          retail_price_usd = coalesce(v_retail_usd, retail_price_usd),
          wholesale_price = coalesce(v_wholesale, wholesale_price),
          wholesale_price_usd = coalesce(v_wholesale_usd, wholesale_price_usd),
          minimum_sale_price = v_effective_minimum,
          minimum_sale_price_usd = coalesce(v_minimum_usd, v_wholesale_usd, v_retail_usd, 0),
          currency = v_line_currency,
          updated_at = now()
      WHERE id = v_product.id;

      -- Kaskadli yangilanish: barcha avvalgi partiyalarni ham ushbu oxirgi narxga sinxronlashtirish
      UPDATE public.stock_batches
      SET retail_price = v_retail,
          retail_price_usd = coalesce(v_retail_usd, retail_price_usd),
          wholesale_price = coalesce(v_wholesale, wholesale_price),
          wholesale_price_usd = coalesce(v_wholesale_usd, wholesale_price_usd),
          minimum_sale_price = v_effective_minimum,
          minimum_sale_price_usd = coalesce(v_minimum_usd, v_wholesale_usd, v_retail_usd, 0),
          unit_cost = v_cost,
          unit_cost_usd = coalesce(v_cost_usd, unit_cost_usd),
          currency = v_line_currency
      WHERE product_id = v_product.id
        AND (v_variant_id IS NULL OR variant_id = v_variant_id OR variant_id IS NULL);
    ELSE
      UPDATE public.products
      SET cost_price = v_cost,
          cost_price_usd = coalesce(v_cost_usd, cost_price_usd),
          currency = v_line_currency,
          updated_at = now()
      WHERE id = v_product.id;

      UPDATE public.stock_batches
      SET unit_cost = v_cost,
          unit_cost_usd = coalesce(v_cost_usd, unit_cost_usd),
          currency = v_line_currency
      WHERE product_id = v_product.id
        AND (v_variant_id IS NULL OR variant_id = v_variant_id OR variant_id IS NULL);
    END IF;

    IF v_variant_id IS NOT NULL THEN
      UPDATE public.product_variants
      SET retail_price = coalesce(v_retail, retail_price),
          retail_price_usd = coalesce(v_retail_usd, retail_price_usd),
          wholesale_price = coalesce(v_wholesale, wholesale_price),
          wholesale_price_usd = coalesce(v_wholesale_usd, wholesale_price_usd),
          minimum_sale_price = coalesce(v_effective_minimum, minimum_sale_price),
          minimum_sale_price_usd = coalesce(v_minimum_usd, v_wholesale_usd, v_retail_usd, 0),
          cost_price = v_cost,
          cost_price_usd = coalesce(v_cost_usd, cost_price_usd)
      WHERE id = v_variant_id;
    END IF;

    -- Qisqa QR kod generatsiyasi (har bir rang/partiya qatori uchun 1 ta umumiy QR kod)
    v_line_qr := public.generate_short_qr();

    -- Birliklarni yaratish
    FOR v_unit_seq IN 1..v_qty LOOP
      IF jsonb_array_length(v_serials) >= v_unit_seq THEN
        v_serial := nullif(btrim(v_serials->>(v_unit_seq - 1)), '');
      ELSE
        v_serial := NULL;
      END IF;

      INSERT INTO public.inventory_units(
        product_id, batch_id, location_id, variant_id,
        serial_number, qr_code, status
      ) VALUES (
        v_product.id, v_batch, v_location, v_variant_id,
        v_serial, v_line_qr, 'available'
      ) RETURNING id INTO v_unit;

      v_created_units := v_created_units + 1;

      -- Inventory movement yozuvi
      INSERT INTO public.inventory_movements(
        movement_type, branch_id, product_id, unit_id, batch_id,
        to_location_id, quantity, performed_by, notes,
        reference_type, reference_id, metadata
      ) VALUES (
        'received', v_branch, v_product.id, v_unit, v_batch,
        v_location, 1, auth.uid(),
        CASE WHEN v_is_inventory THEN 'Inventarizatsiya kirimi' ELSE 'Partiya kirimi' END,
        'stock_receipt', v_receipt,
        jsonb_build_object('source', 'receive_stock', 'unit_sequence', v_unit_seq, 'qr_code', v_line_qr)
      );
    END LOOP;
  END LOOP;

  -- Stock Receipt umumiy summasini yangilash
  UPDATE public.stock_receipts
  SET total_cost = v_receipt_total,
      total_cost_usd = v_receipt_total_usd
  WHERE id = v_receipt;

  -- Agar oddiy partiya kirimi bo'lsa va to'lov kiritilgan bo'lsa, xarajat yozish
  IF NOT v_is_inventory AND v_supplier IS NOT NULL THEN
    v_supplier_payable := v_receipt_total - v_paid_amount;
    IF v_paid_amount > 0 THEN
      INSERT INTO public.expenses(
        branch_id, category_id, amount, currency, expense_date,
        payment_method, description, created_by, reference_type, reference_id
      ) VALUES (
        v_branch,
        (SELECT id FROM public.expense_categories WHERE name ILIKE '%tovar%' OR name ILIKE '%kirim%' LIMIT 1),
        v_paid_amount, v_currency,
        coalesce((p_header->>'received_at')::date, current_date),
        'other',
        'Partiya kirimi to‘lovi: ' || v_receipt_no,
        auth.uid(), 'stock_receipt', v_receipt
      );
    END IF;
  END IF;

  RETURN public.get_stock_receipt(v_receipt);
END;
$$;

GRANT EXECUTE ON FUNCTION public.receive_stock(jsonb, jsonb, uuid) TO authenticated, service_role, anon;


-- ============================================================================
-- 4. UPDATE get_pos_unit_context: Ensure POS always applies latest product price
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_pos_unit_context(p_branch_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code text := nullif(btrim(p_code), '');
  v_target_product_id uuid;
  v_target_variant_id uuid;
  v_unit record;
  v_rate numeric;
  v_sale jsonb := null;
  v_result jsonb;
  v_total_product_stock integer := 0;
  v_total_store_stock integer := 0;
  v_total_warehouse_stock integer := 0;
  v_variants_stock jsonb := '[]'::jsonb;
  v_variants_summary_text text := '';
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'QR, seriya, shtrix-kod yoki SKU talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC
  LIMIT 1;

  -- 1. Kod bo'yicha mahsulot va variantni aniqlash (QR kod, seriya raqami, barcode yoki SKU)
  SELECT
    u.product_id,
    u.variant_id
  INTO
    v_target_product_id,
    v_target_variant_id
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.products p ON p.id = u.product_id
  WHERE (
    upper(u.qr_code) = upper(v_code)
    OR upper(coalesce(u.serial_number, '')) = upper(v_code)
    OR (l.branch_id = p_branch_id AND (upper(coalesce(p.barcode, '')) = upper(v_code) OR upper(p.sku) = upper(v_code)))
  )
  ORDER BY
    CASE WHEN l.branch_id = p_branch_id THEN 0 ELSE 1 END,
    CASE WHEN u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    CASE WHEN upper(u.qr_code) = upper(v_code) THEN 0 ELSE 1 END,
    u.created_at DESC
  LIMIT 1;

  -- Agar inventory_units dan topilmasa, to'g'ridan-to'g'ri products jadvalidan izlash
  IF v_target_product_id IS NULL THEN
    SELECT p.id INTO v_target_product_id
    FROM public.products p
    WHERE upper(p.sku) = upper(v_code) OR upper(coalesce(p.barcode, '')) = upper(v_code)
    LIMIT 1;
  END IF;

  IF v_target_product_id IS NULL THEN
    RAISE EXCEPTION 'Bu kod bo‘yicha mahsulot topilmadi' USING errcode = 'P0002';
  END IF;

  -- 2. Filialdagi eng mos birlikni tanlash:
  -- Narxlar: coalesce(pv.retail_price, p.retail_price, sb.retail_price) orqali
  -- eng oxirgi belgilangan tovar narxi barcha partiyalarga qo'llaniladi!
  SELECT
    u.id, u.qr_code, u.serial_number, u.status, u.location_id, u.active_transfer_id, u.sold_sale_id,
    u.variant_id,
    pv.color_name as variant_color,
    pv.color_hex as variant_color_hex,
    p.id as product_id, p.name as product_name, p.sku, p.barcode, p.slug,
    p.status as product_status, p.is_published,
    p.currency as currency,
    br.name as brand_name,
    coalesce(pv.retail_price, p.retail_price, sb.retail_price) as retail_price,
    coalesce(pv.retail_price_usd, p.retail_price_usd, sb.retail_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pv.retail_price, p.retail_price, sb.retail_price) / v_rate, 2) ELSE null END) as retail_price_usd,
    coalesce(pv.wholesale_price, p.wholesale_price, sb.wholesale_price) as wholesale_price,
    coalesce(pv.wholesale_price_usd, p.wholesale_price_usd, sb.wholesale_price_usd, CASE WHEN v_rate > 0 AND coalesce(pv.wholesale_price, p.wholesale_price, sb.wholesale_price) IS NOT NULL THEN round(coalesce(pv.wholesale_price, p.wholesale_price, sb.wholesale_price) / v_rate, 2) ELSE null END) as wholesale_price_usd,
    coalesce(pv.minimum_sale_price, p.minimum_sale_price, sb.minimum_sale_price) as minimum_sale_price,
    coalesce(pv.minimum_sale_price_usd, p.minimum_sale_price_usd, sb.minimum_sale_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pv.minimum_sale_price, p.minimum_sale_price, sb.minimum_sale_price) / v_rate, 2) ELSE null END) as minimum_sale_price_usd,
    p.tax_rate,
    coalesce(pv.cost_price, p.cost_price, sb.unit_cost) as unit_cost,
    coalesce(pv.cost_price_usd, p.cost_price_usd, sb.unit_cost_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pv.cost_price, p.cost_price, sb.unit_cost) / v_rate, 2) ELSE null END) as unit_cost_usd,
    l.name as location_name, l.type as location_type, l.is_active as location_active,
    l.branch_id as unit_branch_id,
    ub.name as unit_branch_name,
    ub.code as unit_branch_code,
    (l.branch_id = p_branch_id) as in_current_branch,
    (l.branch_id = p_branch_id and l.is_active and l.type in ('store','warehouse')
      and u.status = 'available' and u.active_transfer_id is null and p.status = 'active') as is_sellable,
    coalesce(
      (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = u.variant_id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
      (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1)
    ) as image
  INTO v_unit
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.branches ub ON ub.id = l.branch_id AND ub.is_active
  LEFT JOIN public.brands br ON br.id = p.brand_id
  LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
  LEFT JOIN public.product_variants pv ON pv.id = u.variant_id
  WHERE u.product_id = v_target_product_id
    AND l.type IN ('store', 'warehouse')
  ORDER BY
    -- Priority 1: Shu filialda mavjud erkin birliklar birinchi o'rinda
    CASE WHEN l.branch_id = p_branch_id AND l.is_active AND u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    -- Priority 2: Shu filialga tegishli birliklar
    CASE WHEN l.branch_id = p_branch_id THEN 0 ELSE 1 END,
    -- Priority 3: Boshqa filialda bo'lsa ham erkin turgan birliklar
    CASE WHEN l.is_active AND u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    -- Priority 4: Skaner qilingan aniq QR kodga ega bo'lgan birlik
    CASE WHEN upper(u.qr_code) = upper(v_code) THEN 0 ELSE 1 END,
    -- Priority 5: Aniq variant/rang mosligi
    CASE WHEN v_target_variant_id IS NOT NULL AND u.variant_id = v_target_variant_id THEN 0 ELSE 1 END,
    -- Priority 6: Sotish uchun do'kondagi birlik ombordagidan oldin tavsiya etiladi
    CASE WHEN l.type = 'store' THEN 0 ELSE 1 END,
    -- Priority 7: FIFO - birinchi kirgan partiya birinchi chiqadi
    u.created_at ASC,
    u.id ASC
  LIMIT 1;

  IF v_unit.id IS NULL THEN
    RAISE EXCEPTION 'Bu kod bo‘yicha mahsulot birligi topilmadi' USING errcode = 'P0002';
  END IF;

  -- 3. Filialdagi barcha rang variantlari bo'yicha qoldiqlar yig'indisi
  SELECT
    coalesce(sum(total_qty), 0),
    coalesce(sum(store_qty), 0),
    coalesce(sum(warehouse_qty), 0),
    coalesce(
      jsonb_agg(jsonb_build_object(
        'variant_id', variant_id,
        'color_name', color_name,
        'color_hex', color_hex,
        'is_current', (variant_id IS NOT DISTINCT FROM v_unit.variant_id),
        'total_quantity', total_qty,
        'store_quantity', store_qty,
        'warehouse_quantity', warehouse_qty
      )),
      '[]'::jsonb
    ),
    coalesce(string_agg(total_qty || ' donasi ' || color_name, ', '), '')
  INTO
    v_total_product_stock,
    v_total_store_stock,
    v_total_warehouse_stock,
    v_variants_stock,
    v_variants_summary_text
  FROM (
    SELECT
      count_u.variant_id,
      coalesce(count_pv.color_name, 'Standart') as color_name,
      count_pv.color_hex,
      count(count_u.id) as total_qty,
      count(count_u.id) FILTER (WHERE count_l.type = 'store') as store_qty,
      count(count_u.id) FILTER (WHERE count_l.type = 'warehouse') as warehouse_qty
    FROM public.inventory_units count_u
    JOIN public.locations count_l ON count_l.id = count_u.location_id
    LEFT JOIN public.product_variants count_pv ON count_pv.id = count_u.variant_id
    WHERE count_u.product_id = v_unit.product_id
      AND count_l.branch_id = v_unit.unit_branch_id
      AND count_l.is_active = true
      AND count_u.status = 'available'
      AND count_u.active_transfer_id IS NULL
    GROUP BY count_u.variant_id, count_pv.color_name, count_pv.color_hex, count_pv.sort_order
    ORDER BY coalesce(count_pv.sort_order, 999), count_pv.color_name
  ) s;

  -- Faqat filialda umumiy qoldiq 0 bo'lganda va birlik oldin sotilgan bo'lsa sotuv tafsilotlari yuklanadi
  IF v_total_product_stock = 0 AND v_unit.sold_sale_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'sale_id', s.id,
      'sale_no', s.sale_no,
      'sold_at', s.sold_at,
      'status', s.status,
      'branch_id', s.branch_id,
      'branch_name', b.name,
      'in_current_branch', s.branch_id = p_branch_id,
      'details_visible', s.branch_id = p_branch_id,
      'seller_name', CASE WHEN s.branch_id = p_branch_id THEN seller.full_name END,
      'manager_name', CASE WHEN s.branch_id = p_branch_id THEN manager.full_name END,
      'customer_name', CASE WHEN s.branch_id = p_branch_id THEN c.full_name END,
      'customer_phone', CASE WHEN s.branch_id = p_branch_id THEN c.phone END,
      'unit_price', CASE WHEN s.branch_id = p_branch_id THEN x.unit_price END,
      'discount', CASE WHEN s.branch_id = p_branch_id THEN x.discount END,
      'tax', CASE WHEN s.branch_id = p_branch_id THEN x.tax END,
      'line_total', CASE WHEN s.branch_id = p_branch_id THEN x.line_total END,
      'sale_total', CASE WHEN s.branch_id = p_branch_id THEN s.total END,
      'payments', CASE WHEN s.branch_id = p_branch_id THEN coalesce((
        SELECT jsonb_agg(jsonb_build_object('method_name', pm.name, 'amount', sp.amount) ORDER BY sp.paid_at, sp.id)
        FROM public.sale_payments sp JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
        WHERE sp.sale_id = s.id), '[]'::jsonb) END
    )
    INTO v_sale
    FROM public.sales s
    JOIN public.branches b ON b.id = s.branch_id
    LEFT JOIN public.profiles seller ON seller.id = s.seller_id
    LEFT JOIN public.profiles manager ON manager.id = s.manager_id
    LEFT JOIN public.customers c ON c.id = s.customer_id
    LEFT JOIN public.sale_lines x ON x.sale_id = s.id AND x.unit_id = v_unit.id
    WHERE s.id = v_unit.sold_sale_id;
  END IF;

  SELECT jsonb_build_object(
    'id', v_unit.id,
    'qr_code', v_unit.qr_code,
    'scanned_code', v_code,
    'serial_number', v_unit.serial_number,
    'status', v_unit.status,
    'is_sellable', v_unit.is_sellable,
    'location_id', v_unit.location_id,
    'location_name', v_unit.location_name,
    'location_type', v_unit.location_type,
    'location_active', v_unit.location_active,
    'unit_branch_id', v_unit.unit_branch_id,
    'unit_branch_name', v_unit.unit_branch_name,
    'unit_branch_code', v_unit.unit_branch_code,
    'requested_branch_id', p_branch_id,
    'in_current_branch', v_unit.in_current_branch,
    'variant_id', v_unit.variant_id,
    'variant_color', v_unit.variant_color,
    'variant_color_hex', v_unit.variant_color_hex,
    'variant_stock_count', (
      SELECT count(*) FROM public.inventory_units iu
      JOIN public.locations il ON il.id = iu.location_id
      WHERE iu.product_id = v_unit.product_id
        AND il.branch_id = v_unit.unit_branch_id
        AND il.is_active
        AND iu.status = 'available'
        AND iu.active_transfer_id IS NULL
        AND (iu.variant_id IS NOT DISTINCT FROM v_unit.variant_id)
    ),
    'product_id', v_unit.product_id,
    'product_name', v_unit.product_name,
    'product_status', v_unit.product_status,
    'sku', v_unit.sku,
    'barcode', v_unit.barcode,
    'brand_name', v_unit.brand_name,
    'image', v_unit.image,
    'storefront_url', CASE WHEN v_unit.product_status = 'active' AND v_unit.is_published AND v_unit.slug IS NOT NULL
      THEN '/product/' || v_unit.slug ELSE null END,
    'sale', v_sale,
    'exchange_rate', v_rate,
    'currency', coalesce(v_unit.currency, 'USD'),
    'cost_price', v_unit.unit_cost,
    'cost_price_usd', v_unit.unit_cost_usd,
    'unit_cost', v_unit.unit_cost,
    'unit_cost_usd', v_unit.unit_cost_usd,
    'retail_price', v_unit.retail_price,
    'retail_price_usd', v_unit.retail_price_usd,
    'wholesale_price', v_unit.wholesale_price,
    'wholesale_price_usd', v_unit.wholesale_price_usd,
    'minimum_sale_price', v_unit.minimum_sale_price,
    'minimum_sale_price_usd', v_unit.minimum_sale_price_usd,
    'prices', jsonb_build_object(
      'retail_price_uzs', v_unit.retail_price,
      'retail_price_usd', v_unit.retail_price_usd,
      'wholesale_price_uzs', v_unit.wholesale_price,
      'wholesale_price_usd', v_unit.wholesale_price_usd,
      'minimum_sale_price_uzs', v_unit.minimum_sale_price,
      'minimum_sale_price_usd', v_unit.minimum_sale_price_usd,
      'unit_cost_uzs', v_unit.unit_cost,
      'unit_cost_usd', v_unit.unit_cost_usd,
      'tax_rate', v_unit.tax_rate
    ),
    'branch_stock', jsonb_build_object(
      'store', v_total_store_stock,
      'warehouse', v_total_warehouse_stock,
      'total', v_total_product_stock
    ),
    'variant_branch_stock', jsonb_build_object(
      'store', (
        SELECT count(*) FROM public.inventory_units iu
        JOIN public.locations il ON il.id = iu.location_id
        WHERE iu.product_id = v_unit.product_id
          AND il.branch_id = v_unit.unit_branch_id
          AND il.type = 'store'
          AND il.is_active
          AND iu.status = 'available'
          AND iu.active_transfer_id IS NULL
          AND (iu.variant_id IS NOT DISTINCT FROM v_unit.variant_id)
      ),
      'warehouse', (
        SELECT count(*) FROM public.inventory_units iu
        JOIN public.locations il ON il.id = iu.location_id
        WHERE iu.product_id = v_unit.product_id
          AND il.branch_id = v_unit.unit_branch_id
          AND il.type = 'warehouse'
          AND il.is_active
          AND iu.status = 'available'
          AND iu.active_transfer_id IS NULL
          AND (iu.variant_id IS NOT DISTINCT FROM v_unit.variant_id)
      )
    ),
    'variants_stock', v_variants_stock,
    'variants_summary_text', v_variants_summary_text,
    'other_branches', coalesce((
      SELECT jsonb_agg(jsonb_build_object('branch_id', b.id, 'branch_name', b.name, 'quantity', q.qty) ORDER BY q.qty DESC)
      FROM (
        SELECT al.branch_id, count(*) as qty
        FROM public.inventory_units a
        JOIN public.locations al ON al.id = a.location_id
        WHERE a.product_id = v_unit.product_id AND al.is_active AND al.type in ('store', 'warehouse')
          AND a.status = 'available' AND a.active_transfer_id is null
          AND al.branch_id <> v_unit.unit_branch_id
        GROUP BY al.branch_id
      ) q
      JOIN public.branches b ON b.id = q.branch_id
    ), '[]'::jsonb),
    'components', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', pc.id,
        'component_name', pc.name,
        'name', pc.name,
        'color_name', pc.color_name,
        'color_hex', pc.color_hex,
        'retail_price', pc.retail_price,
        'retail_price_usd', pc.retail_price_usd,
        'retail_price_uzs', pc.retail_price,
        'cost_price', pc.cost_price,
        'cost_price_usd', pc.cost_price_usd,
        'cost_price_uzs', pc.cost_price,
        'wholesale_price', pc.wholesale_price,
        'wholesale_price_usd', pc.wholesale_price_usd,
        'is_default', pc.is_default,
        'is_required', pc.is_required,
        'can_buy_standalone', pc.can_buy_standalone,
        'image_url', pc.image_url,
        'sort_order', pc.sort_order,
        'quantity', coalesce(pc.quantity, 1)
      ) ORDER BY pc.sort_order, pc.created_at)
      FROM public.product_components pc
      WHERE pc.product_id = v_unit.product_id AND pc.is_active = true
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_unit_context(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_unit_context(uuid, text) TO authenticated, service_role;


-- ============================================================================
-- 5. UPDATE find_pos_unit: Ensure unified pricing
-- ============================================================================
CREATE OR REPLACE FUNCTION public.find_pos_unit(p_branch_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code text := nullif(btrim(p_code), '');
  v_product_id uuid;
  v_result jsonb;
BEGIN
  PERFORM public.require_pos_seller(p_branch_id);
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'QR yoki seriya raqami talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT u.product_id INTO v_product_id
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  WHERE (
    upper(u.qr_code) = upper(v_code)
    OR upper(coalesce(u.serial_number, '')) = upper(v_code)
  )
  ORDER BY
    CASE WHEN l.branch_id = p_branch_id THEN 0 ELSE 1 END,
    CASE WHEN u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    u.created_at DESC
  LIMIT 1;

  IF v_product_id IS NULL THEN
    SELECT p.id INTO v_product_id
    FROM public.products p
    WHERE upper(p.sku) = upper(v_code) OR upper(coalesce(p.barcode, '')) = upper(v_code)
    LIMIT 1;
  END IF;

  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'Mahsulot topilmadi yoki sotuvga tayyor emas' USING errcode = 'P0002';
  END IF;

  SELECT jsonb_build_object(
    'id', u.id, 'qr_code', u.qr_code, 'scanned_code', v_code, 'serial_number', u.serial_number, 'status', u.status,
    'product_id', p.id, 'product_name', p.name, 'sku', p.sku, 'brand_name', br.name,
    'retail_price', coalesce(pv.retail_price, p.retail_price, b.retail_price),
    'wholesale_price', coalesce(pv.wholesale_price, p.wholesale_price, b.wholesale_price),
    'minimum_sale_price', coalesce(pv.minimum_sale_price, p.minimum_sale_price, b.minimum_sale_price),
    'cost_price', p.cost_price, 
    'unit_cost', coalesce(pv.cost_price, p.cost_price, b.unit_cost), 
    'tax_rate', p.tax_rate,
    'batch_retail_price', b.retail_price,
    'product_retail_price', p.retail_price,
    'image', (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
    'available_branch_count', (
      SELECT count(*) FROM public.inventory_units iu
      JOIN public.locations il ON il.id = iu.location_id
      WHERE iu.product_id = p.id AND il.branch_id = p_branch_id AND il.is_active AND iu.status = 'available' AND iu.active_transfer_id IS NULL
    )
  )
  INTO v_result
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.branches ub ON ub.id = l.branch_id
  LEFT JOIN public.brands br ON br.id = p.brand_id
  LEFT JOIN public.stock_batches b ON b.id = u.batch_id
  LEFT JOIN public.product_variants pv ON pv.id = u.variant_id
  WHERE u.product_id = v_product_id
    AND l.branch_id = p_branch_id
    AND l.type IN ('store', 'warehouse')
  ORDER BY
    CASE WHEN u.status = 'available' AND u.active_transfer_id IS NULL THEN 0 ELSE 1 END,
    CASE WHEN upper(u.qr_code) = upper(v_code) THEN 0 ELSE 1 END,
    CASE WHEN l.type = 'store' THEN 0 ELSE 1 END,
    u.created_at ASC
  LIMIT 1;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Bu filialda mahsulot birligi topilmadi' USING errcode = 'P0002';
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.find_pos_unit(uuid, text) TO authenticated, service_role;


-- ============================================================================
-- 6. UPDATE update_stock_receipt: Cascade batch price changes to all batches
-- ============================================================================
CREATE OR REPLACE FUNCTION public.update_stock_receipt(
  p_receipt_id uuid,
  p_updates jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_receipt public.stock_receipts%ROWTYPE;
  v_rate numeric;
  v_branch_curr text;
  v_line jsonb;
  v_batch_id uuid;
  v_batch public.stock_batches%ROWTYPE;
  v_qty integer;
  v_delta integer;
  v_seq integer;
  v_i integer;
  v_new_unit_id uuid;
  v_new_qr text;
  v_del_id uuid;
  v_uc numeric;
  v_uc_usd numeric;
  v_rp numeric;
  v_rp_usd numeric;
  v_wp numeric;
  v_wp_usd numeric;
  v_mp numeric;
  v_mp_usd numeric;
  v_curr text;
  v_new_loc uuid;
  v_old_loc uuid;
  v_total_cost numeric := 0;
  v_total_cost_usd numeric := 0;
  v_delete_batch_ids jsonb;
  v_batch_to_delete uuid;
  v_has_sold_units boolean;
BEGIN
  IF current_user <> 'postgres' 
     AND coalesce(current_setting('role', true), '') <> 'service_role'
     AND NOT (public.has_role(array['superadmin','admin']::public.app_role[], null) OR public.is_any_manager()) THEN
    RAISE EXCEPTION 'Partiyani tahrirlash uchun ruxsat berilmagan' USING errcode = '42501';
  END IF;

  SELECT * INTO v_receipt FROM public.stock_receipts WHERE id = p_receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kirim hujjati topilmadi' USING errcode = 'P0002';
  END IF;

  SELECT currency INTO v_branch_curr FROM public.branches WHERE id = v_receipt.branch_id;
  v_rate := coalesce(v_receipt.exchange_rate, public.get_effective_exchange_rate('USD', 'UZS'), 12800);
  IF v_rate <= 0 THEN v_rate := 12800; END IF;

  -- 1. Receipt metadata updates
  IF p_updates ? 'invoice_number' THEN
    UPDATE public.stock_receipts SET invoice_number = nullif(btrim(p_updates->>'invoice_number'), '') WHERE id = p_receipt_id;
  END IF;
  IF p_updates ? 'notes' THEN
    UPDATE public.stock_receipts SET notes = nullif(btrim(p_updates->>'notes'), '') WHERE id = p_receipt_id;
  END IF;
  IF p_updates ? 'supplier_id' THEN
    UPDATE public.stock_receipts SET supplier_id = nullif(p_updates->>'supplier_id', '')::uuid WHERE id = p_receipt_id;
  END IF;

  -- Relocate receipt if receiving_location_id changed
  IF p_updates ? 'receiving_location_id' AND nullif(p_updates->>'receiving_location_id', '') IS NOT NULL THEN
    v_new_loc := (p_updates->>'receiving_location_id')::uuid;
    v_old_loc := v_receipt.receiving_location_id;
    IF v_new_loc IS DISTINCT FROM v_old_loc THEN
      UPDATE public.stock_receipts SET receiving_location_id = v_new_loc WHERE id = p_receipt_id;
      UPDATE public.stock_batches SET location_id = v_new_loc WHERE receipt_id = p_receipt_id;
      UPDATE public.inventory_units SET location_id = v_new_loc
      WHERE batch_id IN (SELECT id FROM public.stock_batches WHERE receipt_id = p_receipt_id)
        AND location_id = v_old_loc
        AND status = 'available';

      INSERT INTO public.inventory_movements(
        movement_type, branch_id, product_id, unit_id, batch_id,
        from_location_id, to_location_id, quantity, performed_by, notes,
        reference_type, reference_id, metadata
      )
      SELECT 
        'relocated', v_receipt.branch_id, u.product_id, u.id, u.batch_id,
        v_old_loc, v_new_loc, 1, auth.uid(),
        'Kirim hujjati tahrirlandi: joylashuv o''zgartirildi',
        'stock_receipt', p_receipt_id,
        jsonb_build_object('source', 'update_stock_receipt', 'reason', 'batch_relocation')
      FROM public.inventory_units u
      WHERE u.batch_id IN (SELECT id FROM public.stock_batches WHERE receipt_id = p_receipt_id)
        AND u.location_id = v_new_loc;
    END IF;
  END IF;

  -- 2. Line updates
  IF p_updates ? 'lines' AND jsonb_typeof(p_updates->'lines') = 'array' THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_updates->'lines') LOOP
      v_batch_id := (v_line->>'batch_id')::uuid;
      IF v_batch_id IS NULL THEN CONTINUE; END IF;

      SELECT * INTO v_batch FROM public.stock_batches WHERE id = v_batch_id AND receipt_id = p_receipt_id;
      IF NOT FOUND THEN CONTINUE; END IF;

      v_curr := upper(coalesce(nullif(btrim(v_line->>'currency'), ''), v_batch.currency, 'USD'));
      IF v_curr NOT IN ('UZS', 'USD') THEN v_curr := 'USD'; END IF;

      -- Unit Cost
      IF v_line ? 'unit_cost' AND nullif(btrim(v_line->>'unit_cost'), '') IS NOT NULL THEN
        v_uc := (v_line->>'unit_cost')::numeric;
        v_uc_usd := CASE WHEN v_line ? 'unit_cost_usd' AND nullif(btrim(v_line->>'unit_cost_usd'), '') IS NOT NULL
          THEN (v_line->>'unit_cost_usd')::numeric ELSE NULL END;

        IF v_curr = 'USD' THEN
          IF v_uc_usd IS NOT NULL AND v_uc_usd > 0 THEN
            v_uc := round(v_uc_usd * v_rate);
          ELSIF v_uc < 20000 THEN
            v_uc_usd := v_uc;
            v_uc := round(v_uc_usd * v_rate);
          ELSE
            v_uc_usd := round(v_uc / v_rate, 2);
            v_uc := round(v_uc);
          END IF;
        ELSE
          v_uc := round(v_uc);
          IF v_uc_usd IS NULL THEN
            v_uc_usd := coalesce(v_batch.unit_cost_usd, round(v_uc / v_rate, 2));
          END IF;
        END IF;

        UPDATE public.stock_batches 
        SET unit_cost = v_uc, unit_cost_usd = v_uc_usd, currency = v_curr 
        WHERE product_id = v_batch.product_id
          AND (v_batch.variant_id IS NULL OR variant_id = v_batch.variant_id OR variant_id IS NULL);

        UPDATE public.products SET
          cost_price = v_uc,
          cost_price_usd = coalesce(v_uc_usd, cost_price_usd),
          currency = v_curr,
          updated_at = now()
        WHERE id = v_batch.product_id;
      END IF;

      -- Retail Price
      IF v_line ? 'retail_price' AND nullif(btrim(v_line->>'retail_price'), '') IS NOT NULL THEN
        v_rp := (v_line->>'retail_price')::numeric;
        v_rp_usd := CASE WHEN v_line ? 'retail_price_usd' AND nullif(btrim(v_line->>'retail_price_usd'), '') IS NOT NULL
          THEN (v_line->>'retail_price_usd')::numeric ELSE NULL END;

        IF v_curr = 'USD' THEN
          IF v_rp_usd IS NOT NULL AND v_rp_usd > 0 THEN
            v_rp := round(v_rp_usd * v_rate);
          ELSIF v_rp < 20000 THEN
            v_rp_usd := v_rp;
            v_rp := round(v_rp_usd * v_rate);
          ELSE
            v_rp_usd := round(v_rp / v_rate, 2);
            v_rp := round(v_rp);
          END IF;
        ELSE
          v_rp := round(v_rp);
          IF v_rp_usd IS NULL THEN
            v_rp_usd := coalesce(v_batch.retail_price_usd, round(v_rp / v_rate, 2));
          END IF;
        END IF;

        UPDATE public.stock_batches 
        SET retail_price = v_rp, retail_price_usd = v_rp_usd, currency = v_curr 
        WHERE product_id = v_batch.product_id
          AND (v_batch.variant_id IS NULL OR variant_id = v_batch.variant_id OR variant_id IS NULL);

        UPDATE public.products SET
          retail_price = v_rp,
          retail_price_usd = coalesce(v_rp_usd, retail_price_usd),
          currency = v_curr,
          updated_at = now()
        WHERE id = v_batch.product_id;
      END IF;

      -- Wholesale Price
      IF v_line ? 'wholesale_price' AND nullif(btrim(v_line->>'wholesale_price'), '') IS NOT NULL THEN
        v_wp := (v_line->>'wholesale_price')::numeric;
        v_wp_usd := CASE WHEN v_line ? 'wholesale_price_usd' AND nullif(btrim(v_line->>'wholesale_price_usd'), '') IS NOT NULL
          THEN (v_line->>'wholesale_price_usd')::numeric ELSE NULL END;

        IF v_curr = 'USD' THEN
          IF v_wp_usd IS NOT NULL AND v_wp_usd > 0 THEN
            v_wp := round(v_wp_usd * v_rate);
          ELSIF v_wp < 20000 THEN
            v_wp_usd := v_wp;
            v_wp := round(v_wp_usd * v_rate);
          ELSE
            v_wp_usd := round(v_wp / v_rate, 2);
            v_wp := round(v_wp);
          END IF;
        ELSE
          v_wp := round(v_wp);
          IF v_wp_usd IS NULL THEN
            v_wp_usd := coalesce(v_batch.wholesale_price_usd, round(v_wp / v_rate, 2));
          END IF;
        END IF;

        UPDATE public.stock_batches 
        SET wholesale_price = v_wp, wholesale_price_usd = v_wp_usd 
        WHERE product_id = v_batch.product_id
          AND (v_batch.variant_id IS NULL OR variant_id = v_batch.variant_id OR variant_id IS NULL);

        UPDATE public.products SET
          wholesale_price = v_wp,
          wholesale_price_usd = coalesce(v_wp_usd, wholesale_price_usd),
          updated_at = now()
        WHERE id = v_batch.product_id;
      END IF;

      -- Minimum Sale Price
      IF v_line ? 'minimum_sale_price' AND nullif(btrim(v_line->>'minimum_sale_price'), '') IS NOT NULL THEN
        v_mp := (v_line->>'minimum_sale_price')::numeric;
        v_mp_usd := CASE WHEN v_line ? 'minimum_sale_price_usd' AND nullif(btrim(v_line->>'minimum_sale_price_usd'), '') IS NOT NULL
          THEN (v_line->>'minimum_sale_price_usd')::numeric ELSE NULL END;

        IF v_curr = 'USD' THEN
          IF v_mp_usd IS NOT NULL AND v_mp_usd > 0 THEN
            v_mp := round(v_mp_usd * v_rate);
          ELSIF v_mp < 20000 THEN
            v_mp_usd := v_mp;
            v_mp := round(v_mp_usd * v_rate);
          ELSE
            v_mp_usd := round(v_mp / v_rate, 2);
            v_mp := round(v_mp);
          END IF;
        ELSE
          v_mp := round(v_mp);
          IF v_mp_usd IS NULL THEN
            v_mp_usd := coalesce(v_batch.minimum_sale_price_usd, round(v_mp / v_rate, 2));
          END IF;
        END IF;

        UPDATE public.stock_batches 
        SET minimum_sale_price = v_mp, minimum_sale_price_usd = v_mp_usd 
        WHERE product_id = v_batch.product_id
          AND (v_batch.variant_id IS NULL OR variant_id = v_batch.variant_id OR variant_id IS NULL);

        UPDATE public.products SET
          minimum_sale_price = v_mp,
          minimum_sale_price_usd = coalesce(v_mp_usd, minimum_sale_price_usd),
          updated_at = now()
        WHERE id = v_batch.product_id;
      END IF;

      -- Quantity modification (add or remove units)
      IF v_line ? 'quantity' AND nullif(btrim(v_line->>'quantity'), '') IS NOT NULL THEN
        v_qty := (v_line->>'quantity')::integer;
        IF v_qty > 0 AND v_qty <> v_batch.quantity THEN
          v_delta := v_qty - v_batch.quantity;
          IF v_delta > 0 THEN
            SELECT qr_code INTO v_new_qr FROM public.inventory_units WHERE batch_id = v_batch_id LIMIT 1;
            IF v_new_qr IS NULL THEN v_new_qr := public.generate_short_qr(); END IF;

            SELECT coalesce(max((metadata->>'unit_sequence')::integer), v_batch.quantity) INTO v_seq
            FROM public.inventory_movements WHERE batch_id = v_batch_id;
            IF v_seq IS NULL THEN v_seq := v_batch.quantity; END IF;

            FOR v_i IN 1..v_delta LOOP
              INSERT INTO public.inventory_units(
                product_id, batch_id, location_id, variant_id,
                qr_code, status
              ) VALUES (
                v_batch.product_id, v_batch.id, v_batch.location_id, v_batch.variant_id,
                v_new_qr, 'available'
              ) RETURNING id INTO v_new_unit_id;

              INSERT INTO public.inventory_movements(
                movement_type, branch_id, product_id, unit_id, batch_id,
                to_location_id, quantity, performed_by, notes,
                reference_type, reference_id, metadata
              ) VALUES (
                'received', v_receipt.branch_id, v_batch.product_id, v_new_unit_id, v_batch.id,
                v_batch.location_id, 1, auth.uid(),
                'Kirim miqdori oshirildi: qo''shimcha birlik',
                'stock_receipt', p_receipt_id,
                jsonb_build_object('source', 'update_stock_receipt', 'unit_sequence', v_seq + v_i)
              );
            END LOOP;
          ELSIF v_delta < 0 THEN
            FOR v_i IN 1..abs(v_delta) LOOP
              SELECT id INTO v_del_id FROM public.inventory_units
              WHERE batch_id = v_batch_id AND status = 'available' AND active_transfer_id IS NULL
              ORDER BY created_at DESC LIMIT 1;

              IF v_del_id IS NOT NULL THEN
                DELETE FROM public.inventory_movements WHERE unit_id = v_del_id;
                DELETE FROM public.inventory_units WHERE id = v_del_id;
              END IF;
            END LOOP;
          END IF;
          UPDATE public.stock_batches SET quantity = v_qty WHERE id = v_batch_id;
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- 3. Recalculate stock_receipt totals
  SELECT coalesce(sum(quantity * unit_cost), 0), coalesce(sum(quantity * unit_cost_usd), 0)
  INTO v_total_cost, v_total_cost_usd
  FROM public.stock_batches WHERE receipt_id = p_receipt_id;

  UPDATE public.stock_receipts
  SET total_cost = v_total_cost,
      total_cost_usd = v_total_cost_usd
  WHERE id = p_receipt_id;

  RETURN public.get_stock_receipt(p_receipt_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_stock_receipt(uuid, jsonb) TO authenticated, service_role;

COMMIT;
