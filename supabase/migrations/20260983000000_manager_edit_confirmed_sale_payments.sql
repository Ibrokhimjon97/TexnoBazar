-- Migration: Add manager_update_sale_payments RPC and expose delivery in get_pos_pending_sale
CREATE OR REPLACE FUNCTION public.manager_update_sale_payments(
  p_pending_sale_id uuid,
  p_payments jsonb,
  p_delivery jsonb DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_pending public.pos_pending_sales%rowtype;
  v_sale public.sales%rowtype;
  v_item jsonb;
  v_method public.payment_methods%rowtype;
  v_paid numeric(18,2) := 0;
  v_count integer := 0;
  v_cod_amount numeric(18,2) := 0;
  v_del_row public.pos_deliveries%rowtype;
  v_items jsonb;
  v_del_id uuid;
  v_delivery_no text;
  v_cust_name text;
  v_cust_phone text;
  v_cust_address text;
  v_fulfillment_source text;
BEGIN
  -- 1. Find pending sale
  SELECT * INTO v_pending FROM public.pos_pending_sales WHERE id = p_pending_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS kassa so‘rovi topilmadi' USING errcode = 'P0002';
  END IF;

  -- 2. Check manager permissions
  PERFORM public.require_pos_manager(v_pending.branch_id);

  -- 3. Set admin override so immutable triggers allow updating payments
  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

  -- 4. Find confirmed sale
  SELECT * INTO v_sale FROM public.sales WHERE pending_sale_id = v_pending.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ushbu so‘rov uchun tasdiqlangan sotuv topilmadi' USING errcode = 'P0002';
  END IF;

  -- 4. Validate payments
  IF p_payments IS NULL OR jsonb_typeof(p_payments) <> 'array' OR jsonb_array_length(p_payments) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'To‘lovlar ro‘yxati noto‘g‘ri' USING errcode = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code')) AND is_active;
    IF NOT FOUND OR (v_item->>'amount') IS NULL OR (v_item->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'To‘lov usuli yoki summasi noto‘g‘ri: %', v_item->>'method_code' USING errcode = '22023';
    END IF;
    IF v_method.code = 'cod' THEN
      v_cod_amount := v_cod_amount + (v_item->>'amount')::numeric(18,2);
    END IF;
    v_paid := v_paid + (v_item->>'amount')::numeric(18,2);
    v_count := v_count + 1;
  END LOOP;

  IF v_paid <> v_sale.total THEN
    RAISE EXCEPTION 'To‘lovlar jami (%) sotuv summasiga (%) teng bo‘lishi shart', v_paid, v_sale.total USING errcode = '22023';
  END IF;

  -- 5. Delete existing sale_payments and insert new ones
  DELETE FROM public.sale_payments WHERE sale_id = v_sale.id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code'));
    INSERT INTO public.sale_payments(
      id, sale_id, payment_method_id, amount, status, external_reference, received_by, paid_at, metadata, created_at
    ) VALUES (
      gen_random_uuid(),
      v_sale.id,
      v_method.id,
      (v_item->>'amount')::numeric(18,2),
      CASE WHEN v_method.code = 'cod' THEN 'pending'::public.payment_status ELSE 'paid'::public.payment_status END,
      nullif(btrim(v_item->>'external_reference'), ''),
      auth.uid(),
      now(),
      '{}'::jsonb,
      now()
    );
  END LOOP;

  -- 6. Also sync pos_pending_sale_payments for consistency
  DELETE FROM public.pos_pending_sale_payments WHERE pending_sale_id = v_pending.id;
  DECLARE
    v_sort integer := 1;
  BEGIN
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code'));
      INSERT INTO public.pos_pending_sale_payments(
        id, pending_sale_id, payment_method_id, amount, external_reference, sort_order, created_at
      ) VALUES (
        gen_random_uuid(),
        v_pending.id,
        v_method.id,
        (v_item->>'amount')::numeric(18,2),
        nullif(btrim(v_item->>'external_reference'), ''),
        v_sort,
        now()
      );
      v_sort := v_sort + 1;
    END LOOP;
  END;

  -- 7. Handle pos_deliveries if COD or delivery was specified
  v_cust_name := coalesce(nullif(btrim(p_delivery->>'customer_name'), ''), 'Mijoz');
  v_cust_phone := nullif(btrim(p_delivery->>'customer_phone'), '');
  v_cust_address := nullif(btrim(p_delivery->>'customer_address'), '');
  v_fulfillment_source := coalesce(nullif(btrim(p_delivery->>'fulfillment_source'), ''), 'warehouse');

  -- Check if delivery record already exists for this sale
  SELECT * INTO v_del_row FROM public.pos_deliveries WHERE sale_id = v_sale.id OR pending_sale_id = v_pending.id LIMIT 1 FOR UPDATE;

  IF v_del_row.id IS NOT NULL THEN
    -- Delivery exists, update it!
    UPDATE public.pos_deliveries
    SET cod_amount = v_cod_amount,
        customer_name = coalesce(v_cust_name, customer_name),
        customer_phone = coalesce(v_cust_phone, customer_phone),
        delivery_address = coalesce(v_cust_address, delivery_address),
        payment_type = CASE WHEN v_cod_amount = v_sale.total THEN 'cod' WHEN v_cod_amount > 0 THEN 'split' ELSE 'cash' END,
        payment_status = CASE WHEN v_cod_amount > 0 THEN 'pending_courier' ELSE 'paid' END,
        updated_at = now()
    WHERE id = v_del_row.id;
  ELSIF v_cod_amount > 0 OR (p_delivery IS NOT NULL AND (p_delivery->>'needed')::boolean = true) THEN
    -- Delivery does not exist yet, but COD > 0 or delivery is needed! Create it!
    IF v_cust_phone IS NULL OR v_cust_address IS NULL THEN
      -- Try to get customer info from customer table if available
      IF v_pending.customer_id IS NOT NULL THEN
        SELECT full_name, phone, coalesce(address->>'address', '') INTO v_cust_name, v_cust_phone, v_cust_address
        FROM public.customers WHERE id = v_pending.customer_id;
      END IF;
    END IF;

    IF v_cust_phone IS NULL OR v_cust_address IS NULL THEN
      RAISE EXCEPTION 'Kuryer to‘lovi yoki dostavka uchun mijoz telefoni va yetkazish manzili kiritilishi shart' USING errcode = '22023';
    END IF;

    v_del_id := gen_random_uuid();
    v_delivery_no := 'DOS-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(v_del_id::text, 1, 6));

    SELECT jsonb_agg(jsonb_build_object(
      'product_id', sl.product_id,
      'product_name', p.name,
      'sku', p.sku,
      'quantity', sl.quantity,
      'unit_price', sl.unit_price,
      'line_total', sl.line_total,
      'qr_code', u.qr_code,
      'serial_number', u.serial_number,
      'location_name', coalesce(l.name, CASE WHEN l.type = 'store' THEN 'Do‘kon' ELSE 'Ombor' END),
      'location_type', l.type,
      'batch_code', coalesce(sb.reference, 'PRT-' || substr(coalesce(u.batch_id::text, '00000000'), 1, 8)),
      'selected_components', coalesce(sl.selected_components, '[]'::jsonb)
    ))
    INTO v_items
    FROM public.sale_lines sl
    JOIN public.products p ON p.id = sl.product_id
    JOIN public.inventory_units u ON u.id = sl.unit_id
    LEFT JOIN public.locations l ON l.id = u.location_id
    LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
    WHERE sl.sale_id = v_sale.id;

    INSERT INTO public.pos_deliveries (
      id, branch_id, sale_id, pending_sale_id, delivery_no,
      customer_name, customer_phone, delivery_address,
      items, total_amount, payment_type, payment_status,
      delivery_status, cod_amount, notes, fulfillment_source, created_at, updated_at
    ) VALUES (
      v_del_id, v_sale.branch_id, v_sale.id, v_pending.id, v_delivery_no,
      v_cust_name, v_cust_phone, v_cust_address,
      coalesce(v_items, '[]'::jsonb), v_sale.total,
      CASE WHEN v_cod_amount = v_sale.total THEN 'cod' WHEN v_cod_amount > 0 THEN 'split' ELSE 'cash' END,
      CASE WHEN v_cod_amount > 0 THEN 'pending_courier' ELSE 'paid' END,
      'pending', v_cod_amount, nullif(btrim(p_delivery->>'notes'), ''), v_fulfillment_source, now(), now()
    );
  END IF;

  UPDATE public.pos_pending_sales
  SET updated_at = now()
  WHERE id = v_pending.id;

  RETURN jsonb_build_object(
    'success', true,
    'sale_id', v_sale.id,
    'pending_id', v_pending.id,
    'cod_amount', v_cod_amount
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.manager_update_sale_payments(uuid, jsonb, jsonb) TO authenticated, service_role;

-- Update get_pos_pending_sale to return delivery object
CREATE OR REPLACE FUNCTION public.get_pos_pending_sale(p_pending_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_s public.pos_pending_sales%rowtype;
  v_manager boolean;
  v_result jsonb;
  v_sale record;
BEGIN
  SELECT * INTO v_s FROM public.pos_pending_sales WHERE id = p_pending_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS so‘rovi topilmadi' USING errcode = 'P0002';
  END IF;

  IF auth.uid() IS NULL THEN
    v_manager := true;
  ELSE
    v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
      OR public.has_role(array['manager']::public.app_role[], v_s.branch_id);

    IF NOT v_manager AND NOT (v_s.seller_id = auth.uid() AND public.has_role(array['seller']::public.app_role[], v_s.branch_id)) THEN
      RAISE EXCEPTION 'POS so‘rovi uchun ruxsat yo‘q' USING errcode = '42501';
    END IF;
  END IF;

  IF v_s.status = 'pending' AND v_s.expires_at <= now() THEN
    PERFORM public.release_pos_reservation(v_s.id, 'expired', 'Rezerv muddati tugadi', auth.uid());
  END IF;

  SELECT to_jsonb(s) || jsonb_build_object(
    'seller_name', seller.full_name,
    'location_name', loc.name,
    'customer', (
      SELECT jsonb_build_object('id', c.id, 'full_name', c.full_name, 'phone', c.phone, 'address', c.address->>'address')
      FROM public.customers c WHERE c.id = s.customer_id
    ),
    'delivery', (
      SELECT jsonb_build_object(
        'id', d.id,
        'delivery_no', d.delivery_no,
        'customer_name', d.customer_name,
        'customer_phone', d.customer_phone,
        'delivery_address', d.delivery_address,
        'cod_amount', d.cod_amount,
        'payment_status', d.payment_status,
        'delivery_status', d.delivery_status,
        'fulfillment_source', d.fulfillment_source,
        'notes', d.notes
      )
      FROM public.pos_deliveries d
      WHERE d.pending_sale_id = s.id OR d.sale_id = (SELECT id FROM public.sales WHERE pending_sale_id = s.id LIMIT 1)
      LIMIT 1
    ),
    'lines', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', x.id,
        'unit_id', x.unit_id,
        'product_id', x.product_id,
        'product_name', p.name,
        'sku', p.sku,
        'qr_code', u.qr_code,
        'serial_number', u.serial_number,
        'image', coalesce(
          (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = u.variant_id ORDER BY m.is_primary DESC, m.sort_order ASC LIMIT 1),
          (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id ORDER BY m.is_primary DESC, m.sort_order ASC LIMIT 1),
          p.seo_image_url
        ),
        'unit_price', x.unit_price,
        'discount', x.discount,
        'tax', x.tax,
        'line_total', x.line_total,
        'retail_price', p.retail_price,
        'minimum_sale_price', p.minimum_sale_price,
        'unit_cost', coalesce(sb.unit_cost, p.cost_price),
        'profit', x.line_total - x.tax - coalesce(sb.unit_cost, p.cost_price),
        'selected_components', coalesce(x.selected_components, '[]'::jsonb)
      ) ORDER BY x.created_at, x.id)
      FROM public.pos_pending_sale_lines x
      JOIN public.products p ON p.id = x.product_id
      JOIN public.inventory_units u ON u.id = x.unit_id
      LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
      WHERE x.pending_sale_id = s.id
    ), '[]'::jsonb),
    'payments', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'method_id', pmt.method_id,
        'method_code', pmt.method_code,
        'method_name', pmt.method_name,
        'amount', pmt.amount,
        'external_reference', pmt.external_reference,
        'sort_order', pmt.sort_order
      ) ORDER BY pmt.sort_order)
      FROM (
        SELECT pm.id AS method_id, pm.code AS method_code, pm.name AS method_name, sp.amount, sp.external_reference, pm.sort_order
        FROM public.sales sa
        JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
        JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
        WHERE sa.pending_sale_id = s.id
        UNION ALL
        SELECT pm.id AS method_id, pm.code AS method_code, pm.name AS method_name, pp.amount, pp.external_reference, pp.sort_order
        FROM public.pos_pending_sale_payments pp
        JOIN public.payment_methods pm ON pm.id = pp.payment_method_id
        WHERE pp.pending_sale_id = s.id
          AND NOT EXISTS (
            SELECT 1 FROM public.sales sa2
            JOIN public.sale_payments sp2 ON sp2.sale_id = sa2.id AND sp2.status IN ('paid', 'pending')
            WHERE sa2.pending_sale_id = s.id
          )
        UNION ALL
        SELECT pm.id AS method_id, pm.code AS method_code, pm.name AS method_name, s.total AS amount, null AS external_reference, 1 AS sort_order
        FROM public.payment_methods pm
        WHERE pm.code = 'cash' AND s.status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM public.sales sa3
            JOIN public.sale_payments sp3 ON sp3.sale_id = sa3.id AND sp3.status IN ('paid', 'pending')
            WHERE sa3.pending_sale_id = s.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.pos_pending_sale_payments pp3
            WHERE pp3.pending_sale_id = s.id
          )
      ) pmt
    ), '[]'::jsonb),
    'can_confirm', s.status = 'pending' AND s.expires_at > now() AND v_manager,
    'can_reject', s.status = 'pending' AND v_manager,
    'remaining_seconds', greatest(0, floor(extract(epoch FROM (s.expires_at - now())))::integer)
  )
  INTO v_result
  FROM public.pos_pending_sales s
  JOIN public.profiles seller ON seller.id = s.seller_id
  JOIN public.locations loc ON loc.id = s.store_location_id
  WHERE s.id = p_pending_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pos_pending_sale(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
