-- Task 3: transactional product catalog, attributes and R2 media metadata.
begin;

alter table public.products add constraint products_name_length_chk
  check (length(btrim(name)) between 2 and 240);
alter table public.products add constraint products_sku_format_chk
  check (sku ~ '^[A-Z0-9][A-Z0-9._-]{1,63}$');
alter table public.products add constraint products_slug_format_chk
  check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');
alter table public.products add constraint products_publish_state_chk
  check (not is_published or status = 'active');
alter table public.product_media add constraint product_media_mime_chk
  check (mime_type in ('image/jpeg','image/png','image/webp','image/avif'));
alter table public.product_media add constraint product_media_bytes_chk
  check (bytes between 1 and 10485760);
alter table public.product_media add constraint product_media_key_chk
  check (r2_key ~ '^products/[a-f0-9-]{36}/[a-f0-9-]+\.(jpg|png|webp|avif)$');
alter table public.product_media add constraint product_media_sort_chk check (sort_order >= 0);
alter table public.product_media add constraint product_media_alt_length_chk
  check (alt_text is null or length(alt_text) <= 240);

create or replace function public.require_catalog_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[], null) then
    raise exception 'Global katalog administratori roli talab qilinadi' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.validate_product_attribute_value()
returns trigger language plpgsql set search_path = '' as $$
declare v_product_category uuid; v_attr record; v_item jsonb;
begin
  select category_id into v_product_category from public.products where id = new.product_id;
  select category_id, data_type, options into v_attr from public.attribute_definitions where id = new.attribute_id;
  if v_attr.category_id is not null and v_attr.category_id <> v_product_category then
    raise exception 'Atribut mahsulot kategoriyasiga tegishli emas' using errcode = '23514';
  end if;
  if (v_attr.data_type = 'text' and jsonb_typeof(new.value) <> 'string')
    or (v_attr.data_type = 'number' and jsonb_typeof(new.value) <> 'number')
    or (v_attr.data_type = 'boolean' and jsonb_typeof(new.value) <> 'boolean')
    or (v_attr.data_type in ('date','select') and jsonb_typeof(new.value) <> 'string')
    or (v_attr.data_type = 'multiselect' and jsonb_typeof(new.value) <> 'array') then
    raise exception 'Atribut qiymati ma’lumot turiga mos emas' using errcode = '23514';
  end if;
  if v_attr.data_type = 'select' and not v_attr.options @> jsonb_build_array(new.value) then
    raise exception 'Tanlov qiymati ruxsat etilgan variant emas' using errcode = '23514';
  end if;
  if v_attr.data_type = 'multiselect' then
    for v_item in select value from jsonb_array_elements(new.value) loop
      if jsonb_typeof(v_item) <> 'string' or not v_attr.options @> jsonb_build_array(v_item) then
        raise exception 'Ko‘p tanlov qiymatlaridan biri ruxsat etilmagan' using errcode = '23514';
      end if;
    end loop;
  end if;
  return new;
end;
$$;
drop trigger if exists product_attribute_value_guard on public.product_attribute_values;
create trigger product_attribute_value_guard before insert or update on public.product_attribute_values
for each row execute function public.validate_product_attribute_value();
create or replace function public.assert_product_publishable(p_product_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_category uuid;
begin
  select category_id into v_category from public.products where id = p_product_id;
  if not found then raise exception 'Mahsulot topilmadi' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.product_media where product_id = p_product_id and is_primary) then
    raise exception 'Nashr qilish uchun asosiy rasm talab qilinadi' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.attribute_definitions a
    where a.is_required and (a.category_id is null or a.category_id = v_category)
      and not exists (select 1 from public.product_attribute_values v where v.product_id = p_product_id and v.attribute_id = a.id)
  ) then raise exception 'Barcha majburiy atributlarni to‘ldiring' using errcode = '23514'; end if;
end;
$$;

