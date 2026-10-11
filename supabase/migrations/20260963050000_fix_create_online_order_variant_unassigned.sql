-- Migration: 20260963050000_fix_create_online_order_variant_unassigned.sql
-- Fix unassigned v_variant record when online order line does not specify a variant

CREATE OR REPLACE FUNCTION public.create_online_order(
  p_customer jsonb,
  p_shipping_address jsonb,
  p_lines jsonb,
  p_payment_method_code text,
  p_idempotency_key text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order uuid := gen_random_uuid();
  v_line jsonb;
  v_product record;
  v_variant record;
  v_variant_id uuid;
  v_color text;
  v_sale_price numeric(18,2);
  v_subtotal numeric(18,2) := 0;
  v_qty integer;
  v_method uuid;
  v_existing public.orders%rowtype;
  v_hash text;
  v_customer_id uuid;
BEGIN
  IF nullif(btrim(p_idempotency_key),'') IS NULL OR jsonb_typeof(p_customer)<>'object' OR jsonb_typeof(p_shipping_address)<>'object'
    OR jsonb_typeof(p_lines)<>'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Buyurtma payload yoki idempotency key noto‘g‘ri' USING errcode='22023';
  END IF;

  IF nullif(btrim(p_customer->>'name'),'') IS NULL OR nullif(btrim(p_customer->>'phone'),'') IS NULL THEN
    RAISE EXCEPTION 'Mijoz ismi va telefoni talab qilinadi' USING errcode='22023';
  END IF;

  SELECT id INTO v_method FROM public.payment_methods WHERE code=lower(btrim(p_payment_method_code)) AND is_active AND (is_online OR is_cash OR code='cod');
  IF v_method IS NULL THEN
    RAISE EXCEPTION 'Faol to‘lov usuli topilmadi' USING errcode='P0002';
  END IF;

  BEGIN
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) e WHERE (e->>'quantity')::numeric <> trunc((e->>'quantity')::numeric)
      OR (e->>'quantity')::integer NOT BETWEEN 1 AND 100) THEN
      RAISE EXCEPTION 'Online buyurtma miqdori 1..100 butun son bo‘lishi kerak' USING errcode='22023';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Buyurtma miqdori noto‘g‘ri' USING errcode='22023';
  END;

  v_hash := encode(extensions.digest(convert_to(jsonb_build_object('customer',p_customer,'shipping_address',p_shipping_address,
    'lines',(SELECT jsonb_agg(jsonb_build_object('product_id',(e->>'product_id')::uuid,'variant_id',nullif(e->>'variant_id','')::uuid,'quantity',(e->>'quantity')::integer)
      ORDER BY (e->>'product_id')::uuid,nullif(e->>'variant_id','')::uuid) FROM jsonb_array_elements(p_lines) e),'payment_method_code',lower(btrim(p_payment_method_code)),
    'notes',nullif(btrim(p_notes),''))::text,'UTF8'),'sha256'),'hex');

  SELECT * INTO v_existing FROM public.orders WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_hash OR v_existing.customer_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Takroriy kalit boshqa buyurtmaga tegishli' USING errcode='22023';
    END IF;
    RETURN v_existing.id;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM public.customers WHERE auth_user_id=auth.uid();
  END IF;

  INSERT INTO public.orders(id,order_no,customer_id,customer_user_id,status,customer_name,customer_phone,customer_email,
    shipping_address,notes,subtotal,total,payment_method_id,idempotency_key,request_hash)
  VALUES(v_order,'ORD-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_order::text,1,8)),v_customer_id,
    auth.uid(),'new',btrim(p_customer->>'name'),btrim(p_customer->>'phone'),nullif(btrim(p_customer->>'email'),'')::extensions.citext,
    p_shipping_address,nullif(btrim(p_notes),''),0,0,v_method,p_idempotency_key,v_hash);

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) ORDER BY (value->>'product_id')::uuid,nullif(value->>'variant_id','')::uuid LOOP
    v_qty := (v_line->>'quantity')::integer;
    v_variant_id := nullif(v_line->>'variant_id','')::uuid;
    v_color := NULL;

    SELECT id,name,sku,coalesce(promotion_price,retail_price) sale_price INTO v_product FROM public.products
      WHERE id=(v_line->>'product_id')::uuid AND status='active' AND is_published FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mahsulot mavjud emas' USING errcode='P0002';
    END IF;

    v_sale_price := v_product.sale_price;

    IF v_variant_id IS NOT NULL THEN
      SELECT id,color_name,coalesce(promotion_price,retail_price) sale_price INTO v_variant FROM public.product_variants
        WHERE id=v_variant_id AND product_id=v_product.id AND is_active FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Rang varianti mavjud emas' USING errcode='P0002';
      END IF;
      IF v_variant.sale_price IS NOT NULL THEN
        v_sale_price := v_variant.sale_price;
      END IF;
      v_color := v_variant.color_name;
    END IF;

    INSERT INTO public.order_lines(order_id,product_id,variant_id,product_name,sku,variant_color,quantity,unit_price,discount,line_total)
    VALUES(v_order,v_product.id,v_variant_id,v_product.name,v_product.sku,v_color,v_qty,v_sale_price,0,round(v_qty*v_sale_price,2));

    v_subtotal := v_subtotal + round(v_qty*v_sale_price,2);
  END LOOP;

  UPDATE public.orders SET subtotal=v_subtotal,total=v_subtotal WHERE id=v_order;
  INSERT INTO public.order_status_history(order_id,to_status,note,actor_id) VALUES(v_order,'new','Online buyurtma yaratildi',auth.uid());
  PERFORM public.enqueue_order_notification(v_order,'Buyurtma qabul qilindi','Buyurtmangiz qabul qilindi',jsonb_build_object('status','new'));

  RETURN v_order;
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing FROM public.orders WHERE idempotency_key=p_idempotency_key;
  IF FOUND AND v_existing.request_hash=v_hash AND v_existing.customer_user_id IS NOT DISTINCT FROM auth.uid() THEN
    RETURN v_existing.id;
  END IF;
  RAISE;
END $$;
