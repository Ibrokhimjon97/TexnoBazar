-- Migration: Courier POS Delivery Self-Selection, QR Verification, and Real-time Live GPS Tracking
-- 1. Alter courier_tracking to support generic and POS delivery tracking
ALTER TABLE public.courier_tracking ALTER COLUMN delivery_id DROP NOT NULL;
ALTER TABLE public.courier_tracking ADD COLUMN IF NOT EXISTS pos_delivery_id uuid REFERENCES public.pos_deliveries(id) ON DELETE SET NULL;
ALTER TABLE public.courier_tracking ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_courier_tracking_courier_time ON public.courier_tracking(courier_id, recorded_at DESC);

-- 2. Courier live locations table for fast real-time position querying
CREATE TABLE IF NOT EXISTS public.courier_live_locations (
  courier_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  latitude numeric(9,6) NOT NULL,
  longitude numeric(9,6) NOT NULL,
  accuracy_m numeric(10,2),
  speed numeric(10,2),
  heading numeric(10,2),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_online boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_courier_live_branch ON public.courier_live_locations(branch_id);

-- Enable RLS
ALTER TABLE public.courier_live_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "courier_live_locations_all" ON public.courier_live_locations;
CREATE POLICY "courier_live_locations_all" ON public.courier_live_locations
  FOR ALL TO authenticated
  USING (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], branch_id)
    OR courier_id = auth.uid()
  )
  WITH CHECK (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], branch_id)
    OR courier_id = auth.uid()
  );

-- Update RLS on pos_deliveries to allow couriers to view and claim
DROP POLICY IF EXISTS "pos_deliveries_courier_select" ON public.pos_deliveries;
CREATE POLICY "pos_deliveries_courier_select" ON public.pos_deliveries
  FOR SELECT TO authenticated
  USING (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager','seller']::public.app_role[], branch_id)
    OR public.has_role(array['courier']::public.app_role[], branch_id)
  );

DROP POLICY IF EXISTS "pos_deliveries_courier_update" ON public.pos_deliveries;
CREATE POLICY "pos_deliveries_courier_update" ON public.pos_deliveries
  FOR UPDATE TO authenticated
  USING (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], branch_id)
    OR (public.has_role(array['courier']::public.app_role[], branch_id) AND (courier_id IS NULL OR courier_id = auth.uid()))
  )
  WITH CHECK (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], branch_id)
    OR (public.has_role(array['courier']::public.app_role[], branch_id) AND (courier_id IS NULL OR courier_id = auth.uid()))
  );

