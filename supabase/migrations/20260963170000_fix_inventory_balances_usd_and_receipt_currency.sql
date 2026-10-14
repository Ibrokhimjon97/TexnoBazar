-- Migration: 20260963170000_fix_inventory_balances_usd_and_receipt_currency.sql
-- 1. list_inventory_balances da cost_price_usd, retail_price_usd, wholesale_price_usd, minimum_sale_price_usd va currency ni qaytarish
-- 2. update_stock_receipt da USD va UZS konvertatsiyasini mustahkamlash
-- 3. receive_stock da USD kiritilganda so'mga aylantirish va USD qiymatlarni aniq saqlash

-- 1. list_inventory_balances funksiyasini yangilash
CREATE OR REPLACE FUNCTION public.list_inventory_balances(
  p_branch_id uuid DEFAULT NULL::uuid,
  p_location_id uuid DEFAULT NULL::uuid,
  p_query text DEFAULT NULL::text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_category_id uuid DEFAULT NULL::uuid,
  p_min_price numeric DEFAULT NULL::numeric,
  p_max_price numeric DEFAULT NULL::numeric,
  p_availability text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
declare
  v_items jsonb;
  v_total bigint;
  v_total_on_hand numeric;
  v_total_reserved numeric;
  v_total_value numeric;
  v_total_cost numeric;
  v_target_branch uuid;
  v_default_loc record;
begin
  if p_limit not between 1 and 500 or p_offset < 0 then
    raise exception 'Sahifalash noto''g''ri';
  end if;

  v_target_branch := coalesce(p_branch_id, (select id from public.branches limit 1));

  select l.id, l.name, l.type, br.name as branch_name into v_default_loc
  from public.locations l
  join public.branches br on br.id = l.branch_id
  where l.branch_id = v_target_branch
  order by case when l.type = 'warehouse' then 1 else 2 end, l.created_at
  limit 1;

  with combined as (
    -- 1. Products that have explicit entries in inventory_balances
    select
      ib.location_id,
      l.name as location_name,
      l.type as location_type,
      l.branch_id,
      br.name as branch_name,
      p.id as product_id,
      p.name as product_name,
      p.sku,
      p.retail_price,
      p.cost_price,
      p.retail_price_usd,
      p.cost_price_usd,
      p.wholesale_price,
      p.wholesale_price_usd,
      p.minimum_sale_price,
      p.minimum_sale_price_usd,
      p.currency,
      p.category_id,
      ib.on_hand,
      ib.reserved,
      (ib.on_hand - ib.reserved) as available,
      ib.updated_at,
      p.created_at
    from public.inventory_balances ib
    join public.locations l on l.id = ib.location_id
    join public.branches br on br.id = l.branch_id
    join public.products p on p.id = ib.product_id
    where public.can_access_branch(l.branch_id)
      and (v_target_branch is null or l.branch_id = v_target_branch)
      and (p_location_id is null or l.id = p_location_id)
      and p.status <> 'archived'

    union all

    -- 2. Products in catalog that have NO balance in this branch yet
    select
      v_default_loc.id as location_id,
      coalesce(v_default_loc.name, 'Asosiy ombor') as location_name,
      coalesce(v_default_loc.type, 'warehouse') as location_type,
      v_target_branch as branch_id,
      coalesce(v_default_loc.branch_name, 'Filial') as branch_name,
      p.id as product_id,
      p.name as product_name,
      p.sku,
      p.retail_price,
      p.cost_price,
      p.retail_price_usd,
      p.cost_price_usd,
      p.wholesale_price,
      p.wholesale_price_usd,
      p.minimum_sale_price,
      p.minimum_sale_price_usd,
      p.currency,
      p.category_id,
      0::numeric as on_hand,
      0::numeric as reserved,
      0::numeric as available,
      p.updated_at,
      p.created_at
    from public.products p
    where p.status <> 'archived'
      and (p_location_id is null or p_location_id = v_default_loc.id)
      and not exists (
        select 1
        from public.inventory_balances ib2
        join public.locations l2 on l2.id = ib2.location_id
        where ib2.product_id = p.id
          and (v_target_branch is null or l2.branch_id = v_target_branch)
      )
  ),
  filtered as (
    select c.*,
      (select m.public_url from public.product_media m where m.product_id = c.product_id order by m.is_primary desc, m.sort_order limit 1) as image
    from combined c
    where (p_query is null or c.product_name ilike '%'||btrim(p_query)||'%' or c.sku ilike '%'||btrim(p_query)||'%')
      and (p_category_id is null or c.category_id = p_category_id)
      and (p_min_price is null or c.retail_price >= p_min_price)
      and (p_max_price is null or c.retail_price <= p_max_price)
      and (p_availability is null
        or (p_availability in ('in_stock', 'available') and c.available > 0)
        or (p_availability in ('out_of_stock', 'empty') and c.available <= 0))
  ),
  aggregates as (
    select
      count(*)::bigint as cnt,
      coalesce(sum(on_hand), 0)::numeric as total_on_hand,
      coalesce(sum(reserved), 0)::numeric as total_reserved,
      coalesce(sum(on_hand * retail_price), 0)::numeric as total_value,
      coalesce(sum(on_hand * coalesce(cost_price, 0)), 0)::numeric as total_cost
    from filtered
  ),
  paged as (
    select *
    from filtered
    order by created_at desc, product_name
    limit p_limit offset p_offset
  )
  select
    coalesce((select cnt from aggregates), 0),
    coalesce((select total_on_hand from aggregates), 0),
    coalesce((select total_reserved from aggregates), 0),
    coalesce((select total_value from aggregates), 0),
    coalesce((select total_cost from aggregates), 0),
    coalesce((select jsonb_agg(to_jsonb(p)) from paged p), '[]'::jsonb)
  into v_total, v_total_on_hand, v_total_reserved, v_total_value, v_total_cost, v_items;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'total_on_hand', v_total_on_hand,
    'total_reserved', v_total_reserved,
    'total_value', v_total_value,
    'total_cost', v_total_cost
  );
