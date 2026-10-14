-- Migration 20260963200000: Fix stock_receipts_request_hash_check, generate_short_qr, and receive_stock movement_type

-- 1. Relax constraint to allow both 32-char (md5) and 64-char (sha256) hexadecimal hashes
ALTER TABLE public.stock_receipts DROP CONSTRAINT IF EXISTS stock_receipts_request_hash_check;
ALTER TABLE public.stock_receipts ADD CONSTRAINT stock_receipts_request_hash_check
  CHECK (((request_hash IS NULL) OR (request_hash ~ '^[0-9a-f]{32,64}$'::text)));

-- 2. Add overload for generate_short_qr(p_prefix text) to prevent function does not exist error
CREATE OR REPLACE FUNCTION public.generate_short_qr(p_prefix text)
RETURNS text
LANGUAGE sql
AS $$
  SELECT public.generate_short_qr();
$$;
GRANT EXECUTE ON FUNCTION public.generate_short_qr(text) TO authenticated, service_role;

-- 3. Update receive_stock to generate valid 64-character sha256 hash, use shared short QR per color line, and use valid 'received' enum for movement_type
CREATE OR REPLACE FUNCTION public.receive_stock(
  p_header jsonb,
  p_lines jsonb,
  p_idempotency_key uuid
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
  v_paid_amount numeric(18,2);
  v_payment_status text;
  v_receipt_record record;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Idempotency key talab qilinadi' USING errcode = '22023';
  END IF;

  v_request_hash := encode(sha256(concat_ws('|', p_header::text, coalesce(p_lines::text, ''))::bytea), 'hex');

  SELECT id, request_hash INTO v_existing, v_existing_hash
  FROM public.stock_receipts
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'Idempotency kaliti boshqa parametrlar bilan ishlatilgan'
        USING errcode = '23505';
    END IF;
    RETURN public.get_stock_receipt(v_existing);
  END IF;

  v_branch := (p_header->>'branch_id')::uuid;
  v_location := (p_header->>'receiving_location_id')::uuid;
  v_supplier := nullif(p_header->>'supplier_id', '')::uuid;

  IF v_branch IS NULL OR v_location IS NULL THEN
    RAISE EXCEPTION 'Filial va qabul joylashuvi talab qilinadi' USING errcode = '22023';
  END IF;

  PERFORM public.require_inventory_operator(v_branch);

  IF NOT EXISTS (
    SELECT 1 FROM public.locations
    WHERE id = v_location AND branch_id = v_branch AND is_active
  ) THEN
    RAISE EXCEPTION 'Noto‘g‘ri yoki nofaol qabul joylashuvi' USING errcode = 'P0002';
  END IF;

  v_receipt_no := p_header->>'receipt_no';
  IF v_supplier IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.suppliers WHERE id = v_supplier AND is_active
  ) THEN
    RAISE EXCEPTION 'Noto‘g‘ri yoki nofaol ta’minotchi' USING errcode = 'P0002';
  END IF;

  v_payment_status := coalesce(p_header->>'payment_status', 'unpaid');
  IF v_payment_status NOT IN ('unpaid', 'partial', 'paid') THEN
    v_payment_status := 'unpaid';
  END IF;

  SELECT currency INTO v_branch_currency FROM public.branches WHERE id = v_branch;
  v_currency := upper(nullif(btrim(p_header->>'currency'), ''));

  IF v_currency IS NULL THEN
    v_currency := coalesce(v_branch_currency, 'USD');
  END IF;

  v_rate := (p_header->>'exchange_rate')::numeric;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    SELECT rate INTO v_rate
    FROM public.exchange_rates
    WHERE currency_from = 'USD' AND currency_to = coalesce(v_branch_currency, 'UZS')
    ORDER BY rate_date DESC, created_at DESC
    LIMIT 1;
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    v_rate := 12800;
  END IF;

  IF v_receipt_no IS NULL OR btrim(v_receipt_no) = '' THEN
    v_receipt_no := 'REC-' || to_char(now(), 'YYYYMMDD-HH24MISS');
  END IF;

  v_paid_amount := coalesce((p_header->>'paid_amount')::numeric, 0);

  INSERT INTO public.stock_receipts(
    idempotency_key, branch_id, receiving_location_id, supplier_id,
    received_at, created_by, receipt_no, paid_amount,
    currency, request_hash, notes, payment_status
  ) VALUES (
    p_idempotency_key, v_branch, v_location, v_supplier,
    coalesce((p_header->>'received_at')::timestamptz, clock_timestamp()),
    auth.uid(), v_receipt_no, v_paid_amount,
    v_currency, v_request_hash, nullif(p_header->>'notes', ''),
    v_payment_status
  ) RETURNING id INTO v_receipt;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_line_no := v_line_no + 1;
    v_qty := (v_line->>'quantity')::integer;
    v_cost := (v_line->>'unit_cost')::numeric(18,2);
    v_cost_usd := (v_line->>'unit_cost_usd')::numeric(18,2);
    v_retail := nullif(v_line->>'retail_price', '')::numeric(18,2);
    v_retail_usd := nullif(v_line->>'retail_price_usd', '')::numeric(18,2);
    v_wholesale := nullif(v_line->>'wholesale_price', '')::numeric(18,2);
    v_wholesale_usd := nullif(v_line->>'wholesale_price_usd', '')::numeric(18,2);
    v_minimum := nullif(v_line->>'minimum_sale_price', '')::numeric(18,2);
    v_minimum_usd := nullif(v_line->>'minimum_sale_price_usd', '')::numeric(18,2);
    v_serials := coalesce(v_line->'serial_numbers', '[]'::jsonb);

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Miqdor musbat bo‘lishi kerak' USING errcode = '22023';
    END IF;
    IF v_cost IS NULL OR v_cost < 0 THEN
      RAISE EXCEPTION 'Tannarx manfiy bo‘lmasligi kerak' USING errcode = '22023';
    END IF;

    -- Normalize USD and UZS values based on currency mode
    IF v_currency = 'USD' THEN
      IF v_cost_usd IS NOT NULL AND v_cost_usd > 0 THEN
        IF v_cost < 20000 THEN
          v_cost := round(v_cost_usd * v_rate);
        ELSE
          v_cost := round(v_cost);
        END IF;
      ELSIF v_cost < 20000 THEN
        v_cost_usd := v_cost;
        v_cost := round(v_cost_usd * v_rate);
      ELSE
        v_cost_usd := round(v_cost / v_rate, 2);
        v_cost := round(v_cost);
      END IF;

      IF v_retail IS NOT NULL THEN
        IF v_retail_usd IS NOT NULL AND v_retail_usd > 0 THEN
          IF v_retail < 20000 THEN v_retail := round(v_retail_usd * v_rate); ELSE v_retail := round(v_retail); END IF;
        ELSIF v_retail < 20000 THEN
          v_retail_usd := v_retail;
          v_retail := round(v_retail_usd * v_rate);
        ELSE
          v_retail_usd := round(v_retail / v_rate, 2);
          v_retail := round(v_retail);
        END IF;
      END IF;

      IF v_wholesale IS NOT NULL THEN
        IF v_wholesale_usd IS NOT NULL AND v_wholesale_usd > 0 THEN
          IF v_wholesale < 20000 THEN v_wholesale := round(v_wholesale_usd * v_rate); ELSE v_wholesale := round(v_wholesale); END IF;
        ELSIF v_wholesale < 20000 THEN
          v_wholesale_usd := v_wholesale;
          v_wholesale := round(v_wholesale_usd * v_rate);
        ELSE
          v_wholesale_usd := round(v_wholesale / v_rate, 2);
          v_wholesale := round(v_wholesale);
        END IF;
      END IF;

      IF v_minimum IS NOT NULL THEN
        IF v_minimum_usd IS NOT NULL AND v_minimum_usd > 0 THEN
          IF v_minimum < 20000 THEN v_minimum := round(v_minimum_usd * v_rate); ELSE v_minimum := round(v_minimum); END IF;
        ELSIF v_minimum < 20000 THEN
          v_minimum_usd := v_minimum;
          v_minimum := round(v_minimum_usd * v_rate);
        ELSE
          v_minimum_usd := round(v_minimum / v_rate, 2);
          v_minimum := round(v_minimum);
        END IF;
      END IF;
    ELSE
      -- UZS mode
      v_cost := round(v_cost);
      IF v_cost_usd IS NULL OR v_cost_usd <= 0 THEN
        v_cost_usd := round(v_cost / v_rate, 2);
      END IF;

      IF v_retail IS NOT NULL THEN
        v_retail := round(v_retail);
        IF v_retail_usd IS NULL OR v_retail_usd <= 0 THEN v_retail_usd := round(v_retail / v_rate, 2); END IF;
      END IF;

      IF v_wholesale IS NOT NULL THEN
        v_wholesale := round(v_wholesale);
        IF v_wholesale_usd IS NULL OR v_wholesale_usd <= 0 THEN v_wholesale_usd := round(v_wholesale / v_rate, 2); END IF;
      END IF;

      IF v_minimum IS NOT NULL THEN
        v_minimum := round(v_minimum);
        IF v_minimum_usd IS NULL OR v_minimum_usd <= 0 THEN v_minimum_usd := round(v_minimum / v_rate, 2); END IF;
      END IF;
    END IF;

    SELECT * INTO v_product
    FROM public.products
    WHERE id = (v_line->>'product_id')::uuid
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mahsulot topilmadi' USING errcode = 'P0002';
    END IF;

    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    IF v_variant_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.product_variants
        WHERE id = v_variant_id AND product_id = v_product.id
      ) THEN
        RAISE EXCEPTION 'Variant mahsulotga tegishli emas' USING errcode = '22023';
      END IF;
    END IF;

    v_effective_minimum := coalesce(v_minimum, v_wholesale, v_retail, 0);

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
      v_currency, auth.uid(),
      coalesce((p_header->>'received_at')::timestamptz, clock_timestamp()),
      upper(btrim(v_receipt_no))
    ) RETURNING id INTO v_batch;

    -- Mahsulot narxlarini yangilash
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
          currency = v_currency
      WHERE id = v_product.id;
    ELSE
      UPDATE public.products
      SET cost_price = v_cost,
          cost_price_usd = coalesce(v_cost_usd, cost_price_usd),
          currency = v_currency
      WHERE id = v_product.id;
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
        product_id, batch_id, location_id, qr_code,
        serial_number, status, unit_sequence, variant_id
      ) VALUES (
        v_product.id, v_batch, v_location, v_line_qr,
        v_serial, 'available', v_unit_seq, v_variant_id
      ) RETURNING id INTO v_unit;

      INSERT INTO public.inventory_movements(
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity, unit_cost, reference_type,
        reference_id, actor_id, metadata
      ) VALUES (
        v_unit, v_product.id, v_batch, 'received',
        NULL, v_location, 1, v_cost, 'stock_receipt',
        v_receipt, auth.uid(),
        jsonb_build_object(
          'source', 'receive_stock',
          'receipt_no', v_receipt_no,
          'line_no', v_line_no,
          'unit_sequence', v_unit_seq
        )
      );

      v_created_units := v_created_units + 1;
    END LOOP;
  END LOOP;

  IF v_payment_status = 'paid' THEN
    UPDATE public.stock_receipts
    SET paid_amount = (
      SELECT coalesce(sum(quantity * unit_cost), 0)
      FROM public.stock_batches WHERE receipt_id = v_receipt
    )
    WHERE id = v_receipt;
  END IF;

  RETURN public.get_stock_receipt(v_receipt);
END;
$$;

GRANT EXECUTE ON FUNCTION public.receive_stock(jsonb, jsonb, uuid) TO authenticated, service_role;
