-- Migration: 20260963120000_fix_receive_stock_exchange_rate.sql
-- 1. Create get_effective_exchange_rate function with flexible types and safe fallback
-- 2. Update receive_stock RPC to safely resolve exchange_rate without throwing function does not exist error

BEGIN;

-- 1. get_effective_exchange_rate funksiyasini yaratish
CREATE OR REPLACE FUNCTION public.get_effective_exchange_rate(
  p_from text DEFAULT 'USD',
  p_to text DEFAULT 'UZS',
  p_date date DEFAULT CURRENT_DATE
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    (
      SELECT rate FROM public.exchange_rates
      WHERE currency_from = coalesce(p_from, 'USD')
        AND currency_to = coalesce(p_to, 'UZS')
        AND rate_date <= coalesce(p_date, CURRENT_DATE)
      ORDER BY rate_date DESC, created_at DESC
      LIMIT 1
    ),
    (
      SELECT rate FROM public.exchange_rates
      WHERE currency_from = coalesce(p_from, 'USD')
        AND currency_to = coalesce(p_to, 'UZS')
      ORDER BY rate_date DESC, created_at DESC
      LIMIT 1
    ),
    12800
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_effective_exchange_rate(text, text, date) TO authenticated, service_role, anon;

-- 2. receive_stock funksiyasini yangilash
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
  v_line_no integer := 0;
  v_seq integer;
  v_serials jsonb;
  v_line_qr text;
  v_total_units integer := 0;
  v_total_cost numeric(18,2) := 0;
  v_paid_amount numeric(18,2) := 0;
  v_debt numeric(18,2) := 0;
  v_currency text;
  v_branch_currency text;
  v_receipt_no text;
  v_rate numeric(18,4);
  v_payment_status text := 'pending';
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key majburiy' USING errcode = '22023';
  END IF;

  v_request_hash := md5(concat_ws('|', p_header::text, p_lines::text));

  SELECT id, request_hash INTO v_existing, v_existing_hash
  FROM public.stock_receipts
  WHERE idempotency_key = p_idempotency_key;

  IF v_existing IS NOT NULL THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'Idempotency kaliti boshqa parametrlar bilan ishlatilgan' USING errcode = '23505';
    END IF;
    RETURN jsonb_build_object('receipt_id', v_existing, 'status', 'idempotent_replay');
  END IF;

  v_branch := (p_header->>'branch_id')::uuid;
  v_location := (p_header->>'receiving_location_id')::uuid;
  v_supplier := (p_header->>'supplier_id')::uuid;
  v_currency := upper(coalesce(nullif(btrim(p_header->>'currency'), ''), 'USD'));

  IF v_branch IS NULL OR v_location IS NULL THEN
    RAISE EXCEPTION 'Filial va qabul qilish joyi majburiy' USING errcode = '22023';
  END IF;

  IF NOT public.can_access_branch(v_branch) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  SELECT btrim(currency::text) INTO v_branch_currency
  FROM public.branches
  WHERE id = v_branch;

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

  v_receipt_no := p_header->>'receipt_no';
  IF v_receipt_no IS NULL OR btrim(v_receipt_no) = '' THEN
    v_receipt_no := 'REC-' || to_char(now(), 'YYYYMMDD-HH24MISS');
  END IF;

  v_paid_amount := coalesce((p_header->>'paid_amount')::numeric, 0);

  INSERT INTO public.stock_receipts(
    idempotency_key, branch_id, receiving_location_id, supplier_id,
    received_at, created_by, receipt_no, total_cost, paid_amount,
    currency, request_hash, notes, payment_status, exchange_rate
  ) VALUES (
    p_idempotency_key, v_branch, v_location, v_supplier,
    coalesce((p_header->>'received_at')::timestamptz, clock_timestamp()),
    auth.uid(), v_receipt_no, 0, v_paid_amount,
    v_currency, v_request_hash, nullif(p_header->>'notes', ''),
    v_payment_status, v_rate
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

    -- Agar USD qiymatlar kiritilmagan bo'lsa valyutaga qarab hisoblash
    IF v_cost_usd IS NULL OR v_cost_usd = 0 THEN
      IF v_currency = 'USD' THEN
        v_cost_usd := v_cost;
      ELSIF v_rate > 0 THEN
        v_cost_usd := round(v_cost / v_rate, 2);
      END IF;
    END IF;

    IF v_retail_usd IS NULL AND v_retail IS NOT NULL THEN
      IF v_currency = 'USD' THEN
        v_retail_usd := v_retail;
      ELSIF v_rate > 0 THEN
        v_retail_usd := round(v_retail / v_rate, 2);
      END IF;
    END IF;

    IF v_wholesale_usd IS NULL AND v_wholesale IS NOT NULL THEN
      IF v_currency = 'USD' THEN
        v_wholesale_usd := v_wholesale;
      ELSIF v_rate > 0 THEN
        v_wholesale_usd := round(v_wholesale / v_rate, 2);
      END IF;
    END IF;

    IF v_minimum_usd IS NULL AND v_minimum IS NOT NULL THEN
      IF v_currency = 'USD' THEN
        v_minimum_usd := v_minimum;
      ELSIF v_rate > 0 THEN
        v_minimum_usd := round(v_minimum / v_rate, 2);
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
      receipt_id, line_no, product_id, variant_id, quantity, unit_cost, unit_cost_usd,
      retail_price, retail_price_usd, wholesale_price, wholesale_price_usd,
      minimum_sale_price, minimum_sale_price_usd
    ) VALUES (
      v_receipt, v_line_no, v_product.id, v_variant_id, v_qty, v_cost, v_cost_usd,
      v_retail, v_retail_usd, v_wholesale, v_wholesale_usd,
      v_effective_minimum, coalesce(v_minimum_usd, v_wholesale_usd, v_retail_usd, 0)
    ) RETURNING id INTO v_batch;

    -- Mahsulot narxlarini yangilash
    IF v_retail IS NOT NULL THEN
      UPDATE public.products
      SET cost_price = v_cost,
          cost_price_usd = v_cost_usd,
          retail_price = v_retail,
          retail_price_usd = v_retail_usd,
          wholesale_price = v_wholesale,
          wholesale_price_usd = v_wholesale_usd,
          minimum_sale_price = v_effective_minimum,
          minimum_sale_price_usd = coalesce(v_minimum_usd, minimum_sale_price_usd),
          currency = v_currency
      WHERE id = v_product.id;
    ELSIF v_cost > 0 THEN
      UPDATE public.products
      SET cost_price = CASE WHEN cost_price = 0 THEN v_cost ELSE cost_price END,
          cost_price_usd = CASE WHEN coalesce(cost_price_usd, 0) = 0 THEN v_cost_usd ELSE cost_price_usd END,
          currency = v_currency
      WHERE id = v_product.id;
    END IF;

    -- Qisqa QR kod generatsiyasi (2 ta katta harf + 4 ta son, masalan: AB1234)
    v_line_qr := public.generate_short_qr();

    FOR v_seq IN 1..v_qty LOOP
      INSERT INTO public.inventory_units(
        product_id, variant_id, batch_id, qr_code, serial_number, location_id, status, unit_sequence
      ) VALUES (
        v_product.id,
        v_variant_id,
        v_batch,
        v_line_qr,
        nullif(btrim(v_serials->>(v_seq - 1)), ''),
        v_location,
        'available',
        v_seq
      ) RETURNING id INTO v_unit;

      INSERT INTO public.stock_ledger(
        product_id, variant_id, batch_id, unit_id, from_location_id, to_location_id,
        direction, quantity, change_type, reference_type, reference_id, actor_id,
        notes, unit_cost, total_cost, currency
      ) VALUES (
        v_product.id, v_variant_id, v_batch, v_unit, NULL, v_location,
        'in', 1, 'received', 'stock_receipt', v_receipt, auth.uid(),
        'Partiya qabuli #' || v_line_no, v_cost, v_cost, v_currency
      );

      INSERT INTO public.inventory_movements(
        unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
        quantity, unit_cost, reference_type, reference_id, actor_id, metadata
      ) VALUES (
        v_unit, v_product.id, v_batch, 'received', NULL, v_location,
        1, v_cost, 'stock_receipt', v_receipt, auth.uid(),
        jsonb_build_object('source', 'receive_stock', 'unit_sequence', v_seq)
      );
    END LOOP;

    v_total_units := v_total_units + v_qty;
    v_total_cost := v_total_cost + (v_qty * v_cost);
  END LOOP;

  v_debt := greatest(0, v_total_cost - v_paid_amount);
  v_payment_status := CASE
    WHEN v_paid_amount >= v_total_cost THEN 'paid'
    WHEN v_paid_amount > 0 THEN 'partial'
    ELSE 'pending'
  END;

  UPDATE public.stock_receipts
  SET total_cost = v_total_cost,
      paid_amount = v_paid_amount,
      debt_amount = v_debt,
      payment_status = v_payment_status
  WHERE id = v_receipt;

  RETURN jsonb_build_object(
    'receipt_id', v_receipt,
    'total_units', v_total_units,
    'total_cost', v_total_cost,
    'paid_amount', v_paid_amount,
    'debt_amount', v_debt,
    'payment_status', v_payment_status,
    'status', 'created'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.receive_stock(jsonb, jsonb, uuid) TO authenticated, service_role;

COMMIT;
