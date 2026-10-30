-- Migration: 20261030101500_fix_branch_debt_transfers_unique_and_conflict.sql
-- Fix: "there is no unique or exclusion constraint matching the ON CONFLICT specification"
-- 1. Ensure unique index on public.branch_debt_transfers (debt_id, transfer_id)
-- 2. Update create_external_branch_transfer to safely insert into branch_debt_transfers with full fields and IF NOT EXISTS check
-- 3. Reload PostgREST schema cache to guarantee immediate readiness without "schema outdated" errors

-- 1. Create unique index on branch_debt_transfers(debt_id, transfer_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_debt_transfers_debt_transfer 
ON public.branch_debt_transfers (debt_id, transfer_id);

-- 2. Update create_external_branch_transfer with identical signature and complete, safe branch debt accumulation
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

    IF v_inc_amount > 0 THEN
      UPDATE public.branch_debts
      SET amount = amount + v_inc_amount,
          notes = coalesce(notes, '') || E'\n+ ' || v_transfer_no || ' (+' || v_inc_amount || ' ' || coalesce(v_target_debt.currency, 'USD') || ')',
          updated_at = now()
      WHERE id = v_target_debt.id;

      IF NOT EXISTS (
        SELECT 1 FROM public.branch_debt_transfers 
        WHERE debt_id = v_target_debt.id AND transfer_id = v_transfer_id
      ) THEN
        INSERT INTO public.branch_debt_transfers (
          debt_id, transfer_id, transfer_no, amount, amount_usd, currency, status, created_at
        ) VALUES (
          v_target_debt.id, v_transfer_id, v_transfer_no, v_inc_amount, v_total_amount_usd, coalesce(v_target_debt.currency, 'USD'), 'added', now()
        );
      END IF;
    END IF;
  END IF;

  RETURN public.get_external_branch_transfer(v_transfer_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_external_branch_transfer(uuid, uuid, text, text, text, text, jsonb) TO authenticated, service_role, anon;

-- PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
