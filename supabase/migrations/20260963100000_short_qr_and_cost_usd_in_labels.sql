-- Migration: 20260963100000_short_qr_and_cost_usd_in_labels.sql
-- 1. Qisqa QR kod generatsiyasi: 2 ta katta harf + 4 ta raqam (masalan: AB1234)
-- 2. receive_stock va update_stock_receipt da generate_short_qr() dan foydalanish
-- 3. list_receipt_qr_labels va get_inventory_unit_passport ga cost_price_usd / unit_cost_usd qo'shish

BEGIN;

-- 1. generate_short_qr funksiyasini mustahkamlash: 2 ta harf + 4 ta raqam
CREATE OR REPLACE FUNCTION public.generate_short_qr()
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_letters text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_qr text;
  v_attempt integer := 0;
BEGIN
  LOOP
    v_qr := substr(v_letters, (floor(random() * 24) + 1)::int, 1)
         || substr(v_letters, (floor(random() * 24) + 1)::int, 1)
         || lpad((floor(random() * 10000))::text, 4, '0');
    
    IF NOT EXISTS (SELECT 1 FROM public.inventory_units WHERE qr_code = v_qr) THEN
      RETURN v_qr;
    END IF;

    v_attempt := v_attempt + 1;
    IF v_attempt > 100 THEN
      -- Fallback: 3 ta harf + 4 ta raqam
      v_qr := substr(v_letters, (floor(random() * 24) + 1)::int, 1)
           || substr(v_letters, (floor(random() * 24) + 1)::int, 1)
           || substr(v_letters, (floor(random() * 24) + 1)::int, 1)
           || lpad((floor(random() * 10000))::text, 4, '0');
      IF NOT EXISTS (SELECT 1 FROM public.inventory_units WHERE qr_code = v_qr) THEN
        RETURN v_qr;
      END IF;
    END IF;

    IF v_attempt > 200 THEN
      RAISE EXCEPTION 'QR kod generatsiya qilib bo''lmadi' USING errcode = 'P0001';
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_short_qr() TO authenticated, service_role;

-- 2. receive_stock funksiyasida generate_short_qr() ni qo'llash
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

  v_rate := coalesce(
    (p_header->>'exchange_rate')::numeric,
    public.get_effective_exchange_rate('USD', coalesce(v_branch_currency, 'UZS'), CURRENT_DATE)
  );

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

-- 3. list_receipt_qr_labels ga cost_price_usd va unit_cost_usd qo'shish
CREATE OR REPLACE FUNCTION public.list_receipt_qr_labels(
  p_receipt_id uuid,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_branch uuid;
  v_items jsonb;
  v_total bigint;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 200 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto‘g‘ri' USING errcode = '22023';
  END IF;

  SELECT branch_id INTO v_branch
  FROM public.stock_receipts
  WHERE id = p_receipt_id;

  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'Partiya topilmadi' USING errcode = 'P0002';
  END IF;

  IF NOT public.can_access_branch(v_branch) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.inventory_units u
  JOIN public.stock_batches b ON b.id = u.batch_id
  WHERE b.receipt_id = p_receipt_id;

  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.line_no, x.unit_sequence), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      u.id,
      coalesce(min(u.qr_code) OVER (PARTITION BY b.id), u.qr_code) AS qr_code,
      u.serial_number,
      u.unit_sequence,
      b.line_no,
      p.name AS product_name,
      p.sku,
      r.receipt_no,
      r.received_at,
      v.color_name AS variant_color,
      b.unit_cost,
      coalesce(b.unit_cost_usd, p.cost_price_usd) AS unit_cost_usd,
      coalesce(b.unit_cost_usd, p.cost_price_usd) AS cost_usd,
      p.cost_price,
      p.cost_price_usd,
      p.retail_price,
      p.wholesale_price,
      p.promotion_price,
      p.minimum_sale_price,
      p.compare_at_price,
      coalesce(v.promotion_price, v.retail_price, b.retail_price, p.promotion_price, p.retail_price) AS effective_price,
      btrim(br.currency::text) AS currency,
      jsonb_build_object(
        'title', p.name,
        'sku', p.sku,
        'price', coalesce(v.promotion_price, v.retail_price, b.retail_price, p.promotion_price, p.retail_price),
        'old_price', CASE WHEN coalesce(v.promotion_price, p.promotion_price) IS NOT NULL THEN coalesce(v.retail_price, b.retail_price, p.retail_price) ELSE p.compare_at_price END,
        'currency', btrim(br.currency::text),
        'qr', coalesce(min(u.qr_code) OVER (PARTITION BY b.id), u.qr_code),
        'color', v.color_name,
        'cost_usd', coalesce(b.unit_cost_usd, p.cost_price_usd)
      ) AS price_label
    FROM public.inventory_units u
    JOIN public.stock_batches b ON b.id = u.batch_id
    JOIN public.products p ON p.id = u.product_id
    LEFT JOIN public.product_variants v ON v.id = u.variant_id
    JOIN public.stock_receipts r ON r.id = b.receipt_id
    JOIN public.branches br ON br.id = r.branch_id
    WHERE b.receipt_id = p_receipt_id
    ORDER BY b.line_no, u.unit_sequence
    LIMIT p_limit OFFSET p_offset
  ) x;

  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_receipt_qr_labels(uuid, integer, integer) TO authenticated, service_role;

