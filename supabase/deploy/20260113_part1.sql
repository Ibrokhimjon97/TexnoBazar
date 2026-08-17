-- Complete business workflows omitted by the initial domain schema.
-- All client mutations are routed through explicitly granted SECURITY DEFINER RPCs.

-- -----------------------------------------------------------------------------
-- Shared invariants, customer persistence, and product price history
-- -----------------------------------------------------------------------------

alter table public.products
  add column if not exists wholesale_price numeric(18,2),
  add column if not exists promotion_price numeric(18,2),
  add column if not exists seo_title text,
  add column if not exists seo_description text,
  add column if not exists seo_image_url text;
alter table public.categories
  add column if not exists seo_title text,
  add column if not exists seo_description text,
  add column if not exists seo_image_url text;

do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.products'::regclass and conname='products_seo_image_url_chk') then
    alter table public.products add constraint products_seo_image_url_chk check(seo_image_url is null or seo_image_url ~ '^https://');
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.categories'::regclass and conname='categories_seo_image_url_chk') then
    alter table public.categories add constraint categories_seo_image_url_chk check(seo_image_url is null or seo_image_url ~ '^https://');
  end if;
end $$;

do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.products'::regclass and conname='products_wholesale_price_chk') then
    alter table public.products add constraint products_wholesale_price_chk
      check(wholesale_price is null or (wholesale_price>=minimum_sale_price and wholesale_price<=retail_price));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.products'::regclass and conname='products_promotion_price_chk') then
    alter table public.products add constraint products_promotion_price_chk
      check(promotion_price is null or (promotion_price>=minimum_sale_price and promotion_price<=retail_price));
  end if;
end $$;

create table public.product_price_history(
  id bigint generated always as identity primary key,
  product_id uuid not null references public.products(id) on delete restrict,
  cost_price numeric(18,2) not null check(cost_price>=0),
  retail_price numeric(18,2) not null check(retail_price>=0),
  wholesale_price numeric(18,2) check(wholesale_price is null or wholesale_price>=0),
  promotion_price numeric(18,2) check(promotion_price is null or promotion_price>=0),
  minimum_sale_price numeric(18,2) not null check(minimum_sale_price>=0),
  previous_prices jsonb not null default '{}'::jsonb check(jsonb_typeof(previous_prices)='object'),
  changed_by uuid references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now()
);
create index product_price_history_product_time_idx on public.product_price_history(product_id,changed_at desc,id desc);

create or replace function public.capture_product_price_history()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' or row(new.cost_price,new.retail_price,new.wholesale_price,new.promotion_price,new.minimum_sale_price)
      is distinct from row(old.cost_price,old.retail_price,old.wholesale_price,old.promotion_price,old.minimum_sale_price) then
    insert into public.product_price_history(product_id,cost_price,retail_price,wholesale_price,promotion_price,
      minimum_sale_price,previous_prices,changed_by)
    values(new.id,new.cost_price,new.retail_price,new.wholesale_price,new.promotion_price,new.minimum_sale_price,
      case when tg_op='UPDATE' then jsonb_build_object('cost_price',old.cost_price,'retail_price',old.retail_price,
        'wholesale_price',old.wholesale_price,'promotion_price',old.promotion_price,
        'minimum_sale_price',old.minimum_sale_price) else '{}'::jsonb end,auth.uid());
  end if;
  return new;
end $$;
create trigger products_price_history after insert or update of cost_price,retail_price,wholesale_price,promotion_price,minimum_sale_price
  on public.products for each row execute function public.capture_product_price_history();
insert into public.product_price_history(product_id,cost_price,retail_price,wholesale_price,promotion_price,
  minimum_sale_price,previous_prices,changed_by)
select p.id,p.cost_price,p.retail_price,p.wholesale_price,p.promotion_price,p.minimum_sale_price,
  jsonb_build_object('baseline',true),null from public.products p
where not exists(select 1 from public.product_price_history h where h.product_id=p.id);
create trigger product_price_history_immutable before update or delete on public.product_price_history
  for each row execute function public.reject_mutation();

