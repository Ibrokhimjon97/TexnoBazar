-- Migration: External branch transfers for unlisted branches (filiallarga tarqatish)
-- Allows sellers and managers to transfer batches of inventory to external branches
-- at cost price (tannarx) or wholesale price (ulgurji narx).

BEGIN;

-- 1. Create external_branch_transfers table
CREATE TABLE IF NOT EXISTS public.external_branch_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no text NOT NULL UNIQUE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  from_location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  target_branch_name text NOT NULL,
  target_manager_name text NOT NULL,
  seller_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  seller_name text NOT NULL,
  price_mode text NOT NULL CHECK (price_mode IN ('cost', 'wholesale', 'custom')),
  currency char(3) NOT NULL DEFAULT 'UZS',
  exchange_rate numeric(18,4) NOT NULL DEFAULT 1,
  total_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  total_amount_usd numeric(18,2) NOT NULL DEFAULT 0,
  total_items_count integer NOT NULL DEFAULT 0 CHECK (total_items_count >= 0),
  notes text,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Create external_branch_transfer_lines table
CREATE TABLE IF NOT EXISTS public.external_branch_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES public.external_branch_transfers(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  product_name text NOT NULL,
  sku text,
  image text,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  unit_price_usd numeric(18,2) NOT NULL DEFAULT 0,
  total_price numeric(18,2) NOT NULL CHECK (total_price >= 0),
  cost_price numeric(18,2) DEFAULT 0,
  wholesale_price numeric(18,2) DEFAULT 0,
  unit_ids uuid[] DEFAULT ARRAY[]::uuid[],
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Add column external_transfer_id to inventory_units if not exists
ALTER TABLE public.inventory_units ADD COLUMN IF NOT EXISTS external_transfer_id uuid REFERENCES public.external_branch_transfers(id) ON DELETE SET NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ext_transfers_branch_date ON public.external_branch_transfers(branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ext_transfers_seller ON public.external_branch_transfers(seller_id);
CREATE INDEX IF NOT EXISTS idx_ext_transfers_target_branch ON public.external_branch_transfers(target_branch_name);
CREATE INDEX IF NOT EXISTS idx_ext_transfer_lines_transfer_id ON public.external_branch_transfer_lines(transfer_id);
CREATE INDEX IF NOT EXISTS idx_ext_transfer_lines_product_id ON public.external_branch_transfer_lines(product_id);

-- 4. RPC: get_external_transfer_references
CREATE OR REPLACE FUNCTION public.get_external_transfer_references(p_branch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rate numeric;
  v_rate_date date;
BEGIN
  SELECT rate, rate_date INTO v_rate, v_rate_date
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC LIMIT 1;

  IF v_rate IS NULL OR v_rate <= 0 THEN
    v_rate := 11850;
    v_rate_date := current_date;
  END IF;

  RETURN jsonb_build_object(
    'branch_id', p_branch_id,
    'locations', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'code', code, 'type', type) ORDER BY type, name)
      FROM public.locations
      WHERE branch_id = p_branch_id AND is_active AND type IN ('store', 'warehouse')
    ), '[]'::jsonb),
    'exchange_rate', v_rate,
    'exchange_rate_date', v_rate_date
  );
END;
$$;

-- 5. RPC: find_external_transfer_product
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
  v_rate numeric;
  v_avail_count integer;
BEGIN
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'QR kod yoki seriya raqami kiritilmadi' USING errcode = '22023';
  END IF;

  IF p_location_id IS NULL THEN
    RAISE EXCEPTION 'Joy (do‘kon yoki ombor) tanlanmagan' USING errcode = '22023';
  END IF;

  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC LIMIT 1;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    v_rate := 11850;
  END IF;

  -- Try finding unit by exact QR or serial number in this location
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
    AND (
      upper(u.qr_code) = upper(v_code)
      OR upper(coalesce(u.serial_number, '')) = upper(v_code)
    )
  LIMIT 1;

  -- Fallback: check by product barcode or SKU that has available units in this location
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
      AND EXISTS (
        SELECT 1 FROM public.inventory_units u3
        WHERE u3.location_id = p_location_id AND u3.product_id = p.id AND u3.status = 'available' AND u3.active_transfer_id IS NULL
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
    'available_count', v_avail_count
  );
END;
$$;

-- 6. RPC: search_external_transfer_products
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
        ) AS sample_qr
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
        AND EXISTS (
          SELECT 1 FROM public.inventory_units u2
          WHERE u2.location_id = p_location_id
            AND u2.product_id = p.id
            AND u2.status = 'available'
            AND u2.active_transfer_id IS NULL
        )
      LIMIT coalesce(p_limit, 30)
    ) q
  ), '[]'::jsonb);
END;
$$;

-- 7. RPC: get_external_branch_transfer
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

-- 8. RPC: create_external_branch_transfer
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
  IF v_seller_id IS NULL THEN
    SELECT id, coalesce(full_name, email, 'Sotuvchi') INTO v_seller_id, v_seller_name
    FROM public.profiles WHERE is_active LIMIT 1;
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
    v_seller_name, coalesce(p_price_mode, 'cost'), 'UZS',
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
      IF p_price_mode = 'wholesale' THEN
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
        'price_mode', p_price_mode,
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

