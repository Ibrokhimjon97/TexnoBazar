-- POS enhancements:
-- 1) get_pos_unit_context: full pricing (UZS+USD), store/warehouse stock, other-branch stock, storefront link.
-- 2) create_pos_pending_sale: accept optional customer info + soft (non-blocking) below-minimum warning already
--    enforced client-side; server keeps hard floor at zero but allows below minimum_sale_price with an explicit flag.
-- 3) pos_relocate_units: seller-initiated store<->warehouse relocation within the same branch, bulk-capable.

-- ---------------------------------------------------------------------------
-- 1) Rich unit context for the seller scanner UI
-- ---------------------------------------------------------------------------
create or replace function public.get_pos_unit_context(p_branch_id uuid, p_code text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_code text := nullif(btrim(p_code), '');
  v_unit record;
  v_rate numeric;
  v_result jsonb;
begin
  perform public.require_pos_seller(p_branch_id);
  if v_code is null then
    raise exception 'QR, seriya, shtrix-kod yoki SKU talab qilinadi' using errcode = '22023';
  end if;

  select
    u.id, u.qr_code, u.serial_number, u.status, u.location_id,
    p.id as product_id, p.name as product_name, p.sku, p.barcode, p.slug, p.is_published,
    br.name as brand_name,
    p.retail_price, p.wholesale_price, p.minimum_sale_price, p.tax_rate,
    coalesce(sb.unit_cost, p.cost_price) as unit_cost,
    l.name as location_name, l.type as location_type,
    (select m.public_url from public.product_media m where m.product_id = p.id order by m.is_primary desc, m.sort_order limit 1) as image
  into v_unit
  from public.inventory_units u
  join public.products p on p.id = u.product_id
  join public.locations l on l.id = u.location_id
  left join public.brands br on br.id = p.brand_id
  left join public.stock_batches sb on sb.id = u.batch_id
  where l.branch_id = p_branch_id and l.type = 'store' and l.is_active and p.status = 'active'
    and u.status = 'available' and u.active_transfer_id is null
    and (upper(u.qr_code) = upper(v_code) or upper(coalesce(u.serial_number, '')) = upper(v_code)
      or upper(coalesce(p.barcode, '')) = upper(v_code) or upper(p.sku) = upper(v_code))
  order by case when upper(u.qr_code) = upper(v_code) then 0
                when upper(coalesce(u.serial_number, '')) = upper(v_code) then 1 else 2 end, u.id
  limit 1;

  if v_unit.id is null then
    raise exception 'Erkin POS mahsulot birligi topilmadi' using errcode = 'P0002';
  end if;

  select rate into v_rate from public.exchange_rates
  where currency_from = 'USD' and currency_to = 'UZS' order by rate_date desc limit 1;

  select jsonb_build_object(
    'id', v_unit.id,
    'qr_code', v_unit.qr_code,
    'serial_number', v_unit.serial_number,
    'status', v_unit.status,
    'location_id', v_unit.location_id,
    'location_name', v_unit.location_name,
    'location_type', v_unit.location_type,
    'product_id', v_unit.product_id,
    'product_name', v_unit.product_name,
    'sku', v_unit.sku,
    'barcode', v_unit.barcode,
    'brand_name', v_unit.brand_name,
    'image', v_unit.image,
    'storefront_url', case when v_unit.is_published and v_unit.slug is not null
      then '/product/' || v_unit.slug else null end,
    'exchange_rate', v_rate,
    'prices', jsonb_build_object(
      'retail_price_uzs', v_unit.retail_price,
      'retail_price_usd', case when v_rate > 0 then round(v_unit.retail_price / v_rate, 2) else null end,
      'wholesale_price_uzs', v_unit.wholesale_price,
      'wholesale_price_usd', case when v_rate > 0 and v_unit.wholesale_price is not null then round(v_unit.wholesale_price / v_rate, 2) else null end,
      'minimum_sale_price_uzs', v_unit.minimum_sale_price,
      'minimum_sale_price_usd', case when v_rate > 0 then round(v_unit.minimum_sale_price / v_rate, 2) else null end,
      'unit_cost_uzs', v_unit.unit_cost,
      'tax_rate', v_unit.tax_rate
    ),
    -- Stock in this branch, split by store vs warehouse
    'branch_stock', jsonb_build_object(
      'store', (select count(*) from public.inventory_units a join public.locations al on al.id = a.location_id
        where a.product_id = v_unit.product_id and al.branch_id = p_branch_id and al.type = 'store'
          and al.is_active and a.status = 'available' and a.active_transfer_id is null),
      'warehouse', (select count(*) from public.inventory_units a join public.locations al on al.id = a.location_id
        where a.product_id = v_unit.product_id and al.branch_id = p_branch_id and al.type = 'warehouse'
          and al.is_active and a.status = 'available' and a.active_transfer_id is null)
    ),
    -- Stock across other branches (management/report-level info shown read-only to the seller)
    'other_branches', coalesce((
      select jsonb_agg(jsonb_build_object('branch_id', b.id, 'branch_name', b.name, 'quantity', q.qty) order by q.qty desc)
      from (
        select al.branch_id, count(*) as qty
        from public.inventory_units a
        join public.locations al on al.id = a.location_id
        where a.product_id = v_unit.product_id and al.is_active and al.type in ('store', 'warehouse')
          and a.status = 'available' and a.active_transfer_id is null and al.branch_id <> p_branch_id
        group by al.branch_id
      ) q
      join public.branches b on b.id = q.branch_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end $$;

grant execute on function public.get_pos_unit_context(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) create_pos_pending_sale: add optional customer capture (name/phone/address).
--    Existing signature is preserved for compatibility; a new optional parameter
--    is appended so old callers keep working unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.create_pos_pending_sale(
  p_branch_id uuid, p_lines jsonb, p_payments jsonb, p_idempotency_key uuid,
  p_notes text default null, p_customer jsonb default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid:=gen_random_uuid(); v_existing public.pos_pending_sales%rowtype; v_item jsonb; v_u public.inventory_units%rowtype;
  v_p record; v_unit_id uuid; v_price numeric(18,2); v_discount numeric(18,2); v_tax numeric(18,2); v_line_total numeric(18,2);
  v_subtotal numeric(18,2):=0; v_discount_total numeric(18,2):=0; v_tax_total numeric(18,2):=0;
  v_total numeric(18,2); v_paid numeric(18,2):=0; v_store uuid; v_method public.payment_methods%rowtype;
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
    if v_p.branch_id<>p_branch_id or v_p.location_type<>'store' or not v_p.location_active or v_u.status<>'available'
      or v_u.active_transfer_id is not null then raise exception 'Mahsulot POS uchun erkin emas: %',v_unit_id using errcode='P0001'; end if;
    if v_p.status<>'active' then raise exception 'Mahsulot faol emas: %',v_unit_id using errcode='P0001'; end if;
    if v_store is null then v_store=v_u.location_id; elsif v_store<>v_u.location_id then
      raise exception 'Barcha mahsulotlar bitta do‘kondan bo‘lishi kerak' using errcode='22023'; end if;
    -- Price bounds: still must be positive and not absurdly above list price.
    if v_price is null or v_discount is null or v_price<=0 or v_price>v_p.retail_price*2 then
      raise exception 'Sotuv narxi ruxsat etilgan chegaradan tashqarida' using errcode='22023'; end if;
    -- Below-minimum sales are now ALLOWED (per business decision): the seller UI warns but the
    -- server no longer hard-blocks a final price under minimum_sale_price. The seller-only
    -- discretionary discount cap still applies to protect against runaway markdowns.
    if v_discount<0 or v_discount>v_price
      or (v_is_seller and v_discount>round(v_price*0.20,2)) then
      raise exception 'Chegirma ruxsat etilgan chegaradan oshdi' using errcode='22023'; end if;
    v_tax=round((v_price-v_discount)*v_p.tax_rate/100,2); v_line_total=v_price-v_discount+v_tax;
    v_subtotal=v_subtotal+v_price; v_discount_total=v_discount_total+v_discount; v_tax_total=v_tax_total+v_tax;
  end loop;
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
      quantity,reference_type,reference_id,actor_id) values(v_u.id,v_u.product_id,v_u.batch_id,'reserved',v_store,v_store,1,'pos_pending_sale',v_id,auth.uid());
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

grant execute on function public.create_pos_pending_sale(uuid, jsonb, jsonb, uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) pos_relocate_units: seller moves one or many units between the branch's
--    store and warehouse locations (either direction). Bulk-capable like
--    place_inventory_units, but scoped to require_pos_seller (not the
--    stricter inventory-operator role) since sellers routinely stage stock.
-- ---------------------------------------------------------------------------
create or replace function public.pos_relocate_units(p_branch_id uuid, p_codes jsonb, p_direction text, p_request_id uuid default gen_random_uuid())
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_target_type public.location_type;
  v_target_location uuid;
  v_code text;
  v_unit record;
  v_count integer := 0;
begin
  perform public.require_pos_seller(p_branch_id);
  if p_direction not in ('to_store', 'to_warehouse') then
    raise exception 'Yo‘nalish noto‘g‘ri' using errcode = '22023';
  end if;
  if jsonb_typeof(p_codes) <> 'array' or jsonb_array_length(p_codes) = 0 or jsonb_array_length(p_codes) > 200 then
    raise exception 'QR ro‘yxati noto‘g‘ri' using errcode = '22023';
  end if;

  v_target_type := case when p_direction = 'to_store' then 'store'::public.location_type else 'warehouse'::public.location_type end;
  select id into v_target_location from public.locations
    where branch_id = p_branch_id and type = v_target_type and is_active
    order by created_at limit 1;
  if v_target_location is null then
    raise exception 'Maqsad joylashuvi topilmadi' using errcode = 'P0002';
  end if;

  for v_code in select distinct btrim(value #>> '{}') from jsonb_array_elements(p_codes) loop
    select u.*, l.branch_id, l.type as location_type into v_unit
    from public.inventory_units u join public.locations l on l.id = u.location_id
    where (upper(u.qr_code) = upper(v_code) or upper(coalesce(u.serial_number, '')) = upper(v_code))
    for update of u;
    if not found then
      raise exception 'Kod topilmadi: %', v_code;
    end if;
    if v_unit.branch_id <> p_branch_id then
      raise exception 'Mahsulot boshqa filialga tegishli: %', v_code;
    end if;
    if v_unit.status <> 'available' or v_unit.active_transfer_id is not null then
      raise exception 'Mahsulot ko‘chirish uchun mavjud emas: %', v_code;
    end if;
    if v_unit.location_type not in ('store', 'warehouse') then
      raise exception 'Mahsulot joylashuvi ko‘chirish uchun yaroqsiz: %', v_code;
    end if;
    if v_unit.location_id <> v_target_location then
      update public.inventory_units set location_id = v_target_location, version = version + 1 where id = v_unit.id;
      insert into public.inventory_movements(unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
        quantity, unit_cost, reference_type, reference_id, actor_id, metadata)
      values(v_unit.id, v_unit.product_id, v_unit.batch_id, 'adjustment', v_unit.location_id, v_target_location, 1, null,
        'pos_relocation', p_request_id, auth.uid(), jsonb_build_object('direction', p_direction));
    end if;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('relocated_count', v_count, 'target_location_id', v_target_location, 'direction', p_direction);
end $$;

grant execute on function public.pos_relocate_units(uuid, jsonb, text, uuid) to authenticated;
