-- Fix update_stock_receipt foreign key violation when reducing batch quantity
-- 1. Alter foreign key constraint on inventory_movements to ON DELETE CASCADE
ALTER TABLE public.inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_unit_id_fkey;
ALTER TABLE public.inventory_movements 
  ADD CONSTRAINT inventory_movements_unit_id_fkey 
  FOREIGN KEY (unit_id) REFERENCES public.inventory_units(id) ON DELETE CASCADE;

-- 2. Update update_stock_receipt function
CREATE OR REPLACE FUNCTION public.update_stock_receipt(p_receipt_id uuid, p_updates jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_r public.stock_receipts%rowtype;
  v_total numeric(18,2);
  v_supplier uuid;
  v_status text;
  v_paid numeric(18,2);
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
  v_rate numeric := 11850;
  v_curr text;
  v_new_unit_id uuid;
  v_del_unit_ids uuid[];
BEGIN
  SELECT * INTO v_r FROM public.stock_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Partiya topilmadi' USING errcode = 'P0002'; END IF;
  PERFORM public.require_inventory_operator(v_r.branch_id);

  IF p_updates IS NULL OR jsonb_typeof(p_updates) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Yangilanish obyekti talab qilinadi' USING errcode = '22023';
  END IF;

  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC, created_at DESC
  LIMIT 1;
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

  -- 2. Receiving location
  IF p_updates ? 'receiving_location_id' AND nullif(btrim(p_updates->>'receiving_location_id'), '') IS NOT NULL THEN
    v_new_location := (p_updates->>'receiving_location_id')::uuid;
    IF NOT EXISTS(SELECT 1 FROM public.locations WHERE id = v_new_location AND branch_id = v_r.branch_id AND is_active) THEN
      RAISE EXCEPTION 'Noto''g''ri qabul joylashuvi' USING errcode = 'P0002';
    END IF;
    IF v_new_location IS DISTINCT FROM v_r.receiving_location_id THEN
      UPDATE public.inventory_units SET location_id = v_new_location
      WHERE batch_id IN (SELECT id FROM public.stock_batches WHERE receipt_id = p_receipt_id)
        AND status = 'available';
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
        -- Prices
        IF v_line ? 'unit_cost' AND nullif(btrim(v_line->>'unit_cost'), '') IS NOT NULL THEN
          v_uc := (v_line->>'unit_cost')::numeric;
          v_uc_usd := CASE WHEN v_line ? 'unit_cost_usd' AND nullif(btrim(v_line->>'unit_cost_usd'), '') IS NOT NULL
            THEN (v_line->>'unit_cost_usd')::numeric ELSE NULL END;
          IF v_curr = 'USD' THEN
            IF v_uc_usd IS NOT NULL AND v_uc_usd > 0 THEN
              v_uc := round(v_uc_usd * v_rate);
            ELSIF v_uc > 0 THEN
              IF v_uc < 20000 THEN
                v_uc_usd := v_uc;
                v_uc := round(v_uc_usd * v_rate);
              ELSE
                v_uc_usd := round(v_uc / v_rate, 2);
              END IF;
            END IF;
          END IF;
          UPDATE public.stock_batches
          SET unit_cost = v_uc,
              unit_cost_usd = coalesce(v_uc_usd, unit_cost_usd)
          WHERE id = v_batch_id;
        END IF;

        v_rp := CASE WHEN v_line ? 'retail_price' AND nullif(btrim(v_line->>'retail_price'), '') IS NOT NULL THEN (v_line->>'retail_price')::numeric ELSE NULL END;
        v_rp_usd := CASE WHEN v_line ? 'retail_price_usd' AND nullif(btrim(v_line->>'retail_price_usd'), '') IS NOT NULL THEN (v_line->>'retail_price_usd')::numeric ELSE NULL END;

        v_wp := CASE WHEN v_line ? 'wholesale_price' AND nullif(btrim(v_line->>'wholesale_price'), '') IS NOT NULL THEN (v_line->>'wholesale_price')::numeric ELSE NULL END;
        v_wp_usd := CASE WHEN v_line ? 'wholesale_price_usd' AND nullif(btrim(v_line->>'wholesale_price_usd'), '') IS NOT NULL THEN (v_line->>'wholesale_price_usd')::numeric ELSE NULL END;

        v_mp := CASE WHEN v_line ? 'minimum_sale_price' AND nullif(btrim(v_line->>'minimum_sale_price'), '') IS NOT NULL THEN (v_line->>'minimum_sale_price')::numeric ELSE NULL END;
        v_mp_usd := CASE WHEN v_line ? 'minimum_sale_price_usd' AND nullif(btrim(v_line->>'minimum_sale_price_usd'), '') IS NOT NULL THEN (v_line->>'minimum_sale_price_usd')::numeric ELSE NULL END;

        IF v_curr = 'USD' THEN
          IF v_rp_usd IS NOT NULL AND v_rp_usd > 0 THEN
            v_rp := round(v_rp_usd * v_rate);
          ELSIF v_rp IS NOT NULL AND v_rp > 0 THEN
            IF v_rp < 20000 THEN v_rp_usd := v_rp; v_rp := round(v_rp_usd * v_rate); ELSE v_rp_usd := round(v_rp / v_rate, 2); END IF;
          END IF;

          IF v_wp_usd IS NOT NULL AND v_wp_usd > 0 THEN
            v_wp := round(v_wp_usd * v_rate);
          ELSIF v_wp IS NOT NULL AND v_wp > 0 THEN
            IF v_wp < 20000 THEN v_wp_usd := v_wp; v_wp := round(v_wp_usd * v_rate); ELSE v_wp_usd := round(v_wp / v_rate, 2); END IF;
          END IF;

          IF v_mp_usd IS NOT NULL AND v_mp_usd > 0 THEN
            v_mp := round(v_mp_usd * v_rate);
          ELSIF v_mp IS NOT NULL AND v_mp > 0 THEN
            IF v_mp < 20000 THEN v_mp_usd := v_mp; v_mp := round(v_mp_usd * v_rate); ELSE v_mp_usd := round(v_mp / v_rate, 2); END IF;
          END IF;
        END IF;

        IF v_rp IS NOT NULL OR v_wp IS NOT NULL OR v_mp IS NOT NULL THEN
          UPDATE public.stock_batches SET
            retail_price = coalesce(v_rp, retail_price),
            retail_price_usd = coalesce(v_rp_usd, retail_price_usd),
            wholesale_price = coalesce(v_wp, wholesale_price),
            wholesale_price_usd = coalesce(v_wp_usd, wholesale_price_usd),
            minimum_sale_price = coalesce(v_mp, minimum_sale_price),
            minimum_sale_price_usd = coalesce(v_mp_usd, minimum_sale_price_usd)
          WHERE id = v_batch_id;

          UPDATE public.products SET
            retail_price = coalesce(v_rp, retail_price),
            retail_price_usd = coalesce(v_rp_usd, retail_price_usd),
            wholesale_price = coalesce(v_wp, wholesale_price),
            wholesale_price_usd = coalesce(v_wp_usd, wholesale_price_usd),
            minimum_sale_price = coalesce(v_mp, minimum_sale_price),
            minimum_sale_price_usd = coalesce(v_mp_usd, minimum_sale_price_usd),
            cost_price = coalesce(v_uc, cost_price),
            cost_price_usd = coalesce(v_uc_usd, cost_price_usd),
            currency = v_curr
          WHERE id = v_batch.product_id;

          IF v_batch.variant_id IS NOT NULL THEN
            UPDATE public.product_variants SET
              retail_price = coalesce(v_rp, retail_price),
              retail_price_usd = coalesce(v_rp_usd, retail_price_usd),
              wholesale_price = coalesce(v_wp, wholesale_price),
              wholesale_price_usd = coalesce(v_wp_usd, wholesale_price_usd),
              minimum_sale_price = coalesce(v_mp, minimum_sale_price),
              minimum_sale_price_usd = coalesce(v_mp_usd, minimum_sale_price_usd),
              cost_price = coalesce(v_uc, cost_price),
              cost_price_usd = coalesce(v_uc_usd, cost_price_usd)
            WHERE id = v_batch.variant_id;
          END IF;
        END IF;

        -- Color / Variant
        IF v_line ? 'variant_color' THEN
          v_color := nullif(btrim(v_line->>'variant_color'), '');
          IF v_color IS NOT NULL THEN
            SELECT id INTO v_var_id FROM public.product_variants
            WHERE product_id = v_batch.product_id AND lower(btrim(color_name)) = lower(v_color) LIMIT 1;
            IF v_var_id IS NULL THEN
              INSERT INTO public.product_variants(product_id, color_name, retail_price, retail_price_usd, wholesale_price, wholesale_price_usd, minimum_sale_price, minimum_sale_price_usd, is_active)
              VALUES(v_batch.product_id, v_color, v_rp, v_rp_usd, v_wp, v_wp_usd, v_mp, v_mp_usd, true)
              RETURNING id INTO v_var_id;
            END IF;
            UPDATE public.stock_batches SET variant_id = v_var_id WHERE id = v_batch_id;
            UPDATE public.inventory_units SET variant_id = v_var_id
            WHERE batch_id = v_batch_id AND status = 'available';
          END IF;
        END IF;

        -- Quantity
        IF v_line ? 'quantity' AND nullif(btrim(v_line->>'quantity'), '') IS NOT NULL THEN
          v_new_qty := (v_line->>'quantity')::integer;
          v_old_qty := v_batch.quantity;
          IF v_new_qty > v_old_qty THEN
            v_diff := v_new_qty - v_old_qty;
            SELECT qr_code INTO v_qr FROM public.inventory_units WHERE batch_id = v_batch_id LIMIT 1;
            SELECT coalesce(max(unit_sequence), 0) INTO v_seq FROM public.inventory_units WHERE batch_id = v_batch_id;
            FOR i IN 1..v_diff LOOP
              INSERT INTO public.inventory_units(
                product_id, variant_id, batch_id, qr_code, location_id, status, unit_sequence
              ) VALUES (
                v_batch.product_id, v_batch.variant_id, v_batch_id, v_qr, v_new_location, 'available', v_seq + i
              ) RETURNING id INTO v_new_unit_id;

              INSERT INTO public.inventory_movements(
                unit_id, product_id, batch_id, movement_type, to_location_id,
                quantity, unit_cost, reference_type, reference_id, actor_id, metadata
              ) VALUES (
                v_new_unit_id, v_batch.product_id, v_batch_id, 'received', v_new_location,
                1, coalesce(v_uc, v_batch.unit_cost), 'stock_receipt', p_receipt_id, auth.uid(),
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
              DELETE FROM public.inventory_units WHERE id = ANY(v_del_unit_ids);
            END IF;

            UPDATE public.stock_batches SET quantity = v_new_qty WHERE id = v_batch_id;
          END IF;
        END IF;
      END IF;
    END LOOP;
  END IF;

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
    currency = CASE WHEN p_updates ? 'currency' THEN coalesce(nullif(btrim(p_updates->>'currency'), ''), currency) ELSE currency END,
    invoice_number = CASE WHEN p_updates ? 'invoice_number' THEN nullif(btrim(p_updates->>'invoice_number'), '') ELSE invoice_number END,
    payment_status = CASE WHEN p_updates ? 'payment_status' THEN coalesce(nullif(btrim(p_updates->>'payment_status'), ''), payment_status) ELSE payment_status END,
    paid_amount = coalesce(v_paid, paid_amount),
    received_at = CASE WHEN p_updates ? 'received_at' AND nullif(btrim(p_updates->>'received_at'), '') IS NOT NULL THEN (p_updates->>'received_at')::timestamptz ELSE received_at end,
    notes = CASE WHEN p_updates ? 'notes' THEN nullif(btrim(p_updates->>'notes'), '') ELSE notes END,
    updated_at = now()
  WHERE id = p_receipt_id;

  RETURN public.get_stock_receipt(p_receipt_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_stock_receipt(uuid, jsonb) TO authenticated, service_role;
