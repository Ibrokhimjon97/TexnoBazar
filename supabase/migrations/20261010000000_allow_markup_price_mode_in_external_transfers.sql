-- Migration: Allow 'markup' and any normalized price mode in external_branch_transfers
-- Fixes error: new row for relation "external_branch_transfers" violates check constraint "external_branch_transfers_price_mode_check"

BEGIN;

-- 1. Drop existing constraint and re-add with 'markup' included
ALTER TABLE public.external_branch_transfers 
  DROP CONSTRAINT IF EXISTS external_branch_transfers_price_mode_check;

ALTER TABLE public.external_branch_transfers 
  ADD CONSTRAINT external_branch_transfers_price_mode_check 
  CHECK (price_mode IN ('cost', 'markup', 'wholesale', 'custom'));

-- 2. Update create_external_branch_transfer to safely normalize price_mode
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
  v_unit_price numeric(18,2);
  v_unit_price_usd numeric(18,2);
  v_line_total numeric(18,2);
  v_pref_qr text;
  v_pref_unit_id uuid;
  v_extra_unit_ids uuid[];
  v_selected_unit_ids uuid[];
  v_needed_extra integer;
  v_prod_rec record;
BEGIN
  -- 1. Validation
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

  -- 2. Seller and Exchange Rate
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

  -- Normalize price_mode safely
  v_normalized_price_mode := CASE
    WHEN lower(coalesce(p_price_mode, 'cost')) IN ('cost', 'markup', 'wholesale', 'custom') 
      THEN lower(coalesce(p_price_mode, 'cost'))
    WHEN lower(p_price_mode) LIKE '%markup%' OR lower(p_price_mode) LIKE '%ustama%'
      THEN 'markup'
    WHEN lower(p_price_mode) LIKE '%whole%' OR lower(p_price_mode) LIKE '%ulgurji%'
      THEN 'wholesale'
    ELSE 'custom'
  END;

  -- 3. Generate transfer ID and No
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

  -- 4. Process each item
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := coalesce((v_item->>'quantity')::integer, 1);
    v_unit_price := coalesce((v_item->>'unit_price')::numeric, 0);
    v_unit_price_usd := coalesce((v_item->>'unit_price_usd')::numeric, 0);
    v_pref_qr := nullif(btrim(v_item->>'qr_code'), '');

    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Tovar soni musbat bo‘lishi kerak' USING errcode = '22023';
    END IF;

    -- Fetch product details
    SELECT p.id, p.name, p.sku, p.cost_price, p.wholesale_price, p.retail_price,
           (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1) as image
    INTO v_prod_rec
    FROM public.products p
    WHERE p.id = v_product_id;

    IF v_prod_rec.id IS NULL THEN
      RAISE EXCEPTION 'Mahsulot topilmadi: %', v_product_id USING errcode = 'P0002';
    END IF;

    -- Determine price if not provided
    IF v_unit_price <= 0 THEN
      IF v_normalized_price_mode = 'wholesale' THEN
        v_unit_price := coalesce(nullif(v_prod_rec.wholesale_price, 0), v_prod_rec.cost_price, v_prod_rec.retail_price, 0);
      ELSE
        v_unit_price := coalesce(nullif(v_prod_rec.cost_price, 0), v_prod_rec.retail_price, 0);
      END IF;
    END IF;

    IF v_unit_price_usd <= 0 AND v_rate > 0 THEN
      v_unit_price_usd := round(v_unit_price / v_rate, 2);
    END IF;

    v_line_total := round(v_unit_price * v_qty, 2);
    v_selected_unit_ids := ARRAY[]::uuid[];

    -- If a specific QR code was passed, try to select that unit first
    v_pref_unit_id := NULL;
    IF v_pref_qr IS NOT NULL THEN
      SELECT u.id INTO v_pref_unit_id
      FROM public.inventory_units u
      WHERE u.location_id = p_from_location_id
        AND u.product_id = v_product_id
        AND u.status = 'available'
        AND u.active_transfer_id IS NULL
        AND upper(u.qr_code) = upper(v_pref_qr)
      LIMIT 1;

      IF v_pref_unit_id IS NOT NULL THEN
        v_selected_unit_ids := array_append(v_selected_unit_ids, v_pref_unit_id);
      END IF;
    END IF;

    -- Select remaining needed units from available inventory
    v_needed_extra := v_qty - cardinality(v_selected_unit_ids);
    IF v_needed_extra > 0 THEN
      SELECT array_agg(u.id) INTO v_extra_unit_ids
      FROM (
        SELECT u.id
        FROM public.inventory_units u
        WHERE u.location_id = p_from_location_id
          AND u.product_id = v_product_id
          AND u.status = 'available'
          AND u.active_transfer_id IS NULL
          AND (v_pref_unit_id IS NULL OR u.id <> v_pref_unit_id)
        ORDER BY u.created_at ASC
        LIMIT v_needed_extra
        FOR UPDATE
      ) u;

      IF v_extra_unit_ids IS NOT NULL THEN
        v_selected_unit_ids := array_cat(v_selected_unit_ids, v_extra_unit_ids);
      END IF;
    END IF;

    -- Verify that we found exactly v_qty units
    IF cardinality(v_selected_unit_ids) < v_qty THEN
      RAISE EXCEPTION 'Omborda/do‘konda "%" tovaridan yetarli miqdor mavjud emas! So‘raldi: %, mavjud: %',
        v_prod_rec.name, v_qty, cardinality(v_selected_unit_ids) USING errcode = '22023';
    END IF;

    -- Update inventory units to 'transferred'
    UPDATE public.inventory_units
    SET status = 'transferred'::public.unit_status,
        external_transfer_id = v_transfer_id,
        updated_at = now()
    WHERE id = ANY(v_selected_unit_ids);

    -- Insert movement log
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
        'unit_price', v_unit_price
      )
    FROM public.inventory_units u
    WHERE u.id = ANY(v_selected_unit_ids);

    -- Insert transfer line
    INSERT INTO public.external_branch_transfer_lines (
      transfer_id, product_id, product_name, sku, image,
      quantity, unit_price, unit_price_usd, total_price,
      cost_price, wholesale_price, unit_ids
    ) VALUES (
      v_transfer_id, v_product_id, v_prod_rec.name, v_prod_rec.sku, v_prod_rec.image,
      v_qty, v_unit_price, v_unit_price_usd, v_line_total,
      coalesce(v_prod_rec.cost_price, 0), coalesce(v_prod_rec.wholesale_price, 0), v_selected_unit_ids
    );

    v_total_amount := v_total_amount + v_line_total;
    v_total_amount_usd := v_total_amount_usd + (v_unit_price_usd * v_qty);
    v_total_items := v_total_items + v_qty;
  END LOOP;

  -- 5. Update header with final totals
  UPDATE public.external_branch_transfers
  SET total_amount = v_total_amount,
      total_amount_usd = v_total_amount_usd,
      total_items_count = v_total_items,
      updated_at = now()
  WHERE id = v_transfer_id;

  RETURN public.get_external_branch_transfer(v_transfer_id);
END;
$$;

GRANT ALL ON TABLE public.external_branch_transfers TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.create_external_branch_transfer(uuid, uuid, text, text, text, text, jsonb) TO authenticated, service_role, anon;

COMMIT;

NOTIFY pgrst, 'reload schema';