-- 4. get_inventory_unit_passport ga cost_price_usd va unit_cost_usd qo'shish
CREATE OR REPLACE FUNCTION public.get_inventory_unit_passport(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
  v_branch uuid;
  v_found boolean;
BEGIN
  SELECT l.branch_id, true INTO v_branch, v_found
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  WHERE upper(u.qr_code) = upper(btrim(p_code))
     OR upper(coalesce(u.serial_number, '')) = upper(btrim(p_code))
  LIMIT 1;

  IF NOT coalesce(v_found, false) THEN
    RAISE EXCEPTION 'QR yoki seriya bo''yicha mahsulot topilmadi' USING errcode = 'P0002';
  END IF;

  IF NOT (
    (v_branch IS NOT NULL AND public.can_access_branch(v_branch))
    OR public.has_role(ARRAY['superadmin', 'admin']::public.app_role[], NULL)
    OR EXISTS (
      SELECT 1 FROM public.inventory_units u
      JOIN public.sale_lines sl ON sl.unit_id = u.id
      JOIN public.sales s ON s.id = sl.sale_id
      WHERE (upper(u.qr_code) = upper(btrim(p_code)) OR upper(coalesce(u.serial_number, '')) = upper(btrim(p_code)))
        AND public.can_access_branch(s.branch_id)
    )
  ) THEN
    RAISE EXCEPTION 'Bu mahsulot uchun ruxsat yo''q' USING errcode = '42501';
  END IF;

  SELECT jsonb_build_object(
    'id', u.id,
    'qr_code', u.qr_code,
    'serial_number', u.serial_number,
    'status', u.status,
    'version', u.version,
    'sold_sale_id', u.sold_sale_id,
    'variant_id', u.variant_id,
    'variant_color', v.color_name,
    'variant_color_hex', v.color_hex,
    'cost_price_usd', coalesce(b.unit_cost_usd, p.cost_price_usd),
    'can_revert_sale', u.status = 'sold' AND u.sold_sale_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.sales s2
        WHERE s2.id = u.sold_sale_id AND s2.status <> 'void'
          AND (
            public.has_role(ARRAY['superadmin', 'admin']::public.app_role[], NULL)
            OR public.has_role(ARRAY['manager']::public.app_role[], s2.branch_id)
          )
      )
      AND NOT EXISTS (SELECT 1 FROM public.sale_return_lines rl WHERE rl.unit_id = u.id),
    'product', jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'sku', p.sku,
      'barcode', p.barcode,
      'brand_name', br.name,
      'slug', p.slug,
      'is_published', p.is_published,
      'status', p.status,
      'retail_price', p.retail_price,
      'retail_price_usd', p.retail_price_usd,
      'cost_price', p.cost_price,
      'cost_price_usd', p.cost_price_usd,
      'wholesale_price', p.wholesale_price,
      'wholesale_price_usd', p.wholesale_price_usd,
      'minimum_sale_price', p.minimum_sale_price,
      'minimum_sale_price_usd', p.minimum_sale_price_usd,
      'image', coalesce(
        (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = u.variant_id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
        (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL ORDER BY m.is_primary DESC, m.sort_order LIMIT 1)
      )
    ),
    'batch', jsonb_build_object(
      'id', b.id,
      'receipt_id', r.id,
      'receipt_no', r.receipt_no,
      'received_at', r.received_at,
      'supplier_name', s.name,
      'unit_cost', b.unit_cost,
      'unit_cost_usd', coalesce(b.unit_cost_usd, p.cost_price_usd),
      'retail_price', coalesce(v.retail_price, b.retail_price),
      'wholesale_price', coalesce(v.wholesale_price, b.wholesale_price),
      'minimum_sale_price', coalesce(v.minimum_sale_price, b.minimum_sale_price)
    ),
    'latest_batch_prices', (
      SELECT jsonb_build_object(
        'retail_price', lb.retail_price,
        'wholesale_price', lb.wholesale_price,
        'minimum_sale_price', lb.minimum_sale_price,
        'unit_cost', lb.unit_cost,
        'unit_cost_usd', lb.unit_cost_usd,
        'received_at', lr.received_at
      )
      FROM public.stock_batches lb
      JOIN public.stock_receipts lr ON lr.id = lb.receipt_id
      WHERE lb.product_id = p.id AND lb.retail_price IS NOT NULL
      ORDER BY lr.received_at DESC LIMIT 1
    ),
    'location', jsonb_build_object(
      'id', l.id,
      'name', l.name,
      'type', l.type,
      'branch_id', l.branch_id,
      'branch_name', branch.name
    ),
    'sale', (
      SELECT jsonb_build_object(
        'sale_id', sale.id,
        'sale_no', sale.sale_no,
        'sold_at', sale.sold_at,
        'status', sale.status,
        'branch_id', sale.branch_id,
        'branch_name', sb.name,
        'receipt_lines', (
          SELECT jsonb_agg(jsonb_build_object(
            'unit_price', sl.unit_price,
            'quantity', sl.quantity,
            'total_price', sl.total_price,
            'discount_amount', sl.discount_amount
          ))
          FROM public.sale_lines sl
          WHERE sl.sale_id = sale.id AND sl.unit_id = u.id
        )
      )
      FROM public.sales sale
      JOIN public.branches sb ON sb.id = sale.branch_id
      WHERE sale.id = u.sold_sale_id
      LIMIT 1
    )
  )
  INTO v_result
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  LEFT JOIN public.product_variants v ON v.id = u.variant_id
  LEFT JOIN public.brands br ON br.id = p.brand_id
  LEFT JOIN public.stock_batches b ON b.id = u.batch_id
  LEFT JOIN public.stock_receipts r ON r.id = b.receipt_id
  LEFT JOIN public.suppliers s ON s.id = r.supplier_id
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.branches branch ON branch.id = l.branch_id
  WHERE upper(u.qr_code) = upper(btrim(p_code))
     OR upper(coalesce(u.serial_number, '')) = upper(btrim(p_code))
  LIMIT 1;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_inventory_unit_passport(text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
