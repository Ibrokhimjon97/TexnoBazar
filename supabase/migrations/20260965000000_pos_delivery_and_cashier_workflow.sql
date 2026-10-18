-- Migration: POS Delivery and Cashier Payment Workflow
-- Supports:
-- 1. Manager cashier payment selection: Naqd, Card/Click, Aralash (Split), COD (Kuryerdan berib yuboraman)
-- 2. Delivery creation with customer phone, address, items, and batch codes
-- 3. Courier cash collection ("Pulni oldim") and delivery status transitions

-- 1. Update manager_confirm_sale to allow 'cod' payment method
CREATE OR REPLACE FUNCTION public.manager_confirm_sale(p_pending_sale_id uuid, p_payments jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_s public.pos_pending_sales%rowtype;
  v_sale uuid;
  v_x record;
  v_item jsonb;
  v_method public.payment_methods%rowtype;
  v_paid numeric(18,2) := 0;
  v_count integer := 0;
  v_is_cod boolean := false;
BEGIN
  SELECT * INTO v_s FROM public.pos_pending_sales WHERE id = p_pending_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS so‘rovi topilmadi' USING errcode = 'P0002';
  END IF;

  PERFORM public.require_pos_manager(v_s.branch_id);
  IF v_s.status = 'confirmed' THEN
    SELECT id INTO v_sale FROM public.sales WHERE pending_sale_id = v_s.id;
    IF v_sale IS NULL THEN
      RAISE EXCEPTION 'Tasdiqlangan POS so‘rovi uchun sotuv topilmadi' USING errcode = 'P0001';
    END IF;
    RETURN v_sale;
  END IF;

  IF v_s.status <> 'pending' THEN
    RAISE EXCEPTION 'Faqat kutilayotgan POS so‘rovi tasdiqlanadi' USING errcode = 'P0001';
  END IF;

  IF v_s.expires_at <= now() THEN
    PERFORM public.release_pos_reservation(v_s.id, 'expired', 'Rezerv muddati tugadi', auth.uid());
    RETURN null;
  END IF;

  PERFORM 1 FROM public.inventory_units u
  JOIN public.pos_pending_sale_lines x ON x.unit_id = u.id
  WHERE x.pending_sale_id = v_s.id ORDER BY u.id FOR UPDATE OF u;

  IF EXISTS(
    SELECT 1 FROM public.inventory_units u
    JOIN public.pos_pending_sale_lines x ON x.unit_id = u.id
    JOIN public.locations l ON l.id = u.location_id
    WHERE x.pending_sale_id = v_s.id AND (
      u.status <> 'reserved' OR u.reserved_until <= now() OR u.sold_sale_id IS NOT NULL
      OR u.active_transfer_id IS NOT NULL OR l.branch_id <> v_s.branch_id OR NOT l.is_active
      OR l.type NOT IN ('store','warehouse')
    )
  ) THEN
    RAISE EXCEPTION 'Rezervdagi mahsulot holati buzilgan' USING errcode = 'P0001';
  END IF;

  IF p_payments IS NULL THEN
    SELECT count(*), coalesce(sum(amount), 0) INTO v_count, v_paid FROM public.pos_pending_sale_payments WHERE pending_sale_id = v_s.id;
  ELSE
    IF jsonb_typeof(p_payments) <> 'array' OR jsonb_array_length(p_payments) NOT BETWEEN 1 AND 10 THEN
      RAISE EXCEPTION 'To‘lovlar ro‘yxati noto‘g‘ri' USING errcode = '22023';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code')) AND is_active;
      IF NOT FOUND OR (v_item->>'amount') IS NULL OR (v_item->>'amount')::numeric <= 0 THEN
        RAISE EXCEPTION 'POS to‘lov usuli yoki summasi noto‘g‘ri' USING errcode = '22023';
      END IF;
      IF v_method.code = 'cod' THEN
        v_is_cod := true;
      END IF;
      v_paid := v_paid + (v_item->>'amount')::numeric(18,2);
      v_count := v_count + 1;
    END LOOP;
  END IF;

  IF v_count NOT BETWEEN 1 AND 10 OR v_paid <> v_s.total THEN
    RAISE EXCEPTION 'To‘lovlar jami sotuv summasiga teng emas' USING errcode = '22023';
  END IF;

  v_sale := gen_random_uuid();
  INSERT INTO public.sales(
    id, sale_no, branch_id, seller_id, manager_id, customer_id, pending_sale_id, status, subtotal, discount, tax, total
  ) VALUES (
    v_sale, 'SAL-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || upper(substr(v_sale::text, 1, 8)),
    v_s.branch_id, v_s.seller_id, auth.uid(), v_s.customer_id, v_s.id, 'completed', v_s.subtotal, v_s.discount, v_s.tax, v_s.total
  );

  PERFORM set_config('texnobazar.manager_confirm_sale', 'allowed', true);

  FOR v_x IN
    SELECT x.*, u.batch_id, u.location_id, coalesce(sb.unit_cost, p.cost_price) as unit_cost
    FROM public.pos_pending_sale_lines x
    JOIN public.inventory_units u ON u.id = x.unit_id
    JOIN public.products p ON p.id = x.product_id
    LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
    WHERE x.pending_sale_id = v_s.id ORDER BY u.id
  LOOP
    INSERT INTO public.sale_lines(
      sale_id, product_id, unit_id, quantity, unit_cost, unit_price, discount, tax, line_total, selected_components
    ) VALUES (
      v_sale, v_x.product_id, v_x.unit_id, 1, v_x.unit_cost, v_x.unit_price, v_x.discount, v_x.tax, v_x.line_total,
      coalesce(v_x.selected_components, '[]'::jsonb)
    );

    UPDATE public.inventory_units
    SET status = 'sold', sold_sale_id = v_sale, reserved_until = null, version = version + 1
    WHERE id = v_x.unit_id;

    INSERT INTO public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, quantity, unit_cost, reference_type, reference_id, actor_id
    ) VALUES (
      v_x.unit_id, v_x.product_id, v_x.batch_id, 'sold', v_x.location_id, 1, v_x.unit_cost, 'sale', v_sale, auth.uid()
    );
  END LOOP;

  PERFORM set_config('texnobazar.manager_confirm_sale', '', true);

  IF p_payments IS NULL THEN
    INSERT INTO public.sale_payments(sale_id, payment_method_id, amount, status, external_reference, received_by)
    SELECT v_sale, payment_method_id, amount, 'paid', external_reference, auth.uid()
    FROM public.pos_pending_sale_payments
    WHERE pending_sale_id = v_s.id ORDER BY sort_order;
  ELSE
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      SELECT * INTO v_method FROM public.payment_methods WHERE code = lower(btrim(v_item->>'method_code'));
      INSERT INTO public.sale_payments(sale_id, payment_method_id, amount, status, external_reference, received_by)
      VALUES (
        v_sale,
        v_method.id,
        (v_item->>'amount')::numeric(18,2),
        CASE WHEN v_method.code = 'cod' THEN 'pending'::public.payment_status ELSE 'paid'::public.payment_status END,
        nullif(btrim(v_item->>'external_reference'), ''),
        auth.uid()
      );
    END LOOP;
  END IF;

  UPDATE public.pos_pending_sales
  SET status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now()
  WHERE id = v_s.id;

  RETURN v_sale;
