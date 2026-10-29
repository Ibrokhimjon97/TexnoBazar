-- Migration: Support modular components in external branch transfers
-- Allows sellers to transfer:
-- 1. Full product sets with custom component selections
-- 2. Standalone components without deducting main body units (0 main units + N components)

BEGIN;

-- 1. Add selected_components to external_branch_transfer_lines
ALTER TABLE public.external_branch_transfer_lines 
ADD COLUMN IF NOT EXISTS selected_components jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 2. Update search_external_transfer_products to include components
CREATE OR REPLACE FUNCTION public.search_external_transfer_products(
  p_branch_id uuid,
  p_location_id uuid,
  p_query text,
  p_limit integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_query text := nullif(btrim(p_query), '');
  v_rate numeric;
  v_rate_date date;
BEGIN
  IF p_location_id IS NULL THEN
    RAISE EXCEPTION 'Joy (do‘kon yoki ombor) tanlanmagan' USING errcode = '22023';
  END IF;

  SELECT rate, rate_date INTO v_rate, v_rate_date
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC LIMIT 1;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    v_rate := 11850;
    v_rate_date := current_date;
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(to_jsonb(q) ORDER BY q.available_count DESC, q.product_name)
    FROM (
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.sku,
        p.barcode,
        (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1) AS image,
        coalesce(nullif(p.cost_price, 0), 0) AS cost_price,
        coalesce(nullif(p.cost_price_usd, 0), CASE WHEN v_rate > 0 THEN round(coalesce(p.cost_price, 0) / v_rate, 2) ELSE 0 END) AS cost_price_usd,
        coalesce(nullif(p.wholesale_price, 0), nullif(p.cost_price, 0), p.retail_price, 0) AS wholesale_price,
        coalesce(nullif(p.wholesale_price_usd, 0), CASE WHEN v_rate > 0 THEN round(coalesce(p.wholesale_price, p.cost_price, 0) / v_rate, 2) ELSE 0 END) AS wholesale_price_usd,
        p.retail_price,
        (
          SELECT count(*)::integer
          FROM public.inventory_units u
          WHERE u.location_id = p_location_id
            AND u.product_id = p.id
            AND u.status = 'available'
            AND u.active_transfer_id IS NULL
        ) AS available_count,
        (
          SELECT u.qr_code
          FROM public.inventory_units u
          WHERE u.location_id = p_location_id
            AND u.product_id = p.id
            AND u.status = 'available'
            AND u.active_transfer_id IS NULL
          ORDER BY u.created_at ASC
          LIMIT 1
        ) AS sample_qr,
        (
          SELECT coalesce(jsonb_agg(
            jsonb_build_object(
              'id', pc.id,
              'name', pc.name,
              'color_name', pc.color_name,
              'color_hex', pc.color_hex,
              'cost_price', coalesce(pc.cost_price, 0),
              'cost_price_usd', coalesce(pc.cost_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pc.cost_price, 0) / v_rate, 2) ELSE 0 END),
              'retail_price', coalesce(pc.retail_price, 0),
              'retail_price_usd', coalesce(pc.retail_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pc.retail_price, 0) / v_rate, 2) ELSE 0 END),
              'wholesale_price', coalesce(pc.wholesale_price, 0),
              'wholesale_price_usd', coalesce(pc.wholesale_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pc.wholesale_price, 0) / v_rate, 2) ELSE 0 END),
              'quantity', coalesce(pc.quantity, 1),
              'can_buy_standalone', pc.can_buy_standalone,
              'is_required', pc.is_required,
              'is_default', pc.is_default,
              'image_url', pc.image_url
            ) ORDER BY pc.sort_order, pc.created_at
          ), '[]'::jsonb)
          FROM public.product_components pc
          WHERE pc.product_id = p.id AND pc.is_active = true
        ) AS components
      FROM public.products p
      WHERE p.status = 'active'
        AND (
          v_query IS NULL
          OR p.name ILIKE '%' || v_query || '%'
          OR p.sku ILIKE '%' || v_query || '%'
          OR coalesce(p.barcode, '') ILIKE '%' || v_query || '%'
          OR EXISTS (
            SELECT 1 FROM public.inventory_units iu
            WHERE iu.product_id = p.id
              AND iu.location_id = p_location_id
              AND (iu.qr_code ILIKE '%' || v_query || '%' OR coalesce(iu.serial_number, '') ILIKE '%' || v_query || '%')
          )
        )
        AND (
          EXISTS (
            SELECT 1 FROM public.inventory_units u2
            WHERE u2.location_id = p_location_id
              AND u2.product_id = p.id
              AND u2.status = 'available'
              AND u2.active_transfer_id IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM public.product_components pc
            WHERE pc.product_id = p.id
              AND pc.is_active = true
          )
        )
      LIMIT coalesce(p_limit, 30)
    ) q
  ), '[]'::jsonb);
