-- 20260963360000_fix_inventory_currency_uzs_immutability.sql
-- Tovar va inventarizatsiyada valyuta bo'yicha qat'iy immutability (o'zgarmaslik) qoidasi:
-- 1. Agar tovar narxi UZS (so'm)da kiritilgan bo'lsa (currency = 'UZS'), dollar kursi o'zgarganda uning
--    SO'MDAGI NARXLARI (tannarx, chakana, ulgurji, minimal) 1 TIYINGA HAM O'ZGARMAYDI!
--    Faqatgina uning USD ekvivalenti (cost_price_usd, retail_price_usd) yangi kurs bo'yicha qayta hisoblanadi.
-- 2. Agar tovar narxi USD (dollar)da kiritilgan bo'lsa (currency = 'USD'), dollar kursi o'zgarganda uning
--    DOLLARDAGI NARXI konstanta qoladi, SO'MDAGI narxi esa yangi kursga ko'paytirilib yangilanadi.
-- 3. sync_usd_prices_on_rate_change funksiyasidagi xato tuzatildi: u avval barcha tovarlarning USD narxi borligiga qarab
--    so'mdagi narxini o'zgartirib yuborayotgan edi. Endi FAQAT currency = 'USD' bo'lgan tovarlarning so'm narxi yangilanadi!
-- 4. receive_stock funksiyasi yangilandi: inventarizatsiya yoki UZS tovarlar partiya qabul qilinganda ham UZS bo'lib qoladi.

-- 1. sync_usd_prices_on_rate_change funksiyasini yangilash
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
        WHEN minimum_sale_price_usd IS NOT NULL AND minimum_sale_price_usd > 0 THEN round(minimum_sale_price_usd * p_new_rate)
        ELSE minimum_sale_price
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
        WHEN p.currency = 'USD' AND pv.minimum_sale_price_usd IS NOT NULL AND pv.minimum_sale_price_usd > 0 THEN round(pv.minimum_sale_price_usd * p_new_rate)
        ELSE pv.minimum_sale_price
      END,
      minimum_sale_price_usd = CASE
        WHEN p.currency = 'USD' THEN pv.minimum_sale_price_usd
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
        WHEN minimum_sale_price_usd IS NOT NULL AND minimum_sale_price_usd > 0 THEN round(minimum_sale_price_usd * p_new_rate)
        ELSE minimum_sale_price
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

  IF v_receipt_no IS NULL OR btrim(v_receipt_no) = '' THEN
    v_receipt_no := 'REC-' || to_char(now(), 'YYYYMMDD-HH24MISS');
  END IF;

  IF v_currency IS NULL THEN
    IF v_receipt_no LIKE 'INV-%' THEN
      v_currency := 'UZS';
    ELSE
      v_currency := coalesce(v_branch_currency, 'USD');
    END IF;
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

    -- Mahsulotni topish va bloklash
    SELECT * INTO v_product
    FROM public.products
    WHERE id = (v_line->>'product_id')::uuid
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mahsulot topilmadi' USING errcode = 'P0002';
    END IF;

    -- Qator valyutasi (prioritet: 1. Qatordagi currency, 2. Agar inventarizatsiya bo'lsa 'UZS', 3. Mahsulot valyutasi, 4. v_currency)
    v_line_currency := upper(nullif(btrim(coalesce(
      v_line->>'currency',
      case when v_receipt_no like 'INV-%' then coalesce(v_product.currency, 'UZS') else null end,
      v_product.currency,
      v_currency,
      'UZS'
    )), ''));

    IF v_line_currency IS NULL THEN
      v_line_currency := 'UZS';
    END IF;

    -- Narxlar normalizatsiyasi
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

      IF v_retail IS NOT NULL OR v_retail_usd IS NOT NULL THEN
        IF v_retail_usd IS NOT NULL AND v_retail_usd > 0 THEN
          v_retail := round(v_retail_usd * v_rate);
        ELSIF v_retail < 20000 THEN
          v_retail_usd := v_retail;
          v_retail := round(v_retail_usd * v_rate);
        ELSE
          v_retail_usd := round(v_retail / v_rate, 2);
          v_retail := round(v_retail);
        END IF;
      END IF;

      IF v_wholesale IS NOT NULL OR v_wholesale_usd IS NOT NULL THEN
        IF v_wholesale_usd IS NOT NULL AND v_wholesale_usd > 0 THEN
          v_wholesale := round(v_wholesale_usd * v_rate);
        ELSIF v_wholesale < 20000 THEN
          v_wholesale_usd := v_wholesale;
          v_wholesale := round(v_wholesale_usd * v_rate);
        ELSE
          v_wholesale_usd := round(v_wholesale / v_rate, 2);
          v_wholesale := round(v_wholesale);
        END IF;
      END IF;

      IF v_minimum IS NOT NULL OR v_minimum_usd IS NOT NULL THEN
        IF v_minimum_usd IS NOT NULL AND v_minimum_usd > 0 THEN
          v_minimum := round(v_minimum_usd * v_rate);
        ELSIF v_minimum < 20000 THEN
          v_minimum_usd := v_minimum;
          v_minimum := round(v_minimum_usd * v_rate);
        ELSE
          v_minimum_usd := round(v_minimum / v_rate, 2);
          v_minimum := round(v_minimum);
        END IF;
      END IF;
    ELSE
      -- UZS rejimi: UZS narx konstanta (aniq so'm saqlanadi, qayta ko'paytirilmaydi!)
      v_cost := round(v_cost);
      v_cost_usd := round(v_cost / v_rate, 2);

      IF v_retail IS NOT NULL THEN
        v_retail := round(v_retail);
        v_retail_usd := round(v_retail / v_rate, 2);
      END IF;

      IF v_wholesale IS NOT NULL THEN
        v_wholesale := round(v_wholesale);
        v_wholesale_usd := round(v_wholesale / v_rate, 2);
      END IF;

      IF v_minimum IS NOT NULL THEN
        v_minimum := round(v_minimum);
        v_minimum_usd := round(v_minimum / v_rate, 2);
      END IF;
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
          currency = v_line_currency
      WHERE id = v_product.id;
    ELSE
      UPDATE public.products
      SET cost_price = v_cost,
          cost_price_usd = coalesce(v_cost_usd, cost_price_usd),
          currency = v_line_currency
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

GRANT EXECUTE ON FUNCTION public.receive_stock(jsonb, jsonb, uuid) TO authenticated, service_role, anon;

-- 3. Bugun yaratilgan va inventarizatsiya orqali kiritilgan tovarlarning valyutasini UZS ga o'tkazish
-- va ularning asl so'm narxlarini tiklash:
UPDATE public.products
SET currency = 'UZS',
    cost_price = 1770000,
    retail_price = 2004000
WHERE name = 'Bolalar mashinasi GANLAN 9188';

UPDATE public.products
SET currency = 'UZS',
    cost_price = 2250000,
    retail_price = 2460000
WHERE name = 'Bolalar mashinasi 1155LAK';

UPDATE public.products
SET currency = 'UZS',
    cost_price = 900000,
    retail_price = 1140000
WHERE name = 'X1-9 KOLYASKA';

UPDATE public.products
SET currency = 'UZS',
    cost_price = 258000,
    retail_price = 360000
WHERE name = 'S500D kolyaska';

UPDATE public.products
SET currency = 'UZS',
    cost_price = 588000,
    retail_price = 684000
WHERE name = 'Bolalar uchun kolyaska 168DRON';

UPDATE public.products
SET currency = 'UZS',
    cost_price = 732000,
    retail_price = 900000
WHERE name = 'K304 KOLYASKA';

-- Shuningdek, ushbu tovarlarning tegishli partiyalari (stock_batches) va kvitansiyalarini (stock_receipts) UZS qilish:
UPDATE public.stock_batches b
SET currency = 'UZS',
    unit_cost = p.cost_price,
    retail_price = p.retail_price
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

UPDATE public.stock_receipts
SET currency = 'UZS'
WHERE receipt_no IN (
  'INV-20261017-093537',
  'INV-20261017-092349',
  'INV-20261017-091004',
  'INV-20261017-090535',
  'INV-20261017-090253',
  'INV-20261017-085830'
);

-- Barcha UZS tovarlarning USD ekvivalentini oxirgi kurs bo'yicha qayta hisoblash:
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
