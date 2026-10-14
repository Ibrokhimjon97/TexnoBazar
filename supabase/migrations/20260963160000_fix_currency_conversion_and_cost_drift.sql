-- Migration: Fix Currency Conversion and Cost Price Drift
-- 1. get_inventory_references: return cost_price_usd, retail_price_usd, wholesale_price_usd, minimum_sale_price_usd, currency
-- 2. update_stock_receipt: properly handle currency changes between USD and UZS, update batch and product currency, preserve exact USD values
-- 3. get_stock_receipt: return batch currency and preserve exact unit_cost_usd

BEGIN;

-- 1. Enhance get_inventory_references to include all USD price fields and currency
CREATE OR REPLACE FUNCTION public.get_inventory_references(p_branch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.can_access_branch(p_branch_id) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  RETURN jsonb_build_object(
    'locations', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', l.id, 'code', l.code, 'name', l.name, 'type', l.type) ORDER BY l.name)
      FROM public.locations l
      WHERE l.branch_id = p_branch_id AND l.is_active AND l.type IN ('store', 'warehouse')
    ), '[]'::jsonb),
    'suppliers', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name) ORDER BY s.name)
      FROM public.suppliers s
      WHERE s.is_active
    ), '[]'::jsonb),
    'products', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id,
        'sku', p.sku,
        'name', p.name,
        'track_individual_units', p.track_individual_units,
        'cost_price', p.cost_price,
        'cost_price_usd', p.cost_price_usd,
        'retail_price', p.retail_price,
        'retail_price_usd', p.retail_price_usd,
        'wholesale_price', p.wholesale_price,
        'wholesale_price_usd', p.wholesale_price_usd,
        'minimum_sale_price', p.minimum_sale_price,
        'minimum_sale_price_usd', p.minimum_sale_price_usd,
        'currency', p.currency,
        'image', (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1)
      ) ORDER BY p.name)
      FROM public.products p
      WHERE p.status <> 'archived'
    ), '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_inventory_references(uuid) TO authenticated, service_role;

-- 2. Enhance update_stock_receipt to properly handle currency conversions and batch currency
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
  v_r public.stock_receipts%rowtype;
  v_supplier uuid;
  v_new_location uuid;
  v_line jsonb;
  v_batch_id uuid;
  v_batch public.stock_batches%rowtype;
  v_new_qty integer;
  v_old_qty integer;
  v_diff integer;
  v_avail integer;
  v_color text;
  v_var_id uuid;
  v_seq integer;
  v_qr text;
  v_uc numeric(18,2);
  v_uc_usd numeric(18,2);
  v_rp numeric(18,2);
  v_rp_usd numeric(18,2);
  v_wp numeric(18,2);
  v_wp_usd numeric(18,2);
  v_mp numeric(18,2);
  v_mp_usd numeric(18,2);
  v_rate numeric;
  v_curr text;
  v_new_unit_id uuid;
  v_del_unit_ids uuid[];
  v_paid numeric(18,2);