-- Keep the established catalog RPC signature while persisting the complete price set.
create or replace function public.save_catalog_product(p_product jsonb,p_attributes jsonb default '[]'::jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_status public.product_status; v_item jsonb; v_cost numeric(18,2); v_retail numeric(18,2);
begin
  perform public.require_catalog_admin();
  if jsonb_typeof(p_product)<>'object' or jsonb_typeof(p_attributes)<>'array' then raise exception 'Mahsulot formati notoвЂgвЂri' using errcode='22023'; end if;
  begin
    v_id=nullif(p_product->>'id','')::uuid; v_status=coalesce(nullif(p_product->>'status','')::public.product_status,'draft');
    v_cost=coalesce((p_product->>'cost_price')::numeric,0); v_retail=(p_product->>'retail_price')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Mahsulot identifikatori yoki narxi notoвЂgвЂri' using errcode='22023'; end;
  if v_id is null then
    insert into public.products(sku,barcode,category_id,brand_id,name,slug,description,seo_title,seo_description,seo_image_url,status,is_published,track_individual_units,
      cost_price,retail_price,wholesale_price,promotion_price,minimum_sale_price,compare_at_price,tax_rate,metadata)
    values(upper(btrim(p_product->>'sku')),nullif(btrim(p_product->>'barcode'),''),(p_product->>'category_id')::uuid,
      nullif(p_product->>'brand_id','')::uuid,btrim(p_product->>'name'),lower(btrim(p_product->>'slug')),
      nullif(btrim(p_product->>'description'),''),nullif(btrim(p_product->>'seo_title'),''),nullif(btrim(p_product->>'seo_description'),''),nullif(btrim(p_product->>'seo_image_url'),''),v_status,false,coalesce((p_product->>'track_individual_units')::boolean,true),
      v_cost,v_retail,nullif(p_product->>'wholesale_price','')::numeric,nullif(p_product->>'promotion_price','')::numeric,
      coalesce(nullif(p_product->>'minimum_sale_price','')::numeric,least(v_cost,v_retail)),nullif(p_product->>'compare_at_price','')::numeric,
      coalesce((p_product->>'tax_rate')::numeric,0),coalesce(p_product->'metadata','{}'::jsonb)) returning id into v_id;
  else
    update public.products set sku=upper(btrim(p_product->>'sku')),barcode=nullif(btrim(p_product->>'barcode'),''),
      category_id=(p_product->>'category_id')::uuid,brand_id=nullif(p_product->>'brand_id','')::uuid,
      name=btrim(p_product->>'name'),slug=lower(btrim(p_product->>'slug')),description=nullif(btrim(p_product->>'description'),''),
      seo_title=nullif(btrim(p_product->>'seo_title'),''),seo_description=nullif(btrim(p_product->>'seo_description'),''),seo_image_url=nullif(btrim(p_product->>'seo_image_url'),''),
      status=case when status='archived' then 'draft'::public.product_status else v_status end,is_published=false,
      track_individual_units=coalesce((p_product->>'track_individual_units')::boolean,true),cost_price=v_cost,retail_price=v_retail,
      wholesale_price=case when p_product ? 'wholesale_price' then nullif(p_product->>'wholesale_price','')::numeric else wholesale_price end,
      promotion_price=case when p_product ? 'promotion_price' then nullif(p_product->>'promotion_price','')::numeric else promotion_price end,
      minimum_sale_price=case when p_product ? 'minimum_sale_price' then coalesce(nullif(p_product->>'minimum_sale_price','')::numeric,least(v_cost,v_retail)) else minimum_sale_price end,
      compare_at_price=nullif(p_product->>'compare_at_price','')::numeric,tax_rate=coalesce((p_product->>'tax_rate')::numeric,0),
      metadata=coalesce(p_product->'metadata','{}'::jsonb) where id=v_id;
    if not found then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if;
  end if;
  delete from public.product_attribute_values where product_id=v_id;
  for v_item in select value from jsonb_array_elements(p_attributes) loop
    insert into public.product_attribute_values(product_id,attribute_id,value) values(v_id,(v_item->>'attribute_id')::uuid,v_item->'value');
  end loop;
  return v_id;
end $$;

create table public.customer_favorites(
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id,product_id)
);
create index customer_favorites_user_time_idx on public.customer_favorites(user_id,created_at desc);

create table public.customer_cart_items(
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity integer not null check(quantity between 1 and 100),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  primary key(user_id,product_id)
);