EXCEPTION WHEN unique_violation THEN
  SELECT id INTO v_sale FROM public.sales WHERE pending_sale_id = p_pending_sale_id;
  IF v_sale IS NOT NULL THEN RETURN v_sale; END IF;
  RAISE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.manager_confirm_sale(uuid, jsonb) TO authenticated, service_role;

-- 2. Create pos_deliveries table
CREATE TABLE IF NOT EXISTS public.pos_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  sale_id uuid REFERENCES public.sales(id) ON DELETE CASCADE,
  pending_sale_id uuid REFERENCES public.pos_pending_sales(id) ON DELETE SET NULL,
  delivery_no text NOT NULL UNIQUE,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  delivery_address text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_amount numeric(18,2) NOT NULL DEFAULT 0,
  payment_type text NOT NULL DEFAULT 'cash', -- 'cash', 'card', 'click', 'split', 'cod'
  payment_status text NOT NULL DEFAULT 'paid', -- 'paid' (kassada qabul qilingan), 'pending_courier' (kuryer olishi kerak), 'collected' (kassaga kirim qilindi)
  delivery_status text NOT NULL DEFAULT 'pending', -- 'pending' (Kutilmoqda), 'in_transit' (Yo'lda), 'delivered' (Yetkazildi), 'cancelled' (Bekor qilindi)
  cod_amount numeric(18,2) NOT NULL DEFAULT 0,
  courier_id uuid REFERENCES public.profiles(id),
  courier_name text,
  courier_phone text,
  notes text,
  paid_at timestamptz,
  paid_received_by uuid REFERENCES public.profiles(id),
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_deliveries_branch_status ON public.pos_deliveries(branch_id, delivery_status);
CREATE INDEX IF NOT EXISTS idx_pos_deliveries_created_at ON public.pos_deliveries(created_at DESC);

-- Enable RLS
ALTER TABLE public.pos_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pos_deliveries_manager_all" ON public.pos_deliveries;
CREATE POLICY "pos_deliveries_manager_all" ON public.pos_deliveries
  FOR ALL TO authenticated
  USING (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager','seller']::public.app_role[], branch_id)
  )
  WITH CHECK (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager','seller']::public.app_role[], branch_id)
  );

-- 3. RPC to create a POS delivery application
CREATE OR REPLACE FUNCTION public.create_pos_delivery(
  p_sale_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_delivery_address text,
  p_payment_type text DEFAULT 'cash',
  p_cod_amount numeric DEFAULT 0,
  p_notes text DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_sale public.sales%rowtype;
  v_items jsonb;
  v_delivery_no text;
  v_payment_status text;
  v_del_id uuid := gen_random_uuid();
  v_row public.pos_deliveries%rowtype;
BEGIN
  SELECT * INTO v_sale FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sotuv topilmadi: %', p_sale_id USING errcode = 'P0002';
  END IF;

  v_delivery_no := 'DOS-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(v_del_id::text, 1, 6));

  -- Gather items with batch numbers, QR codes, and product names
  SELECT jsonb_agg(jsonb_build_object(
    'product_id', sl.product_id,
    'product_name', p.name,
    'sku', p.sku,
    'quantity', sl.quantity,
    'unit_price', sl.unit_price,
    'line_total', sl.line_total,
    'qr_code', u.qr_code,
    'serial_number', u.serial_number,
    'batch_code', coalesce(sb.reference, 'PRT-' || substr(coalesce(u.batch_id::text, '00000000'), 1, 8)),
    'selected_components', coalesce(sl.selected_components, '[]'::jsonb)
  ))
  INTO v_items
  FROM public.sale_lines sl
  JOIN public.products p ON p.id = sl.product_id
  JOIN public.inventory_units u ON u.id = sl.unit_id
  LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
  WHERE sl.sale_id = v_sale.id;

  IF lower(p_payment_type) = 'cod' OR p_cod_amount > 0 THEN
    v_payment_status := 'pending_courier';
  ELSE
    v_payment_status := 'paid';
  END IF;

  INSERT INTO public.pos_deliveries (
    id, branch_id, sale_id, pending_sale_id, delivery_no,
    customer_name, customer_phone, delivery_address,
    items, total_amount, payment_type, payment_status,
    delivery_status, cod_amount, notes, created_at, updated_at
  ) VALUES (
    v_del_id, v_sale.branch_id, v_sale.id, v_sale.pending_sale_id, v_delivery_no,
    trim(p_customer_name), trim(p_customer_phone), trim(p_delivery_address),
    coalesce(v_items, '[]'::jsonb), v_sale.total, lower(p_payment_type), v_payment_status,
    'pending', coalesce(p_cod_amount, 0), nullif(trim(p_notes), ''), now(), now()
  )
  RETURNING * INTO v_row;

  -- Also update customer record if phone is provided
  IF trim(p_customer_phone) <> '' THEN
    UPDATE public.customers
    SET full_name = coalesce(nullif(trim(p_customer_name), ''), full_name),
        address = jsonb_build_object('address', trim(p_delivery_address)),
        updated_at = now()
    WHERE phone = trim(p_customer_phone);
  END IF;

  RETURN to_jsonb(v_row);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_pos_delivery(uuid, text, text, text, text, numeric, text) TO authenticated, service_role;

-- 4. RPC to list POS deliveries for manager
CREATE OR REPLACE FUNCTION public.list_pos_deliveries(
  p_branch_id uuid,
  p_status text DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_items jsonb;
  v_total integer;
  v_pending_count integer;
  v_in_transit_count integer;
  v_delivered_count integer;
  v_cod_pending_count integer;
  v_cod_pending_amount numeric;
BEGIN
  IF NOT public.current_user_active() OR NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager','seller']::public.app_role[], p_branch_id)
  ) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  -- Summary counts
  SELECT
    count(*) FILTER (WHERE delivery_status = 'pending'),
    count(*) FILTER (WHERE delivery_status = 'in_transit'),
    count(*) FILTER (WHERE delivery_status = 'delivered'),
    count(*) FILTER (WHERE payment_status = 'pending_courier'),
    coalesce(sum(cod_amount) FILTER (WHERE payment_status = 'pending_courier'), 0)
  INTO
    v_pending_count, v_in_transit_count, v_delivered_count, v_cod_pending_count, v_cod_pending_amount
  FROM public.pos_deliveries
  WHERE branch_id = p_branch_id;

  -- Filtered total
  SELECT count(*) INTO v_total
  FROM public.pos_deliveries d
  WHERE d.branch_id = p_branch_id
    AND (p_status IS NULL OR p_status = '' OR p_status = 'all' OR d.delivery_status = p_status)
    AND (p_query IS NULL OR p_query = '' OR (
      d.delivery_no ILIKE '%' || p_query || '%'
      OR d.customer_name ILIKE '%' || p_query || '%'
      OR d.customer_phone ILIKE '%' || p_query || '%'
      OR d.delivery_address ILIKE '%' || p_query || '%'
    ));

  -- Filtered items
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      d.*,
      s.sale_no,
      p.full_name AS courier_display_name,
      p.phone AS courier_display_phone
    FROM public.pos_deliveries d
    LEFT JOIN public.sales s ON s.id = d.sale_id
    LEFT JOIN public.profiles p ON p.id = d.courier_id
    WHERE d.branch_id = p_branch_id
      AND (p_status IS NULL OR p_status = '' OR p_status = 'all' OR d.delivery_status = p_status)
      AND (p_query IS NULL OR p_query = '' OR (
        d.delivery_no ILIKE '%' || p_query || '%'
        OR d.customer_name ILIKE '%' || p_query || '%'
        OR d.customer_phone ILIKE '%' || p_query || '%'
        OR d.delivery_address ILIKE '%' || p_query || '%'
      ))
    ORDER BY d.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) q;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'summary', jsonb_build_object(
      'pending_count', coalesce(v_pending_count, 0),
      'in_transit_count', coalesce(v_in_transit_count, 0),
      'delivered_count', coalesce(v_delivered_count, 0),
      'cod_pending_count', coalesce(v_cod_pending_count, 0),
      'cod_pending_amount', coalesce(v_cod_pending_amount, 0)
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_pos_deliveries(uuid, text, text, integer, integer) TO authenticated, service_role;

-- 5. RPC: Manager clicks "Pulni oldim" (Courier Cash Accepted)
CREATE OR REPLACE FUNCTION public.manager_accept_delivery_cash(p_delivery_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_del public.pos_deliveries%rowtype;
  v_account_id uuid;
  v_tx_id uuid;
BEGIN
  SELECT * INTO v_del FROM public.pos_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dostavka yozuvi topilmadi' USING errcode = 'P0002';
  END IF;

  IF NOT public.current_user_active() OR NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], v_del.branch_id)
  ) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  IF v_del.payment_status = 'collected' THEN
    RETURN to_jsonb(v_del);
  END IF;

  -- 1. Book income transaction in branch cash account
  SELECT id INTO v_account_id FROM public.finance_accounts WHERE branch_id = v_del.branch_id AND is_active LIMIT 1;
  IF v_account_id IS NULL THEN
    INSERT INTO public.finance_accounts (branch_id, code, name, currency)
    VALUES (v_del.branch_id, 'CASH-' || left(v_del.branch_id::text, 8), 'Kassa', 'UZS')
    RETURNING id INTO v_account_id;
  END IF;

  INSERT INTO public.finance_transactions (
    account_id, branch_id, type, category, amount, description, reference_type, reference_id, created_by
  ) VALUES (
    v_account_id, v_del.branch_id, 'income', 'delivery_cod_cash', v_del.cod_amount,
    'Dostavka kuryer puli qabul qilindi: ' || v_del.delivery_no || ' (' || v_del.customer_name || ')',
    'pos_delivery', v_del.id, auth.uid()
  )
  RETURNING id INTO v_tx_id;

  -- 2. Update sale_payments to paid if sale exists
  IF v_del.sale_id IS NOT NULL THEN
    UPDATE public.sale_payments
    SET status = 'paid'::public.payment_status,
        received_by = auth.uid(),
        paid_at = now()
    WHERE sale_id = v_del.sale_id AND status = 'pending'::public.payment_status;
  END IF;

  -- 3. Update pos_deliveries
  UPDATE public.pos_deliveries
  SET payment_status = 'collected',
      delivery_status = 'delivered',
      paid_at = now(),
      paid_received_by = auth.uid(),
      delivered_at = coalesce(delivered_at, now()),
      updated_at = now()
  WHERE id = p_delivery_id
  RETURNING * INTO v_del;

  RETURN to_jsonb(v_del);