END;
$$;

-- 3. Update find_external_transfer_product to include components
CREATE OR REPLACE FUNCTION public.find_external_transfer_product(
  p_branch_id uuid,
  p_location_id uuid,
  p_code text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code text := nullif(btrim(p_code), '');
  v_unit record;
  v_avail_count integer;
  v_rate numeric;
  v_rate_date date;
BEGIN
  IF p_location_id IS NULL THEN
    RAISE EXCEPTION 'Joy (do‘kon yoki ombor) tanlanmagan' USING errcode = '22023';
  END IF;

  IF v_code IS NULL THEN
    RAISE EXCEPTION 'Qidiruv kodi kiritilmadi' USING errcode = '22023';
  END IF;

  SELECT rate, rate_date INTO v_rate, v_rate_date
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC LIMIT 1;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    v_rate := 11850;
    v_rate_date := current_date;
  END IF;

  -- 1. Try finding by exact QR or serial number in this location
  SELECT
    u.id AS unit_id,
    u.qr_code,
    u.serial_number,
    p.id AS product_id,
    p.name AS product_name,
    p.sku,
    p.barcode,
    (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1) AS image,
    coalesce(nullif(p.cost_price, 0), 0) AS cost_price,
    coalesce(nullif(p.cost_price_usd, 0), CASE WHEN v_rate > 0 THEN round(coalesce(p.cost_price, 0) / v_rate, 2) ELSE 0 END) AS cost_price_usd,
    coalesce(nullif(p.wholesale_price, 0), nullif(p.cost_price, 0), p.retail_price, 0) AS wholesale_price,
    coalesce(nullif(p.wholesale_price_usd, 0), CASE WHEN v_rate > 0 THEN round(coalesce(p.wholesale_price, p.cost_price, 0) / v_rate, 2) ELSE 0 END) AS wholesale_price_usd,
    p.retail_price
  INTO v_unit
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  WHERE u.location_id = p_location_id
    AND u.status = 'available'
    AND u.active_transfer_id IS NULL
    AND p.status = 'active'
    AND (
      upper(u.qr_code) = upper(v_code)
      OR upper(coalesce(u.serial_number, '')) = upper(v_code)
      OR upper(coalesce(p.barcode, '')) = upper(v_code)
      OR upper(p.sku) = upper(v_code)
    )
  LIMIT 1;

  -- 2. Fallback: check by product barcode or SKU that has available units or components
  IF v_unit.product_id IS NULL THEN
    SELECT
      NULL::uuid AS unit_id,
      (
        SELECT u2.qr_code FROM public.inventory_units u2
        WHERE u2.location_id = p_location_id AND u2.product_id = p.id AND u2.status = 'available' AND u2.active_transfer_id IS NULL
        LIMIT 1
      ) AS qr_code,
      NULL AS serial_number,
      p.id AS product_id,
      p.name AS product_name,
      p.sku,
      p.barcode,
      (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1) AS image,
      coalesce(nullif(p.cost_price, 0), 0) AS cost_price,
      coalesce(nullif(p.cost_price_usd, 0), CASE WHEN v_rate > 0 THEN round(coalesce(p.cost_price, 0) / v_rate, 2) ELSE 0 END) AS cost_price_usd,
      coalesce(nullif(p.wholesale_price, 0), nullif(p.cost_price, 0), p.retail_price, 0) AS wholesale_price,
      coalesce(nullif(p.wholesale_price_usd, 0), CASE WHEN v_rate > 0 THEN round(coalesce(p.wholesale_price, p.cost_price, 0) / v_rate, 2) ELSE 0 END) AS wholesale_price_usd,
      p.retail_price
    INTO v_unit
    FROM public.products p
    WHERE p.status = 'active'
      AND (upper(coalesce(p.barcode, '')) = upper(v_code) OR upper(p.sku) = upper(v_code))
      AND (
        EXISTS (
          SELECT 1 FROM public.inventory_units u3
          WHERE u3.location_id = p_location_id AND u3.product_id = p.id AND u3.status = 'available' AND u3.active_transfer_id IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM public.product_components pc
          WHERE pc.product_id = p.id AND pc.is_active = true
        )
      )
    LIMIT 1;
  END IF;

  IF v_unit.product_id IS NULL THEN
    RAISE EXCEPTION 'Ushbu joyda transferga tayyor tovar topilmadi: %', v_code USING errcode = 'P0002';
  END IF;

  -- Count total available units of this product in this location
  SELECT count(*)::integer INTO v_avail_count
  FROM public.inventory_units u
  WHERE u.location_id = p_location_id
    AND u.product_id = v_unit.product_id
    AND u.status = 'available'
    AND u.active_transfer_id IS NULL;

  RETURN jsonb_build_object(
    'unit_id', v_unit.unit_id,
    'qr_code', v_unit.qr_code,
    'serial_number', v_unit.serial_number,
    'product_id', v_unit.product_id,
    'product_name', v_unit.product_name,
    'sku', v_unit.sku,
    'barcode', v_unit.barcode,
    'image', v_unit.image,
    'cost_price', v_unit.cost_price,
    'cost_price_usd', v_unit.cost_price_usd,
    'wholesale_price', v_unit.wholesale_price,
    'wholesale_price_usd', v_unit.wholesale_price_usd,
    'retail_price', v_unit.retail_price,
    'available_count', v_avail_count,
    'components', (
      SELECT coalesce(jsonb_agg(
        jsonb_build_object(
          'id', pc.id,
          'name', pc.name,
          'color_name', pc.color_name,
          'color_hex', pc.color_hex,
          'cost_price', coalesce(pc.cost_price, 0),
          'cost_price_usd', coalesce(pc.cost_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pc.cost_price, 0) / v_rate, 2) ELSE 0 END),
          'retail_price', coalesce(pc.retail_price, 0),
          'retail_price_usd', coalesce(pc.retail_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pc.retail_price, 0) / v_rate, 2) ELSE 0 END),
          'wholesale_price', coalesce(pc.wholesale_price, 0),
          'wholesale_price_usd', coalesce(pc.wholesale_price_usd, CASE WHEN v_rate > 0 THEN round(coalesce(pc.wholesale_price, 0) / v_rate, 2) ELSE 0 END),
          'quantity', coalesce(pc.quantity, 1),
          'can_buy_standalone', pc.can_buy_standalone,
          'is_required', pc.is_required,
          'is_default', pc.is_default,
          'image_url', pc.image_url
        ) ORDER BY pc.sort_order, pc.created_at
      ), '[]'::jsonb)
      FROM public.product_components pc
      WHERE pc.product_id = v_unit.product_id AND pc.is_active = true
    )
  );