create table public.customer_addresses(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null check(length(btrim(label)) between 1 and 80),
  recipient_name text not null check(length(btrim(recipient_name)) between 2 and 160),
  phone text not null check(length(btrim(phone)) between 5 and 40),
  address jsonb not null check(jsonb_typeof(address)='object'),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index customer_addresses_user_idx on public.customer_addresses(user_id,created_at desc);
create unique index customer_addresses_one_default_uidx on public.customer_addresses(user_id) where is_default;
create trigger customer_cart_items_set_updated_at before update on public.customer_cart_items
  for each row execute function public.set_updated_at();
create trigger customer_addresses_set_updated_at before update on public.customer_addresses
  for each row execute function public.set_updated_at();

create or replace function public.save_customer_profile(p_profile jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_customer public.customers%rowtype; v_name text; v_phone text; v_email extensions.citext;
begin
  if auth.uid() is null or not public.current_user_active() or jsonb_typeof(p_profile)<>'object' then
    raise exception 'Faol autentifikatsiya va profil obyekti talab qilinadi' using errcode='42501';
  end if;
  v_name=nullif(btrim(p_profile->>'full_name'),''); v_phone=nullif(btrim(p_profile->>'phone'),'');
  v_email=nullif(btrim(p_profile->>'email'),'')::extensions.citext;
  if v_name is null or length(v_name)>160 then raise exception 'Mijoz ismi notoвЂgвЂri' using errcode='22023'; end if;
  if p_profile ? 'address' and jsonb_typeof(p_profile->'address')<>'object' then raise exception 'Manzil obyekt boвЂlishi kerak' using errcode='22023'; end if;
  update public.profiles set full_name=v_name,phone=v_phone where id=auth.uid();
  insert into public.customers(auth_user_id,full_name,phone,email,address)
  values(auth.uid(),v_name,v_phone,v_email,coalesce(p_profile->'address','{}'::jsonb))
  on conflict(auth_user_id) do update set full_name=excluded.full_name,phone=excluded.phone,email=excluded.email,
    address=excluded.address
  returning * into v_customer;
  return jsonb_build_object('id',v_customer.id,'full_name',v_customer.full_name,'phone',v_customer.phone,
    'email',v_customer.email,'address',v_customer.address,'loyalty_points',v_customer.loyalty_points);
end $$;

create or replace function public.save_customer_address(p_address jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_default boolean; v_count integer;
begin
  if auth.uid() is null or not public.current_user_active() or jsonb_typeof(p_address)<>'object' then
    raise exception 'Faol autentifikatsiya va manzil obyekti talab qilinadi' using errcode='42501'; end if;
  perform 1 from public.profiles where id=auth.uid() for update;
  begin v_id=nullif(p_address->>'id','')::uuid; exception when invalid_text_representation then
    raise exception 'Manzil identifikatori notoвЂgвЂri' using errcode='22023'; end;
  if nullif(btrim(p_address->>'label'),'') is null or nullif(btrim(p_address->>'recipient_name'),'') is null
    or nullif(btrim(p_address->>'phone'),'') is null or jsonb_typeof(p_address->'address')<>'object' then
    raise exception 'Manzil maydonlari toвЂliq emas' using errcode='22023'; end if;
  select count(*) into v_count from public.customer_addresses where user_id=auth.uid();
  v_default=coalesce((p_address->>'is_default')::boolean,v_count=0);
  if v_default then update public.customer_addresses set is_default=false where user_id=auth.uid() and is_default; end if;
  if v_id is null then
    insert into public.customer_addresses(user_id,label,recipient_name,phone,address,is_default)
    values(auth.uid(),btrim(p_address->>'label'),btrim(p_address->>'recipient_name'),btrim(p_address->>'phone'),
      p_address->'address',v_default) returning id into v_id;
  else
    update public.customer_addresses set label=btrim(p_address->>'label'),recipient_name=btrim(p_address->>'recipient_name'),
      phone=btrim(p_address->>'phone'),address=p_address->'address',is_default=v_default
    where id=v_id and user_id=auth.uid();
    if not found then raise exception 'Manzil topilmadi' using errcode='P0002'; end if;
  end if;
  return v_id;
end $$;

create or replace function public.delete_customer_address(p_address_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_was_default boolean;
begin
  if auth.uid() is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  delete from public.customer_addresses where id=p_address_id and user_id=auth.uid() returning is_default into v_was_default;
  if not found then raise exception 'Manzil topilmadi' using errcode='P0002'; end if;
  if v_was_default then update public.customer_addresses set is_default=true where id=(select id from public.customer_addresses
    where user_id=auth.uid() order by created_at,id limit 1); end if;
end $$;

create or replace function public.set_customer_favorite(p_product_id uuid,p_favorite boolean)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.current_user_active() then raise exception 'Faol autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  if p_favorite then
    if not exists(select 1 from public.products where id=p_product_id and status='active' and is_published) then
      raise exception 'Ochiq mahsulot topilmadi' using errcode='P0002'; end if;
    insert into public.customer_favorites(user_id,product_id) values(auth.uid(),p_product_id) on conflict do nothing;
  else delete from public.customer_favorites where user_id=auth.uid() and product_id=p_product_id; end if;
  return p_favorite;
end $$;

create or replace function public.set_customer_cart_item(p_product_id uuid,p_quantity integer)
returns integer language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.current_user_active() then raise exception 'Faol autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  if coalesce(p_quantity,0)<=0 then delete from public.customer_cart_items where user_id=auth.uid() and product_id=p_product_id; return 0; end if;
  if p_quantity>100 then raise exception 'Savat miqdori 100 dan oshmasligi kerak' using errcode='22023'; end if;
  if not exists(select 1 from public.products where id=p_product_id and status='active' and is_published) then
    raise exception 'Ochiq mahsulot topilmadi' using errcode='P0002'; end if;
  insert into public.customer_cart_items(user_id,product_id,quantity) values(auth.uid(),p_product_id,p_quantity)
  on conflict(user_id,product_id) do update set quantity=excluded.quantity;
  return p_quantity;
end $$;

create or replace function public.get_customer_account()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  return jsonb_build_object(
    'profile',(select jsonb_build_object('id',p.id,'email',p.email,'full_name',p.full_name,'phone',p.phone,'avatar_url',p.avatar_url)
      from public.profiles p where p.id=auth.uid()),
    'customer',(select to_jsonb(c)-'auth_user_id' from public.customers c where c.auth_user_id=auth.uid()),
    'addresses',coalesce((select jsonb_agg(to_jsonb(a)-'user_id' order by a.is_default desc,a.created_at,a.id)
      from public.customer_addresses a where a.user_id=auth.uid()),'[]'::jsonb),
    'favorites',coalesce((select jsonb_agg(f.product_id order by f.created_at desc) from public.customer_favorites f where f.user_id=auth.uid()),'[]'::jsonb),
    'cart',coalesce((select jsonb_agg(jsonb_build_object('product_id',c.product_id,'quantity',c.quantity,'updated_at',c.updated_at)
      order by c.updated_at desc) from public.customer_cart_items c where c.user_id=auth.uid()),'[]'::jsonb));
end $$;

-- -----------------------------------------------------------------------------
-- Inventory counts and write-offs (individual physical units)
-- -----------------------------------------------------------------------------

insert into public.locations(code,name,type,is_active)
values('SYSTEM-WRITEOFF','Tizim hisobdan chiqarish joyi','writeoff',true)
on conflict(code) do update set name=excluded.name,type='writeoff',is_active=true;

alter table public.inventory_counts
  add column if not exists idempotency_key uuid,
  add column if not exists request_hash text,
  add column if not exists created_by uuid references public.profiles(id) on delete restrict,
  add column if not exists reviewed_by uuid references public.profiles(id) on delete restrict,
  add column if not exists reviewed_at timestamptz,
  add column if not exists cancelled_by uuid references public.profiles(id) on delete restrict,
  add column if not exists cancelled_at timestamptz;
alter table public.inventory_count_lines add column if not exists expected_unit_version bigint;
create unique index inventory_counts_location_idempotency_uidx on public.inventory_counts(location_id,idempotency_key)
  where idempotency_key is not null;
create unique index inventory_movements_count_unit_uidx on public.inventory_movements(reference_id,unit_id,movement_type)
  where reference_type='inventory_count' and reference_id is not null and unit_id is not null and movement_type='adjustment';

alter table public.writeoffs
  add column if not exists idempotency_key uuid,
  add column if not exists request_hash text,
  add column if not exists cancelled_by uuid references public.profiles(id) on delete restrict,
  add column if not exists cancelled_at timestamptz;
create unique index writeoffs_location_idempotency_uidx on public.writeoffs(location_id,idempotency_key)
  where idempotency_key is not null;
create unique index inventory_movements_writeoff_unit_uidx on public.inventory_movements(reference_id,unit_id,movement_type)
  where reference_type='writeoff' and reference_id is not null and unit_id is not null and movement_type='writeoff';

create or replace function public.create_inventory_count(p_location_id uuid,p_scope jsonb,p_notes text,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_branch uuid; v_id uuid:=gen_random_uuid(); v_hash text; v_existing public.inventory_counts%rowtype; v_scope jsonb;
begin
  select branch_id into v_branch from public.locations where id=p_location_id and is_active and type in('store','warehouse');
  if v_branch is null then raise exception 'Faol hisob joyi topilmadi' using errcode='P0002'; end if;
  perform public.require_inventory_operator(v_branch);
  perform 1 from public.locations where id=p_location_id for update;
  if p_idempotency_key is null or jsonb_typeof(coalesce(p_scope,'{}'::jsonb))<>'object' then raise exception 'Scope va takroriy kalit talab qilinadi' using errcode='22023'; end if;
  v_scope=coalesce(p_scope,'{}'::jsonb);
  if coalesce(v_scope->>'mode','full') not in('full','scoped') then raise exception 'Scope mode full yoki scoped boвЂlishi kerak' using errcode='22023'; end if;
  if coalesce(v_scope->>'mode','full')='scoped' and (jsonb_typeof(v_scope->'product_ids')<>'array' or jsonb_array_length(v_scope->'product_ids')=0) then
    raise exception 'Scoped hisob uchun product_ids talab qilinadi' using errcode='22023'; end if;
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('location_id',p_location_id,'scope',v_scope,
    'notes',nullif(btrim(p_notes),''))::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.inventory_counts where location_id=p_location_id and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa hisob mazmunida ishlatilgan' using errcode='22023'; end if;
    return to_jsonb(v_existing);
  end if;
  insert into public.inventory_counts(id,count_no,location_id,scope,status,notes,idempotency_key,request_hash,created_by)
  values(v_id,'CNT-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8)),
    p_location_id,v_scope,'draft',nullif(btrim(p_notes),''),p_idempotency_key,v_hash,auth.uid()) returning * into v_existing;
  return to_jsonb(v_existing);
end $$;

create or replace function public.start_inventory_count(p_count_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count public.inventory_counts%rowtype; v_branch uuid;
begin
  select * into v_count from public.inventory_counts where id=p_count_id for update;
  if not found then raise exception 'Inventarizatsiya topilmadi' using errcode='P0002'; end if;
  select branch_id into v_branch from public.locations where id=v_count.location_id;
  perform public.require_inventory_operator(v_branch);
  if v_count.status='counting' then return to_jsonb(v_count); end if;
  if v_count.status<>'draft' then raise exception 'Faqat draft hisob boshlanadi' using errcode='P0001'; end if;
  perform 1 from public.inventory_units u where u.location_id=v_count.location_id
    and u.status in('available','reserved','returned')
    and (coalesce(v_count.scope->>'mode','full')='full' or u.product_id in(
      select (value#>>'{}')::uuid from jsonb_array_elements(v_count.scope->'product_ids')))
    order by u.id for update;
  insert into public.inventory_count_lines(inventory_count_id,product_id,unit_id,expected_quantity,counted_quantity,expected_unit_version)
  select v_count.id,u.product_id,u.id,1,0,u.version from public.inventory_units u where u.location_id=v_count.location_id
    and u.status in('available','reserved','returned')
    and (coalesce(v_count.scope->>'mode','full')='full' or u.product_id in(
      select (value#>>'{}')::uuid from jsonb_array_elements(v_count.scope->'product_ids')))
  order by u.id on conflict(inventory_count_id,unit_id) do nothing;
  update public.inventory_counts set status='counting',started_by=auth.uid(),started_at=now() where id=p_count_id returning * into v_count;
  return to_jsonb(v_count)||jsonb_build_object('expected_units',(select count(*) from public.inventory_count_lines where inventory_count_id=p_count_id));
end $$;

create or replace function public.count_inventory_unit(p_count_id uuid,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count public.inventory_counts%rowtype; v_unit public.inventory_units%rowtype; v_branch uuid; v_line uuid;
begin
  select * into v_count from public.inventory_counts where id=p_count_id for update;
  if not found then raise exception 'Inventarizatsiya topilmadi' using errcode='P0002'; end if;
  select branch_id into v_branch from public.locations where id=v_count.location_id; perform public.require_inventory_operator(v_branch);
  if v_count.status<>'counting' then raise exception 'Hisob counting holatida emas' using errcode='P0001'; end if;
  if nullif(btrim(p_code),'') is null then raise exception 'QR yoki seriya talab qilinadi' using errcode='22023'; end if;
  select * into v_unit from public.inventory_units where upper(qr_code)=upper(btrim(p_code))
    or upper(coalesce(serial_number,''))=upper(btrim(p_code)) for update;
  if not found then raise exception 'Mahsulot birligi topilmadi' using errcode='P0002'; end if;
  if v_unit.status in('sold','written_off','in_transit') or v_unit.active_transfer_id is not null then
    raise exception 'Bu birlik inventarizatsiyada sanalmaydi' using errcode='P0001'; end if;
  if coalesce(v_count.scope->>'mode','full')='scoped' and not exists(select 1 from jsonb_array_elements(v_count.scope->'product_ids') e
    where (e.value#>>'{}')::uuid=v_unit.product_id) then raise exception 'Mahsulot hisob scope iga kirmaydi' using errcode='P0001'; end if;
  insert into public.inventory_count_lines(inventory_count_id,product_id,unit_id,expected_quantity,counted_quantity,counted_by,counted_at,expected_unit_version)
  values(p_count_id,v_unit.product_id,v_unit.id,case when v_unit.location_id=v_count.location_id then 1 else 0 end,1,auth.uid(),now(),v_unit.version)
  on conflict(inventory_count_id,unit_id) do update set counted_quantity=1,counted_by=auth.uid(),counted_at=now()
  returning id into v_line;
  return jsonb_build_object('line_id',v_line,'unit_id',v_unit.id,'product_id',v_unit.product_id,
    'expected_location_id',v_unit.location_id,'count_location_id',v_count.location_id,'counted',true);
end $$;

create or replace function public.review_inventory_count(p_count_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count public.inventory_counts%rowtype; v_branch uuid;
begin
  select * into v_count from public.inventory_counts where id=p_count_id for update;
  if not found then raise exception 'Inventarizatsiya topilmadi' using errcode='P0002'; end if;
  select branch_id into v_branch from public.locations where id=v_count.location_id; perform public.require_inventory_operator(v_branch);
  if v_count.status='review' then return to_jsonb(v_count); end if;
  if v_count.status<>'counting' then raise exception 'Faqat counting holati review ga oвЂtadi' using errcode='P0001'; end if;
  update public.inventory_counts set status='review',reviewed_by=auth.uid(),reviewed_at=now() where id=p_count_id returning * into v_count;
  return to_jsonb(v_count)||jsonb_build_object('variance_units',(select count(*) from public.inventory_count_lines where inventory_count_id=p_count_id and variance<>0));
end $$;

create or replace function public.post_inventory_count(p_count_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count public.inventory_counts%rowtype; v_branch uuid; v_line record; v_unit public.inventory_units%rowtype; v_writeoff uuid;
begin
  select * into v_count from public.inventory_counts where id=p_count_id for update;
  if not found then raise exception 'Inventarizatsiya topilmadi' using errcode='P0002'; end if;
  select branch_id into v_branch from public.locations where id=v_count.location_id; perform public.require_inventory_operator(v_branch);
  if not(public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager']::public.app_role[],v_branch)) then
    raise exception 'Inventarizatsiyani post qilish uchun menejer roli talab qilinadi' using errcode='42501'; end if;
  if v_count.status='posted' then return to_jsonb(v_count); end if;
  if v_count.status<>'review' then raise exception 'Faqat review holati post qilinadi' using errcode='P0001'; end if;
  select id into v_writeoff from public.locations where code='SYSTEM-WRITEOFF' and type='writeoff' for share;
  perform 1 from public.inventory_units u join public.inventory_count_lines x on x.unit_id=u.id
    where x.inventory_count_id=p_count_id order by u.id for update of u;
  if exists(select 1 from public.inventory_count_lines x join public.inventory_units u on u.id=x.unit_id
    where x.inventory_count_id=p_count_id and x.expected_quantity=1
      and (u.location_id<>v_count.location_id or u.version is distinct from x.expected_unit_version
        or u.status not in('available','reserved','returned') or u.active_transfer_id is not null)) then
    raise exception 'Inventarizatsiya snapshotidan keyin birlik holati oвЂzgargan' using errcode='40001';
  end if;
  if exists(select 1 from public.inventory_units u where u.location_id=v_count.location_id
    and u.status in('available','reserved','returned')
    and (coalesce(v_count.scope->>'mode','full')='full' or u.product_id in(
      select (value#>>'{}')::uuid from jsonb_array_elements(v_count.scope->'product_ids')))
    and not exists(select 1 from public.inventory_count_lines x where x.inventory_count_id=p_count_id and x.unit_id=u.id)) then
    raise exception 'Inventarizatsiya boshlanganidan keyin yangi birlik kelgan; hisobni qayta boshlang' using errcode='40001';
  end if;
  for v_line in select * from public.inventory_count_lines where inventory_count_id=p_count_id and variance<>0 order by unit_id loop
    select * into v_unit from public.inventory_units where id=v_line.unit_id;
    if v_line.variance=-1 then
      if v_unit.location_id<>v_count.location_id or v_unit.status not in('available','returned') or v_unit.active_transfer_id is not null then
        raise exception 'Kamomad birligi band yoki joyi oвЂzgargan: %',v_unit.id using errcode='P0001'; end if;
      update public.inventory_units set location_id=v_writeoff,status='written_off',reserved_until=null,sold_sale_id=null,version=version+1 where id=v_unit.id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,
        unit_cost,reference_type,reference_id,reason,actor_id,metadata)
      values(v_unit.id,v_unit.product_id,v_unit.batch_id,'adjustment',v_count.location_id,v_writeoff,1,null,
        'inventory_count',p_count_id,'Inventarizatsiya kamomadi',auth.uid(),jsonb_build_object('variance',-1)) on conflict do nothing;
    elsif v_line.variance=1 then
      if v_unit.status not in('available','returned') or v_unit.active_transfer_id is not null then
        raise exception 'Ortiqcha birlik band: %',v_unit.id using errcode='P0001'; end if;
      if not exists(select 1 from public.locations l where l.id=v_unit.location_id and l.branch_id=v_branch) then
        raise exception 'Boshqa filial birligini inventarizatsiya bilan koвЂchirib boвЂlmaydi' using errcode='P0001'; end if;
      update public.inventory_units set location_id=v_count.location_id,status='available',reserved_until=null,version=version+1 where id=v_unit.id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,
        unit_cost,reference_type,reference_id,reason,actor_id,metadata)
      values(v_unit.id,v_unit.product_id,v_unit.batch_id,'adjustment',v_unit.location_id,v_count.location_id,1,null,
        'inventory_count',p_count_id,'Inventarizatsiya ortiqchasi',auth.uid(),jsonb_build_object('variance',1)) on conflict do nothing;
    else raise exception 'Individual birlik variance faqat -1, 0 yoki 1 boвЂlishi mumkin' using errcode='23514'; end if;
  end loop;
  update public.inventory_counts set status='posted',posted_by=auth.uid(),posted_at=now() where id=p_count_id returning * into v_count;
  return to_jsonb(v_count)||jsonb_build_object('adjusted_units',(select count(*) from public.inventory_count_lines where inventory_count_id=p_count_id and variance<>0));
end $$;

create or replace function public.cancel_inventory_count(p_count_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count public.inventory_counts%rowtype; v_branch uuid;
begin
  select * into v_count from public.inventory_counts where id=p_count_id for update;
  if not found then raise exception 'Inventarizatsiya topilmadi' using errcode='P0002'; end if;
  select branch_id into v_branch from public.locations where id=v_count.location_id; perform public.require_inventory_operator(v_branch);
  if v_count.status='cancelled' then return to_jsonb(v_count); end if;
  if v_count.status='posted' then raise exception 'Post qilingan hisob bekor qilinmaydi' using errcode='P0001'; end if;
  update public.inventory_counts set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),
    notes=concat_ws(E'\n',notes,'Bekor qilish: '||coalesce(nullif(btrim(p_reason),''),'Sabab koвЂrsatilmagan'))
  where id=p_count_id returning * into v_count; return to_jsonb(v_count);
end $$;

create or replace function public.create_writeoff(p_location_id uuid,p_reason text,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_branch uuid; v_id uuid:=gen_random_uuid(); v_hash text; v_row public.writeoffs%rowtype;
begin
  select branch_id into v_branch from public.locations where id=p_location_id and is_active and type in('store','warehouse');
  if v_branch is null then raise exception 'Faol joylashuv topilmadi' using errcode='P0002'; end if; perform public.require_inventory_operator(v_branch);
  perform 1 from public.locations where id=p_location_id for update;
  if p_idempotency_key is null or nullif(btrim(p_reason),'') is null then raise exception 'Sabab va takroriy kalit talab qilinadi' using errcode='22023'; end if;
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('location_id',p_location_id,'reason',btrim(p_reason))::text,'UTF8'),'sha256'),'hex');
  select * into v_row from public.writeoffs where location_id=p_location_id and idempotency_key=p_idempotency_key;
  if found then if v_row.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa mazmunda ishlatilgan' using errcode='22023'; end if; return to_jsonb(v_row); end if;
  insert into public.writeoffs(id,writeoff_no,location_id,status,reason,created_by,idempotency_key,request_hash)
  values(v_id,'WO-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8)),p_location_id,'draft',btrim(p_reason),auth.uid(),p_idempotency_key,v_hash)
  returning * into v_row; return to_jsonb(v_row);
end $$;

create or replace function public.add_writeoff_unit(p_writeoff_id uuid,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_w public.writeoffs%rowtype; v_u public.inventory_units%rowtype; v_branch uuid; v_cost numeric(18,2);
begin
  select * into v_w from public.writeoffs where id=p_writeoff_id for update;
  if not found then raise exception 'Hisobdan chiqarish topilmadi' using errcode='P0002'; end if;
  select branch_id into v_branch from public.locations where id=v_w.location_id; perform public.require_inventory_operator(v_branch);
  if v_w.status<>'draft' then raise exception 'Birlik faqat draft hujjatga qoвЂshiladi' using errcode='P0001'; end if;
  select * into v_u from public.inventory_units where upper(qr_code)=upper(btrim(p_code)) or upper(coalesce(serial_number,''))=upper(btrim(p_code)) for update;
  if not found then raise exception 'Birlik topilmadi' using errcode='P0002'; end if;
  if v_u.location_id<>v_w.location_id or v_u.status not in('available','returned') or v_u.active_transfer_id is not null then
    raise exception 'Birlik bu joyda erkin emas' using errcode='P0001'; end if;
  select coalesce(b.unit_cost,p.cost_price) into v_cost from public.products p left join public.stock_batches b on b.id=v_u.batch_id where p.id=v_u.product_id;
  insert into public.writeoff_lines(writeoff_id,product_id,unit_id,quantity,unit_cost)
  values(p_writeoff_id,v_u.product_id,v_u.id,1,v_cost) on conflict(writeoff_id,unit_id) do nothing;
  return jsonb_build_object('writeoff_id',p_writeoff_id,'unit_id',v_u.id,'product_id',v_u.product_id,'unit_cost',v_cost);
end $$;

create or replace function public.approve_writeoff(p_writeoff_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_w public.writeoffs%rowtype; v_branch uuid;
begin
  select * into v_w from public.writeoffs where id=p_writeoff_id for update;
  if not found then raise exception 'Hisobdan chiqarish topilmadi' using errcode='P0002'; end if;
  select branch_id into v_branch from public.locations where id=v_w.location_id;
  if not(public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager']::public.app_role[],v_branch)) then raise exception 'Menejer roli talab qilinadi' using errcode='42501'; end if;
  if v_w.status='approved' then return to_jsonb(v_w); end if;
  if v_w.status<>'draft' or not exists(select 1 from public.writeoff_lines where writeoff_id=p_writeoff_id) then raise exception 'BoвЂsh boвЂlmagan draft hujjat talab qilinadi' using errcode='P0001'; end if;
  update public.writeoffs set status='approved',approved_by=auth.uid() where id=p_writeoff_id returning * into v_w; return to_jsonb(v_w);
end $$;