END;
$$;

GRANT EXECUTE ON FUNCTION public.manager_accept_delivery_cash(uuid) TO authenticated, service_role;

-- 6. RPC: Manager updates delivery status (e.g. 'delivered', 'in_transit')
CREATE OR REPLACE FUNCTION public.manager_update_delivery_status(
  p_delivery_id uuid,
  p_status text,
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
  SELECT * INTO v_del FROM public.pos_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dostavka yozuvi topilmadi' USING errcode = 'P0002';
  END IF;

  IF NOT public.current_user_active() OR NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], v_del.branch_id)
  ) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  UPDATE public.pos_deliveries
  SET delivery_status = p_status,
      delivered_at = CASE WHEN p_status = 'delivered' THEN coalesce(delivered_at, now()) ELSE delivered_at END,
      notes = coalesce(nullif(trim(p_notes), ''), notes),
      updated_at = now()
  WHERE id = p_delivery_id
  RETURNING * INTO v_del;

  RETURN to_jsonb(v_del);
END;
$$;

GRANT EXECUTE ON FUNCTION public.manager_update_delivery_status(uuid, text, text) TO authenticated, service_role;

-- 7. RPC: Manager cancels delivery
CREATE OR REPLACE FUNCTION public.manager_cancel_delivery(
  p_delivery_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_del public.pos_deliveries%rowtype;
BEGIN
  SELECT * INTO v_del FROM public.pos_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dostavka yozuvi topilmadi' USING errcode = 'P0002';
  END IF;

  IF NOT public.current_user_active() OR NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], v_del.branch_id)
  ) THEN
    RAISE EXCEPTION 'Ruxsat yo‘q' USING errcode = '42501';
  END IF;

  UPDATE public.pos_deliveries
  SET delivery_status = 'cancelled',
      cancel_reason = trim(p_reason),
      cancelled_at = now(),
      updated_at = now()
  WHERE id = p_delivery_id
  RETURNING * INTO v_del;

  RETURN to_jsonb(v_del);
END;
$$;

GRANT EXECUTE ON FUNCTION public.manager_cancel_delivery(uuid, text) TO authenticated, service_role;