END;
$$;

-- 4. Update create_external_branch_transfer to support selected_components and standalone components
CREATE OR REPLACE FUNCTION public.create_external_branch_transfer(
  p_branch_id uuid,
  p_from_location_id uuid,
  p_target_branch_name text,
  p_target_manager_name text,
  p_price_mode text,
  p_notes text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seller_id uuid;
  v_seller_name text;
  v_rate numeric;
  v_transfer_id uuid;
  v_transfer_no text;
  v_normalized_price_mode text;
  v_total_amount numeric(18,2) := 0;
  v_total_amount_usd numeric(18,2) := 0;
  v_total_items integer := 0;
  v_item jsonb;
  v_product_id uuid;
  v_qty integer;
  v_main_qty integer;
  v_is_component_only boolean;
  v_sel_comps jsonb;
  v_custom_name text;
  v_unit_price numeric(18,2);
  v_unit_price_usd numeric(18,2);
  v_line_total numeric(18,2);
  v_pref_qr text;
  v_pref_unit_id uuid;
  v_extra_unit_ids uuid[];
  v_selected_unit_ids uuid[];
  v_needed_extra integer;
  v_prod_rec record;
  v_target_branch_id uuid;
  v_target_debt record;
  v_inc_amount numeric(18,2);
BEGIN
  -- Validation
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'Filial ko‘rsatilmadi' USING errcode = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.locations
    WHERE id = p_from_location_id AND branch_id = p_branch_id AND is_active AND type IN ('store', 'warehouse')
  ) THEN
    RAISE EXCEPTION 'Faol jo‘natish joyi (do‘kon yoki ombor) topilmadi' USING errcode = 'P0002';
  END IF;

  IF nullif(btrim(p_target_branch_name), '') IS NULL THEN
    RAISE EXCEPTION 'Qabul qiluvchi filial/do‘kon nomini kiriting' USING errcode = '22023';
  END IF;

  IF nullif(btrim(p_target_manager_name), '') IS NULL THEN
    RAISE EXCEPTION 'Filial boshlig‘i ismini kiriting' USING errcode = '22023';
  END IF;

  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Kamida bitta tovar tanlanishi kerak' USING errcode = '22023';
  END IF;

  -- Seller and Exchange Rate
  v_seller_id := auth.uid();
  IF v_seller_id IS NOT NULL THEN
    SELECT coalesce(full_name, email, 'Sotuvchi') INTO v_seller_name
    FROM public.profiles WHERE id = v_seller_id;
  END IF;
  IF v_seller_id IS NULL OR v_seller_name IS NULL THEN
    SELECT id, coalesce(full_name, email, 'Sotuvchi') INTO v_seller_id, v_seller_name
    FROM public.profiles WHERE is_active LIMIT 1;
  END IF;
  IF v_seller_id IS NULL THEN
    SELECT id, coalesce(full_name, email, 'Sotuvchi') INTO v_seller_id, v_seller_name
    FROM public.profiles LIMIT 1;
  END IF;
  IF v_seller_name IS NULL THEN
    v_seller_name := 'Sotuvchi';
  END IF;

  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC LIMIT 1;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    v_rate := 11850;
  END IF;

  -- Normalize price_mode
  v_normalized_price_mode := CASE
    WHEN lower(coalesce(p_price_mode, 'cost')) IN ('cost', 'markup', 'wholesale', 'custom') 
      THEN lower(coalesce(p_price_mode, 'cost'))
    WHEN lower(p_price_mode) LIKE '%markup%' OR lower(p_price_mode) LIKE '%ustama%'
      THEN 'markup'
    WHEN lower(p_price_mode) LIKE '%whole%' OR lower(p_price_mode) LIKE '%ulgurji%'
      THEN 'wholesale'
    ELSE 'custom'
  END;

  -- Generate transfer ID and No
  v_transfer_id := gen_random_uuid();
  v_transfer_no := 'TRF-EXT-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  -- Insert header record initially
  INSERT INTO public.external_branch_transfers (
    id, transfer_no, branch_id, from_location_id,
    target_branch_name, target_manager_name,
    seller_id, seller_name, price_mode, currency,
    exchange_rate, total_amount, total_amount_usd, total_items_count, notes
  ) VALUES (
    v_transfer_id, v_transfer_no, p_branch_id, p_from_location_id,
    btrim(p_target_branch_name), btrim(p_target_manager_name),
    v_seller_id,
    v_seller_name, v_normalized_price_mode, 'UZS',
    v_rate, 0, 0, 0, nullif(btrim(p_notes), '')
  );

  -- Process lines
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := coalesce((v_item->>'quantity')::integer, 1);
    v_unit_price := coalesce((v_item->>'unit_price')::numeric, 0);
    v_unit_price_usd := coalesce((v_item->>'unit_price_usd')::numeric, 0);
    v_pref_qr := nullif(btrim(v_item->>'qr_code'), '');
    v_sel_comps := coalesce(v_item->'selected_components', '[]'::jsonb);
    v_is_component_only := coalesce((v_item->>'is_component_only')::boolean, false);
    v_main_qty := coalesce((v_item->>'main_quantity')::integer, CASE WHEN v_is_component_only THEN 0 ELSE v_qty END);
    v_custom_name := nullif(btrim(v_item->>'product_name'), '');

    IF v_unit_price <= 0 AND v_unit_price_usd > 0 THEN
      v_unit_price := round(v_unit_price_usd * v_rate);
    ELSIF v_unit_price_usd <= 0 AND v_unit_price > 0 AND v_rate > 0 THEN
      v_unit_price_usd := round(v_unit_price / v_rate, 2);
    END IF;

    v_line_total := v_unit_price * v_qty;

    -- Query product details with correct product_media image subquery
    SELECT 
      p.id, 
      p.name, 
      p.sku, 
      (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1) AS image,
      p.cost_price, 
      p.wholesale_price
    INTO v_prod_rec
    FROM public.products p
    WHERE p.id = v_product_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mahsulot topilmadi: %', v_product_id USING errcode = 'P0002';
    END IF;

    v_selected_unit_ids := ARRAY[]::uuid[];

    -- Only deduct physical units from inventory_units if main_quantity > 0
    IF v_main_qty > 0 THEN
      IF v_pref_qr IS NOT NULL THEN
        SELECT id INTO v_pref_unit_id
        FROM public.inventory_units
        WHERE location_id = p_from_location_id
          AND product_id = v_product_id
          AND status = 'available'::public.unit_status
          AND (qr_code = v_pref_qr OR serial_number = v_pref_qr)
        LIMIT 1
        FOR UPDATE;

        IF v_pref_unit_id IS NOT NULL THEN
          v_selected_unit_ids := ARRAY[v_pref_unit_id];
        END IF;
      END IF;

      v_needed_extra := v_main_qty - cardinality(v_selected_unit_ids);
      IF v_needed_extra > 0 THEN
        SELECT coalesce(array_agg(u.id), ARRAY[]::uuid[]) INTO v_extra_unit_ids
        FROM (
          SELECT id FROM public.inventory_units
          WHERE location_id = p_from_location_id
            AND product_id = v_product_id
            AND status = 'available'::public.unit_status
            AND id <> ALL(v_selected_unit_ids)
          LIMIT v_needed_extra
          FOR UPDATE
        ) u;

        IF v_extra_unit_ids IS NOT NULL THEN
          v_selected_unit_ids := array_cat(v_selected_unit_ids, v_extra_unit_ids);
        END IF;
      END IF;

      IF cardinality(v_selected_unit_ids) < v_main_qty THEN
        RAISE EXCEPTION 'Omborda/do‘konda "%" tovaridan yetarli miqdor mavjud emas! So‘raldi: %, mavjud: %',
          v_prod_rec.name, v_main_qty, cardinality(v_selected_unit_ids) USING errcode = '22023';
      END IF;

      UPDATE public.inventory_units
      SET status = 'transferred'::public.unit_status,
          external_transfer_id = v_transfer_id,
          updated_at = now()
      WHERE id = ANY(v_selected_unit_ids);

      INSERT INTO public.inventory_movements (
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity, unit_cost,
        reference_type, reference_id, reason, actor_id, metadata
      )
      SELECT
        u.id, u.product_id, u.batch_id, 'transfer_out'::public.movement_type,
        p_from_location_id, NULL, 1, v_unit_price,
        'external_branch_transfer', v_transfer_id,
        'Filialga transfer: ' || btrim(p_target_branch_name), v_seller_id,
        jsonb_build_object(
          'target_branch_name', btrim(p_target_branch_name),
          'target_manager_name', btrim(p_target_manager_name),
          'price_mode', v_normalized_price_mode,
          'transfer_no', v_transfer_no,
          'product_name', v_prod_rec.name,
          'unit_price', v_unit_price,
          'selected_components', v_sel_comps
        )
      FROM public.inventory_units u
      WHERE u.id = ANY(v_selected_unit_ids);
    ELSE
      -- Component-only transfer (no main physical body deducted)
      INSERT INTO public.inventory_movements (
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity, unit_cost,
        reference_type, reference_id, reason, actor_id, metadata
      ) VALUES (
        NULL, v_product_id, NULL, 'transfer_out'::public.movement_type,
        p_from_location_id, NULL, v_qty, v_unit_price,
        'external_branch_transfer', v_transfer_id,
        'Filialga qismlar transferi: ' || btrim(p_target_branch_name), v_seller_id,
        jsonb_build_object(
          'target_branch_name', btrim(p_target_branch_name),
          'target_manager_name', btrim(p_target_manager_name),
          'price_mode', v_normalized_price_mode,
          'transfer_no', v_transfer_no,
          'product_name', v_prod_rec.name,
          'is_component_only', true,
          'selected_components', v_sel_comps
        )
      );
    END IF;

    -- Insert into transfer lines with unit_price strictly for this transfer
    INSERT INTO public.external_branch_transfer_lines (
      transfer_id, product_id, product_name, sku, image,
      quantity, unit_price, unit_price_usd, total_price,
      cost_price, wholesale_price, unit_ids, selected_components
    ) VALUES (
      v_transfer_id, v_product_id, coalesce(v_custom_name, v_prod_rec.name), v_prod_rec.sku, v_prod_rec.image,
      v_qty, v_unit_price, v_unit_price_usd, v_line_total,
      coalesce(v_prod_rec.cost_price, 0), coalesce(v_prod_rec.wholesale_price, 0), v_selected_unit_ids, v_sel_comps
    );

    v_total_amount := v_total_amount + v_line_total;
    v_total_amount_usd := v_total_amount_usd + (v_unit_price_usd * v_qty);
    v_total_items := v_total_items + v_qty;
  END LOOP;

  -- Update header with final totals
  UPDATE public.external_branch_transfers
  SET total_amount = v_total_amount,
      total_amount_usd = v_total_amount_usd,
      total_items_count = v_total_items,
      updated_at = now()
  WHERE id = v_transfer_id;

  -- Accumulate onto active branch debt if debtor branch exists
  SELECT id INTO v_target_branch_id
  FROM public.branches
  WHERE lower(btrim(name)) = lower(btrim(p_target_branch_name))
  LIMIT 1;

  SELECT * INTO v_target_debt
  FROM public.branch_debts
  WHERE creditor_branch_id = p_branch_id
    AND (
      (v_target_branch_id IS NOT NULL AND debtor_branch_id = v_target_branch_id)
      OR lower(btrim(coalesce(target_branch_name, ''))) = lower(btrim(p_target_branch_name))
    )
    AND status IN ('open'::public.debt_status, 'partially_paid'::public.debt_status)
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_target_debt.id IS NOT NULL THEN
    v_inc_amount := CASE 
      WHEN coalesce(v_target_debt.currency, 'USD') = 'USD' THEN v_total_amount_usd
      ELSE v_total_amount
    END;

    UPDATE public.branch_debts
    SET amount = amount + v_inc_amount,
        updated_at = now()
    WHERE id = v_target_debt.id;

    INSERT INTO public.branch_debt_transfers (debt_id, transfer_id)
    VALUES (v_target_debt.id, v_transfer_id)
    ON CONFLICT (debt_id, transfer_id) DO NOTHING;
  END IF;

  RETURN public.get_external_branch_transfer(v_transfer_id);
