-- Migration: Fix schema columns in receive_stock and update_stock_receipt
-- Eliminates non-existent columns (stock_receipts.status, total_cost, total_cost_usd, exchange_rate,
-- inventory_movements.branch_id, performed_by, notes) while keeping latest price cascading across batches.

BEGIN;

-- 1. receive_stock
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
  v_is_inventory boolean := false;
  v_actor_id uuid;
  v_paid_amount numeric(18,2) := 0;
  v_payment_status text := 'unpaid';
  v_total_cost numeric(18,2) := 0;
  v_debt numeric(18,2) := 0;
  v_receipt_record jsonb;
  v_retry_count integer := 0;
  v_unique_receipt_no text;
BEGIN
  IF p_header IS NULL OR jsonb_typeof(p_header) <> 'object' THEN
    RAISE EXCEPTION 'Partiya sarlavhasi (p_header) noto‘g‘ri' USING errcode = '22023';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Kamida bitta tovar qatori kiritilishi shart' USING errcode = '22023';
  END IF;

  v_branch := (p_header->>'branch_id')::uuid;
  v_location := coalesce((p_header->>'receiving_location_id')::uuid, (p_header->>'location_id')::uuid);
  v_supplier := nullif(btrim(p_header->>'supplier_id'), '')::uuid;
  v_currency := upper(coalesce(nullif(btrim(p_header->>'currency'), ''), 'USD'));
  IF v_currency NOT IN ('UZS', 'USD') THEN
    v_currency := 'USD';
  END IF;

  IF v_branch IS NULL OR v_location IS NULL THEN
    RAISE EXCEPTION 'Filial va qabul joylashuvi talab qilinadi' USING errcode = '22023';
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
    v_payment_status := 'paid';
  ELSE
    v_paid_amount := coalesce((p_header->>'paid_amount')::numeric, 0);
    v_payment_status := coalesce(nullif(btrim(p_header->>'payment_status'), ''), 'unpaid');
    IF v_payment_status NOT IN ('unpaid', 'partial', 'paid') THEN
      v_payment_status := 'unpaid';
    END IF;
  END IF;

  v_receipt_no := nullif(btrim(p_header->>'receipt_no'), '');
  IF v_receipt_no IS NULL THEN
    IF v_is_inventory THEN
      v_receipt_no := 'INV-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || substr(md5(random()::text), 1, 4);
    ELSE
      v_receipt_no := 'REC-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' || substr(md5(random()::text), 1, 4);
    END IF;
  END IF;

  v_request_hash := encode(sha256(concat_ws('|', p_header::text, coalesce(p_lines::text, ''))::bytea), 'hex');

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, request_hash INTO v_existing, v_existing_hash 
    FROM public.stock_receipts 
    WHERE idempotency_key = p_idempotency_key;

    IF v_existing IS NOT NULL THEN
      IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
        RAISE EXCEPTION 'Takroriy so‘rov: idempotency_key boshqa ma''lumotlar bilan yuborilgan' USING errcode = '22023';
      END IF;
      v_receipt_record := public.get_stock_receipt(v_existing);
      RETURN v_receipt_record || jsonb_build_object(
        'receipt_id', v_existing,
        'receipt', v_receipt_record
      );
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

  -- Resolve actor safely
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    SELECT id INTO v_actor_id FROM public.profiles WHERE is_active LIMIT 1;
  END IF;
  IF v_actor_id IS NULL THEN
    SELECT id INTO v_actor_id FROM public.profiles LIMIT 1;
  END IF;

  -- Create stock_receipts record using valid table columns
  INSERT INTO public.stock_receipts(
    idempotency_key, branch_id, receiving_location_id, supplier_id,
    received_at, created_by, receipt_no, paid_amount,
    currency, request_hash, notes, payment_status
  ) VALUES (
    p_idempotency_key, v_branch, v_location, v_supplier,
    coalesce((p_header->>'received_at')::timestamptz, clock_timestamp()),
    v_actor_id, upper(btrim(v_receipt_no)), v_paid_amount,
    v_currency, v_request_hash, nullif(btrim(p_header->>'notes'), ''),
    v_payment_status
  ) RETURNING id INTO v_receipt;

  -- Process lines
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

    -- Create stock batch
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
      v_line_currency, v_actor_id,
      coalesce((p_header->>'received_at')::timestamptz, clock_timestamp()),
      upper(btrim(v_receipt_no))
    ) RETURNING id INTO v_batch;

    -- Update product prices and cascade to all existing batches for this product
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

    -- Generate single short QR per line/color
    v_line_qr := public.generate_short_qr();

    -- Create inventory units
    FOR v_unit_seq IN 1..v_qty LOOP
      IF jsonb_array_length(v_serials) >= v_unit_seq THEN
        v_serial := nullif(btrim(v_serials->>(v_unit_seq - 1)), '');
      ELSE
        v_serial := NULL;
      END IF;

      INSERT INTO public.inventory_units(
        product_id, batch_id, location_id, variant_id,
        serial_number, qr_code, status, unit_sequence
      ) VALUES (
        v_product.id, v_batch, v_location, v_variant_id,
        v_serial, v_line_qr, 'available'::public.unit_status, v_unit_seq
      ) RETURNING id INTO v_unit;

      v_created_units := v_created_units + 1;

      -- Inventory movement log
      INSERT INTO public.inventory_movements(
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity, unit_cost,
        reference_type, reference_id, reason, actor_id, metadata
      ) VALUES (
        v_unit, v_product.id, v_batch, 'received'::public.movement_type,
        NULL, v_location, 1, v_cost,
        'stock_receipt', v_receipt,
        CASE WHEN v_is_inventory THEN 'Inventarizatsiya kirimi' ELSE 'Partiya kirimi' END,
        v_actor_id,
        jsonb_build_object(
          'source', 'receive_stock',
          'receipt_no', v_receipt_no,
          'line_no', v_line_no,
          'unit_sequence', v_unit_seq,
          'qr_code', v_line_qr
        )
      );
    END LOOP;
  END LOOP;

  -- Supplier balance update (if supplier selected and unpaid debt exists)
  v_total_cost := (
    SELECT coalesce(sum(quantity * unit_cost), 0)
    FROM public.stock_batches
    WHERE receipt_id = v_receipt
  );

  IF v_supplier IS NOT NULL THEN
    IF v_payment_status = 'unpaid' THEN
      v_debt := v_total_cost;
    ELSIF v_payment_status = 'partial' THEN
      v_debt := greatest(0, v_total_cost - v_paid_amount);
    ELSE
      v_debt := 0;
    END IF;

    IF v_debt > 0 THEN
      UPDATE public.suppliers SET balance = balance + v_debt WHERE id = v_supplier;
    END IF;
  END IF;

  v_receipt_record := public.get_stock_receipt(v_receipt);

  RETURN v_receipt_record || jsonb_build_object(
    'receipt_id', v_receipt,
    'receipt', v_receipt_record,
    'created_units_count', v_created_units,
    'total_lines', v_line_no
  );
