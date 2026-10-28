-- Migration: Allow finding transfer product by name, partial SKU, barcode, or QR
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
    RAISE EXCEPTION 'QR kod, barkod yoki tovar nomi kiritilmadi' USING errcode = '22023';
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

  -- 1. Try finding unit by exact QR or serial number in this location
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

  -- 2. Fallback: check by product barcode or exact SKU that has available units in this location
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

  -- 3. Fallback: check by product name (ILIKE) or partial SKU/barcode with available units in this location
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
      AND (
        p.name ILIKE '%' || v_code || '%'
        OR p.sku ILIKE '%' || v_code || '%'
        OR coalesce(p.barcode, '') ILIKE '%' || v_code || '%'
      )
      AND EXISTS (
        SELECT 1 FROM public.inventory_units u3
        WHERE u3.location_id = p_location_id AND u3.product_id = p.id AND u3.status = 'available' AND u3.active_transfer_id IS NULL
      )
    ORDER BY
      CASE
        WHEN upper(p.name) = upper(v_code) THEN 1
        WHEN upper(p.sku) = upper(v_code) THEN 2
        WHEN p.name ILIKE v_code || '%' THEN 3
        ELSE 4
      END,
      p.name ASC
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