END;
$$;

-- 5. Update get_external_branch_transfer to return selected_components
CREATE OR REPLACE FUNCTION public.get_external_branch_transfer(p_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'id', t.id,
    'transfer_no', t.transfer_no,
    'branch_id', t.branch_id,
    'branch_name', b.name,
    'from_location_id', t.from_location_id,
    'from_location_name', l.name,
    'from_location_type', l.type,
    'target_branch_name', t.target_branch_name,
    'target_manager_name', t.target_manager_name,
    'seller_id', t.seller_id,
    'seller_name', t.seller_name,
    'price_mode', t.price_mode,
    'currency', t.currency,
    'exchange_rate', t.exchange_rate,
    'total_amount', t.total_amount,
    'total_amount_usd', t.total_amount_usd,
    'total_items_count', t.total_items_count,
    'notes', t.notes,
    'status', t.status,
    'created_at', t.created_at,
    'lines', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', tl.id,
          'product_id', tl.product_id,
          'product_name', tl.product_name,
          'sku', tl.sku,
          'image', tl.image,
          'quantity', tl.quantity,
          'unit_price', tl.unit_price,
          'unit_price_usd', tl.unit_price_usd,
          'total_price', tl.total_price,
          'cost_price', tl.cost_price,
          'wholesale_price', tl.wholesale_price,
          'unit_ids', tl.unit_ids,
          'selected_components', coalesce(tl.selected_components, '[]'::jsonb),
          'qr_codes', (
            SELECT jsonb_agg(iu.qr_code)
            FROM public.inventory_units iu
            WHERE iu.id = ANY(tl.unit_ids)
          )
        ) ORDER BY tl.created_at
      )
      FROM public.external_branch_transfer_lines tl
      WHERE tl.transfer_id = t.id
    ), '[]'::jsonb)
  ) INTO v_result
  FROM public.external_branch_transfers t
  JOIN public.branches b ON b.id = t.branch_id
  JOIN public.locations l ON l.id = t.from_location_id
  WHERE t.id = p_transfer_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_external_transfer_products(uuid, uuid, text, integer) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.find_external_transfer_product(uuid, uuid, text) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.create_external_branch_transfer(uuid, uuid, text, text, text, text, jsonb) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.get_external_branch_transfer(uuid) TO authenticated, service_role, anon;

COMMIT;

NOTIFY pgrst, 'reload schema';