end;
$$;

GRANT EXECUTE ON FUNCTION public.list_inventory_balances(uuid, uuid, text, integer, integer, uuid, numeric, numeric, text) TO authenticated, service_role;


-- 2. update_stock_receipt funksiyasini yangilash
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
  v_r record;
  v_line jsonb;
  v_batch_id uuid;
  v_batch record;
  v_diff integer;
  v_supplier uuid;
  v_new_location uuid;
  v_var_id uuid;
  v_color text;
  v_cur_qty integer;
  v_new_qty integer;
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
        AND status IN ('available', 'returned');

      UPDATE public.stock_batches SET location_id = v_new_location
      WHERE receipt_id = p_receipt_id;
    END IF;
  ELSE
    v_new_location := v_r.receiving_location_id;
  END IF;

  -- 3. Lines processing
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
            ELSIF v_uc < 20000 THEN
              v_uc_usd := v_uc;
              v_uc := round(v_uc_usd * v_rate);
            ELSE
              v_uc_usd := round(v_uc / v_rate, 2);
              v_uc := round(v_uc);
            END IF;
          ELSE
            -- UZS mode: v_uc is the UZS cost. Preserve exact unit_cost_usd if available or compute it
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
        IF v_line ? 'quantity' AND (v_line->>'quantity')::integer IS NOT NULL THEN
          v_new_qty := (v_line->>'quantity')::integer;
          IF v_new_qty < 1 THEN
            RAISE EXCEPTION 'Miqdor kamida 1 bo‘lishi kerak' USING errcode = '22023';
          END IF;

          SELECT count(*)::integer INTO v_cur_qty
          FROM public.inventory_units
          WHERE batch_id = v_batch_id;

          v_diff := v_new_qty - v_cur_qty;

          IF v_diff > 0 THEN
            SELECT coalesce(max(unit_sequence), 0) INTO v_seq
            FROM public.inventory_units
            WHERE batch_id = v_batch_id;

            FOR i IN 1..v_diff LOOP
              v_seq := v_seq + 1;
              v_qr := public.generate_short_qr('U');
              INSERT INTO public.inventory_units(
                product_id, batch_id, location_id, qr_code,
                status, unit_sequence, variant_id
              ) VALUES (
                v_batch.product_id, v_batch_id, v_new_location, v_qr,
                'available', v_seq, v_var_id
              ) RETURNING id INTO v_new_unit_id;

              INSERT INTO public.inventory_movements(
                unit_id, product_id, batch_id, movement_type, to_location_id,
                quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
              ) VALUES (
                v_new_unit_id, v_batch.product_id, v_batch_id, 'inbound', v_new_location,
                1, coalesce(v_uc, v_batch.unit_cost), 'stock_receipt', p_receipt_id,
                'Partiya tahririda yangi birlik qo‘shildi', auth.uid(),
                jsonb_build_object('source', 'update_stock_receipt', 'unit_sequence', v_seq)
              );
            END LOOP;

            UPDATE public.stock_batches SET quantity = v_new_qty WHERE id = v_batch_id;

          ELSIF v_diff < 0 THEN
            v_diff := abs(v_diff);
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
