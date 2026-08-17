begin;

-- Remove the unused uuid[] initializer flagged by plpgsql_check. The workflow
-- semantics are unchanged; duplicate unit IDs are validated by the set query.
create or replace function public.create_branch_transfer(p_header jsonb,p_lines jsonb,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid:=gen_random_uuid(); v_existing public.transfers%rowtype; v_from uuid; v_to uuid; v_fb uuid; v_tb uuid;
  v_currency text; v_notes text; v_item jsonb; v_uid uuid; v_price numeric(18,2);
  v_normalized jsonb; v_hash text; v_total numeric(18,2); v_unit public.inventory_units%rowtype;
begin
  if auth.uid() is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  if p_idempotency_key is null or jsonb_typeof(p_header)<>'object' or jsonb_typeof(p_lines)<>'array'
    or jsonb_array_length(p_lines) not between 1 and 500 then raise exception 'Transfer ma’lumotlari noto‘g‘ri' using errcode='22023'; end if;
  if p_header ? 'transfer_no' then raise exception 'Transfer raqamini mijoz yubora olmaydi' using errcode='22023'; end if;
  begin v_from=(p_header->>'from_location_id')::uuid; v_to=(p_header->>'to_location_id')::uuid;
  exception when invalid_text_representation then raise exception 'Joylashuv identifikatori noto‘g‘ri' using errcode='22023'; end;
  v_currency=upper(coalesce(nullif(btrim(p_header->>'currency'),''),'UZS')); v_notes=nullif(btrim(p_header->>'notes'),'');
  if v_currency !~ '^[A-Z]{3}$' then raise exception 'Valyuta kodi noto‘g‘ri' using errcode='22023'; end if;
  select branch_id into v_fb from public.locations where id=v_from and is_active and type in ('store','warehouse');
  select branch_id into v_tb from public.locations where id=v_to and is_active and type in ('store','warehouse');
  if v_fb is null or v_tb is null then raise exception 'Faol transfer joylashuvi topilmadi' using errcode='P0002'; end if;
  if v_fb=v_tb then raise exception 'Transfer boshqa filialga yuborilishi kerak' using errcode='23514'; end if;
  if not exists(select 1 from public.branches where id=v_fb and is_active)
    or not exists(select 1 from public.branches where id=v_tb and is_active) then raise exception 'Faol filial talab qilinadi' using errcode='23514'; end if;
  perform public.require_source_manager(v_fb);
  begin
    select jsonb_agg(jsonb_build_object('unit_id',q.unit_id::text,'unit_price',q.unit_price) order by q.unit_id),
      sum(q.unit_price) into v_normalized,v_total
    from (select (e->>'unit_id')::uuid unit_id,(e->>'unit_price')::numeric(18,2) unit_price
      from jsonb_array_elements(p_lines)e)q;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Mahsulot identifikatori yoki transfer narxi noto‘g‘ri' using errcode='22023';
  end;
  if exists(select 1 from jsonb_array_elements(p_lines)e group by (e->>'unit_id')::uuid having count(*)>1) then
    raise exception 'Mahsulot identifikatorlari takrorlanmasligi kerak' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_lines)e where (e->>'unit_price')::numeric<=0) then
    raise exception 'Har bir transfer narxi musbat bo‘lishi shart' using errcode='22023'; end if;
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('from_location_id',v_from::text,'to_location_id',v_to::text,
    'currency',v_currency,'notes',v_notes,'lines',v_normalized)::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.transfers where from_branch_id=v_fb and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa mazmun bilan yuborildi' using errcode='22023'; end if;
    return public.get_branch_transfer(v_existing.id);
  end if;
  perform 1 from public.inventory_units u where u.id in(select (e->>'unit_id')::uuid from jsonb_array_elements(p_lines)e)
    order by u.id for update;
  insert into public.transfers(id,transfer_no,from_location_id,to_location_id,from_branch_id,to_branch_id,status,notes,
    currency,total_amount,idempotency_key,request_hash,created_by,requested_by,requested_at)
  values(v_id,'TR-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8)),v_from,v_to,v_fb,v_tb,
    'requested',v_notes,v_currency,v_total,p_idempotency_key,v_hash,auth.uid(),auth.uid(),now());
  for v_item in select value from jsonb_array_elements(p_lines) order by (value->>'unit_id')::uuid loop
    v_uid=(v_item->>'unit_id')::uuid; v_price=(v_item->>'unit_price')::numeric(18,2);
    select * into v_unit from public.inventory_units where id=v_uid;
    if not found then raise exception 'Mahsulot birligi topilmadi: %',v_uid using errcode='P0002'; end if;
    if v_unit.location_id<>v_from or v_unit.status<>'available' or v_unit.active_transfer_id is not null then
      raise exception 'Mahsulot jo‘natish joyida erkin emas: %',v_uid using errcode='P0001'; end if;
    insert into public.transfer_lines(transfer_id,product_id,unit_id,quantity,unit_price) values(v_id,v_unit.product_id,v_uid,1,v_price);
    update public.inventory_units set active_transfer_id=v_id,version=version+1 where id=v_uid;
  end loop;
  return public.get_branch_transfer(v_id);
exception when unique_violation then
  select * into v_existing from public.transfers where from_branch_id=v_fb and idempotency_key=p_idempotency_key;
  if found and v_existing.request_hash=v_hash then return public.get_branch_transfer(v_existing.id); end if;
  if found then raise exception 'Takroriy kalit boshqa mazmun bilan yuborildi' using errcode='22023'; end if;
  raise;
end $$;

-- timestamptz parsing depends on session timezone, so this validator is STABLE.
create or replace function public.validate_inventory_search_filters(p_filters jsonb)
returns jsonb language plpgsql stable set search_path='' as $$
declare v jsonb:=coalesce(p_filters,'{}'::jsonb);v_key text;v_min numeric;v_max numeric;v_from timestamptz;v_to timestamptz;
begin
  if jsonb_typeof(v)<>'object' then raise exception 'Inventar qidiruv filtrlari object bo‘lishi kerak' using errcode='22023'; end if;
  foreach v_key in array array['branch_ids','location_ids','statuses','seller_ids'] loop
    if v ? v_key and jsonb_typeof(v->v_key)<>'array' then raise exception '% array bo‘lishi kerak',v_key using errcode='22023'; end if;
    if coalesce(jsonb_array_length(v->v_key),0)>100 then raise exception '% qiymatlari juda ko‘p',v_key using errcode='22023'; end if;
  end loop;
  if exists(select 1 from jsonb_each_text(v) item where length(item.value)>500) then raise exception 'Qidiruv filtri juda uzun' using errcode='22023'; end if;
  begin
    v_min=nullif(v->>'min_price','')::numeric;v_max=nullif(v->>'max_price','')::numeric;
    v_from=nullif(v->>'from','')::timestamptz;v_to=nullif(v->>'to','')::timestamptz;
  exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
    raise exception 'Narx yoki sana filtri noto‘g‘ri' using errcode='22023';
  end;
  if coalesce(v_min,0)<0 or coalesce(v_max,0)<0 or (v_min is not null and v_max is not null and v_min>v_max)
    or (v_from is not null and v_to is not null and v_from>=v_to) then
    raise exception 'Qidiruv oralig‘i noto‘g‘ri' using errcode='22023';
  end if;
  return v;
end $$;

commit;