BEGIN
  SELECT * INTO v_r FROM public.stock_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Partiya topilmadi' USING errcode = 'P0002'; END IF;
  PERFORM public.require_inventory_operator(v_r.branch_id);

  IF p_updates IS NULL OR jsonb_typeof(p_updates) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Yangilanish obyekti talab qilinadi' USING errcode = '22023';
  END IF;

  v_rate := public.get_effective_exchange_rate('USD', 'UZS');
  IF v_rate IS NULL OR v_rate <= 0 THEN v_rate := 11850; END IF;

  v_curr := UPPER(COALESCE(nullif(btrim(p_updates->>'currency'), ''), btrim(v_r.currency::text), 'USD'));

  -- 1. Supplier
  IF p_updates ? 'supplier_id' THEN
    v_supplier := nullif(btrim(p_updates->>'supplier_id'), '')::uuid;
    IF v_supplier IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.suppliers WHERE id = v_supplier AND is_active) THEN
      RAISE EXCEPTION 'Faol ta''minotchi topilmadi' USING errcode = 'P0002';
    END IF;
  ELSE
    v_supplier := v_r.supplier_id;
  END IF;

  -- 2. Location
  IF p_updates ? 'receiving_location_id' AND nullif(btrim(p_updates->>'receiving_location_id'), '') IS NOT NULL THEN
    v_new_location := (p_updates->>'receiving_location_id')::uuid;
    IF NOT EXISTS(SELECT 1 FROM public.locations WHERE id = v_new_location AND branch_id = v_r.branch_id AND is_active) THEN
      RAISE EXCEPTION 'Noto''g''ri qabul joylashuvi' USING errcode = 'P0002';
    END IF;
    IF v_new_location IS DISTINCT FROM v_r.receiving_location_id THEN
      INSERT INTO public.inventory_movements(
        unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
        quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
      )
      SELECT 
        u.id, u.product_id, u.batch_id, 'adjustment', u.location_id, v_new_location,
        1, b.unit_cost, 'stock_receipt', p_receipt_id, 'Partiya joylashuvi o‘zgartirildi', auth.uid(),
        jsonb_build_object('source', 'update_stock_receipt', 'reason', 'batch_relocation')
      FROM public.inventory_units u
      JOIN public.stock_batches b ON b.id = u.batch_id
      WHERE u.batch_id IN (SELECT id FROM public.stock_batches WHERE receipt_id = p_receipt_id)
        AND u.status IN ('available', 'returned')
        AND u.location_id IS DISTINCT FROM v_new_location;

      UPDATE public.inventory_units SET location_id = v_new_location, updated_at = now()
      WHERE batch_id IN (SELECT id FROM public.stock_batches WHERE receipt_id = p_receipt_id)
        AND status IN ('available', 'returned')
        AND location_id IS DISTINCT FROM v_new_location;
    END IF;
  ELSE
    v_new_location := v_r.receiving_location_id;
  END IF;

  -- 3. Lines update
  IF p_updates ? 'lines' AND jsonb_typeof(p_updates->'lines') = 'array' THEN
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_updates->'lines') LOOP
      v_batch_id := (v_line->>'id')::uuid;
      SELECT * INTO v_batch FROM public.stock_batches WHERE id = v_batch_id AND receipt_id = p_receipt_id FOR UPDATE;
      IF FOUND THEN
        -- Unit Cost
        IF v_line ? 'unit_cost' AND nullif(btrim(v_line->>'unit_cost'), '') IS NOT NULL THEN
          v_uc := (v_line->>'unit_cost')::numeric;
          v_uc_usd := CASE WHEN v_line ? 'unit_cost_usd' AND nullif(btrim(v_line->>'unit_cost_usd'), '') IS NOT NULL
            THEN (v_line->>'unit_cost_usd')::numeric ELSE NULL END;
          IF v_curr = 'USD' THEN
            IF v_uc_usd IS NOT NULL AND v_uc_usd > 0 THEN
              v_uc := round(v_uc_usd * v_rate);
            ELSE
              v_uc_usd := round(v_uc / v_rate, 2);
              v_uc := round(v_uc);
            END IF;
          ELSE
            -- UZS mode: v_uc is the UZS cost. Keep existing v_uc_usd if available or compute it
            v_uc := round(v_uc);
            IF v_uc_usd IS NULL THEN
              v_uc_usd := coalesce(v_batch.unit_cost_usd, round(v_uc / v_rate, 2));
            END IF;
          END IF;
          UPDATE public.stock_batches SET unit_cost = v_uc, unit_cost_usd = v_uc_usd, currency = v_curr WHERE id = v_batch_id;
          UPDATE public.products SET
            cost_price = v_uc,
            cost_price_usd = coalesce(v_uc_usd, cost_price_usd),
            currency = v_curr
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
          UPDATE public.stock_batches SET retail_price = v_rp, retail_price_usd = v_rp_usd, currency = v_curr WHERE id = v_batch_id;
          UPDATE public.products SET
            retail_price = v_rp,
            retail_price_usd = coalesce(v_rp_usd, retail_price_usd),
            currency = v_curr
          WHERE id = v_batch.product_id;
        END IF;

        -- Wholesale Price
        IF v_line ? 'wholesale_price' THEN
          IF nullif(btrim(v_line->>'wholesale_price'), '') IS NOT NULL THEN
            v_wp := (v_line->>'wholesale_price')::numeric;
            v_wp_usd := CASE WHEN v_line ? 'wholesale_price_usd' AND nullif(btrim(v_line->>'wholesale_price_usd'), '') IS NOT NULL
              THEN (v_line->>'wholesale_price_usd')::numeric ELSE NULL END;
            IF v_curr = 'USD' THEN
              IF v_wp_usd IS NOT NULL AND v_wp_usd > 0 THEN
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
          ELSE
            v_wp := NULL;
            v_wp_usd := NULL;
          END IF;
          UPDATE public.stock_batches SET wholesale_price = v_wp, wholesale_price_usd = v_wp_usd, currency = v_curr WHERE id = v_batch_id;
          UPDATE public.products SET
            wholesale_price = v_wp,
            wholesale_price_usd = v_wp_usd,
            currency = v_curr
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
          UPDATE public.stock_batches SET minimum_sale_price = v_mp, minimum_sale_price_usd = v_mp_usd, currency = v_curr WHERE id = v_batch_id;
          UPDATE public.products SET
            minimum_sale_price = v_mp,
            minimum_sale_price_usd = coalesce(v_mp_usd, minimum_sale_price_usd),
            currency = v_curr
          WHERE id = v_batch.product_id;
        END IF;

        -- Variant color
        IF v_line ? 'variant_color' THEN
          v_color := nullif(btrim(v_line->>'variant_color'), '');
          IF v_color IS NOT NULL THEN
            SELECT id INTO v_var_id FROM public.product_variants
            WHERE product_id = v_batch.product_id AND lower(color_name) = lower(v_color)
            LIMIT 1;
            IF v_var_id IS NULL THEN
              INSERT INTO public.product_variants(product_id, color_name, is_active)
              VALUES (v_batch.product_id, v_color, true)
              RETURNING id INTO v_var_id;
            END IF;
          ELSE
            v_var_id := NULL;
          END IF;
          UPDATE public.stock_batches SET variant_id = v_var_id WHERE id = v_batch_id;
          UPDATE public.inventory_units SET variant_id = v_var_id
          WHERE batch_id = v_batch_id AND status = 'available';
        END IF;

        -- Quantity sync
        IF v_line ? 'quantity' AND nullif(btrim(v_line->>'quantity'), '') IS NOT NULL THEN
          v_new_qty := (v_line->>'quantity')::integer;
          v_old_qty := v_batch.quantity;
          IF v_new_qty > v_old_qty THEN
            v_diff := v_new_qty - v_old_qty;
            SELECT coalesce(max(unit_sequence), 0) INTO v_seq FROM public.inventory_units WHERE batch_id = v_batch_id;
            FOR i IN 1..v_diff LOOP
              v_qr := public.generate_short_qr();
              INSERT INTO public.inventory_units (
                batch_id, product_id, variant_id, location_id, unit_sequence, qr_code, status
              ) VALUES (
                v_batch_id, v_batch.product_id, v_batch.variant_id, v_new_location, v_seq + i, v_qr, 'available'
              ) RETURNING id INTO v_new_unit_id;

              INSERT INTO public.inventory_movements (
                unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id, quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
              ) VALUES (
                v_new_unit_id, v_batch.product_id, v_batch_id, 'received', NULL, v_new_location, 1, v_batch.unit_cost, 'stock_receipt', p_receipt_id, 'Qo‘shimcha miqdor qabul qilindi', auth.uid(),
                jsonb_build_object('source', 'update_stock_receipt', 'unit_sequence', v_seq + i)
              );
            END LOOP;
            UPDATE public.stock_batches SET quantity = v_new_qty WHERE id = v_batch_id;
          ELSIF v_new_qty < v_old_qty AND v_new_qty >= 1 THEN
            v_diff := v_old_qty - v_new_qty;
            SELECT count(*) INTO v_avail FROM public.inventory_units WHERE batch_id = v_batch_id AND status = 'available';
            IF v_diff > v_avail THEN
              RAISE EXCEPTION 'Miqdorni % tagacha kamaytirib bo''lmaydi, chunki sotilgan birliklar bor', v_new_qty USING errcode = '22023';
            END IF;

            SELECT array_agg(id) INTO v_del_unit_ids
            FROM (
              SELECT id FROM public.inventory_units
              WHERE batch_id = v_batch_id AND status = 'available'
              ORDER BY unit_sequence DESC
              LIMIT v_diff
            ) t;

            IF v_del_unit_ids IS NOT NULL AND array_length(v_del_unit_ids, 1) > 0 THEN
              DELETE FROM public.inventory_movements WHERE unit_id = ANY(v_del_unit_ids);
              DELETE FROM public.pos_pending_sale_lines WHERE unit_id = ANY(v_del_unit_ids);
              DELETE FROM public.inventory_count_lines WHERE unit_id = ANY(v_del_unit_ids);
              DELETE FROM public.order_reserved_units WHERE unit_id = ANY(v_del_unit_ids);
              DELETE FROM public.inventory_units WHERE id = ANY(v_del_unit_ids);
            END IF;

            UPDATE public.stock_batches SET quantity = v_new_qty WHERE id = v_batch_id;
          END IF;
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- Update all batches in this receipt to ensure currency consistency
  UPDATE public.stock_batches SET currency = v_curr WHERE receipt_id = p_receipt_id;

  -- 4. General fields & paid_amount sync
  IF v_r.payment_status = 'paid' OR (p_updates ? 'payment_status' AND p_updates->>'payment_status' = 'paid') THEN
    SELECT coalesce(sum(quantity * unit_cost), 0) INTO v_paid FROM public.stock_batches WHERE receipt_id = p_receipt_id;
  ELSIF p_updates ? 'payment_status' AND p_updates->>'payment_status' = 'unpaid' THEN
    v_paid := 0;
  ELSIF p_updates ? 'paid_amount' AND nullif(btrim(p_updates->>'paid_amount'), '') IS NOT NULL THEN
    v_paid := (p_updates->>'paid_amount')::numeric;
  ELSE
    v_paid := v_r.paid_amount;
  END IF;

  UPDATE public.stock_receipts SET
    supplier_id = v_supplier,
    receiving_location_id = v_new_location,
    currency = v_curr,
    invoice_number = CASE WHEN p_updates ? 'invoice_number' THEN nullif(btrim(p_updates->>'invoice_number'), '') ELSE invoice_number END,
    payment_status = CASE WHEN p_updates ? 'payment_status' THEN coalesce(nullif(btrim(p_updates->>'payment_status'), ''), payment_status) ELSE payment_status END,
    paid_amount = coalesce(v_paid, paid_amount),
    received_at = CASE WHEN p_updates ? 'received_at' AND nullif(btrim(p_updates->>'received_at'), '') IS NOT NULL THEN (p_updates->>'received_at')::timestamptz ELSE received_at END,
    notes = CASE WHEN p_updates ? 'notes' THEN nullif(btrim(p_updates->>'notes'), '') ELSE notes END,
    updated_at = now()
  WHERE id = p_receipt_id;

  RETURN public.get_stock_receipt(p_receipt_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_stock_receipt(uuid, jsonb) TO authenticated, service_role;

-- 3. Enhance get_stock_receipt to guarantee currency on receipt lines
CREATE OR REPLACE FUNCTION public.get_stock_receipt(p_receipt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
  v_branch uuid;
BEGIN
  SELECT branch_id INTO v_branch FROM public.stock_receipts WHERE id = p_receipt_id;
  IF v_branch IS NULL THEN RAISE EXCEPTION 'Partiya topilmadi' USING errcode = 'P0002'; END IF;
  IF NOT public.can_access_branch(v_branch) THEN RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501'; END IF;

  SELECT to_jsonb(r) || jsonb_build_object(
    'branch_name', br.name,
    'supplier_name', coalesce(s.name, CASE WHEN r.receipt_no LIKE 'INV-%' THEN 'Inventarizatsiya' ELSE 'Ta’minotchi ko‘rsatilmagan' END),
    'location_name', l.name,
    'location_type', l.type,
    'lines', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', b.id, 'line_no', b.line_no, 'product_id', b.product_id,
          'product_name', p.name, 'sku', p.sku, 'variant_id', b.variant_id,
          'variant_color', v.color_name, 'quantity', b.quantity,
          'unit_cost', b.unit_cost,
          'unit_cost_usd', coalesce(b.unit_cost_usd, p.cost_price_usd),
          'retail_price', coalesce(v.retail_price, b.retail_price, p.retail_price),
          'retail_price_usd', coalesce(v.retail_price_usd, b.retail_price_usd, p.retail_price_usd),
          'wholesale_price', coalesce(v.wholesale_price, b.wholesale_price, p.wholesale_price),
          'wholesale_price_usd', coalesce(v.wholesale_price_usd, b.wholesale_price_usd, p.wholesale_price_usd),
          'minimum_sale_price', coalesce(v.minimum_sale_price, b.minimum_sale_price, p.minimum_sale_price, 0),
          'minimum_sale_price_usd', coalesce(v.minimum_sale_price_usd, b.minimum_sale_price_usd, p.minimum_sale_price_usd, 0),
          'currency', coalesce(b.currency, r.currency, 'USD'),
          'qr_count', (SELECT count(*) FROM public.inventory_units u WHERE u.batch_id = b.id)
        ) ORDER BY b.line_no
      )
      FROM public.stock_batches b
      JOIN public.products p ON p.id = b.product_id
      LEFT JOIN public.product_variants v ON v.id = b.variant_id
      WHERE b.receipt_id = r.id
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM public.stock_receipts r
  JOIN public.branches br ON br.id = r.branch_id
  LEFT JOIN public.suppliers s ON s.id = r.supplier_id
  JOIN public.locations l ON l.id = r.receiving_location_id
  WHERE r.id = p_receipt_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_stock_receipt(uuid) TO authenticated, service_role;

COMMIT;
