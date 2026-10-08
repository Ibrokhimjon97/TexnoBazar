-- Online orders must carry the chosen color variant per line (price, stock and later
-- fulfillment all depend on it), and reservation must pull inventory_units matching
-- that exact variant (or the product's "no variant" bucket when the line has none).
begin;

create or replace function public.create_online_order(p_customer jsonb,p_shipping_address jsonb,p_lines jsonb,p_payment_method_code text,p_idempotency_key text default null,p_notes text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_order uuid:=gen_random_uuid(); v_line jsonb; v_product record; v_variant record; v_variant_id uuid; v_sale_price numeric(18,2); v_subtotal numeric(18,2):=0; v_qty integer; v_method uuid; v_existing public.orders%rowtype; v_hash text; v_customer_id uuid;
begin
  if nullif(btrim(p_idempotency_key),'') is null or jsonb_typeof(p_customer)<>'object' or jsonb_typeof(p_shipping_address)<>'object'
    or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'Buyurtma payload yoki idempotency key noto‘g‘ri' using errcode='22023'; end if;
  if nullif(btrim(p_customer->>'name'),'') is null or nullif(btrim(p_customer->>'phone'),'') is null then raise exception 'Mijoz ismi va telefoni talab qilinadi' using errcode='22023'; end if;
  select id into v_method from public.payment_methods where code=lower(btrim(p_payment_method_code)) and is_active and (is_online or is_cash or code='cod');
  if v_method is null then raise exception 'Faol to‘lov usuli topilmadi' using errcode='P0002'; end if;
  begin
    if exists(select 1 from jsonb_array_elements(p_lines)e where (e->>'quantity')::numeric<>trunc((e->>'quantity')::numeric)
      or (e->>'quantity')::integer not between 1 and 100) then raise exception 'Online buyurtma miqdori 1..100 butun son bo‘lishi kerak' using errcode='22023'; end if;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Buyurtma miqdori noto‘g‘ri' using errcode='22023'; end;
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('customer',p_customer,'shipping_address',p_shipping_address,
    'lines',(select jsonb_agg(jsonb_build_object('product_id',(e->>'product_id')::uuid,'variant_id',nullif(e->>'variant_id','')::uuid,'quantity',(e->>'quantity')::integer)
      order by (e->>'product_id')::uuid,nullif(e->>'variant_id','')::uuid) from jsonb_array_elements(p_lines)e),'payment_method_code',lower(btrim(p_payment_method_code)),
    'notes',nullif(btrim(p_notes),''))::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.orders where idempotency_key=p_idempotency_key;
  if found then if v_existing.request_hash is distinct from v_hash or v_existing.customer_user_id is distinct from auth.uid() then raise exception 'Takroriy kalit boshqa buyurtmaga tegishli' using errcode='22023'; end if; return v_existing.id; end if;
  if auth.uid() is not null then select id into v_customer_id from public.customers where auth_user_id=auth.uid(); end if;
  insert into public.orders(id,order_no,customer_id,customer_user_id,status,customer_name,customer_phone,customer_email,
    shipping_address,notes,subtotal,total,payment_method_id,idempotency_key,request_hash)
  values(v_order,'ORD-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_order::text,1,8)),v_customer_id,
    auth.uid(),'new',btrim(p_customer->>'name'),btrim(p_customer->>'phone'),nullif(btrim(p_customer->>'email'),'')::extensions.citext,
    p_shipping_address,nullif(btrim(p_notes),''),0,0,v_method,p_idempotency_key,v_hash);
  for v_line in select value from jsonb_array_elements(p_lines) order by (value->>'product_id')::uuid,nullif(value->>'variant_id','')::uuid loop
    v_qty=(v_line->>'quantity')::integer;
    v_variant_id=nullif(v_line->>'variant_id','')::uuid;
    select id,name,sku,coalesce(promotion_price,retail_price) sale_price into v_product from public.products
      where id=(v_line->>'product_id')::uuid and status='active' and is_published for share;
    if not found then raise exception 'Mahsulot mavjud emas' using errcode='P0002'; end if;
    v_sale_price:=v_product.sale_price;
    if v_variant_id is not null then
      select id,color_name,coalesce(promotion_price,retail_price) sale_price into v_variant from public.product_variants
        where id=v_variant_id and product_id=v_product.id and is_active for share;
      if not found then raise exception 'Rang varianti mavjud emas' using errcode='P0002'; end if;
      if v_variant.sale_price is not null then v_sale_price:=v_variant.sale_price; end if;
    end if;
    insert into public.order_lines(order_id,product_id,variant_id,product_name,sku,variant_color,quantity,unit_price,discount,line_total)
    values(v_order,v_product.id,v_variant_id,v_product.name,v_product.sku,v_variant.color_name,v_qty,v_sale_price,0,round(v_qty*v_sale_price,2));
    v_subtotal=v_subtotal+round(v_qty*v_sale_price,2);
  end loop;
  update public.orders set subtotal=v_subtotal,total=v_subtotal where id=v_order;
  insert into public.order_status_history(order_id,to_status,note,actor_id) values(v_order,'new','Online buyurtma yaratildi',auth.uid());
  perform public.enqueue_order_notification(v_order,'Buyurtma qabul qilindi','Buyurtmangiz qabul qilindi',jsonb_build_object('status','new'));
  return v_order;
exception when unique_violation then
  select * into v_existing from public.orders where idempotency_key=p_idempotency_key;
  if found and v_existing.request_hash=v_hash and v_existing.customer_user_id is not distinct from auth.uid() then return v_existing.id; end if; raise;
end $$;

create or replace function public.reserve_online_order_units(p_order_id uuid,p_branch_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare v_o public.orders%rowtype; v_line record; v_u record; v_needed integer; v_count integer:=0;
begin
  select * into v_o from public.orders where id=p_order_id for update;
  if not found then raise exception 'Buyurtma topilmadi' using errcode='P0002'; end if;
  if not(public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager','warehouse']::public.app_role[],p_branch_id)) then raise exception 'Filial menejeri yoki omborchi roli talab qilinadi' using errcode='42501'; end if;
  if not exists(select 1 from public.branches where id=p_branch_id and is_active) then raise exception 'Faol filial topilmadi' using errcode='P0002'; end if;
  if v_o.branch_id is not null and v_o.branch_id<>p_branch_id then raise exception 'Buyurtma boshqa filialga biriktirilgan' using errcode='P0001'; end if;
  if v_o.status not in('new','confirmed') then raise exception 'Buyurtma rezerv uchun mos holatda emas' using errcode='P0001'; end if;
  if exists(select 1 from public.order_reserved_units where order_id=p_order_id and released_at is null and fulfilled_at is null) then
    if exists(select 1 from public.order_lines ol where ol.order_id=p_order_id and
      (select count(*) from public.order_reserved_units r where r.order_id=p_order_id and r.order_line_id=ol.id and r.released_at is null and r.fulfilled_at is null)<>ol.quantity)
      or exists(select 1 from public.order_reserved_units r where r.order_id=p_order_id and r.released_at is null and r.fulfilled_at is null
        and not exists(select 1 from public.order_lines ol where ol.id=r.order_line_id and ol.order_id=p_order_id)) then
      raise exception 'Buyurtma rezervlari to‘liq emas; qo‘lda tekshiruv talab qilinadi' using errcode='P0001';
    end if;
    return (select count(*) from public.order_reserved_units where order_id=p_order_id and released_at is null and fulfilled_at is null); end if;
  for v_line in select * from public.order_lines where order_id=p_order_id order by product_id,variant_id,id loop
    if v_line.quantity<>trunc(v_line.quantity) then raise exception 'Individual birlik modeli butun miqdor talab qiladi' using errcode='23514'; end if;
    v_needed=v_line.quantity::integer;
    perform 1 from public.inventory_units u join public.locations l on l.id=u.location_id
      where u.product_id=v_line.product_id and u.variant_id is not distinct from v_line.variant_id and l.branch_id=p_branch_id and l.is_active and l.type in('store','warehouse')
        and u.status='available' and u.active_transfer_id is null
      order by u.id limit v_needed for update of u;
    if (select count(*) from public.inventory_units u join public.locations l on l.id=u.location_id
      where u.product_id=v_line.product_id and u.variant_id is not distinct from v_line.variant_id and l.branch_id=p_branch_id and l.is_active and l.type in('store','warehouse')
        and u.status='available' and u.active_transfer_id is null)<v_needed then raise exception 'Mahsulot zaxirasi yetarli emas: %',v_line.product_id using errcode='P0001'; end if;
    for v_u in select u.* from public.inventory_units u join public.locations l on l.id=u.location_id
      where u.product_id=v_line.product_id and u.variant_id is not distinct from v_line.variant_id and l.branch_id=p_branch_id and l.is_active and l.type in('store','warehouse')
        and u.status='available' and u.active_transfer_id is null order by u.id limit v_needed loop
      insert into public.order_reserved_units(order_id,order_line_id,unit_id,reserved_by) values(p_order_id,v_line.id,v_u.id,auth.uid());
      update public.inventory_units set status='reserved',reserved_until=null,version=version+1 where id=v_u.id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,
        reference_type,reference_id,actor_id) values(v_u.id,v_u.product_id,v_u.batch_id,'reserved',v_u.location_id,v_u.location_id,1,'online_order',p_order_id,auth.uid()) on conflict do nothing;
      v_count=v_count+1;
    end loop;
  end loop;
  update public.orders set branch_id=p_branch_id where id=p_order_id and branch_id is null;
  return v_count;
end $$;

notify pgrst, 'reload schema';

commit;
