-- Migration: Auto-cleanup old courier tracking data and smart distance-based GPS throttling
-- 1. Create index on recorded_at for instant deletes and range filtering
CREATE INDEX IF NOT EXISTS idx_courier_tracking_recorded_at ON public.courier_tracking(recorded_at);

-- 2. Immediate cleanup of any existing records older than 2 days to instantly free up database space
DELETE FROM public.courier_tracking
WHERE recorded_at < (now() - interval '2 days');

-- 3. Dedicated cleanup RPC function that can be called anytime or scheduled
CREATE OR REPLACE FUNCTION public.cleanup_old_courier_tracking(p_days integer DEFAULT 2)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_deleted integer := 0;
  v_threshold_days integer := greatest(1, coalesce(p_days, 2));
BEGIN
  DELETE FROM public.courier_tracking
  WHERE recorded_at < (now() - (v_threshold_days || ' days')::interval);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_rows', v_deleted,
    'retained_days', v_threshold_days,
    'cleaned_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_old_courier_tracking(integer) TO authenticated, service_role;

-- 4. Overwrite record_courier_gps_location with smart 25m movement gate and automatic continuous purge
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

  -- 1. Always update single-row live location (0 table growth, preserves live online status for manager)
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

  -- 2. Smart History Logging:
  -- ONLY insert into courier_tracking history if courier moved >= 25 meters (0.025 km) or first location.
  -- Stationary courier (< 25m) will NOT generate database clutter!
  IF v_last_time IS NULL OR v_dist_km >= 0.025 THEN
    INSERT INTO public.courier_tracking (
      courier_id, branch_id, pos_delivery_id, latitude, longitude, accuracy_m, recorded_at
    ) VALUES (
      auth.uid(), v_branch_id, p_pos_delivery_id, p_latitude, p_longitude, p_accuracy_m, now()
    );
  END IF;

  -- 3. Automatic Continuous Auto-cleanup:
  -- Purge any tracking older than 2 days on every write so database never accumulates bloat
  DELETE FROM public.courier_tracking
  WHERE recorded_at < (now() - interval '2 days');

  RETURN jsonb_build_object(
    'success', true,
    'latitude', p_latitude,
    'longitude', p_longitude,
    'dist_km', v_dist_km,
    'recorded_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_courier_gps_location(numeric, numeric, numeric, numeric, numeric, uuid) TO authenticated, service_role;

-- 5. Update legacy insert_courier_tracking with the same 25m movement check and auto-cleanup
CREATE OR REPLACE FUNCTION public.insert_courier_tracking(
  p_delivery_id uuid,
  p_latitude numeric,
  p_longitude numeric,
  p_accuracy_m numeric DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_id bigint := 0;
  v_last_lat numeric;
  v_last_lon numeric;
  v_dist_km numeric := 0;
BEGIN
  IF NOT public.current_user_active() OR NOT EXISTS (
    SELECT 1
    FROM public.deliveries d
    JOIN public.orders o ON o.id = d.order_id
    JOIN public.profile_roles r ON r.profile_id = auth.uid() AND r.role = 'courier' AND r.branch_id = o.branch_id
    WHERE d.id = p_delivery_id AND d.courier_id = auth.uid() AND d.status = 'in_transit'
  ) THEN
    RAISE EXCEPTION 'Yo‘ldagi faol yetkazib berish topilmadi' USING errcode = '42501';
  END IF;

  IF p_latitude NOT BETWEEN -90 AND 90 OR p_longitude NOT BETWEEN -180 AND 180
    OR (p_accuracy_m IS NOT NULL AND p_accuracy_m NOT BETWEEN 0 AND 1000) THEN
    RAISE EXCEPTION 'Koordinata yoki GPS aniqligi noto‘g‘ri' USING errcode = '22023';
  END IF;

  SELECT latitude, longitude INTO v_last_lat, v_last_lon
  FROM public.courier_tracking
  WHERE courier_id = auth.uid() AND delivery_id = p_delivery_id
  ORDER BY recorded_at DESC
  LIMIT 1;

  IF v_last_lat IS NOT NULL AND v_last_lon IS NOT NULL THEN
    v_dist_km := public.haversine_distance_km(v_last_lat, v_last_lon, p_latitude, p_longitude);
  END IF;

  -- Only record if moved >= 25 meters or first entry
  IF v_last_lat IS NULL OR v_dist_km >= 0.025 THEN
    INSERT INTO public.courier_tracking(delivery_id, courier_id, latitude, longitude, accuracy_m, recorded_at)
    VALUES (p_delivery_id, auth.uid(), p_latitude, p_longitude, p_accuracy_m, now())
    RETURNING id INTO v_id;
  END IF;

  -- Auto-cleanup
  DELETE FROM public.courier_tracking
  WHERE recorded_at < (now() - interval '2 days');

  RETURN coalesce(v_id, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.insert_courier_tracking(uuid, numeric, numeric, numeric) TO authenticated, service_role;