END;
$$;


-- 2. update_stock_receipt
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
  v_actor_id uuid;
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
  v_delete_batch_ids jsonb;
  v_batch_to_delete uuid;
  v_has_sold_units boolean;
BEGIN
  SELECT * INTO v_receipt FROM public.stock_receipts WHERE id = p_receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kirim hujjati topilmadi' USING errcode = 'P0002';
  END IF;

  v_rate := coalesce(public.get_effective_exchange_rate('USD', 'UZS'), 12800);
  IF v_rate <= 0 THEN v_rate := 12800; END IF;

  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    SELECT id INTO v_actor_id FROM public.profiles WHERE is_active LIMIT 1;
  END IF;
  IF v_actor_id IS NULL THEN
    SELECT id INTO v_actor_id FROM public.profiles LIMIT 1;
  END IF;

  -- 1. Receipt metadata updates
  IF p_updates ? 'invoice_number' THEN
    UPDATE public.stock_receipts SET invoice_number = nullif(btrim(p_updates->>'invoice_number'), '') WHERE id = p_receipt_id;
  END IF;
  IF p_updates ? 'notes' THEN
    UPDATE public.stock_receipts SET notes = nullif(btrim(p_updates->>'notes'), '') WHERE id = p_receipt_id;
  END IF;
  IF p_updates ? 'supplier_id' THEN
    UPDATE public.stock_receipts SET supplier_id = nullif(btrim(p_updates->>'supplier_id'), '')::uuid WHERE id = p_receipt_id;
  END IF;

  -- Relocate receipt if receiving_location_id changed
  IF p_updates ? 'receiving_location_id' AND nullif(btrim(p_updates->>'receiving_location_id'), '') IS NOT NULL THEN
    v_new_loc := (p_updates->>'receiving_location_id')::uuid;
    v_old_loc := v_receipt.receiving_location_id;
    IF v_new_loc IS DISTINCT FROM v_old_loc THEN
      UPDATE public.stock_receipts SET receiving_location_id = v_new_loc WHERE id = p_receipt_id;
      UPDATE public.stock_batches SET location_id = v_new_loc WHERE receipt_id = p_receipt_id;
      UPDATE public.inventory_units SET location_id = v_new_loc
      WHERE batch_id IN (SELECT id FROM public.stock_batches WHERE receipt_id = p_receipt_id)
        AND location_id = v_old_loc
        AND status IN ('available', 'reserved');
    END IF;
  END IF;

  -- Delete batches if requested
  IF p_updates ? 'deleted_batch_ids' THEN
    v_delete_batch_ids := p_updates->'deleted_batch_ids';
    IF jsonb_typeof(v_delete_batch_ids) = 'array' THEN
      FOR v_batch_to_delete IN SELECT (value::text)::uuid FROM jsonb_array_elements_text(v_delete_batch_ids) LOOP
        SELECT EXISTS (
          SELECT 1 FROM public.inventory_units WHERE batch_id = v_batch_to_delete AND status = 'sold'
        ) INTO v_has_sold_units;

        IF v_has_sold_units THEN
          RAISE EXCEPTION 'Ushbu partiyadan tovarlar sotilgan, uni butunlay o‘chirib bo‘lmaydi!' USING errcode = '22023';
        END IF;

        DELETE FROM public.inventory_movements WHERE batch_id = v_batch_to_delete;
        DELETE FROM public.inventory_units WHERE batch_id = v_batch_to_delete;
        DELETE FROM public.stock_batches WHERE id = v_batch_to_delete AND receipt_id = p_receipt_id;
      END LOOP;
    END IF;
  END IF;

  -- 2. Line updates (prices, quantities)
  IF p_updates ? 'lines' AND jsonb_typeof(p_updates->'lines') = 'array' THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_updates->'lines') LOOP
      v_batch_id := (v_line->>'id')::uuid;
      SELECT * INTO v_batch FROM public.stock_batches WHERE id = v_batch_id AND receipt_id = p_receipt_id;
      IF NOT FOUND THEN CONTINUE; END IF;

      v_curr := coalesce(v_line->>'currency', v_batch.currency, 'USD');

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
        SET unit_cost = v_uc, unit_cost_usd = v_uc_usd 
        WHERE product_id = v_batch.product_id
          AND (v_batch.variant_id IS NULL OR variant_id = v_batch.variant_id OR variant_id IS NULL);

        UPDATE public.products SET
          cost_price = v_uc,
          cost_price_usd = coalesce(v_uc_usd, cost_price_usd),
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
        SET retail_price = v_rp, retail_price_usd = v_rp_usd 
        WHERE product_id = v_batch.product_id
          AND (v_batch.variant_id IS NULL OR variant_id = v_batch.variant_id OR variant_id IS NULL);

        UPDATE public.products SET
          retail_price = v_rp,
          retail_price_usd = coalesce(v_rp_usd, retail_price_usd),
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
                v_new_qr, 'available'::public.unit_status
              ) RETURNING id INTO v_new_unit_id;

              INSERT INTO public.inventory_movements(
                unit_id, product_id, batch_id, movement_type,
                from_location_id, to_location_id, quantity, unit_cost,
                reference_type, reference_id, reason, actor_id, metadata
              ) VALUES (
                v_new_unit_id, v_batch.product_id, v_batch.id, 'received'::public.movement_type,
                NULL, v_batch.location_id, 1, coalesce(v_batch.unit_cost, 0),
                'stock_receipt', p_receipt_id, 'Kirim miqdori oshirildi: qo''shimcha birlik',
                v_actor_id,
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

  RETURN public.get_stock_receipt(p_receipt_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.receive_stock(jsonb, jsonb, uuid) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.update_stock_receipt(uuid, jsonb) TO authenticated, service_role, anon;

COMMIT;

NOTIFY pgrst, 'reload schema';