-- 9. RPC: list_external_branch_transfers
CREATE OR REPLACE FUNCTION public.list_external_branch_transfers(
  p_branch_id uuid DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_from_date date DEFAULT NULL,
  p_to_date date DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_seller_id uuid DEFAULT NULL,
  p_price_mode text DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_query text := nullif(btrim(p_query), '');
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_limit integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_offset integer := (v_page - 1) * v_limit;
  v_total_count integer := 0;
  v_total_value_uzs numeric(18,2) := 0;
  v_total_value_usd numeric(18,2) := 0;
  v_total_items integer := 0;
  v_items jsonb;
BEGIN
  -- Compute totals across filtered set
  SELECT
    count(*)::integer,
    coalesce(sum(t.total_amount), 0),
    coalesce(sum(t.total_amount_usd), 0),
    coalesce(sum(t.total_items_count), 0)
  INTO
    v_total_count,
    v_total_value_uzs,
    v_total_value_usd,
    v_total_items
  FROM public.external_branch_transfers t
  WHERE (p_branch_id IS NULL OR t.branch_id = p_branch_id)
    AND (p_location_id IS NULL OR t.from_location_id = p_location_id)
    AND (p_seller_id IS NULL OR t.seller_id = p_seller_id)
    AND (p_price_mode IS NULL OR p_price_mode = 'all' OR t.price_mode = p_price_mode)
    AND (p_from_date IS NULL OR t.created_at >= (p_from_date::timestamptz))
    AND (p_to_date IS NULL OR t.created_at < ((p_to_date + interval '1 day')::timestamptz))
    AND (
      v_query IS NULL
      OR t.transfer_no ILIKE '%' || v_query || '%'
      OR t.target_branch_name ILIKE '%' || v_query || '%'
      OR t.target_manager_name ILIKE '%' || v_query || '%'
      OR t.seller_name ILIKE '%' || v_query || '%'
      OR coalesce(t.notes, '') ILIKE '%' || v_query || '%'
      OR EXISTS (
        SELECT 1 FROM public.external_branch_transfer_lines l
        WHERE l.transfer_id = t.id
          AND (l.product_name ILIKE '%' || v_query || '%' OR coalesce(l.sku, '') ILIKE '%' || v_query || '%')
      )
    );

  -- Fetch page items
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', q.id,
      'transfer_no', q.transfer_no,
      'branch_id', q.branch_id,
      'branch_name', q.branch_name,
      'from_location_id', q.from_location_id,
      'from_location_name', q.from_location_name,
      'from_location_type', q.from_location_type,
      'target_branch_name', q.target_branch_name,
      'target_manager_name', q.target_manager_name,
      'seller_id', q.seller_id,
      'seller_name', q.seller_name,
      'price_mode', q.price_mode,
      'currency', q.currency,
      'exchange_rate', q.exchange_rate,
      'total_amount', q.total_amount,
      'total_amount_usd', q.total_amount_usd,
      'total_items_count', q.total_items_count,
      'notes', q.notes,
      'status', q.status,
      'created_at', q.created_at,
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
            'unit_ids', tl.unit_ids
          ) ORDER BY tl.created_at
        )
        FROM public.external_branch_transfer_lines tl
        WHERE tl.transfer_id = q.id
      ), '[]'::jsonb)
    ) ORDER BY q.created_at DESC
  ), '[]'::jsonb) INTO v_items
  FROM (
    SELECT
      t.*,
      b.name AS branch_name,
      l.name AS from_location_name,
      l.type AS from_location_type
    FROM public.external_branch_transfers t
    JOIN public.branches b ON b.id = t.branch_id
    JOIN public.locations l ON l.id = t.from_location_id
    WHERE (p_branch_id IS NULL OR t.branch_id = p_branch_id)
      AND (p_location_id IS NULL OR t.from_location_id = p_location_id)
      AND (p_seller_id IS NULL OR t.seller_id = p_seller_id)
      AND (p_price_mode IS NULL OR p_price_mode = 'all' OR t.price_mode = p_price_mode)
      AND (p_from_date IS NULL OR t.created_at >= (p_from_date::timestamptz))
      AND (p_to_date IS NULL OR t.created_at < ((p_to_date + interval '1 day')::timestamptz))
      AND (
        v_query IS NULL
        OR t.transfer_no ILIKE '%' || v_query || '%'
        OR t.target_branch_name ILIKE '%' || v_query || '%'
        OR t.target_manager_name ILIKE '%' || v_query || '%'
        OR t.seller_name ILIKE '%' || v_query || '%'
        OR coalesce(t.notes, '') ILIKE '%' || v_query || '%'
        OR EXISTS (
          SELECT 1 FROM public.external_branch_transfer_lines l
          WHERE l.transfer_id = t.id
            AND (l.product_name ILIKE '%' || v_query || '%' OR coalesce(l.sku, '') ILIKE '%' || v_query || '%')
        )
      )
    ORDER BY t.created_at DESC
    LIMIT v_limit OFFSET v_offset
  ) q;

  RETURN jsonb_build_object(
    'items', v_items,
    'total_count', v_total_count,
    'total_value_uzs', v_total_value_uzs,
    'total_value_usd', v_total_value_usd,
    'total_items_count', v_total_items,
    'page', v_page,
    'page_size', v_limit
  );
END;
$$;

-- Permissions
GRANT ALL ON TABLE public.external_branch_transfers TO authenticated, service_role, anon;
GRANT ALL ON TABLE public.external_branch_transfer_lines TO authenticated, service_role, anon;

GRANT EXECUTE ON FUNCTION public.get_external_transfer_references(uuid) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.find_external_transfer_product(uuid, uuid, text) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.search_external_transfer_products(uuid, uuid, text, integer) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.create_external_branch_transfer(uuid, uuid, text, text, text, text, jsonb) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.list_external_branch_transfers(uuid, text, date, date, uuid, uuid, text, integer, integer) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.get_external_branch_transfer(uuid) TO authenticated, service_role, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