create or replace function public.list_catalog_products(
  p_query text default null, p_status public.product_status default null,
  p_category_id uuid default null, p_brand_id uuid default null,
  p_limit integer default 20, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_total bigint;
begin
  perform public.require_catalog_admin();
  if p_limit not between 1 and 100 or p_offset < 0 then raise exception 'Sahifalash qiymati noto‘g‘ri'; end if;
  select count(*) into v_total from public.products p where
    (p_query is null or btrim(p_query) = '' or p.name ilike '%'||btrim(p_query)||'%' or p.sku ilike '%'||btrim(p_query)||'%' or coalesce(p.barcode,'') ilike '%'||btrim(p_query)||'%')
    and (p_status is null or p.status = p_status) and (p_category_id is null or p.category_id = p_category_id)
    and (p_brand_id is null or p.brand_id = p_brand_id);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v_items from (
    select p.id,p.sku,p.barcode,p.category_id,c.name category_name,p.brand_id,b.name brand_name,p.name,p.slug,
      p.status,p.is_published,p.track_individual_units,p.cost_price,p.retail_price,p.compare_at_price,p.tax_rate,
      p.created_at,p.updated_at,coalesce(sum(ib.on_hand-ib.reserved),0) available_stock,
      (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order,m.created_at limit 1) primary_image
    from public.products p join public.categories c on c.id=p.category_id left join public.brands b on b.id=p.brand_id
    left join public.inventory_balances ib on ib.product_id=p.id
    where (p_query is null or btrim(p_query) = '' or p.name ilike '%'||btrim(p_query)||'%' or p.sku ilike '%'||btrim(p_query)||'%' or coalesce(p.barcode,'') ilike '%'||btrim(p_query)||'%')
      and (p_status is null or p.status=p_status) and (p_category_id is null or p.category_id=p_category_id) and (p_brand_id is null or p.brand_id=p_brand_id)
    group by p.id,c.name,b.name order by p.created_at desc limit p_limit offset p_offset
  ) x;
  return jsonb_build_object('items',v_items,'total',v_total);
end;
$$;

create or replace function public.get_catalog_product(p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.require_catalog_admin();
  select to_jsonb(p) || jsonb_build_object(
    'category_name',c.name,'brand_name',b.name,
    'media',coalesce((select jsonb_agg(to_jsonb(m) order by m.is_primary desc,m.sort_order,m.created_at) from public.product_media m where m.product_id=p.id),'[]'::jsonb),
    'attributes',coalesce((select jsonb_agg(jsonb_build_object('attribute_id',v.attribute_id,'value',v.value)) from public.product_attribute_values v where v.product_id=p.id),'[]'::jsonb)
  ) into v_result from public.products p join public.categories c on c.id=p.category_id left join public.brands b on b.id=p.brand_id where p.id=p_product_id;
  if v_result is null then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if;
  return v_result;
end;
$$;
create or replace function public.save_catalog_product(p_product jsonb, p_attributes jsonb default '[]'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_status public.product_status; v_item jsonb;
begin
  perform public.require_catalog_admin();
  if jsonb_typeof(p_product) <> 'object' or jsonb_typeof(p_attributes) <> 'array' then raise exception 'Mahsulot formati noto‘g‘ri'; end if;
  v_id := nullif(p_product->>'id','')::uuid;
  v_status := coalesce(nullif(p_product->>'status','')::public.product_status,'draft');
  if v_id is null then
    insert into public.products(sku,barcode,category_id,brand_id,name,slug,description,status,is_published,track_individual_units,cost_price,retail_price,compare_at_price,tax_rate,metadata)
    values(upper(btrim(p_product->>'sku')),nullif(btrim(p_product->>'barcode'),''),(p_product->>'category_id')::uuid,nullif(p_product->>'brand_id','')::uuid,
      btrim(p_product->>'name'),lower(btrim(p_product->>'slug')),nullif(btrim(p_product->>'description'),''),v_status,false,
      coalesce((p_product->>'track_individual_units')::boolean,true),coalesce((p_product->>'cost_price')::numeric,0),(p_product->>'retail_price')::numeric,
      nullif(p_product->>'compare_at_price','')::numeric,coalesce((p_product->>'tax_rate')::numeric,0),coalesce(p_product->'metadata','{}'::jsonb)) returning id into v_id;
  else
    update public.products set sku=upper(btrim(p_product->>'sku')),barcode=nullif(btrim(p_product->>'barcode'),''),category_id=(p_product->>'category_id')::uuid,
      brand_id=nullif(p_product->>'brand_id','')::uuid,name=btrim(p_product->>'name'),slug=lower(btrim(p_product->>'slug')),description=nullif(btrim(p_product->>'description'),''),
      status=case when status='archived' then 'draft'::public.product_status else v_status end,is_published=false,
      track_individual_units=coalesce((p_product->>'track_individual_units')::boolean,true),cost_price=coalesce((p_product->>'cost_price')::numeric,0),
      retail_price=(p_product->>'retail_price')::numeric,compare_at_price=nullif(p_product->>'compare_at_price','')::numeric,tax_rate=coalesce((p_product->>'tax_rate')::numeric,0),
      metadata=coalesce(p_product->'metadata','{}'::jsonb) where id=v_id;
    if not found then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if;
  end if;
  delete from public.product_attribute_values where product_id=v_id;
  for v_item in select value from jsonb_array_elements(p_attributes) loop
    insert into public.product_attribute_values(product_id,attribute_id,value) values(v_id,(v_item->>'attribute_id')::uuid,v_item->'value');
  end loop;
  return v_id;
end;
$$;

create or replace function public.set_catalog_product_publication(p_product_id uuid, p_publish boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_catalog_admin();
  if p_publish then
    perform public.assert_product_publishable(p_product_id);
    update public.products set status='active',is_published=true where id=p_product_id;
  else update public.products set is_published=false where id=p_product_id; end if;
  if not found then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if;
end;
$$;
create or replace function public.archive_catalog_product(p_product_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin perform public.require_catalog_admin(); update public.products set status='archived',is_published=false where id=p_product_id;
if not found then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if; end; $$;

create or replace function public.require_catalog_actor(p_actor_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.profiles p join public.profile_roles r on r.profile_id=p.id
    where p.id=p_actor_id and p.is_active and r.role in ('superadmin','admin') and r.branch_id is null) then
    raise exception 'Global katalog administratori roli talab qilinadi' using errcode='42501';
  end if;
end;
$$;

create or replace function public.attach_product_media(p_actor_id uuid,p_product_id uuid,p_r2_key text,p_public_url text,p_mime_type text,p_bytes bigint,p_alt_text text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_primary boolean;
begin
  perform public.require_catalog_actor(p_actor_id);
  if not exists(select 1 from public.products where id=p_product_id) then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if;
  v_primary := not exists(select 1 from public.product_media where product_id=p_product_id);
  insert into public.product_media(product_id,r2_key,public_url,mime_type,bytes,alt_text,sort_order,is_primary)
  values(p_product_id,p_r2_key,p_public_url,p_mime_type,p_bytes,nullif(btrim(p_alt_text),''),coalesce((select max(sort_order)+1 from public.product_media where product_id=p_product_id),0),v_primary) returning id into v_id;
  return v_id;
end;
$$;
create or replace function public.set_primary_product_media(p_product_id uuid,p_media_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin perform public.require_catalog_admin();
  if not exists(select 1 from public.product_media where id=p_media_id and product_id=p_product_id) then raise exception 'Rasm topilmadi' using errcode='P0002'; end if;
  update public.product_media set is_primary=false where product_id=p_product_id and is_primary;
  update public.product_media set is_primary=true where id=p_media_id;
end; $$;
create or replace function public.detach_product_media(p_actor_id uuid,p_media_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_key text; v_product uuid; v_was_primary boolean;
begin perform public.require_catalog_actor(p_actor_id);
  delete from public.product_media where id=p_media_id returning r2_key,product_id,is_primary into v_key,v_product,v_was_primary;
  if v_key is null then raise exception 'Rasm topilmadi' using errcode='P0002'; end if;
  if v_was_primary then update public.product_media set is_primary=true where id=(select id from public.product_media where product_id=v_product order by sort_order,created_at limit 1); end if;
  return v_key;
end; $$;
drop trigger if exists product_attribute_values_audit on public.product_attribute_values;
create trigger product_attribute_values_audit after insert or update or delete on public.product_attribute_values for each row execute function public.audit_row_change();
drop trigger if exists product_media_audit on public.product_media;
create trigger product_media_audit after insert or update or delete on public.product_media for each row execute function public.audit_row_change();

revoke insert,update,delete on public.products,public.product_attribute_values,public.product_media from authenticated;
revoke all on function public.require_catalog_admin(),public.require_catalog_actor(uuid),public.validate_product_attribute_value(),public.assert_product_publishable(uuid) from public,anon,authenticated;
revoke all on function public.list_catalog_products(text,public.product_status,uuid,uuid,integer,integer),public.get_catalog_product(uuid),public.save_catalog_product(jsonb,jsonb),public.set_catalog_product_publication(uuid,boolean),public.archive_catalog_product(uuid),public.attach_product_media(uuid,uuid,text,text,text,bigint,text),public.set_primary_product_media(uuid,uuid),public.detach_product_media(uuid,uuid) from public,anon;
grant execute on function public.list_catalog_products(text,public.product_status,uuid,uuid,integer,integer),public.get_catalog_product(uuid),public.save_catalog_product(jsonb,jsonb),public.set_catalog_product_publication(uuid,boolean),public.archive_catalog_product(uuid),public.set_primary_product_media(uuid,uuid) to authenticated;
grant execute on function public.require_catalog_admin(),public.require_catalog_actor(uuid),public.validate_product_attribute_value(),public.assert_product_publishable(uuid),public.list_catalog_products(text,public.product_status,uuid,uuid,integer,integer),public.get_catalog_product(uuid),public.save_catalog_product(jsonb,jsonb),public.set_catalog_product_publication(uuid,boolean),public.archive_catalog_product(uuid),public.attach_product_media(uuid,uuid,text,text,text,bigint,text),public.set_primary_product_media(uuid,uuid),public.detach_product_media(uuid,uuid) to service_role;

commit;