-- 3. Haversine distance function in kilometers
CREATE OR REPLACE FUNCTION public.haversine_distance_km(lat1 numeric, lon1 numeric, lat2 numeric, lon2 numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  SELECT (6371.0 * acos(
    least(1.0, greatest(-1.0,
      cos(radians(lat1)) * cos(radians(lat2)) * cos(radians(lon2) - radians(lon1)) +
      sin(radians(lat1)) * sin(radians(lat2))
    ))
  ))::numeric(10,3);
$$;

-- 4. RPC: Record courier GPS location
CREATE OR REPLACE FUNCTION public.record_courier_gps_location(
  p_latitude numeric,
  p_longitude numeric,
  p_accuracy_m numeric DEFAULT NULL,
  p_speed numeric DEFAULT NULL,
  p_heading numeric DEFAULT NULL,
  p_pos_delivery_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_branch_id uuid;
  v_last_lat numeric;
  v_last_lon numeric;
  v_last_time timestamptz;
  v_dist_km numeric := 0;
BEGIN
  IF NOT public.current_user_active() THEN
    RAISE EXCEPTION 'Foydalanuvchi faol emas' USING errcode = '42501';
  END IF;

  IF p_latitude NOT BETWEEN -90 AND 90 OR p_longitude NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'Koordinatalar noto‘g‘ri' USING errcode = '22023';
  END IF;

  -- Get courier's branch
  SELECT branch_id INTO v_branch_id
  FROM public.profile_roles
  WHERE profile_id = auth.uid() AND role = 'courier' AND branch_id IS NOT NULL
  LIMIT 1;

  IF v_branch_id IS NULL THEN
    -- Fallback to any active branch
    SELECT id INTO v_branch_id FROM public.branches WHERE is_active LIMIT 1;
  END IF;

  -- Get last position to avoid redundant writes
  SELECT latitude, longitude, updated_at
  INTO v_last_lat, v_last_lon, v_last_time
  FROM public.courier_live_locations
  WHERE courier_id = auth.uid();

  IF v_last_lat IS NOT NULL AND v_last_lon IS NOT NULL THEN
    v_dist_km := public.haversine_distance_km(v_last_lat, v_last_lon, p_latitude, p_longitude);
  END IF;

  -- Upsert live location
  INSERT INTO public.courier_live_locations (
    courier_id, branch_id, latitude, longitude, accuracy_m, speed, heading, updated_at, is_online
  ) VALUES (
    auth.uid(), v_branch_id, p_latitude, p_longitude, p_accuracy_m, p_speed, p_heading, now(), true
  )
  ON CONFLICT (courier_id) DO UPDATE SET
    branch_id = EXCLUDED.branch_id,
    latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude,
    accuracy_m = EXCLUDED.accuracy_m,
    speed = EXCLUDED.speed,
    heading = EXCLUDED.heading,
    updated_at = now(),
    is_online = true;

  -- Insert tracking point if distance moved >= 0.005 km (5 meters) or > 15 seconds since last point
  IF v_last_time IS NULL OR v_dist_km >= 0.005 OR (now() - v_last_time) >= interval '15 seconds' THEN
    INSERT INTO public.courier_tracking (
      courier_id, branch_id, pos_delivery_id, latitude, longitude, accuracy_m, recorded_at
    ) VALUES (
      auth.uid(), v_branch_id, p_pos_delivery_id, p_latitude, p_longitude, p_accuracy_m, now()
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'latitude', p_latitude,
    'longitude', p_longitude,
    'recorded_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_courier_gps_location(numeric, numeric, numeric, numeric, numeric, uuid) TO authenticated, service_role;

-- 5. RPC: Get active couriers live locations (for manager and admin tracking modal)
CREATE OR REPLACE FUNCTION public.get_active_couriers_live_locations(p_branch_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_result jsonb;
  v_today_start timestamptz := (date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent')) AT TIME ZONE 'Asia/Tashkent';
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT public.current_user_active() OR NOT (
      public.has_role(array['superadmin','admin']::public.app_role[], null)
      OR public.has_role(array['manager']::public.app_role[], p_branch_id)
    ) THEN
      RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
    END IF;
  END IF;

  WITH distance_calc AS (
    SELECT
      ct.courier_id,
      coalesce(sum(
        CASE
          WHEN ct.prev_lat IS NOT NULL AND ct.prev_lon IS NOT NULL THEN
            -- Only sum if segment distance is realistic (> 5m and speed < 160 km/h)
            CASE
              WHEN public.haversine_distance_km(ct.prev_lat, ct.prev_lon, ct.latitude, ct.longitude) BETWEEN 0.005 AND 10.0
              THEN public.haversine_distance_km(ct.prev_lat, ct.prev_lon, ct.latitude, ct.longitude)
              ELSE 0
            END
          ELSE 0
        END
      ), 0) AS today_km
    FROM (
      SELECT
        courier_id,
        latitude,
        longitude,
        lag(latitude) OVER (PARTITION BY courier_id ORDER BY recorded_at ASC) AS prev_lat,
        lag(longitude) OVER (PARTITION BY courier_id ORDER BY recorded_at ASC) AS prev_lon
      FROM public.courier_tracking
      WHERE recorded_at >= v_today_start
    ) ct
    GROUP BY ct.courier_id
  ),
  active_deliveries AS (
    SELECT
      courier_id,
      count(*) AS active_count
    FROM public.pos_deliveries
    WHERE courier_id IS NOT NULL AND delivery_status IN ('pending', 'in_transit')
    GROUP BY courier_id
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'courier_id', p.id,
      'courier_name', p.full_name,
      'courier_phone', p.phone,
      'latitude', coalesce(cll.latitude, 41.311081), -- Default Tashkent center if not set
      'longitude', coalesce(cll.longitude, 69.240562),
      'accuracy_m', cll.accuracy_m,
      'speed', cll.speed,
      'heading', cll.heading,
      'updated_at', cll.updated_at,
      'is_online', (cll.updated_at IS NOT NULL AND (now() - cll.updated_at) < interval '10 minutes'),
      'has_gps', (cll.latitude IS NOT NULL),
      'today_km', round(coalesce(dc.today_km, 0)::numeric, 2),
      'active_deliveries_count', coalesce(ad.active_count, 0)
    ) ORDER BY p.full_name ASC
  ), '[]'::jsonb)
  INTO v_result
  FROM public.profiles p
  JOIN public.profile_roles r ON r.profile_id = p.id AND r.role = 'courier'
  LEFT JOIN public.courier_live_locations cll ON cll.courier_id = p.id
  LEFT JOIN distance_calc dc ON dc.courier_id = p.id
  LEFT JOIN active_deliveries ad ON ad.courier_id = p.id
  WHERE p.is_active
    AND (p_branch_id IS NULL OR r.branch_id = p_branch_id OR r.branch_id IS NULL);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_active_couriers_live_locations(uuid) TO authenticated, service_role;

-- 6. RPC: Get courier daily route path (polyline coords and km)
CREATE OR REPLACE FUNCTION public.get_courier_daily_route(
  p_courier_id uuid,
  p_date date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_points jsonb;
  v_total_km numeric := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.current_user_active() THEN
    RAISE EXCEPTION 'Foydalanuvchi faol emas' USING errcode = '42501';
  END IF;

  v_day_start := (p_date::text || ' 00:00:00')::timestamp AT TIME ZONE 'Asia/Tashkent';
  v_day_end := (p_date::text || ' 23:59:59')::timestamp AT TIME ZONE 'Asia/Tashkent';

  WITH raw_points AS (
    SELECT
      id,
      latitude,
      longitude,
      accuracy_m,
      recorded_at,
      lag(latitude) OVER (ORDER BY recorded_at ASC) AS prev_lat,
      lag(longitude) OVER (ORDER BY recorded_at ASC) AS prev_lon,
      lag(recorded_at) OVER (ORDER BY recorded_at ASC) AS prev_time
    FROM public.courier_tracking
    WHERE courier_id = p_courier_id
      AND recorded_at >= v_day_start
      AND recorded_at <= v_day_end
    ORDER BY recorded_at ASC
  ),
  filtered_points AS (
    SELECT
      id,
      latitude,
      longitude,
      accuracy_m,
      recorded_at,
      CASE
        WHEN prev_lat IS NOT NULL AND prev_lon IS NOT NULL THEN
          public.haversine_distance_km(prev_lat, prev_lon, latitude, longitude)
        ELSE 0
      END AS segment_km
    FROM raw_points
  )
  SELECT
    coalesce(jsonb_agg(
      jsonb_build_object(
        'lat', fp.latitude,
        'lng', fp.longitude,
        'accuracy', fp.accuracy_m,
        'time', fp.recorded_at
      ) ORDER BY fp.recorded_at ASC
    ), '[]'::jsonb),
    coalesce(sum(
      CASE
        -- filter out jitter and unrealistic teleport jumps
        WHEN fp.segment_km BETWEEN 0.005 AND 10.0 THEN fp.segment_km
        ELSE 0
      END
    ), 0)
  INTO v_points, v_total_km
  FROM filtered_points fp;

  RETURN jsonb_build_object(
    'courier_id', p_courier_id,
    'date', p_date,
    'total_km', round(v_total_km::numeric, 2),
    'points', v_points
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_courier_daily_route(uuid, date) TO authenticated, service_role;

-- 7. RPC: Courier list POS deliveries (available, my_active, delivered)
CREATE OR REPLACE FUNCTION public.courier_list_pos_deliveries(
  p_tab text DEFAULT 'available' -- 'available', 'my_active', 'delivered'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_branch_id uuid;
  v_items jsonb;
  v_available_count integer;
  v_my_active_count integer;
  v_delivered_count integer;
  v_total_cash_to_collect numeric := 0;
  v_courier_id uuid := auth.uid();
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT public.current_user_active() THEN
      RAISE EXCEPTION 'Foydalanuvchi faol emas' USING errcode = '42501';
    END IF;
  ELSE
    SELECT profile_id INTO v_courier_id FROM public.profile_roles WHERE role = 'courier' LIMIT 1;
  END IF;

  -- Determine courier's branch
  SELECT branch_id INTO v_branch_id
  FROM public.profile_roles
  WHERE profile_id = v_courier_id AND role = 'courier' AND branch_id IS NOT NULL
  LIMIT 1;

  IF v_branch_id IS NULL THEN
    SELECT branch_id INTO v_branch_id FROM public.pos_deliveries LIMIT 1;
  END IF;

  -- Counters
  SELECT
    count(*) FILTER (WHERE courier_id IS NULL AND delivery_status IN ('pending', 'in_transit')),
    count(*) FILTER (WHERE courier_id = v_courier_id AND delivery_status != 'delivered' AND delivery_status != 'cancelled'),
    count(*) FILTER (WHERE courier_id = v_courier_id AND delivery_status = 'delivered'),
    coalesce(sum(cod_amount) FILTER (WHERE courier_id = v_courier_id AND delivery_status != 'delivered' AND payment_status = 'pending_courier'), 0)
  INTO
    v_available_count,
    v_my_active_count,
    v_delivered_count,
    v_total_cash_to_collect
  FROM public.pos_deliveries
  WHERE (v_branch_id IS NULL OR branch_id = v_branch_id);

  -- Fetch items according to selected tab
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      d.id,
      d.branch_id,
      d.delivery_no,
      d.customer_name,
      d.customer_phone,
      d.delivery_address,
      d.items,
      d.total_amount,
      d.payment_type,
      d.payment_status,
      d.delivery_status,
      d.cod_amount,
      d.courier_id,
      d.courier_name,
      d.courier_phone,
      d.notes,
      d.created_at,
      d.delivered_at,
      s.sale_no,
      coalesce(sp.full_name, 'Sotuvchi') AS seller_name,
      coalesce(sp.phone, '') AS seller_phone
    FROM public.pos_deliveries d
    LEFT JOIN public.sales s ON s.id = d.sale_id
    LEFT JOIN public.profiles sp ON sp.id = s.seller_id
    WHERE (v_branch_id IS NULL OR d.branch_id = v_branch_id)
      AND (
        (p_tab = 'available' AND d.courier_id IS NULL AND d.delivery_status IN ('pending', 'in_transit'))
        OR
        (p_tab = 'my_active' AND d.courier_id = v_courier_id AND d.delivery_status != 'delivered' AND d.delivery_status != 'cancelled')
        OR
        (p_tab = 'delivered' AND d.courier_id = v_courier_id AND d.delivery_status = 'delivered')
      )
    ORDER BY d.created_at DESC
  ) q;

  RETURN jsonb_build_object(
    'items', v_items,
    'tab', p_tab,
    'summary', jsonb_build_object(
      'available_count', coalesce(v_available_count, 0),
      'my_active_count', coalesce(v_my_active_count, 0),
      'delivered_count', coalesce(v_delivered_count, 0),
      'total_cash_to_collect', coalesce(v_total_cash_to_collect, 0)
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.courier_list_pos_deliveries(text) TO authenticated, service_role;

-- 8. RPC: Courier claims deliveries (1 or multiple)
CREATE OR REPLACE FUNCTION public.courier_claim_pos_deliveries(
  p_delivery_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_courier public.profiles%rowtype;
  v_claimed_count integer := 0;
BEGIN
  IF NOT public.current_user_active() THEN
    RAISE EXCEPTION 'Foydalanuvchi faol emas' USING errcode = '42501';
  END IF;

  SELECT * INTO v_courier FROM public.profiles WHERE id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kuryer profili topilmadi' USING errcode = 'P0002';
  END IF;

  IF p_delivery_ids IS NULL OR array_length(p_delivery_ids, 1) = 0 THEN
    RAISE EXCEPTION 'Kamida bitta dostavka tanlanishi kerak' USING errcode = '22023';
  END IF;

  UPDATE public.pos_deliveries
  SET courier_id = auth.uid(),
      courier_name = v_courier.full_name,
      courier_phone = v_courier.phone,
      delivery_status = 'in_transit',
      updated_at = now()
  WHERE id = ANY(p_delivery_ids)
    AND courier_id IS NULL
    AND delivery_status IN ('pending', 'in_transit');

  GET DIAGNOSTICS v_claimed_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'claimed_count', v_claimed_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.courier_claim_pos_deliveries(uuid[]) TO authenticated, service_role;

-- 9. RPC: Courier unclaims a delivery (edit / release back)
CREATE OR REPLACE FUNCTION public.courier_unclaim_pos_delivery(
  p_delivery_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_del public.pos_deliveries%rowtype;
BEGIN
  IF NOT public.current_user_active() THEN
    RAISE EXCEPTION 'Foydalanuvchi faol emas' USING errcode = '42501';
  END IF;

  SELECT * INTO v_del FROM public.pos_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dostavka topilmadi' USING errcode = 'P0002';
  END IF;

  IF v_del.courier_id <> auth.uid() THEN
    RAISE EXCEPTION 'Ushbu dostavka sizga biriktirilmagan' USING errcode = '42501';
  END IF;

  IF v_del.delivery_status = 'delivered' THEN
    RAISE EXCEPTION 'Yetkazib bo‘lingan dostavkani qaytarib bo‘lmaydi' USING errcode = 'P0001';
  END IF;

  UPDATE public.pos_deliveries
  SET courier_id = NULL,
      courier_name = NULL,
      courier_phone = NULL,
      delivery_status = 'pending',
      updated_at = now()
  WHERE id = p_delivery_id
  RETURNING * INTO v_del;

  RETURN jsonb_build_object(
    'success', true,
    'delivery_id', v_del.id,
    'delivery_no', v_del.delivery_no
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.courier_unclaim_pos_delivery(uuid) TO authenticated, service_role;

-- 10. RPC: Courier completes a delivery ("Yetkazdim")
CREATE OR REPLACE FUNCTION public.courier_complete_pos_delivery(
  p_delivery_id uuid,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_del public.pos_deliveries%rowtype;
BEGIN
  IF NOT public.current_user_active() THEN
    RAISE EXCEPTION 'Foydalanuvchi faol emas' USING errcode = '42501';
  END IF;

  SELECT * INTO v_del FROM public.pos_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dostavka topilmadi' USING errcode = 'P0002';
  END IF;

  IF v_del.courier_id <> auth.uid() AND NOT public.has_role(array['superadmin','admin','manager']::public.app_role[], v_del.branch_id) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  UPDATE public.pos_deliveries
  SET delivery_status = 'delivered',
      delivered_at = now(),
      notes = coalesce(nullif(trim(p_notes), ''), notes),
      updated_at = now()
  WHERE id = p_delivery_id
  RETURNING * INTO v_del;

  RETURN jsonb_build_object(
    'success', true,
    'delivery_id', v_del.id,
    'delivery_no', v_del.delivery_no,
    'delivery_status', v_del.delivery_status,
    'delivered_at', v_del.delivered_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.courier_complete_pos_delivery(uuid, text) TO authenticated, service_role;

-- 11. RPC: Courier QR verification for products
CREATE OR REPLACE FUNCTION public.courier_verify_product_unit_qr(
  p_delivery_id uuid,
  p_scanned_code text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_del public.pos_deliveries%rowtype;
  v_clean_code text := trim(p_scanned_code);
  v_item jsonb;
  v_unit record;
  v_prod record;
  v_matched boolean := false;
  v_exact_unit boolean := false;
  v_matched_item jsonb := null;
BEGIN
  IF NOT public.current_user_active() THEN
    RAISE EXCEPTION 'Foydalanuvchi faol emas' USING errcode = '42501';
  END IF;

  SELECT * INTO v_del FROM public.pos_deliveries WHERE id = p_delivery_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dostavka topilmadi' USING errcode = 'P0002';
  END IF;

  -- 1. Check if scanned code directly matches an item's qr_code, batch_code, or sku
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_del.items) LOOP
    IF lower(coalesce(v_item->>'qr_code', '')) = lower(v_clean_code)
       OR lower(coalesce(v_item->>'batch_code', '')) = lower(v_clean_code)
       OR lower(coalesce(v_item->>'sku', '')) = lower(v_clean_code) THEN
      v_matched := true;
      v_exact_unit := (lower(coalesce(v_item->>'qr_code', '')) = lower(v_clean_code));
      v_matched_item := v_item;
      EXIT;
    END IF;
  END LOOP;

  IF v_matched THEN
    RETURN jsonb_build_object(
      'matched', true,
      'exact_unit', v_exact_unit,
      'product_name', v_matched_item->>'product_name',
      'sku', v_matched_item->>'sku',
      'message', CASE
        WHEN v_exact_unit THEN 'Aynan biriktirilgan tovar birligi (' || v_clean_code || ') tasdiqlandi!'
        ELSE 'To‘g‘ri tovar tanlandi: ' || (v_matched_item->>'product_name')
      END
    );
  END IF;

  -- 2. Check if scanned code belongs to any inventory unit or product in the database
  SELECT u.*, p.name AS product_name, p.sku AS product_sku
  INTO v_unit
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  WHERE lower(u.qr_code) = lower(v_clean_code)
     OR lower(coalesce(u.serial_number, '')) = lower(v_clean_code)
  LIMIT 1;

  IF FOUND THEN
    -- Check if this unit's product_id is in this delivery's items
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_del.items) LOOP
      IF (v_item->>'product_id')::uuid = v_unit.product_id THEN
        RETURN jsonb_build_object(
          'matched', true,
          'exact_unit', false,
          'product_name', v_unit.product_name,
          'sku', v_unit.product_sku,
          'message', 'Tovar turi to‘g‘ri (' || v_unit.product_name || '). Ombordan boshqa to‘g‘ri birlik tanlandi.'
        );
      END IF;
    END LOOP;

    -- Scanned existing unit, but it belongs to a completely different product!
    RETURN jsonb_build_object(
      'matched', false,
      'scanned_product_name', v_unit.product_name,
      'message', 'DIQQAT: Siz boshqa tovarni tanladingiz: "' || v_unit.product_name || '". Bu buyurtmaga mos kelmaydi!'
    );
  END IF;

  -- 3. Check if scanned code is a product SKU
  SELECT * INTO v_prod FROM public.products WHERE lower(sku) = lower(v_clean_code) LIMIT 1;
  IF FOUND THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_del.items) LOOP
      IF (v_item->>'product_id')::uuid = v_prod.id THEN
        RETURN jsonb_build_object(
          'matched', true,
          'exact_unit', false,
          'product_name', v_prod.name,
          'sku', v_prod.sku,
          'message', 'Tovar turi to‘g‘ri: ' || v_prod.name
        );
      END IF;
    END LOOP;

    RETURN jsonb_build_object(
      'matched', false,
      'scanned_product_name', v_prod.name,
      'message', 'DIQQAT: Bu boshqa tovar (' || v_prod.name || '). Bu buyurtmaga kirmaydi!'
    );
  END IF;

  -- 4. Code not found in database
  RETURN jsonb_build_object(
    'matched', false,
    'message', 'Ushbu QR kod yoki seriya raqami (' || v_clean_code || ') topilmadi.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.courier_verify_product_unit_qr(uuid, text) TO authenticated, service_role;
