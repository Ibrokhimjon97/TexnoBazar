-- Migration: 20261006000000_smart_inventory_reconciliation.sql
-- Description: Smart inventory audit, reconciliation, fast code resolution, and alias re-linking.

BEGIN;

-- 1. product_code_aliases: Tovar uchun qo'shimcha yoki eski QR/shtrix kodlarni bog'lash jadvali
CREATE TABLE IF NOT EXISTS public.product_code_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  code text NOT NULL,
  notes text,
  created_at timestamptz DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  CONSTRAINT product_code_aliases_code_unique UNIQUE (code)
);

CREATE INDEX IF NOT EXISTS idx_product_code_aliases_code ON public.product_code_aliases (upper(code));
CREATE INDEX IF NOT EXISTS idx_product_code_aliases_product ON public.product_code_aliases (product_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_code_aliases TO authenticated, service_role;

-- 2. stock_reconciliations & lines: Reviziya tarixi jurnali
CREATE TABLE IF NOT EXISTS public.stock_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_no text NOT NULL UNIQUE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'applied' CHECK (status IN ('draft', 'applied', 'cancelled')),
  notes text,
  total_items integer NOT NULL DEFAULT 0,
  total_matched integer NOT NULL DEFAULT 0,
  total_surplus integer NOT NULL DEFAULT 0,
  total_shortage integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  applied_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.stock_reconciliation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id uuid NOT NULL REFERENCES public.stock_reconciliations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  expected_quantity numeric NOT NULL DEFAULT 0,
  counted_quantity numeric NOT NULL DEFAULT 0,
  variance numeric NOT NULL DEFAULT 0,
  action_taken text NOT NULL DEFAULT 'none',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_reconciliations_branch ON public.stock_reconciliations (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_reconciliation_lines_rec ON public.stock_reconciliation_lines (reconciliation_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_reconciliations TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_reconciliation_lines TO authenticated, service_role;

-- 3. resolve_product_by_code: Skanerlangan QR, shtrix-kod, SKU yoki taxallus orqali tovarni aniqlash
CREATE OR REPLACE FUNCTION public.resolve_product_by_code(p_branch_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_product_id uuid;
  v_res record;
  v_branch_stock numeric := 0;
  v_canonical_qr text;
BEGIN
  IF v_code = '' THEN
    RETURN jsonb_build_object('found', false, 'error', 'Kod bo''sh');
  END IF;

  -- 1) Avval qo'shimcha biriktirilgan taxalluslar jadvalidan qidiramiz
  SELECT product_id INTO v_product_id
  FROM public.product_code_aliases
  WHERE upper(code) = v_code
  LIMIT 1;

  -- 2) inventory_units (qr_code yoki serial_number)
  IF v_product_id IS NULL THEN
    SELECT product_id INTO v_product_id
    FROM public.inventory_units
    WHERE upper(qr_code) = v_code OR upper(coalesce(serial_number, '')) = v_code
    ORDER BY CASE WHEN status = 'available' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1;
  END IF;

  -- 3) products (barcode, sku, yoki id)
  IF v_product_id IS NULL THEN
    SELECT id INTO v_product_id
    FROM public.products
    WHERE upper(sku) = v_code
       OR upper(coalesce(barcode, '')) = v_code
       OR id::text = v_code
    LIMIT 1;
  END IF;

  -- Agar topilmasa
  IF v_product_id IS NULL THEN
    RETURN jsonb_build_object(
      'found', false,
      'code', p_code
    );
  END IF;

  -- Mahsulot ma'lumotlarini yig'amiz
  SELECT
    p.id,
    p.name,
    p.sku,
    p.barcode,
    p.currency,
    p.retail_price,
    p.retail_price_usd,
    p.cost_price,
    p.cost_price_usd,
    c.name as category_name,
    b.name as brand_name,
    (
      SELECT pm.media_url
      FROM public.product_media pm
      WHERE pm.product_id = p.id
      ORDER BY pm.is_primary DESC, pm.created_at ASC
      LIMIT 1
    ) as image_url
  INTO v_res
  FROM public.products p
  LEFT JOIN public.categories c ON c.id = p.category_id
  LEFT JOIN public.brands b ON b.id = p.brand_id
  WHERE p.id = v_product_id;

  -- Filialdagi joriy qoldiqni hisoblash
  SELECT coalesce(sum(ib.on_hand), 0) INTO v_branch_stock
  FROM public.inventory_balances ib
  JOIN public.locations l ON l.id = ib.location_id
  WHERE l.branch_id = p_branch_id
    AND ib.product_id = v_product_id;

  -- Mavjud eng mos QR kodni aniqlash
  SELECT coalesce(
    (SELECT u.qr_code FROM public.inventory_units u WHERE u.product_id = v_product_id AND u.status = 'available' ORDER BY u.created_at DESC LIMIT 1),
    (SELECT u.qr_code FROM public.inventory_units u WHERE u.product_id = v_product_id ORDER BY u.created_at DESC LIMIT 1),
    v_res.barcode,
    v_res.sku
  ) INTO v_canonical_qr;

  RETURN jsonb_build_object(
    'found', true,
    'scanned_code', p_code,
    'product', jsonb_build_object(
      'id', v_res.id,
      'name', v_res.name,
      'sku', v_res.sku,
      'barcode', v_res.barcode,
      'currency', v_res.currency,
      'retail_price', v_res.retail_price,
      'retail_price_usd', v_res.retail_price_usd,
      'cost_price', v_res.cost_price,
      'cost_price_usd', v_res.cost_price_usd,
      'category_name', v_res.category_name,
      'brand_name', v_res.brand_name,
      'image_url', v_res.image_url,
      'branch_stock', v_branch_stock,
      'canonical_qr', v_canonical_qr
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_product_by_code(uuid, text) TO authenticated, service_role;

-- 4. link_code_to_product: Noma'lum yoki eski QR kodni mahsulotga biriktirish
CREATE OR REPLACE FUNCTION public.link_code_to_product(p_code text, p_product_id uuid, p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_prod_name text;
BEGIN
  IF v_code = '' OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'Kod va mahsulot majburiy' USING errcode = '22023';
  END IF;

  SELECT name INTO v_prod_name FROM public.products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mahsulot topilmadi' USING errcode = 'P0002';
  END IF;

  INSERT INTO public.product_code_aliases (product_id, code, notes, created_by)
  VALUES (p_product_id, v_code, p_notes, auth.uid())
  ON CONFLICT (code) DO UPDATE
    SET product_id = p_product_id,
        notes = coalesce(p_notes, public.product_code_aliases.notes);

  -- Agar mahsulotning shtrix-kodi yo'q bo'lsa, shuni qo'yib qo'yamiz
  UPDATE public.products
  SET barcode = coalesce(barcode, v_code)
  WHERE id = p_product_id AND barcode IS NULL;

  RETURN jsonb_build_object(
    'success', true,
    'code', v_code,
    'product_id', p_product_id,
    'product_name', v_prod_name,
    'message', 'QR kod muvaffaqiyatli biriktirildi'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.link_code_to_product(text, uuid, text) TO authenticated, service_role;

-- 5. apply_stock_reconciliation: Reviziya tafovutlarini dastur balansiga tatbiq etish
CREATE OR REPLACE FUNCTION public.apply_stock_reconciliation(
  p_branch_id uuid,
  p_location_id uuid,
  p_items jsonb,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rec_id uuid;
  v_rec_no text;
  v_target_location uuid := p_location_id;
  v_writeoff_loc uuid;
  v_item jsonb;
  v_prod_id uuid;
  v_expected numeric;
  v_counted numeric;
  v_diff numeric;
  v_total_items integer := 0;
  v_matched integer := 0;
  v_surplus integer := 0;
  v_shortage integer := 0;
  v_new_labels jsonb := '[]'::jsonb;
  v_prod record;
  v_new_qr text;
  v_dummy_batch uuid;
  v_short_units uuid[];
  v_unit_id uuid;
BEGIN
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'Filial tanlanmagan' USING errcode = '22023';
  END IF;

  PERFORM public.require_inventory_operator(p_branch_id);

  IF NOT (
    public.has_role(ARRAY['superadmin', 'admin']::public.app_role[], NULL)
    OR public.has_role(ARRAY['manager']::public.app_role[], p_branch_id)
  ) THEN
    RAISE EXCEPTION 'Faqat menejer yoki admin reviziyani tasdiqlay oladi' USING errcode = '42501';
  END IF;

  -- Default location agar kiritilmagan bo'lsa
  IF v_target_location IS NULL THEN
    SELECT id INTO v_target_location
    FROM public.locations
    WHERE branch_id = p_branch_id
    ORDER BY CASE WHEN type = 'store' THEN 0 ELSE 1 END, created_at ASC
    LIMIT 1;
  END IF;

  -- Writeoff location
  SELECT id INTO v_writeoff_loc
  FROM public.locations
  WHERE type = 'writeoff'
  LIMIT 1;

  v_rec_no := 'REV-' || to_char(now(), 'YYYYMMDD-HH24MI') || '-' || substr(md5(random()::text), 1, 4);

  INSERT INTO public.stock_reconciliations (
    reconciliation_no, branch_id, location_id, status, notes, created_by
  ) VALUES (
    v_rec_no, p_branch_id, v_target_location, 'applied', p_notes, auth.uid()
  ) RETURNING id INTO v_rec_id;

  -- Iteratsiya
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_prod_id := (v_item->>'product_id')::uuid;
    v_expected := coalesce((v_item->>'expected')::numeric, 0);
    v_counted := coalesce((v_item->>'counted')::numeric, 0);
    v_diff := v_counted - v_expected;

    v_total_items := v_total_items + 1;

    SELECT id, name, sku, barcode, cost_price, cost_price_usd, retail_price, retail_price_usd, currency
    INTO v_prod
    FROM public.products
    WHERE id = v_prod_id;

    IF v_diff = 0 THEN
      v_matched := v_matched + 1;
      INSERT INTO public.stock_reconciliation_lines (
        reconciliation_id, product_id, expected_quantity, counted_quantity, variance, action_taken
      ) VALUES (
        v_rec_id, v_prod_id, v_expected, v_counted, 0, 'none'
      );

    ELSIF v_diff > 0 THEN
      -- ORTIQCHA (SURPLUS): Do'kon hisobiga kirim qilamiz
      v_surplus := v_surplus + 1;

      -- Ushbu tovar uchun eng so'nggi partiyani topamiz yoki yangi partiya ochamiz
      SELECT sb.id INTO v_dummy_batch
      FROM public.stock_batches sb
      JOIN public.stock_receipts sr ON sr.id = sb.receipt_id
      WHERE sb.product_id = v_prod_id AND sr.branch_id = p_branch_id
      ORDER BY sb.created_at DESC
      LIMIT 1;

      IF v_dummy_batch IS NULL THEN
        SELECT sb.id INTO v_dummy_batch
        FROM public.stock_batches sb
        WHERE sb.product_id = v_prod_id
        ORDER BY sb.created_at DESC
        LIMIT 1;
      END IF;

      -- Mavjud partiya bo'lmasa, reviziya partiyasini yaratamiz
      IF v_dummy_batch IS NULL THEN
        INSERT INTO public.stock_batches (
          batch_number, product_id, initial_quantity, remaining_quantity,
          unit_cost, unit_cost_usd, retail_price, retail_price_usd
        ) VALUES (
          'REV-BATCH-' || substr(md5(random()::text), 1, 6),
          v_prod_id, v_diff::int, v_diff::int,
          coalesce(v_prod.cost_price, 0), coalesce(v_prod.cost_price_usd, 0),
          coalesce(v_prod.retail_price, 0), coalesce(v_prod.retail_price_usd, 0)
        ) RETURNING id INTO v_dummy_batch;
      END IF;

      -- Ushbu tovar uchun umumiy QR kodni topamiz
      SELECT u.qr_code INTO v_new_qr
      FROM public.inventory_units u
      WHERE u.product_id = v_prod_id AND u.qr_code IS NOT NULL
      ORDER BY u.created_at DESC
      LIMIT 1;

      IF v_new_qr IS NULL THEN
        v_new_qr := public.generate_short_qr();
      END IF;

      -- Har bir ortiqcha dona uchun inventory_units yaratamiz
      FOR i IN 1..v_diff::int LOOP
        INSERT INTO public.inventory_units (
          product_id, batch_id, location_id, qr_code, status
        ) VALUES (
          v_prod_id, v_dummy_batch, v_target_location, v_new_qr, 'available'
        );
      END LOOP;

      -- inventory_balances yangilash
      INSERT INTO public.inventory_balances (location_id, product_id, on_hand, reserved, updated_at)
      VALUES (v_target_location, v_prod_id, v_diff, 0, now())
      ON CONFLICT (location_id, product_id) DO UPDATE
        SET on_hand = public.inventory_balances.on_hand + v_diff,
            updated_at = now();

      -- Harakatlar logi
      INSERT INTO public.inventory_movements (
        product_id, batch_id, movement_type, to_location_id, quantity,
        unit_cost, reference_type, reference_id, reason, actor_id, metadata
      ) VALUES (
        v_prod_id, v_dummy_batch, 'adjustment', v_target_location, v_diff,
        v_prod.cost_price, 'stock_reconciliation', v_rec_id,
        'Reviziya ortiqchasi: +' || v_diff::text || ' dona',
        auth.uid(), jsonb_build_object('reconciliation_no', v_rec_no, 'variance', v_diff)
      );

      -- Yangi QR stiker ro'yxatiga qo'shish
      v_new_labels := v_new_labels || jsonb_build_object(
        'product_id', v_prod.id,
        'product_name', v_prod.name,
        'title', v_prod.name,
        'sku', v_prod.sku,
        'qr_code', v_new_qr,
        'code', v_new_qr,
        'price', coalesce(v_prod.retail_price, 0),
        'retail_price', coalesce(v_prod.retail_price, 0),
        'retail_price_usd', coalesce(v_prod.retail_price_usd, 0),
        'cost_usd', coalesce(v_prod.cost_price_usd, 0),
        'quantity', v_diff::int
      );

      INSERT INTO public.stock_reconciliation_lines (
        reconciliation_id, product_id, expected_quantity, counted_quantity, variance, action_taken
      ) VALUES (
        v_rec_id, v_prod_id, v_expected, v_counted, v_diff, 'surplus_added'
      );

    ELSE
      -- KAMOMAD (SHORTAGE): Do'kon hisobidan kamaytiramiz (hisobdan chiqarish)
      v_shortage := v_shortage + 1;

      -- Mavjud mavjud birliklarni topamiz
      SELECT array_agg(u.id) INTO v_short_units
      FROM (
        SELECT id FROM public.inventory_units
        WHERE product_id = v_prod_id
          AND location_id = v_target_location
          AND status = 'available'
          AND active_transfer_id IS NULL
        ORDER BY created_at ASC
        LIMIT abs(v_diff)::int
      ) u;

      IF v_short_units IS NOT NULL AND array_length(v_short_units, 1) > 0 THEN
        UPDATE public.inventory_units
        SET status = 'written_off',
            location_id = coalesce(v_writeoff_loc, location_id),
            version = version + 1
        WHERE id = ANY(v_short_units);
      END IF;

      -- inventory_balances yangilash
      UPDATE public.inventory_balances
      SET on_hand = greatest(0, on_hand - abs(v_diff)),
          updated_at = now()
      WHERE location_id = v_target_location AND product_id = v_prod_id;

      -- Harakatlar logi
      INSERT INTO public.inventory_movements (
        product_id, movement_type, from_location_id, quantity,
        unit_cost, reference_type, reference_id, reason, actor_id, metadata
      ) VALUES (
        v_prod_id, 'adjustment', v_target_location, abs(v_diff),
        v_prod.cost_price, 'stock_reconciliation', v_rec_id,
        'Reviziya kamomadi: -' || abs(v_diff)::text || ' dona',
        auth.uid(), jsonb_build_object('reconciliation_no', v_rec_no, 'variance', v_diff)
      );

      INSERT INTO public.stock_reconciliation_lines (
        reconciliation_id, product_id, expected_quantity, counted_quantity, variance, action_taken
      ) VALUES (
        v_rec_id, v_prod_id, v_expected, v_counted, v_diff, 'shortage_written_off'
      );

    END IF;
  END LOOP;

  -- Yakuniy umumiy sonlarni yangilash
  UPDATE public.stock_reconciliations
  SET total_items = v_total_items,
      total_matched = v_matched,
      total_surplus = v_surplus,
      total_shortage = v_shortage,
      applied_at = now()
  WHERE id = v_rec_id;

  RETURN jsonb_build_object(
    'success', true,
    'reconciliation_id', v_rec_id,
    'reconciliation_no', v_rec_no,
    'total_items', v_total_items,
    'total_matched', v_matched,
    'total_surplus', v_surplus,
    'total_shortage', v_shortage,
    'new_labels', v_new_labels
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_stock_reconciliation(uuid, uuid, jsonb, text) TO authenticated, service_role;

-- 6. list_stock_reconciliations: Tarixni olish
CREATE OR REPLACE FUNCTION public.list_stock_reconciliations(
  p_branch_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_items jsonb;
  v_total bigint;
BEGIN
  SELECT count(*) INTO v_total
  FROM public.stock_reconciliations
  WHERE branch_id = p_branch_id;

  SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) INTO v_items
  FROM (
    SELECT
      sr.id,
      sr.reconciliation_no,
      sr.branch_id,
      sr.location_id,
      l.name as location_name,
      sr.status,
      sr.notes,
      sr.total_items,
      sr.total_matched,
      sr.total_surplus,
      sr.total_shortage,
      sr.created_at,
      sr.applied_at,
      p.full_name as author_name
    FROM public.stock_reconciliations sr
    LEFT JOIN public.locations l ON l.id = sr.location_id
    LEFT JOIN public.profiles p ON p.id = sr.created_by
    WHERE sr.branch_id = p_branch_id
    ORDER BY sr.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) q;

  RETURN jsonb_build_object(
    'total', v_total,
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_stock_reconciliations(uuid, integer, integer) TO authenticated, service_role;

COMMIT;
