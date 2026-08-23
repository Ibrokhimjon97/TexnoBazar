begin;

-- 1) Sellers may now sell units that still sit in the branch warehouse.
--    Units must belong to the seller's own branch and be free; cross-branch
--    units stay forbidden. Mixed store/warehouse baskets are allowed.
create or replace function public.create_pos_pending_sale(
  p_branch_id uuid, p_lines jsonb, p_payments jsonb, p_idempotency_key uuid,
  p_notes text default null, p_customer jsonb default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid:=gen_random_uuid(); v_existing public.pos_pending_sales%rowtype; v_item jsonb; v_u public.inventory_units%rowtype;
  v_p record; v_unit_id uuid; v_price numeric(18,2); v_discount numeric(18,2); v_tax numeric(18,2); v_line_total numeric(18,2);
  v_subtotal numeric(18,2):=0; v_discount_total numeric(18,2):=0; v_tax_total numeric(18,2):=0;
  v_total numeric(18,2); v_paid numeric(18,2):=0; v_store uuid; v_first_location uuid; v_method public.payment_methods%rowtype;
  v_norm_lines jsonb; v_norm_payments jsonb; v_hash text; v_minutes integer:=15; v_sort integer:=0; v_is_seller boolean;
  v_customer_id uuid; v_customer_name text; v_customer_phone text; v_customer_address text;
begin
  perform public.require_pos_seller(p_branch_id);
  if p_idempotency_key is null or p_lines is null or jsonb_typeof(p_lines)<>'array'
    or jsonb_array_length(p_lines) not between 1 and 50 or p_payments is null or jsonb_typeof(p_payments)<>'array'
    or jsonb_array_length(p_payments) not between 1 and 10 then
    raise exception 'POS qatorlari yoki to‘lovlari noto‘g‘ri' using errcode='22023'; end if;
  begin
    select jsonb_agg(jsonb_build_object('unit_id',q.unit_id::text,'unit_price',q.unit_price,'discount',q.discount) order by q.unit_id)
      into v_norm_lines from(select (e->>'unit_id')::uuid unit_id,(e->>'unit_price')::numeric(18,2) unit_price,
        coalesce((e->>'discount')::numeric(18,2),0) discount from jsonb_array_elements(p_lines)e)q;
    select jsonb_agg(jsonb_build_object('method_code',q.method_code,'amount',q.amount,'external_reference',q.external_reference)
      order by q.method_code,q.amount,q.external_reference nulls first)
      into v_norm_payments from(select lower(btrim(e->>'method_code')) method_code,(e->>'amount')::numeric(18,2) amount,
        nullif(btrim(e->>'external_reference'),'') external_reference from jsonb_array_elements(p_payments)e)q;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'POS identifikatori yoki summasi noto‘g‘ri' using errcode='22023'; end;
  if exists(select 1 from jsonb_array_elements(p_lines)e group by (e->>'unit_id')::uuid having count(*)>1) then
    raise exception 'Mahsulot birliklari takrorlanmasligi kerak' using errcode='22023'; end if;

  -- Optional customer capture: never blocks the sale, purely informational.
  v_customer_name := nullif(btrim(p_customer->>'full_name'), '');
  v_customer_phone := nullif(btrim(p_customer->>'phone'), '');
  v_customer_address := nullif(btrim(p_customer->>'address'), '');
  if v_customer_phone is not null then
    select id into v_customer_id from public.customers where phone = v_customer_phone;
    if v_customer_id is null then
      insert into public.customers(full_name, phone, address)
      values(coalesce(v_customer_name, v_customer_phone), v_customer_phone,
        case when v_customer_address is not null then jsonb_build_object('address', v_customer_address) else '{}'::jsonb end)
      returning id into v_customer_id;
    elsif v_customer_name is not null or v_customer_address is not null then
      update public.customers set
        full_name = coalesce(v_customer_name, full_name),
        address = case when v_customer_address is not null then jsonb_build_object('address', v_customer_address) else address end,
        updated_at = now()
      where id = v_customer_id;
    end if;
  end if;

  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('branch_id',p_branch_id::text,'notes',nullif(btrim(p_notes),''),
    'lines',v_norm_lines,'payments',v_norm_payments,'customer_phone',v_customer_phone)::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.pos_pending_sales where seller_id=auth.uid() and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa POS mazmuni bilan yuborildi' using errcode='22023'; end if;
    return public.get_pos_pending_sale(v_existing.id);
  end if;
  perform 1 from public.inventory_units u where u.id in(select (e->>'unit_id')::uuid from jsonb_array_elements(p_lines)e)
    order by u.id for update;
  v_is_seller=public.has_role(array['seller']::public.app_role[],p_branch_id)
    and not(public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager']::public.app_role[],p_branch_id));
  for v_item in select value from jsonb_array_elements(p_lines) order by (value->>'unit_id')::uuid loop
    v_unit_id=(v_item->>'unit_id')::uuid; v_price=(v_item->>'unit_price')::numeric(18,2);
    v_discount=coalesce((v_item->>'discount')::numeric(18,2),0);
    select * into v_u from public.inventory_units where id=v_unit_id;
    if not found then raise exception 'Mahsulot birligi topilmadi: %',v_unit_id using errcode='P0002'; end if;
    select p.*,l.branch_id,l.type location_type,l.is_active location_active into v_p from public.products p
      join public.locations l on l.id=v_u.location_id where p.id=v_u.product_id;
    -- Store and warehouse units of the seller's own branch are both sellable.
    if v_p.branch_id<>p_branch_id or v_p.location_type not in ('store','warehouse') or not v_p.location_active
      or v_u.status<>'available' or v_u.active_transfer_id is not null then
      raise exception 'Mahsulot POS uchun erkin emas: %',v_unit_id using errcode='P0001'; end if;
    if v_p.status<>'active' then raise exception 'Mahsulot faol emas: %',v_unit_id using errcode='P0001'; end if;
    if v_first_location is null then v_first_location=v_u.location_id; end if;
    if v_store is null and v_p.location_type='store' then v_store=v_u.location_id; end if;
    -- Price bounds: still must be positive and not absurdly above list price.
    if v_price is null or v_discount is null or v_price<=0 or v_price>v_p.retail_price*2 then
      raise exception 'Sotuv narxi ruxsat etilgan chegaradan tashqarida' using errcode='22023'; end if;
    -- Below-minimum sales stay allowed; the seller-only discount cap still applies.
    if v_discount<0 or v_discount>v_price
      or (v_is_seller and v_discount>round(v_price*0.20,2)) then
      raise exception 'Chegirma ruxsat etilgan chegaradan oshdi' using errcode='22023'; end if;
    v_tax=round((v_price-v_discount)*v_p.tax_rate/100,2); v_line_total=v_price-v_discount+v_tax;
    v_subtotal=v_subtotal+v_price; v_discount_total=v_discount_total+v_discount; v_tax_total=v_tax_total+v_tax;
  end loop;
  -- Reference location for the queued sale: prefer a store location of the branch.
  if v_store is null then
    select id into v_store from public.locations
      where branch_id=p_branch_id and type='store' and is_active order by created_at limit 1;
  end if;
  v_store=coalesce(v_store,v_first_location);
  if v_store is null then raise exception 'POS joylashuvi topilmadi' using errcode='P0002'; end if;
  v_total=v_subtotal-v_discount_total+v_tax_total;
  if v_total<=0 then raise exception 'POS jami summasi musbat bo‘lishi kerak' using errcode='22023'; end if;
  for v_item in select value from jsonb_array_elements(p_payments) loop
    select * into v_method from public.payment_methods where code=lower(btrim(v_item->>'method_code')) and is_active and code<>'cod';
    if not found or nullif(btrim(v_item->>'method_code'),'') is null or (v_item->>'amount') is null
      or (v_item->>'amount')::numeric<=0 then
      raise exception 'Faol POS to‘lov usuli yoki summa noto‘g‘ri' using errcode='22023'; end if;
    v_paid=v_paid+(v_item->>'amount')::numeric(18,2);
  end loop;
  if v_paid<>v_total then raise exception 'To‘lovlar jami sotuv summasiga teng emas' using errcode='22023'; end if;
  begin select greatest(1,least(120,(value#>>'{}')::integer)) into v_minutes from public.system_settings where key='pos.reservation_minutes';
  exception when others then v_minutes:=15; end;
  insert into public.pos_pending_sales(id,pending_no,branch_id,store_location_id,seller_id,customer_id,status,subtotal,discount,tax,total,
    expires_at,idempotency_key,request_hash,notes)
  values(v_id,'POS-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8)),p_branch_id,v_store,
    auth.uid(),v_customer_id,'pending',v_subtotal,v_discount_total,v_tax_total,v_total,now()+make_interval(mins=>v_minutes),p_idempotency_key,v_hash,nullif(btrim(p_notes),''));
  for v_item in select value from jsonb_array_elements(p_lines) order by (value->>'unit_id')::uuid loop
    v_unit_id=(v_item->>'unit_id')::uuid; v_price=(v_item->>'unit_price')::numeric(18,2); v_discount=coalesce((v_item->>'discount')::numeric(18,2),0);
    select * into v_u from public.inventory_units where id=v_unit_id;
    v_tax=round((v_price-v_discount)*(select tax_rate from public.products where id=v_u.product_id)/100,2);
    insert into public.pos_pending_sale_lines(pending_sale_id,product_id,unit_id,unit_price,discount,tax,line_total)
      values(v_id,v_u.product_id,v_u.id,v_price,v_discount,v_tax,v_price-v_discount+v_tax);
    update public.inventory_units set status='reserved',reserved_until=now()+make_interval(mins=>v_minutes),version=version+1 where id=v_u.id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,
      quantity,reference_type,reference_id,actor_id) values(v_u.id,v_u.product_id,v_u.batch_id,'reserved',v_u.location_id,v_u.location_id,1,'pos_pending_sale',v_id,auth.uid());
  end loop;
  for v_item in select value from jsonb_array_elements(p_payments) loop
    v_sort=v_sort+1; select * into v_method from public.payment_methods where code=lower(btrim(v_item->>'method_code'));
    insert into public.pos_pending_sale_payments(pending_sale_id,payment_method_id,amount,external_reference,sort_order)
      values(v_id,v_method.id,(v_item->>'amount')::numeric(18,2),nullif(btrim(v_item->>'external_reference'),''),v_sort);
  end loop;
  return public.get_pos_pending_sale(v_id);
exception when unique_violation then
  select * into v_existing from public.pos_pending_sales where seller_id=auth.uid() and idempotency_key=p_idempotency_key;
  if found and v_existing.request_hash=v_hash then return public.get_pos_pending_sale(v_existing.id); end if;
  if found then raise exception 'Takroriy kalit boshqa POS mazmuni bilan yuborildi' using errcode='22023'; end if;
  raise;
end $$;

-- 2) Confirmation must accept reserved units from any active store/warehouse
--    location of the sale's own branch instead of one fixed store location.
create or replace function public.manager_confirm_sale(p_pending_sale_id uuid,p_payments jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_s public.pos_pending_sales%rowtype; v_sale uuid; v_x record; v_item jsonb; v_method public.payment_methods%rowtype;
  v_paid numeric(18,2):=0; v_count integer:=0;
begin
  select * into v_s from public.pos_pending_sales where id=p_pending_sale_id for update;
  if not found then raise exception 'POS so‘rovi topilmadi' using errcode='P0002'; end if;
  perform public.require_pos_manager(v_s.branch_id);
  if v_s.status='confirmed' then
    select id into v_sale from public.sales where pending_sale_id=v_s.id;
    if v_sale is null then raise exception 'Tasdiqlangan POS so‘rovi uchun sotuv topilmadi' using errcode='P0001'; end if;
    return v_sale;
  end if;
  if v_s.status<>'pending' then raise exception 'Faqat kutilayotgan POS so‘rovi tasdiqlanadi' using errcode='P0001'; end if;
  if v_s.expires_at<=now() then
    perform public.release_pos_reservation(v_s.id,'expired','Rezerv muddati tugadi',auth.uid());
    return null;
  end if;
  perform 1 from public.inventory_units u join public.pos_pending_sale_lines x on x.unit_id=u.id
    where x.pending_sale_id=v_s.id order by u.id for update of u;
  if exists(select 1 from public.inventory_units u
    join public.pos_pending_sale_lines x on x.unit_id=u.id
    join public.locations l on l.id=u.location_id
    where x.pending_sale_id=v_s.id and (u.status<>'reserved' or u.reserved_until<=now() or u.sold_sale_id is not null
      or u.active_transfer_id is not null or l.branch_id<>v_s.branch_id or not l.is_active
      or l.type not in ('store','warehouse'))) then
    raise exception 'Rezervdagi mahsulot holati buzilgan' using errcode='P0001'; end if;
  if p_payments is null then
    select count(*),coalesce(sum(amount),0) into v_count,v_paid from public.pos_pending_sale_payments where pending_sale_id=v_s.id;
  else
    if jsonb_typeof(p_payments)<>'array' or jsonb_array_length(p_payments) not between 1 and 10 then
      raise exception 'To‘lovlar ro‘yxati noto‘g‘ri' using errcode='22023'; end if;
    for v_item in select value from jsonb_array_elements(p_payments) loop
      select * into v_method from public.payment_methods where code=lower(btrim(v_item->>'method_code')) and is_active and code<>'cod';
      if not found or (v_item->>'amount') is null or (v_item->>'amount')::numeric<=0 then
        raise exception 'POS to‘lov usuli yoki summasi noto‘g‘ri' using errcode='22023'; end if;
      v_paid=v_paid+(v_item->>'amount')::numeric(18,2); v_count=v_count+1;
    end loop;
  end if;
  if v_count not between 1 and 10 or v_paid<>v_s.total then raise exception 'To‘lovlar jami sotuv summasiga teng emas' using errcode='22023'; end if;
  v_sale=gen_random_uuid();
  insert into public.sales(id,sale_no,branch_id,seller_id,manager_id,customer_id,pending_sale_id,status,subtotal,discount,tax,total)
  values(v_sale,'SAL-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_sale::text,1,8)),v_s.branch_id,
    v_s.seller_id,auth.uid(),v_s.customer_id,v_s.id,'completed',v_s.subtotal,v_s.discount,v_s.tax,v_s.total);
  perform set_config('texnobazar.manager_confirm_sale','allowed',true);
  for v_x in select x.*,u.batch_id,u.location_id,coalesce(sb.unit_cost,p.cost_price) unit_cost
    from public.pos_pending_sale_lines x join public.inventory_units u on u.id=x.unit_id
    join public.products p on p.id=x.product_id left join public.stock_batches sb on sb.id=u.batch_id
    where x.pending_sale_id=v_s.id order by u.id loop
    insert into public.sale_lines(sale_id,product_id,unit_id,quantity,unit_cost,unit_price,discount,tax,line_total)
      values(v_sale,v_x.product_id,v_x.unit_id,1,v_x.unit_cost,v_x.unit_price,v_x.discount,v_x.tax,v_x.line_total);
    update public.inventory_units set status='sold',sold_sale_id=v_sale,reserved_until=null,version=version+1 where id=v_x.unit_id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,quantity,unit_cost,
      reference_type,reference_id,actor_id) values(v_x.unit_id,v_x.product_id,v_x.batch_id,'sold',v_x.location_id,1,
      v_x.unit_cost,'sale',v_sale,auth.uid());
  end loop;
  perform set_config('texnobazar.manager_confirm_sale','',true);
  if p_payments is null then
    insert into public.sale_payments(sale_id,payment_method_id,amount,status,external_reference,received_by)
      select v_sale,payment_method_id,amount,'paid',external_reference,auth.uid() from public.pos_pending_sale_payments
      where pending_sale_id=v_s.id order by sort_order;
  else
    for v_item in select value from jsonb_array_elements(p_payments) loop
      select * into v_method from public.payment_methods where code=lower(btrim(v_item->>'method_code'));
      insert into public.sale_payments(sale_id,payment_method_id,amount,status,external_reference,received_by)
      values(v_sale,v_method.id,(v_item->>'amount')::numeric(18,2),'paid',nullif(btrim(v_item->>'external_reference'),''),auth.uid());
    end loop;
  end if;
  update public.pos_pending_sales set status='confirmed',confirmed_by=auth.uid(),confirmed_at=now() where id=v_s.id;
  return v_sale;
exception when unique_violation then
  select id into v_sale from public.sales where pending_sale_id=p_pending_sale_id;
  if v_sale is not null then return v_sale; end if; raise;
end $$;

-- 3) Read-only availability of one product across every active branch so the
--    seller can tell a customer where the remaining stock is.
create or replace function public.get_pos_product_availability(p_branch_id uuid, p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_product record; v_branches jsonb; v_result jsonb;
begin
  perform public.require_pos_seller(p_branch_id);
  select p.id, p.name, p.sku, p.status
    into v_product
  from public.products p
  where p.id = p_product_id;
  if v_product.id is null then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'branch_id', q.branch_id,
      'branch_name', q.branch_name,
      'branch_code', q.branch_code,
      'is_current_branch', q.branch_id = p_branch_id,
      'store', q.store,
      'warehouse', q.warehouse,
      'total', q.store + q.warehouse
    ) order by (q.branch_id = p_branch_id) desc, q.store + q.warehouse desc, q.branch_name), '[]'::jsonb)
    into v_branches
  from (
    select b.id as branch_id, b.name as branch_name, b.code as branch_code,
      count(*) filter (where l.type = 'store') as store,
      count(*) filter (where l.type = 'warehouse') as warehouse
    from public.inventory_units u
    join public.locations l on l.id = u.location_id
    join public.branches b on b.id = l.branch_id and b.is_active
    where u.product_id = p_product_id
      and u.status = 'available'
      and u.active_transfer_id is null
      and l.is_active
      and l.type in ('store', 'warehouse')
    group by b.id, b.name, b.code
  ) q;

  select jsonb_build_object(
    'product_id', v_product.id,
    'product_name', v_product.name,
    'sku', v_product.sku,
    'product_status', v_product.status,
    'requested_branch_id', p_branch_id,
    'branches', v_branches,
    'current_branch_total', coalesce((
      select (item->>'total')::integer from jsonb_array_elements(v_branches) item
      where (item->>'branch_id')::uuid = p_branch_id limit 1), 0),
    'total_available', coalesce((
      select sum((item->>'total')::integer) from jsonb_array_elements(v_branches) item), 0)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_pos_product_availability(uuid, uuid) from public, anon;
grant execute on function public.get_pos_product_availability(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
