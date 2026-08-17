-- Complete business workflows omitted by the initial domain schema.
-- All client mutations are routed through explicitly granted SECURITY DEFINER RPCs.
begin;

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
  if jsonb_typeof(p_product)<>'object' or jsonb_typeof(p_attributes)<>'array' then raise exception 'Mahsulot formati noto‘g‘ri' using errcode='22023'; end if;
  begin
    v_id=nullif(p_product->>'id','')::uuid; v_status=coalesce(nullif(p_product->>'status','')::public.product_status,'draft');
    v_cost=coalesce((p_product->>'cost_price')::numeric,0); v_retail=(p_product->>'retail_price')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Mahsulot identifikatori yoki narxi noto‘g‘ri' using errcode='22023'; end;
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
  if v_name is null or length(v_name)>160 then raise exception 'Mijoz ismi noto‘g‘ri' using errcode='22023'; end if;
  if p_profile ? 'address' and jsonb_typeof(p_profile->'address')<>'object' then raise exception 'Manzil obyekt bo‘lishi kerak' using errcode='22023'; end if;
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
    raise exception 'Manzil identifikatori noto‘g‘ri' using errcode='22023'; end;
  if nullif(btrim(p_address->>'label'),'') is null or nullif(btrim(p_address->>'recipient_name'),'') is null
    or nullif(btrim(p_address->>'phone'),'') is null or jsonb_typeof(p_address->'address')<>'object' then
    raise exception 'Manzil maydonlari to‘liq emas' using errcode='22023'; end if;
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
  if coalesce(v_scope->>'mode','full') not in('full','scoped') then raise exception 'Scope mode full yoki scoped bo‘lishi kerak' using errcode='22023'; end if;
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
  if v_count.status<>'counting' then raise exception 'Faqat counting holati review ga o‘tadi' using errcode='P0001'; end if;
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
    raise exception 'Inventarizatsiya snapshotidan keyin birlik holati o‘zgargan' using errcode='40001';
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
        raise exception 'Kamomad birligi band yoki joyi o‘zgargan: %',v_unit.id using errcode='P0001'; end if;
      update public.inventory_units set location_id=v_writeoff,status='written_off',reserved_until=null,sold_sale_id=null,version=version+1 where id=v_unit.id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,
        unit_cost,reference_type,reference_id,reason,actor_id,metadata)
      values(v_unit.id,v_unit.product_id,v_unit.batch_id,'adjustment',v_count.location_id,v_writeoff,1,null,
        'inventory_count',p_count_id,'Inventarizatsiya kamomadi',auth.uid(),jsonb_build_object('variance',-1)) on conflict do nothing;
    elsif v_line.variance=1 then
      if v_unit.status not in('available','returned') or v_unit.active_transfer_id is not null then
        raise exception 'Ortiqcha birlik band: %',v_unit.id using errcode='P0001'; end if;
      if not exists(select 1 from public.locations l where l.id=v_unit.location_id and l.branch_id=v_branch) then
        raise exception 'Boshqa filial birligini inventarizatsiya bilan ko‘chirib bo‘lmaydi' using errcode='P0001'; end if;
      update public.inventory_units set location_id=v_count.location_id,status='available',reserved_until=null,version=version+1 where id=v_unit.id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,
        unit_cost,reference_type,reference_id,reason,actor_id,metadata)
      values(v_unit.id,v_unit.product_id,v_unit.batch_id,'adjustment',v_unit.location_id,v_count.location_id,1,null,
        'inventory_count',p_count_id,'Inventarizatsiya ortiqchasi',auth.uid(),jsonb_build_object('variance',1)) on conflict do nothing;
    else raise exception 'Individual birlik variance faqat -1, 0 yoki 1 bo‘lishi mumkin' using errcode='23514'; end if;
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
    notes=concat_ws(E'\n',notes,'Bekor qilish: '||coalesce(nullif(btrim(p_reason),''),'Sabab ko‘rsatilmagan'))
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
  if v_w.status<>'draft' then raise exception 'Birlik faqat draft hujjatga qo‘shiladi' using errcode='P0001'; end if;
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
  if v_w.status<>'draft' or not exists(select 1 from public.writeoff_lines where writeoff_id=p_writeoff_id) then raise exception 'Bo‘sh bo‘lmagan draft hujjat talab qilinadi' using errcode='P0001'; end if;
  update public.writeoffs set status='approved',approved_by=auth.uid() where id=p_writeoff_id returning * into v_w; return to_jsonb(v_w);
end $$;

create or replace function public.post_writeoff(p_writeoff_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_w public.writeoffs%rowtype; v_branch uuid; v_dest uuid; v_x record; v_u public.inventory_units%rowtype;
begin
  select * into v_w from public.writeoffs where id=p_writeoff_id for update;
  if not found then raise exception 'Hisobdan chiqarish topilmadi' using errcode='P0002'; end if;
  select branch_id into v_branch from public.locations where id=v_w.location_id; perform public.require_inventory_operator(v_branch);
  if v_w.status='posted' then return to_jsonb(v_w); end if;
  if v_w.status<>'approved' then raise exception 'Faqat approved hujjat post qilinadi' using errcode='P0001'; end if;
  select id into v_dest from public.locations where code='SYSTEM-WRITEOFF' for share;
  perform 1 from public.inventory_units u join public.writeoff_lines x on x.unit_id=u.id where x.writeoff_id=p_writeoff_id order by u.id for update of u;
  for v_x in select * from public.writeoff_lines where writeoff_id=p_writeoff_id order by unit_id loop
    select * into v_u from public.inventory_units where id=v_x.unit_id;
    if v_u.location_id<>v_w.location_id or v_u.status not in('available','returned') or v_u.active_transfer_id is not null then raise exception 'Birlik holati o‘zgargan: %',v_u.id using errcode='P0001'; end if;
    update public.inventory_units set location_id=v_dest,status='written_off',reserved_until=null,sold_sale_id=null,version=version+1 where id=v_u.id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,unit_cost,
      reference_type,reference_id,reason,actor_id) values(v_u.id,v_u.product_id,v_u.batch_id,'writeoff',v_w.location_id,v_dest,1,
      v_x.unit_cost,'writeoff',p_writeoff_id,v_w.reason,auth.uid()) on conflict do nothing;
  end loop;
  update public.writeoffs set status='posted',posted_at=now() where id=p_writeoff_id returning * into v_w; return to_jsonb(v_w);
end $$;

create or replace function public.cancel_writeoff(p_writeoff_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_w public.writeoffs%rowtype; v_branch uuid;
begin
  select * into v_w from public.writeoffs where id=p_writeoff_id for update;
  if not found then raise exception 'Hisobdan chiqarish topilmadi' using errcode='P0002'; end if;
  select branch_id into v_branch from public.locations where id=v_w.location_id; perform public.require_inventory_operator(v_branch);
  if v_w.status='cancelled' then return to_jsonb(v_w); end if;
  if v_w.status='posted' then raise exception 'Post qilingan hujjat bekor qilinmaydi' using errcode='P0001'; end if;
  update public.writeoffs set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),reason=reason||E'\nBekor qilish: '||coalesce(nullif(btrim(p_reason),''),'Sabab ko‘rsatilmagan')
  where id=p_writeoff_id returning * into v_w; return to_jsonb(v_w);
end $$;

-- -----------------------------------------------------------------------------
-- Returns/exchanges
-- -----------------------------------------------------------------------------

alter table public.sale_returns
  add column if not exists idempotency_key uuid,
  add column if not exists request_hash text,
  add column if not exists approved_at timestamptz,
  add column if not exists cancelled_by uuid references public.profiles(id) on delete restrict,
  add column if not exists cancelled_at timestamptz;
-- A physical unit may be sold again after a completed resellable return.
alter table public.sale_lines drop constraint if exists sale_lines_unit_id_key;
create unique index sale_lines_sale_unit_uidx on public.sale_lines(sale_id,unit_id);
create index sale_lines_unit_history_idx on public.sale_lines(unit_id,created_at desc);
create unique index sale_returns_branch_idempotency_uidx on public.sale_returns(branch_id,idempotency_key) where idempotency_key is not null;
create table public.sale_refunds(
  id uuid primary key default gen_random_uuid(),return_id uuid not null unique references public.sale_returns(id) on delete restrict,
  sale_id uuid not null references public.sales(id) on delete restrict,amount numeric(18,2) not null check(amount>=0),
  created_by uuid not null references public.profiles(id) on delete restrict,created_at timestamptz not null default now()
);
create index sale_refunds_sale_time_idx on public.sale_refunds(sale_id,created_at desc);
create trigger sale_refunds_immutable before update or delete on public.sale_refunds for each row execute function public.reject_mutation();
create trigger sale_return_lines_immutable before update or delete on public.sale_return_lines for each row execute function public.reject_mutation();
create unique index inventory_movements_return_unit_uidx on public.inventory_movements(reference_id,unit_id,movement_type)
  where reference_type='sale_return' and reference_id is not null and unit_id is not null and movement_type in('returned','writeoff');

-- Sale payment rows stay immutable except for the return workflow's monotonic refund status.
drop trigger if exists sale_payments_immutable on public.sale_payments;
create or replace function public.guard_sale_payment_refund_update()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or current_setting('texnobazar.complete_sale_return',true) is distinct from 'allowed'
    or old.id is distinct from new.id or old.sale_id is distinct from new.sale_id or old.payment_method_id is distinct from new.payment_method_id
    or old.amount is distinct from new.amount or old.external_reference is distinct from new.external_reference
    or old.received_by is distinct from new.received_by or old.paid_at is distinct from new.paid_at
    or old.metadata is distinct from new.metadata or old.created_at is distinct from new.created_at
    or not((old.status='paid' and new.status in('partially_refunded','refunded'))
      or (old.status='partially_refunded' and new.status='refunded') or old.status=new.status) then
    raise exception 'Sale payment o‘zgarmas; faqat refund status o‘tishi mumkin' using errcode='55000';
  end if;
  return new;
end $$;
create trigger sale_payments_refund_guard before update or delete on public.sale_payments
  for each row execute function public.guard_sale_payment_refund_update();
drop trigger if exists sale_payments_audit on public.sale_payments;
create trigger sale_payments_audit after insert or update on public.sale_payments
  for each row execute function public.audit_row_change();

create or replace function public.request_sale_return(p_sale_id uuid,p_kind public.return_kind,p_reason text,p_lines jsonb,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_sale public.sales%rowtype; v_id uuid:=gen_random_uuid(); v_hash text; v_row public.sale_returns%rowtype; v_item jsonb; v_line public.sale_lines%rowtype; v_total numeric(18,2):=0;
begin
  select * into v_sale from public.sales where id=p_sale_id for update;
  if not found then raise exception 'Sotuv topilmadi' using errcode='P0002'; end if; perform public.require_pos_seller(v_sale.branch_id);
  if v_sale.status in('returned','void') then raise exception 'Sotuv qaytarish uchun yopilgan' using errcode='P0001'; end if;
  if p_idempotency_key is null or nullif(btrim(p_reason),'') is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'Qaytarish ma’lumotlari noto‘g‘ri' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_lines)e group by (e->>'sale_line_id')::uuid having count(*)>1) then raise exception 'Sotuv qatori takrorlangan' using errcode='22023'; end if;
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('sale_id',p_sale_id,'kind',p_kind,'reason',btrim(p_reason),'lines',p_lines)::text,'UTF8'),'sha256'),'hex');
  select * into v_row from public.sale_returns where branch_id=v_sale.branch_id and idempotency_key=p_idempotency_key;
  if found then if v_row.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa qaytarishda ishlatilgan' using errcode='22023'; end if; return to_jsonb(v_row); end if;
  insert into public.sale_returns(id,return_no,original_sale_id,kind,status,branch_id,customer_id,reason,refund_amount,requested_by,idempotency_key,request_hash)
  values(v_id,'RET-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8)),p_sale_id,p_kind,'requested',v_sale.branch_id,v_sale.customer_id,btrim(p_reason),0,auth.uid(),p_idempotency_key,v_hash);
  for v_item in select value from jsonb_array_elements(p_lines) order by (value->>'sale_line_id')::uuid loop
    select * into v_line from public.sale_lines where id=(v_item->>'sale_line_id')::uuid and sale_id=p_sale_id;
    if not found then raise exception 'Sotuv qatori topilmadi' using errcode='P0002'; end if;
    if coalesce(v_item->>'condition','') not in('resellable','damaged','defective') then raise exception 'Qaytarish condition noto‘g‘ri' using errcode='22023'; end if;
    if exists(select 1 from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id
      where x.sale_line_id=v_line.id and r.status in('requested','approved','completed')) then raise exception 'Bu birlik avval qaytarilgan yoki jarayonda' using errcode='P0001'; end if;
    if (v_item->>'refund_amount')::numeric<0 or (v_item->>'refund_amount')::numeric>v_line.line_total then raise exception 'Refund summasi qator summasidan oshdi' using errcode='22023'; end if;
    insert into public.sale_return_lines(return_id,sale_line_id,unit_id,quantity,condition,refund_amount)
    values(v_id,v_line.id,v_line.unit_id,1,v_item->>'condition',(v_item->>'refund_amount')::numeric);
    v_total=v_total+(v_item->>'refund_amount')::numeric;
  end loop;
  update public.sale_returns set refund_amount=v_total where id=v_id returning * into v_row; return to_jsonb(v_row);
end $$;

create or replace function public.approve_sale_return(p_return_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.sale_returns%rowtype;
begin
  select * into v_r from public.sale_returns where id=p_return_id for update;
  if not found then raise exception 'Qaytarish topilmadi' using errcode='P0002'; end if; perform public.require_pos_manager(v_r.branch_id);
  if v_r.status='approved' then return to_jsonb(v_r); end if;
  if v_r.status<>'requested' then raise exception 'Faqat requested qaytarish tasdiqlanadi' using errcode='P0001'; end if;
  update public.sale_returns set status='approved',approved_by=auth.uid(),approved_at=now() where id=p_return_id returning * into v_r; return to_jsonb(v_r);
end $$;

create or replace function public.complete_sale_return(p_return_id uuid,p_resell_location_id uuid,p_replacement_sale_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.sale_returns%rowtype; v_sale public.sales%rowtype; v_x record; v_u public.inventory_units%rowtype; v_dest uuid; v_writeoff uuid; v_completed integer; v_all integer; v_paid numeric(18,2);
begin
  select * into v_r from public.sale_returns where id=p_return_id for update;
  if not found then raise exception 'Qaytarish topilmadi' using errcode='P0002'; end if; perform public.require_pos_manager(v_r.branch_id);
  if v_r.status='completed' then return to_jsonb(v_r); end if;
  if v_r.status<>'approved' then raise exception 'Faqat approved qaytarish yakunlanadi' using errcode='P0001'; end if;
  select * into v_sale from public.sales where id=v_r.original_sale_id for update;
  select id into v_dest from public.locations where id=p_resell_location_id and branch_id=v_r.branch_id and is_active and type in('store','warehouse');
  if v_dest is null then raise exception 'Qayta sotish joyi filialga mos emas' using errcode='P0002'; end if;
  if p_replacement_sale_id is not null then
    if v_r.kind<>'exchange' then raise exception 'Oddiy return replacement sale qabul qilmaydi' using errcode='22023'; end if;
    if not exists(select 1 from public.sales where id=p_replacement_sale_id and branch_id=v_r.branch_id and status='completed') then
      raise exception 'Replacement sale shu filialdagi yakunlangan sotuv bo‘lishi kerak' using errcode='22023'; end if;
  end if;
  select id into v_writeoff from public.locations where code='SYSTEM-WRITEOFF' for share;
  perform 1 from public.inventory_units u join public.sale_return_lines x on x.unit_id=u.id where x.return_id=p_return_id order by u.id for update of u;
  for v_x in select x.*,sl.product_id,sl.unit_cost from public.sale_return_lines x join public.sale_lines sl on sl.id=x.sale_line_id where x.return_id=p_return_id order by x.unit_id loop
    select * into v_u from public.inventory_units where id=v_x.unit_id;
    if v_u.status<>'sold' or v_u.sold_sale_id is distinct from v_r.original_sale_id then raise exception 'Sotilgan birlik holati qaytarishga mos emas: %',v_u.id using errcode='P0001'; end if;
    if v_x.condition='resellable' then
      update public.inventory_units set location_id=v_dest,status='available',sold_sale_id=null,reserved_until=null,version=version+1 where id=v_u.id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,unit_cost,reference_type,reference_id,reason,actor_id,metadata)
      values(v_u.id,v_u.product_id,v_u.batch_id,'returned',v_u.location_id,v_dest,1,v_x.unit_cost,'sale_return',p_return_id,v_r.reason,auth.uid(),jsonb_build_object('condition',v_x.condition)) on conflict do nothing;
    else
      update public.inventory_units set location_id=v_writeoff,status='written_off',sold_sale_id=null,reserved_until=null,version=version+1 where id=v_u.id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,unit_cost,reference_type,reference_id,reason,actor_id,metadata)
      values(v_u.id,v_u.product_id,v_u.batch_id,'writeoff',v_u.location_id,v_writeoff,1,v_x.unit_cost,'sale_return',p_return_id,v_r.reason,auth.uid(),jsonb_build_object('condition',v_x.condition)) on conflict do nothing;
    end if;
  end loop;
  update public.sale_returns set status='completed',replacement_sale_id=p_replacement_sale_id,completed_at=now() where id=p_return_id returning * into v_r;
  insert into public.sale_refunds(return_id,sale_id,amount,created_by)
    values(v_r.id,v_r.original_sale_id,v_r.refund_amount,auth.uid()) on conflict(return_id) do nothing;
  select count(*) into v_all from public.sale_lines where sale_id=v_r.original_sale_id;
  select count(distinct x.sale_line_id) into v_completed from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id where r.original_sale_id=v_r.original_sale_id and r.status='completed';
  update public.sales set status=case when v_completed>=v_all then 'returned'::public.sale_status else 'partially_returned'::public.sale_status end where id=v_r.original_sale_id;
  select coalesce(sum(refund_amount),0) into v_paid from public.sale_returns where original_sale_id=v_r.original_sale_id and status='completed';
  perform set_config('texnobazar.complete_sale_return','allowed',true);
  update public.sale_payments set status=case when v_paid>=v_sale.total then 'refunded'::public.payment_status else 'partially_refunded'::public.payment_status end where sale_id=v_r.original_sale_id and status in('paid','partially_refunded');
  perform set_config('texnobazar.complete_sale_return','',true);
  return to_jsonb(v_r);
end $$;

create or replace function public.cancel_sale_return(p_return_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.sale_returns%rowtype;
begin
  select * into v_r from public.sale_returns where id=p_return_id for update;
  if not found then raise exception 'Qaytarish topilmadi' using errcode='P0002'; end if; perform public.require_pos_manager(v_r.branch_id);
  if v_r.status='cancelled' then return to_jsonb(v_r); end if;
  if v_r.status='completed' then raise exception 'Yakunlangan qaytarish bekor qilinmaydi' using errcode='P0001'; end if;
  update public.sale_returns set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),reason=reason||E'\nBekor qilish: '||coalesce(nullif(btrim(p_reason),''),'Sabab ko‘rsatilmagan') where id=p_return_id returning * into v_r; return to_jsonb(v_r);
end $$;

-- -----------------------------------------------------------------------------
-- Online fulfillment, delivery, courier, notifications
-- -----------------------------------------------------------------------------

alter table public.orders add column if not exists request_hash text;
alter table public.sales add column if not exists order_id uuid references public.orders(id) on delete restrict;
create unique index sales_order_uidx on public.sales(order_id) where order_id is not null;

create table public.order_reserved_units(
  id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete restrict,
  order_line_id uuid not null references public.order_lines(id) on delete restrict,
  unit_id uuid not null references public.inventory_units(id) on delete restrict,
  reserved_by uuid not null references public.profiles(id) on delete restrict,reserved_at timestamptz not null default now(),
  released_at timestamptz,released_by uuid references public.profiles(id) on delete restrict,
  fulfilled_at timestamptz,created_at timestamptz not null default now(),unique(order_id,unit_id),
  check(not(released_at is not null and fulfilled_at is not null)),
  check((released_at is null)=(released_by is null))
);
create unique index order_reserved_units_active_unit_uidx on public.order_reserved_units(unit_id) where released_at is null and fulfilled_at is null;
create index order_reserved_units_order_idx on public.order_reserved_units(order_id,order_line_id,unit_id);
-- Reservation identity is immutable; only one-time release/fulfillment stamps may change.
create or replace function public.guard_order_reserved_unit()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or old.order_id is distinct from new.order_id or old.order_line_id is distinct from new.order_line_id
    or old.unit_id is distinct from new.unit_id or old.reserved_by is distinct from new.reserved_by
    or old.reserved_at is distinct from new.reserved_at or old.created_at is distinct from new.created_at
    or (old.released_at is not null and (new.released_at is distinct from old.released_at or new.released_by is distinct from old.released_by))
    or (old.fulfilled_at is not null and new.fulfilled_at is distinct from old.fulfilled_at)
    or (new.released_at is not null and new.fulfilled_at is not null) then
    raise exception 'Order rezerv ledgeri o‘zgarmas' using errcode='55000'; end if;
  return new;
end $$;
create trigger order_reserved_units_guard before update or delete on public.order_reserved_units for each row execute function public.guard_order_reserved_unit();
create unique index inventory_movements_order_reservation_uidx on public.inventory_movements(reference_id,unit_id,movement_type)
  where reference_type='online_order' and reference_id is not null and unit_id is not null and movement_type in('reserved','reservation_released','sold');

create or replace function public.enqueue_order_notification(p_order_id uuid,p_title text,p_body text,p_data jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare v_recipient uuid;
begin
  select p.id into v_recipient from public.orders o join public.profiles p on p.id=o.customer_user_id where o.id=p_order_id;
  if v_recipient is not null then insert into public.notifications(recipient_id,channel,title,body,data,sent_at)
    values(v_recipient,'in_app',p_title,p_body,coalesce(p_data,'{}'::jsonb)||jsonb_build_object('order_id',p_order_id),now()); end if;
end $$;

create or replace function public.create_online_order(p_customer jsonb,p_shipping_address jsonb,p_lines jsonb,p_payment_method_code text,p_idempotency_key text default null,p_notes text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_order uuid:=gen_random_uuid(); v_line jsonb; v_product record; v_subtotal numeric(18,2):=0; v_qty integer; v_method uuid; v_existing public.orders%rowtype; v_hash text; v_customer_id uuid;
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
    'lines',(select jsonb_agg(jsonb_build_object('product_id',(e->>'product_id')::uuid,'quantity',(e->>'quantity')::integer)
      order by (e->>'product_id')::uuid) from jsonb_array_elements(p_lines)e),'payment_method_code',lower(btrim(p_payment_method_code)),
    'notes',nullif(btrim(p_notes),''))::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.orders where idempotency_key=p_idempotency_key;
  if found then if v_existing.request_hash is distinct from v_hash or v_existing.customer_user_id is distinct from auth.uid() then raise exception 'Takroriy kalit boshqa buyurtmaga tegishli' using errcode='22023'; end if; return v_existing.id; end if;
  if auth.uid() is not null then select id into v_customer_id from public.customers where auth_user_id=auth.uid(); end if;
  insert into public.orders(id,order_no,customer_id,customer_user_id,status,customer_name,customer_phone,customer_email,
    shipping_address,notes,subtotal,total,payment_method_id,idempotency_key,request_hash)
  values(v_order,'ORD-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_order::text,1,8)),v_customer_id,
    auth.uid(),'new',btrim(p_customer->>'name'),btrim(p_customer->>'phone'),nullif(btrim(p_customer->>'email'),'')::extensions.citext,
    p_shipping_address,nullif(btrim(p_notes),''),0,0,v_method,p_idempotency_key,v_hash);
  for v_line in select value from jsonb_array_elements(p_lines) order by (value->>'product_id')::uuid loop
    v_qty=(v_line->>'quantity')::integer;
    select id,name,sku,coalesce(promotion_price,retail_price) sale_price into v_product from public.products
      where id=(v_line->>'product_id')::uuid and status='active' and is_published for share;
    if not found then raise exception 'Mahsulot mavjud emas' using errcode='P0002'; end if;
    insert into public.order_lines(order_id,product_id,product_name,sku,quantity,unit_price,discount,line_total)
    values(v_order,v_product.id,v_product.name,v_product.sku,v_qty,v_product.sale_price,0,round(v_qty*v_product.sale_price,2));
    v_subtotal=v_subtotal+round(v_qty*v_product.sale_price,2);
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
declare v_o public.orders%rowtype; v_line record; v_u record; v_needed integer; v_count integer:=0; v_location_branch uuid;
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
  for v_line in select * from public.order_lines where order_id=p_order_id order by product_id,id loop
    if v_line.quantity<>trunc(v_line.quantity) then raise exception 'Individual birlik modeli butun miqdor talab qiladi' using errcode='23514'; end if;
    v_needed=v_line.quantity::integer;
    perform 1 from public.inventory_units u join public.locations l on l.id=u.location_id
      where u.product_id=v_line.product_id and l.branch_id=p_branch_id and l.is_active and l.type in('store','warehouse')
        and u.status='available' and u.active_transfer_id is null
      order by u.id limit v_needed for update of u;
    if (select count(*) from public.inventory_units u join public.locations l on l.id=u.location_id
      where u.product_id=v_line.product_id and l.branch_id=p_branch_id and l.is_active and l.type in('store','warehouse')
        and u.status='available' and u.active_transfer_id is null)<v_needed then raise exception 'Mahsulot zaxirasi yetarli emas: %',v_line.product_id using errcode='P0001'; end if;
    for v_u in select u.* from public.inventory_units u join public.locations l on l.id=u.location_id
      where u.product_id=v_line.product_id and l.branch_id=p_branch_id and l.is_active and l.type in('store','warehouse')
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

create or replace function public.transition_online_order(p_order_id uuid,p_target public.order_status,p_branch_id uuid default null,p_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_o public.orders%rowtype; v_old public.order_status; v_branch uuid; v_reserved integer;
begin
  select * into v_o from public.orders where id=p_order_id for update;
  if not found then raise exception 'Buyurtma topilmadi' using errcode='P0002'; end if;
  v_branch=coalesce(v_o.branch_id,p_branch_id);
  if v_branch is null then raise exception 'Filial identifikatori talab qilinadi' using errcode='22023'; end if;
  if not(public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager','warehouse']::public.app_role[],v_branch)) then raise exception 'Fulfillment roli talab qilinadi' using errcode='42501'; end if;
  if v_o.status=p_target then return to_jsonb(v_o); end if;
  if not((v_o.status='new' and p_target='confirmed') or (v_o.status='confirmed' and p_target='processing') or (v_o.status='processing' and p_target='ready')) then raise exception 'Online buyurtma status o‘tishi noto‘g‘ri' using errcode='P0001'; end if;
  if p_target='confirmed' then v_reserved=public.reserve_online_order_units(p_order_id,v_branch); end if;
  v_old=v_o.status; update public.orders set branch_id=v_branch,status=p_target where id=p_order_id returning * into v_o;
  insert into public.order_status_history(order_id,from_status,to_status,note,actor_id) values(p_order_id,v_old,p_target,nullif(btrim(p_note),''),auth.uid());
  perform public.enqueue_order_notification(p_order_id,'Buyurtma holati yangilandi','Buyurtma holati: '||p_target::text,jsonb_build_object('status',p_target));
  return to_jsonb(v_o)||jsonb_build_object('reserved_units',(select count(*) from public.order_reserved_units where order_id=p_order_id and released_at is null and fulfilled_at is null));
end $$;

create or replace function public.cancel_online_order(p_order_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_o public.orders%rowtype; v_x record;
begin
  select * into v_o from public.orders where id=p_order_id for update;
  if not found then raise exception 'Buyurtma topilmadi' using errcode='P0002'; end if;
  if v_o.customer_user_id=auth.uid() then
    if v_o.status not in('new','confirmed') then raise exception 'Mijoz bu bosqichda bekor qila olmaydi' using errcode='P0001'; end if;
  elsif v_o.branch_id is null or not(public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager']::public.app_role[],v_o.branch_id)) then raise exception 'Bekor qilish ruxsati yo‘q' using errcode='42501'; end if;
  if v_o.status='cancelled' then return to_jsonb(v_o); end if;
  if v_o.status in('shipped','delivered','returned') then raise exception 'Jo‘natilgan/yakunlangan buyurtma bekor qilinmaydi' using errcode='P0001'; end if;
  perform 1 from public.inventory_units u join public.order_reserved_units r on r.unit_id=u.id where r.order_id=p_order_id and r.released_at is null and r.fulfilled_at is null order by u.id for update of u;
  for v_x in select r.*,u.product_id,u.batch_id,u.location_id,u.status from public.order_reserved_units r join public.inventory_units u on u.id=r.unit_id where r.order_id=p_order_id and r.released_at is null and r.fulfilled_at is null order by u.id loop
    if v_x.status='reserved' then update public.inventory_units set status='available',reserved_until=null,version=version+1 where id=v_x.unit_id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,reference_type,reference_id,reason,actor_id)
      values(v_x.unit_id,v_x.product_id,v_x.batch_id,'reservation_released',v_x.location_id,v_x.location_id,1,'online_order',p_order_id,nullif(btrim(p_reason),''),auth.uid()) on conflict do nothing; end if;
    update public.order_reserved_units set released_at=now(),released_by=auth.uid() where id=v_x.id;
  end loop;
  update public.deliveries set status='cancelled' where order_id=p_order_id and status not in('delivered','cancelled');
  insert into public.order_status_history(order_id,from_status,to_status,note,actor_id) values(p_order_id,v_o.status,'cancelled',nullif(btrim(p_reason),''),auth.uid());
  update public.orders set status='cancelled' where id=p_order_id returning * into v_o;
  perform public.enqueue_order_notification(p_order_id,'Buyurtma bekor qilindi',coalesce(nullif(btrim(p_reason),''),'Buyurtma bekor qilindi'),jsonb_build_object('status','cancelled'));
  return to_jsonb(v_o);
end $$;

create or replace function public.assign_order_courier(p_order_id uuid,p_courier_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_o public.orders%rowtype; v_d public.deliveries%rowtype; v_old public.order_status;
begin
  select * into v_o from public.orders where id=p_order_id for update;
  if not found then raise exception 'Buyurtma topilmadi' using errcode='P0002'; end if;
  if v_o.branch_id is null or not(public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager']::public.app_role[],v_o.branch_id)) then raise exception 'Filial menejeri roli talab qilinadi' using errcode='42501'; end if;
  if v_o.status not in('ready','assigned') then raise exception 'Faqat ready buyurtma kuryerga beriladi' using errcode='P0001'; end if;
  if not exists(select 1 from public.profiles p join public.profile_roles r on r.profile_id=p.id where p.id=p_courier_id and p.is_active and r.role='courier' and r.branch_id=v_o.branch_id) then raise exception 'Faol filial kuryeri topilmadi' using errcode='P0002'; end if;
  select * into v_d from public.deliveries where order_id=p_order_id for update;
  if found and v_o.status='assigned' and v_d.courier_id=p_courier_id and v_d.status='assigned' then return to_jsonb(v_d); end if;
  insert into public.deliveries(order_id,courier_id,status,tracking_code,assigned_at)
  values(p_order_id,p_courier_id,'assigned','DLV-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(p_order_id::text,1,8)),now())
  on conflict(order_id) do update set courier_id=excluded.courier_id,status='assigned',assigned_at=now(),proof_url=null,recipient_note=null
  returning * into v_d;
  if v_o.status<>'assigned' then v_old=v_o.status; update public.orders set status='assigned' where id=p_order_id;
    insert into public.order_status_history(order_id,from_status,to_status,note,actor_id) values(p_order_id,v_old,'assigned','Kuryer biriktirildi',auth.uid()); end if;
  insert into public.notifications(recipient_id,title,body,data,sent_at) values(p_courier_id,'Yangi yetkazib berish','Sizga buyurtma biriktirildi',jsonb_build_object('order_id',p_order_id,'delivery_id',v_d.id),now());
  perform public.enqueue_order_notification(p_order_id,'Kuryer biriktirildi','Buyurtmangiz kuryerga topshirishga tayyor',jsonb_build_object('status','assigned','tracking_code',v_d.tracking_code));
  return to_jsonb(v_d);
end $$;

create or replace function public.finalize_online_order_sale(p_order_id uuid,p_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_o public.orders%rowtype; v_sale uuid; v_x record; v_cost numeric(18,2); v_total numeric(18,2):=0;
begin
  select * into v_o from public.orders where id=p_order_id for update;
  select id into v_sale from public.sales where order_id=p_order_id; if v_sale is not null then return v_sale; end if;
  perform 1 from public.inventory_units u join public.order_reserved_units r on r.unit_id=u.id where r.order_id=p_order_id and r.released_at is null and r.fulfilled_at is null order by u.id for update of u;
  if not exists(select 1 from public.order_reserved_units where order_id=p_order_id and released_at is null and fulfilled_at is null) then raise exception 'Buyurtma rezervlari topilmadi' using errcode='P0001'; end if;
  v_sale=gen_random_uuid();
  insert into public.sales(id,sale_no,branch_id,seller_id,manager_id,customer_id,order_id,status,subtotal,discount,tax,total)
  values(v_sale,'WEB-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_sale::text,1,8)),v_o.branch_id,p_actor,null,v_o.customer_id,p_order_id,'completed',v_o.subtotal,v_o.discount,0,v_o.subtotal-v_o.discount);
  perform set_config('texnobazar.manager_confirm_sale','allowed',true);
  for v_x in select r.id reservation_id,r.unit_id,r.order_line_id,u.product_id,u.batch_id,u.location_id,u.status,
      ol.unit_price,ol.discount,coalesce(sb.unit_cost,p.cost_price) unit_cost
    from public.order_reserved_units r join public.inventory_units u on u.id=r.unit_id join public.order_lines ol on ol.id=r.order_line_id
    join public.products p on p.id=u.product_id left join public.stock_batches sb on sb.id=u.batch_id
    where r.order_id=p_order_id and r.released_at is null and r.fulfilled_at is null order by u.id loop
    if v_x.status<>'reserved' then raise exception 'Online rezerv birligi band emas: %',v_x.unit_id using errcode='P0001'; end if;
    insert into public.sale_lines(sale_id,product_id,unit_id,quantity,unit_cost,unit_price,discount,tax,line_total)
    values(v_sale,v_x.product_id,v_x.unit_id,1,v_x.unit_cost,v_x.unit_price,0,0,v_x.unit_price);
    update public.inventory_units set status='sold',sold_sale_id=v_sale,reserved_until=null,version=version+1 where id=v_x.unit_id;
    update public.order_reserved_units set fulfilled_at=now() where id=v_x.reservation_id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,quantity,unit_cost,reference_type,reference_id,actor_id)
    values(v_x.unit_id,v_x.product_id,v_x.batch_id,'sold',v_x.location_id,1,v_x.unit_cost,'online_order',p_order_id,p_actor) on conflict do nothing;
    v_total=v_total+v_x.unit_price;
  end loop;
  perform set_config('texnobazar.manager_confirm_sale','',true);
  insert into public.sale_payments(sale_id,payment_method_id,amount,status,received_by,metadata)
  values(v_sale,v_o.payment_method_id,v_total,'paid',p_actor,jsonb_build_object('online_order_id',p_order_id));
  update public.orders set payment_status='paid' where id=p_order_id;
  return v_sale;
exception when unique_violation then select id into v_sale from public.sales where order_id=p_order_id; if v_sale is not null then return v_sale; end if; raise;
end $$;

create or replace function public.list_courier_deliveries(p_status public.delivery_status default null,p_limit integer default 30,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb; v_total bigint;
begin
  if auth.uid() is null or not public.current_user_active() or not exists(select 1 from public.profile_roles where profile_id=auth.uid() and role='courier') then raise exception 'Faol kuryer roli talab qilinadi' using errcode='42501'; end if;
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  select count(*) into v_total from public.deliveries where courier_id=auth.uid() and (p_status is null or status=p_status);
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb) into v_items from(
    select d.id,d.order_id,d.status,d.tracking_code,d.assigned_at,d.picked_up_at,d.delivered_at,d.proof_url,d.created_at,
      o.order_no,o.customer_name,o.customer_phone,o.shipping_address,o.total,o.payment_status,o.notes,
      coalesce((select jsonb_agg(jsonb_build_object('product_name',l.product_name,'sku',l.sku,'quantity',l.quantity) order by l.id) from public.order_lines l where l.order_id=o.id),'[]'::jsonb) lines
    from public.deliveries d join public.orders o on o.id=d.order_id where d.courier_id=auth.uid() and (p_status is null or d.status=p_status)
    order by d.created_at desc limit p_limit offset p_offset)q;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

create or replace function public.business_day_start(p_date date)
returns timestamptz language sql immutable set search_path='' as $$
  select p_date::timestamp without time zone at time zone 'Asia/Tashkent';
$$;

create or replace function public.get_courier_stats(p_from date default (now() at time zone 'Asia/Tashkent')::date,p_to date default (now() at time zone 'Asia/Tashkent')::date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.current_user_active() or not exists(select 1 from public.profile_roles where profile_id=auth.uid() and role='courier') then raise exception 'Faol kuryer roli talab qilinadi' using errcode='42501'; end if;
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>366 then raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023'; end if;
  return (select jsonb_build_object('assigned',count(*),'delivered',count(*) filter(where status='delivered'),
    'failed',count(*) filter(where status='failed'),'active',count(*) filter(where status in('assigned','picked_up','in_transit')),
    'delivery_rate',case when count(*) filter(where status in('delivered','failed'))=0 then 0 else round(100.0*count(*) filter(where status='delivered')/count(*) filter(where status in('delivered','failed')),2) end)
    from public.deliveries where courier_id=auth.uid() and created_at>=public.business_day_start(p_from) and created_at<public.business_day_start(p_to+1));
end $$;

create or replace function public.insert_courier_tracking(p_delivery_id uuid,p_latitude numeric,p_longitude numeric,p_accuracy_m numeric default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare v_id bigint;
begin
  if not exists(select 1 from public.deliveries d where d.id=p_delivery_id and d.courier_id=auth.uid() and d.status in('assigned','picked_up','in_transit'))
    or not public.current_user_active() then raise exception 'Faol yetkazib berish topilmadi' using errcode='42501'; end if;
  if p_latitude not between -90 and 90 or p_longitude not between -180 and 180 or (p_accuracy_m is not null and p_accuracy_m<0) then raise exception 'Koordinata noto‘g‘ri' using errcode='22023'; end if;
  insert into public.courier_tracking(delivery_id,courier_id,latitude,longitude,accuracy_m) values(p_delivery_id,auth.uid(),p_latitude,p_longitude,p_accuracy_m) returning id into v_id; return v_id;
end $$;

create table public.delivery_proofs(
  id uuid primary key default gen_random_uuid(),delivery_id uuid not null references public.deliveries(id) on delete cascade,
  courier_id uuid not null references public.profiles(id) on delete restrict,r2_key text not null unique,
  public_url text not null check(public_url ~ '^https://'),mime_type text not null check(mime_type in('image/jpeg','image/png','image/webp','image/avif')),
  bytes bigint not null check(bytes between 1 and 10485760),status text not null default 'pending' check(status in('pending','verified','consumed','delete_pending','deleted')),
  created_at timestamptz not null default now(),verified_at timestamptz,consumed_at timestamptz,deleted_at timestamptz
);
create index delivery_proofs_delivery_idx on public.delivery_proofs(delivery_id,created_at desc);
create unique index delivery_proofs_consumed_delivery_uidx on public.delivery_proofs(delivery_id) where status='consumed';
alter table public.delivery_proofs enable row level security;
revoke all on public.delivery_proofs from public,anon,authenticated;
grant all on public.delivery_proofs to service_role;

drop function if exists public.courier_update_delivery_status(uuid,public.delivery_status,text,text);
create or replace function public.courier_update_delivery_status(p_delivery_id uuid,p_status public.delivery_status,p_note text default null,p_proof_id uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_d public.deliveries%rowtype; v_o public.orders%rowtype; v_p public.delivery_proofs%rowtype; v_order_status public.order_status; v_sale uuid; v_order_id uuid;
begin
  select order_id into v_order_id from public.deliveries where id=p_delivery_id;
  if not found then raise exception 'Yetkazib berish topilmadi' using errcode='P0002'; end if;
  select * into v_o from public.orders where id=v_order_id for update;
  select * into v_d from public.deliveries where id=p_delivery_id for update;
  if not found or v_d.order_id<>v_order_id or v_d.courier_id<>auth.uid() or not public.current_user_active() or not exists(select 1 from public.profile_roles r where r.profile_id=auth.uid() and r.role='courier' and r.branch_id=v_o.branch_id) then raise exception 'Faol biriktirilgan kuryer talab qilinadi' using errcode='42501'; end if;
  if v_d.status=p_status then return; end if;
  if not((v_d.status='assigned' and p_status='picked_up') or (v_d.status='picked_up' and p_status='in_transit') or (v_d.status='in_transit' and p_status in('delivered','failed'))) then raise exception 'Yetkazib berish status o‘tishi noto‘g‘ri' using errcode='P0001'; end if;
  if p_status='delivered' then
    if p_proof_id is null then raise exception 'Tasdiqlangan proof ID talab qilinadi' using errcode='22023'; end if;
    select * into v_p from public.delivery_proofs where id=p_proof_id and delivery_id=p_delivery_id and courier_id=auth.uid() and status='verified' for update;
    if not found then raise exception 'Tasdiqlangan yetkazish isboti topilmadi' using errcode='P0002'; end if;
  end if;
  if p_status='failed' and nullif(btrim(p_note),'') is null then raise exception 'Muvaffaqiyatsizlik sababi talab qilinadi' using errcode='22023'; end if;
  update public.deliveries set status=p_status,picked_up_at=case when p_status='picked_up' then now() else picked_up_at end,
    delivered_at=case when p_status='delivered' then now() else delivered_at end,
    proof_url=case when p_status='delivered' then v_p.public_url else proof_url end,recipient_note=coalesce(nullif(btrim(p_note),''),recipient_note)
  where id=p_delivery_id;
  v_order_status=case when p_status in('picked_up','in_transit') then 'shipped'::public.order_status when p_status='delivered' then 'delivered'::public.order_status else 'processing'::public.order_status end;
  if p_status='delivered' then
    v_sale=public.finalize_online_order_sale(v_d.order_id,auth.uid());
    update public.delivery_proofs set status='consumed',consumed_at=now() where id=v_p.id;
  end if;
  update public.orders set status=v_order_status where id=v_d.order_id;
  insert into public.order_status_history(order_id,from_status,to_status,note,actor_id) values(v_d.order_id,v_o.status,v_order_status,nullif(btrim(p_note),''),auth.uid());
  perform public.enqueue_order_notification(v_d.order_id,case when p_status='delivered' then 'Buyurtma yetkazildi' when p_status='failed' then 'Yetkazib berish amalga oshmadi' else 'Yetkazib berish yangilandi' end,
    coalesce(nullif(btrim(p_note),''),'Yetkazib berish holati: '||p_status::text),jsonb_build_object('delivery_status',p_status,'proof_url',v_p.public_url,'proof_id',p_proof_id,'sale_id',v_sale));
end $$;

create or replace function public.list_notifications(p_unread_only boolean default false,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  return jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from(
    select id,channel,title,body,data,read_at,sent_at,created_at from public.notifications where recipient_id=auth.uid()
      and (not p_unread_only or read_at is null) order by created_at desc limit p_limit offset p_offset)q),'[]'::jsonb),
    'unread_count',(select count(*) from public.notifications where recipient_id=auth.uid() and read_at is null));
end $$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if auth.uid() is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  update public.notifications set read_at=coalesce(read_at,now()) where recipient_id=auth.uid() and read_at is null and (p_ids is null or id=any(p_ids));
  get diagnostics v_count=row_count; return v_count;
end $$;

-- -----------------------------------------------------------------------------
-- Finance, supplier ledger, payroll
-- -----------------------------------------------------------------------------

alter table public.finance_transactions
  add column if not exists idempotency_key uuid,
  add column if not exists request_hash text;
create unique index finance_transactions_account_idempotency_uidx on public.finance_transactions(account_id,idempotency_key) where idempotency_key is not null;
create trigger finance_transactions_immutable before update or delete on public.finance_transactions for each row execute function public.reject_mutation();

create table public.supplier_payments(
  id uuid primary key default gen_random_uuid(),supplier_id uuid not null references public.suppliers(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,account_id uuid not null references public.finance_accounts(id) on delete restrict,
  amount numeric(18,2) not null check(amount>0),currency char(3) not null check(currency ~ '^[A-Z]{3}$'),
  method text not null check(length(btrim(method)) between 2 and 64),reference text,notes text,idempotency_key uuid not null,
  finance_transaction_id uuid not null unique references public.finance_transactions(id) on delete restrict,
  paid_at timestamptz not null default now(),created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),unique(supplier_id,branch_id,idempotency_key)
);
create index supplier_payments_supplier_time_idx on public.supplier_payments(supplier_id,paid_at desc);

create table public.supplier_returns(
  id uuid primary key default gen_random_uuid(),return_no text not null unique,supplier_id uuid not null references public.suppliers(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,from_location_id uuid not null references public.locations(id) on delete restrict,
  status text not null default 'draft' check(status in('draft','posted','cancelled')),reason text not null,
  total_amount numeric(18,2) not null default 0 check(total_amount>=0),idempotency_key uuid not null,request_hash text not null,
  created_by uuid not null references public.profiles(id) on delete restrict,posted_by uuid references public.profiles(id) on delete restrict,
  posted_at timestamptz,cancelled_by uuid references public.profiles(id) on delete restrict,cancelled_at timestamptz,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(branch_id,idempotency_key)
);
create table public.supplier_return_lines(
  id uuid primary key default gen_random_uuid(),supplier_return_id uuid not null references public.supplier_returns(id) on delete restrict,
  unit_id uuid not null references public.inventory_units(id) on delete restrict,product_id uuid not null references public.products(id) on delete restrict,
  unit_cost numeric(18,2) not null check(unit_cost>=0),created_at timestamptz not null default now(),unique(supplier_return_id,unit_id)
);
create index supplier_returns_supplier_time_idx on public.supplier_returns(supplier_id,created_at desc);
create trigger supplier_returns_set_updated_at before update on public.supplier_returns for each row execute function public.set_updated_at();
create trigger supplier_payments_immutable before update or delete on public.supplier_payments for each row execute function public.reject_mutation();
create trigger supplier_return_lines_immutable before update or delete on public.supplier_return_lines for each row execute function public.reject_mutation();
create unique index inventory_movements_supplier_return_uidx on public.inventory_movements(reference_id,unit_id,movement_type)
  where reference_type='supplier_return' and reference_id is not null and unit_id is not null and movement_type in('reserved','reservation_released','adjustment');

create or replace function public.accrue_supplier_balance_from_receipt_line()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.receipt_id is not null and new.supplier_id is not null then
    update public.suppliers set balance=balance+(new.quantity*new.unit_cost) where id=new.supplier_id;
  end if;
  return new;
end $$;
create trigger stock_batches_supplier_accrual after insert on public.stock_batches
  for each row execute function public.accrue_supplier_balance_from_receipt_line();

alter table public.payroll_runs
  add column if not exists idempotency_key uuid,
  add column if not exists request_hash text,
  add column if not exists created_by uuid references public.profiles(id) on delete restrict,
  add column if not exists finance_transaction_id uuid references public.finance_transactions(id) on delete restrict;
create unique index payroll_runs_scope_idempotency_uidx on public.payroll_runs(coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid),idempotency_key) where idempotency_key is not null;
create trigger payroll_items_immutable before update or delete on public.payroll_items for each row execute function public.reject_mutation();

create or replace function public.require_finance_operator(p_branch_id uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not(public.has_role(array['superadmin','admin']::public.app_role[],null)
    or (p_branch_id is not null and public.has_role(array['manager','accountant']::public.app_role[],p_branch_id))) then raise exception 'Moliya operatori roli talab qilinadi' using errcode='42501'; end if;
end $$;

create or replace function public.save_finance_account(p_account jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_branch uuid; v_currency text;
begin
  if jsonb_typeof(p_account)<>'object' then raise exception 'Hisob obyekti talab qilinadi' using errcode='22023'; end if;
  begin v_id=nullif(p_account->>'id','')::uuid; v_branch=nullif(p_account->>'branch_id','')::uuid; exception when invalid_text_representation then raise exception 'Hisob identifikatori noto‘g‘ri' using errcode='22023'; end;
  perform public.require_finance_operator(v_branch); v_currency=upper(coalesce(nullif(btrim(p_account->>'currency'),''),'UZS'));
  if v_currency !~ '^[A-Z]{3}$' or nullif(btrim(p_account->>'code'),'') is null or nullif(btrim(p_account->>'name'),'') is null then raise exception 'Hisob maydonlari noto‘g‘ri' using errcode='22023'; end if;
  if v_branch is not null and not exists(select 1 from public.branches where id=v_branch and is_active) then raise exception 'Faol filial topilmadi' using errcode='P0002'; end if;
  if v_id is null then insert into public.finance_accounts(branch_id,code,name,currency,is_active) values(v_branch,upper(btrim(p_account->>'code')),btrim(p_account->>'name'),v_currency::char(3),coalesce((p_account->>'is_active')::boolean,true)) returning id into v_id;
  else update public.finance_accounts set code=upper(btrim(p_account->>'code')),name=btrim(p_account->>'name'),currency=v_currency::char(3),is_active=coalesce((p_account->>'is_active')::boolean,is_active)
    where id=v_id and branch_id is not distinct from v_branch; if not found then raise exception 'Moliya hisobi topilmadi' using errcode='P0002'; end if; end if;
  return v_id;
end $$;

create or replace function public.post_finance_transaction(p_account_id uuid,p_type public.finance_type,p_category text,p_amount numeric,p_occurred_at timestamptz,p_description text,p_reference_type text,p_reference_id uuid,p_idempotency_key uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_account public.finance_accounts%rowtype; v_id uuid:=gen_random_uuid(); v_hash text; v_existing public.finance_transactions%rowtype;
begin
  select * into v_account from public.finance_accounts where id=p_account_id and is_active for update;
  if not found then raise exception 'Faol moliya hisobi topilmadi' using errcode='P0002'; end if; perform public.require_finance_operator(v_account.branch_id);
  if p_idempotency_key is null or p_amount is null or p_amount<=0 or nullif(btrim(p_category),'') is null then raise exception 'Tranzaksiya maydonlari noto‘g‘ri' using errcode='22023'; end if;
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('account_id',p_account_id,'type',p_type,'category',btrim(p_category),'amount',p_amount,
    'occurred_at',p_occurred_at,'description',nullif(btrim(p_description),''),'reference_type',nullif(btrim(p_reference_type),''),'reference_id',p_reference_id)::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.finance_transactions where account_id=p_account_id and idempotency_key=p_idempotency_key;
  if found then if v_existing.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa tranzaksiyada ishlatilgan' using errcode='22023'; end if; return v_existing.id; end if;
  insert into public.finance_transactions(id,account_id,branch_id,type,category,amount,occurred_at,description,reference_type,reference_id,created_by,idempotency_key,request_hash)
  values(v_id,p_account_id,v_account.branch_id,p_type,btrim(p_category),p_amount,coalesce(p_occurred_at,now()),nullif(btrim(p_description),''),nullif(btrim(p_reference_type),''),p_reference_id,auth.uid(),p_idempotency_key,v_hash);
  return v_id;
end $$;

create or replace function public.record_supplier_payment(p_supplier_id uuid,p_branch_id uuid,p_account_id uuid,p_amount numeric,p_method text,p_reference text,p_notes text,p_idempotency_key uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid:=gen_random_uuid(); v_tx uuid; v_account public.finance_accounts%rowtype; v_existing public.supplier_payments%rowtype;
begin
  perform public.require_finance_operator(p_branch_id);
  perform 1 from public.suppliers where id=p_supplier_id and is_active for update;
  if not found then raise exception 'Faol supplier topilmadi' using errcode='P0002'; end if;
  select * into v_existing from public.supplier_payments where supplier_id=p_supplier_id and branch_id=p_branch_id and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.amount is distinct from p_amount or v_existing.account_id is distinct from p_account_id
      or v_existing.method is distinct from btrim(p_method) or v_existing.reference is distinct from nullif(btrim(p_reference),'')
      or v_existing.notes is distinct from nullif(btrim(p_notes),'') then
      raise exception 'Takroriy kalit boshqa to‘lovda ishlatilgan' using errcode='22023'; end if;
    return v_existing.id;
  end if;
  select * into v_account from public.finance_accounts where id=p_account_id and is_active and branch_id is not distinct from p_branch_id;
  if not found or not exists(select 1 from public.suppliers where id=p_supplier_id and is_active) then raise exception 'Faol supplier yoki hisob topilmadi' using errcode='P0002'; end if;
  if p_amount<=0 or nullif(btrim(p_method),'') is null then raise exception 'To‘lov summasi/usuli noto‘g‘ri' using errcode='22023'; end if;
  v_tx=public.post_finance_transaction(p_account_id,'expense','supplier_payment',p_amount,now(),'Ta’minotchi to‘lovi','supplier_payment',v_id,p_idempotency_key);
  insert into public.supplier_payments(id,supplier_id,branch_id,account_id,amount,currency,method,reference,notes,idempotency_key,finance_transaction_id,created_by)
  values(v_id,p_supplier_id,p_branch_id,p_account_id,p_amount,v_account.currency,btrim(p_method),nullif(btrim(p_reference),''),nullif(btrim(p_notes),''),p_idempotency_key,v_tx,auth.uid());
  update public.suppliers set balance=balance-p_amount where id=p_supplier_id; return v_id;
end $$;

create or replace function public.create_supplier_return(p_supplier_id uuid,p_location_id uuid,p_reason text,p_unit_ids uuid[],p_idempotency_key uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_branch uuid; v_id uuid:=gen_random_uuid(); v_hash text; v_existing public.supplier_returns%rowtype; v_u record; v_total numeric(18,2):=0;
begin
  select branch_id into v_branch from public.locations where id=p_location_id and is_active and type in('store','warehouse');
  if v_branch is null then raise exception 'Faol joylashuv topilmadi' using errcode='P0002'; end if; perform public.require_inventory_operator(v_branch);
  if not(public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager','accountant','warehouse']::public.app_role[],v_branch)) then raise exception 'Supplier return roli talab qilinadi' using errcode='42501'; end if;
  perform 1 from public.branches where id=v_branch for update;
  if p_idempotency_key is null or nullif(btrim(p_reason),'') is null or coalesce(array_length(p_unit_ids,1),0) not between 1 and 500 or not exists(select 1 from public.suppliers where id=p_supplier_id and is_active) then raise exception 'Supplier return ma’lumotlari noto‘g‘ri' using errcode='22023'; end if;
  if (select count(*) from unnest(p_unit_ids)x)<>(select count(distinct x) from unnest(p_unit_ids)x) then raise exception 'Birliklar takrorlanmasligi kerak' using errcode='22023'; end if;
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('supplier_id',p_supplier_id,'location_id',p_location_id,'reason',btrim(p_reason),'units',(select jsonb_agg(x order by x) from unnest(p_unit_ids)x))::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.supplier_returns where branch_id=v_branch and idempotency_key=p_idempotency_key;
  if found then if v_existing.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa supplier returnda ishlatilgan' using errcode='22023'; end if; return v_existing.id; end if;
  perform 1 from public.inventory_units where id=any(p_unit_ids) order by id for update;
  if (select count(*) from public.inventory_units where id=any(p_unit_ids))<>cardinality(p_unit_ids) then
    raise exception 'So‘ralgan birliklardan biri topilmadi' using errcode='P0002';
  end if;
  if exists(select 1 from public.inventory_units u left join public.stock_batches b on b.id=u.batch_id
    where u.id=any(p_unit_ids) and b.supplier_id is distinct from p_supplier_id) then
    raise exception 'Birlik supplier provenance ga mos emas' using errcode='23514';
  end if;
  insert into public.supplier_returns(id,return_no,supplier_id,branch_id,from_location_id,status,reason,idempotency_key,request_hash,created_by)
  values(v_id,'SRT-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8)),p_supplier_id,v_branch,p_location_id,'draft',btrim(p_reason),p_idempotency_key,v_hash,auth.uid());
  for v_u in select u.*,coalesce(b.unit_cost,p.cost_price) unit_cost from public.inventory_units u join public.products p on p.id=u.product_id left join public.stock_batches b on b.id=u.batch_id where u.id=any(p_unit_ids) order by u.id loop
    if v_u.location_id<>p_location_id or v_u.status not in('available','returned') or v_u.active_transfer_id is not null then raise exception 'Birlik supplier return uchun erkin emas: %',v_u.id using errcode='P0001'; end if;
    insert into public.supplier_return_lines(supplier_return_id,unit_id,product_id,unit_cost) values(v_id,v_u.id,v_u.product_id,v_u.unit_cost);
    update public.inventory_units set status='reserved',reserved_until=null,version=version+1 where id=v_u.id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,unit_cost,reference_type,reference_id,actor_id)
    values(v_u.id,v_u.product_id,v_u.batch_id,'reserved',p_location_id,p_location_id,1,v_u.unit_cost,'supplier_return',v_id,auth.uid()) on conflict do nothing;
    v_total=v_total+v_u.unit_cost;
  end loop;
  update public.supplier_returns set total_amount=v_total where id=v_id; return v_id;
end $$;

create or replace function public.post_supplier_return(p_return_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.supplier_returns%rowtype; v_x record; v_u public.inventory_units%rowtype; v_dest uuid;
begin
  select * into v_r from public.supplier_returns where id=p_return_id for update;
  if not found then raise exception 'Supplier return topilmadi' using errcode='P0002'; end if; perform public.require_finance_operator(v_r.branch_id);
  if v_r.status='posted' then return to_jsonb(v_r); end if; if v_r.status<>'draft' then raise exception 'Faqat draft supplier return post qilinadi' using errcode='P0001'; end if;
  select id into v_dest from public.locations where code='SYSTEM-WRITEOFF' for share;
  perform 1 from public.inventory_units u join public.supplier_return_lines x on x.unit_id=u.id where x.supplier_return_id=p_return_id order by u.id for update of u;
  for v_x in select x.*,u.batch_id,u.location_id,u.status from public.supplier_return_lines x join public.inventory_units u on u.id=x.unit_id where x.supplier_return_id=p_return_id order by x.unit_id loop
    if v_x.status<>'reserved' or v_x.location_id<>v_r.from_location_id then raise exception 'Supplier return rezervi buzilgan' using errcode='P0001'; end if;
    update public.inventory_units set status='written_off',location_id=v_dest,reserved_until=null,sold_sale_id=null,version=version+1 where id=v_x.unit_id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,unit_cost,reference_type,reference_id,reason,actor_id)
    values(v_x.unit_id,v_x.product_id,v_x.batch_id,'adjustment',v_r.from_location_id,v_dest,1,v_x.unit_cost,'supplier_return',p_return_id,v_r.reason,auth.uid()) on conflict do nothing;
  end loop;
  update public.suppliers set balance=balance-v_r.total_amount where id=v_r.supplier_id;
  update public.supplier_returns set status='posted',posted_by=auth.uid(),posted_at=now() where id=p_return_id returning * into v_r; return to_jsonb(v_r);
end $$;

create or replace function public.cancel_supplier_return(p_return_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.supplier_returns%rowtype; v_x record;
begin
  select * into v_r from public.supplier_returns where id=p_return_id for update;
  if not found then raise exception 'Supplier return topilmadi' using errcode='P0002'; end if; perform public.require_inventory_operator(v_r.branch_id);
  if v_r.status='cancelled' then return to_jsonb(v_r); end if; if v_r.status='posted' then raise exception 'Post qilingan supplier return bekor qilinmaydi' using errcode='P0001'; end if;
  perform 1 from public.inventory_units u join public.supplier_return_lines x on x.unit_id=u.id where x.supplier_return_id=p_return_id order by u.id for update of u;
  for v_x in select x.*,u.batch_id,u.location_id,u.status from public.supplier_return_lines x join public.inventory_units u on u.id=x.unit_id where x.supplier_return_id=p_return_id order by x.unit_id loop
    if v_x.status='reserved' then update public.inventory_units set status='available',version=version+1 where id=v_x.unit_id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,unit_cost,reference_type,reference_id,reason,actor_id)
      values(v_x.unit_id,v_x.product_id,v_x.batch_id,'reservation_released',v_x.location_id,v_x.location_id,1,v_x.unit_cost,'supplier_return',p_return_id,nullif(btrim(p_reason),''),auth.uid()) on conflict do nothing; end if;
  end loop;
  update public.supplier_returns set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),reason=reason||E'\nBekor qilish: '||coalesce(nullif(btrim(p_reason),''),'Sabab ko‘rsatilmagan') where id=p_return_id returning * into v_r; return to_jsonb(v_r);
end $$;

create or replace function public.create_payroll_run(p_branch_id uuid,p_period_start date,p_period_end date,p_items jsonb,p_idempotency_key uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid:=gen_random_uuid(); v_hash text; v_existing public.payroll_runs%rowtype; v_item jsonb; v_total numeric(18,2):=0; v_gross numeric(18,2); v_ded numeric(18,2);
begin
  perform public.require_finance_operator(p_branch_id);
  if p_branch_id is not null then perform 1 from public.branches where id=p_branch_id for update; end if;
  if p_branch_id is null or p_idempotency_key is null or p_period_start is null or p_period_end<p_period_start or p_period_end-p_period_start>366
    or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 1000 then raise exception 'Payroll ma’lumotlari noto‘g‘ri' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_items)e group by (e->>'employee_id')::uuid having count(*)>1) then raise exception 'Xodim takrorlangan' using errcode='22023'; end if;
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('branch_id',p_branch_id,'period_start',p_period_start,'period_end',p_period_end,'items',p_items)::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.payroll_runs where branch_id=p_branch_id and idempotency_key=p_idempotency_key;
  if found then if v_existing.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa payroll uchun ishlatilgan' using errcode='22023'; end if; return v_existing.id; end if;
  insert into public.payroll_runs(id,branch_id,period_start,period_end,status,total,idempotency_key,request_hash,created_by)
  values(v_id,p_branch_id,p_period_start,p_period_end,'draft',0,p_idempotency_key,v_hash,auth.uid());
  for v_item in select value from jsonb_array_elements(p_items) order by (value->>'employee_id')::uuid loop
    v_gross=(v_item->>'gross')::numeric; v_ded=coalesce((v_item->>'deductions')::numeric,0);
    if v_gross<0 or v_ded<0 or v_ded>v_gross or not exists(select 1 from public.profile_roles where profile_id=(v_item->>'employee_id')::uuid and branch_id=p_branch_id) then raise exception 'Payroll xodimi yoki summasi noto‘g‘ri' using errcode='22023'; end if;
    insert into public.payroll_items(payroll_run_id,employee_id,gross,deductions,metadata) values(v_id,(v_item->>'employee_id')::uuid,v_gross,v_ded,coalesce(v_item->'metadata','{}'::jsonb));
    v_total=v_total+v_gross-v_ded;
  end loop;
  update public.payroll_runs set total=v_total where id=v_id; return v_id;
end $$;

create or replace function public.approve_payroll_run(p_payroll_run_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.payroll_runs%rowtype;
begin
  select * into v_r from public.payroll_runs where id=p_payroll_run_id for update;
  if not found then raise exception 'Payroll topilmadi' using errcode='P0002'; end if; perform public.require_finance_operator(v_r.branch_id);
  if v_r.status='approved' then return to_jsonb(v_r); end if; if v_r.status<>'draft' then raise exception 'Faqat draft payroll tasdiqlanadi' using errcode='P0001'; end if;
  update public.payroll_runs set status='approved',approved_by=auth.uid() where id=p_payroll_run_id returning * into v_r; return to_jsonb(v_r);
end $$;

create or replace function public.pay_payroll_run(p_payroll_run_id uuid,p_account_id uuid,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.payroll_runs%rowtype; v_tx uuid;
begin
  select * into v_r from public.payroll_runs where id=p_payroll_run_id for update;
  if not found then raise exception 'Payroll topilmadi' using errcode='P0002'; end if; perform public.require_finance_operator(v_r.branch_id);
  if v_r.status='paid' then
    if exists(select 1 from public.finance_transactions t where t.id=v_r.finance_transaction_id and t.account_id=p_account_id and t.idempotency_key=p_idempotency_key) then return to_jsonb(v_r); end if;
    raise exception 'To‘langan payroll replay parametrlari mos emas' using errcode='22023';
  end if;
  if v_r.status<>'approved' then raise exception 'Faqat approved payroll to‘lanadi' using errcode='P0001'; end if;
  if not exists(select 1 from public.finance_accounts where id=p_account_id and is_active and branch_id is not distinct from v_r.branch_id) then raise exception 'Payroll moliya hisobi topilmadi' using errcode='P0002'; end if;
  v_tx=public.post_finance_transaction(p_account_id,'expense','payroll',v_r.total,now(),'Payroll '||v_r.period_start||' - '||v_r.period_end,'payroll_run',v_r.id,p_idempotency_key);
  update public.payroll_runs set status='paid',paid_at=now(),finance_transaction_id=v_tx where id=p_payroll_run_id returning * into v_r; return to_jsonb(v_r);
end $$;

-- -----------------------------------------------------------------------------
-- CMS safe operations, audit, public storefront, reports
-- -----------------------------------------------------------------------------

create or replace function public.reorder_cms_items(p_entity text,p_items jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare v_item jsonb; v_count integer:=0; v_id uuid; v_order integer;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) then raise exception 'Global admin roli talab qilinadi' using errcode='42501'; end if;
  if p_entity not in('banners','home_blocks','menu_items') or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>500 then raise exception 'CMS reorder payload noto‘g‘ri' using errcode='22023'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    begin v_id=(v_item->>'id')::uuid; v_order=(v_item->>'sort_order')::integer; exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'CMS id/sort_order noto‘g‘ri' using errcode='22023'; end;
    if v_order not between -100000 and 100000 then raise exception 'sort_order chegaradan tashqarida' using errcode='22023'; end if;
    if p_entity='banners' then update public.cms_banners set sort_order=v_order where id=v_id;
    elsif p_entity='home_blocks' then update public.cms_home_blocks set sort_order=v_order where id=v_id;
    else update public.cms_menu_items set sort_order=v_order where id=v_id; end if;
    if not found then raise exception 'CMS elementi topilmadi: %',v_id using errcode='P0002'; end if; v_count=v_count+1;
  end loop; return v_count;
end $$;

create or replace function public.delete_cms_banner(p_banner_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare v_b public.cms_banners%rowtype;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) then raise exception 'Global admin roli talab qilinadi' using errcode='42501'; end if;
  select * into v_b from public.cms_banners where id=p_banner_id for update;
  if not found then raise exception 'Banner topilmadi' using errcode='P0002'; end if;
  if v_b.is_active and (v_b.starts_at is null or v_b.starts_at<=now()) and (v_b.ends_at is null or v_b.ends_at>now()) then raise exception 'Faol banner media faylini o‘chirishdan oldin bannerni faolsizlantiring' using errcode='P0001'; end if;
  delete from public.cms_banners where id=p_banner_id; return v_b.r2_key;
end $$;

create table public.banner_media_uploads(
  id uuid primary key default gen_random_uuid(),banner_id uuid not null,uploader_id uuid not null references public.profiles(id) on delete restrict,
  r2_key text not null unique,public_url text not null check(public_url ~ '^https://'),mime_type text not null check(mime_type in('image/jpeg','image/png','image/webp','image/avif')),
  bytes bigint not null check(bytes between 1 and 10485760),status text not null default 'pending' check(status in('pending','verified','attached','delete_pending','deleted')),
  created_at timestamptz not null default now(),verified_at timestamptz,attached_at timestamptz,deleted_at timestamptz
);
create index banner_media_uploads_banner_idx on public.banner_media_uploads(banner_id,created_at desc);
alter table public.banner_media_uploads enable row level security;
revoke all on public.banner_media_uploads from public,anon,authenticated;
grant all on public.banner_media_uploads to service_role;

create table public.media_cleanup_queue(
  r2_key text primary key,scope text not null check(scope in('banners','delivery-proofs','products')),
  status text not null default 'pending' check(status in('pending','processing','dead')),
  attempts integer not null default 0,last_error text,requested_at timestamptz not null default now(),next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,lock_token uuid,last_attempt_at timestamptz
);
alter table public.media_cleanup_queue enable row level security;
revoke all on public.media_cleanup_queue from public,anon,authenticated;
grant all on public.media_cleanup_queue to service_role;

create or replace function public.claim_media_cleanup_batch(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_items jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  if p_limit not between 1 and 100 then raise exception 'Cleanup limit noto‘g‘ri' using errcode='22023'; end if;
  with candidates as(
    select r2_key from public.media_cleanup_queue where (status='pending' and next_attempt_at<=now()) or (status='processing' and locked_at<now()-interval '15 minutes')
      order by next_attempt_at,requested_at for update skip locked limit p_limit
  ), claimed as(
    update public.media_cleanup_queue q set status='processing',attempts=q.attempts+1,locked_at=now(),last_attempt_at=now(),lock_token=gen_random_uuid()
    from candidates c where q.r2_key=c.r2_key returning q.r2_key,q.scope,q.attempts,q.lock_token
  ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) into v_items from claimed;
  return v_items;
end $$;

create or replace function public.finish_media_cleanup(p_r2_key text,p_lock_token uuid,p_success boolean,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_attempts integer;
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  select attempts into v_attempts from public.media_cleanup_queue where r2_key=p_r2_key and lock_token=p_lock_token and status='processing' for update;
  if not found then raise exception 'Cleanup lease topilmadi' using errcode='P0002'; end if;
  if p_success then
    update public.delivery_proofs set status='deleted',deleted_at=coalesce(deleted_at,now()) where r2_key=p_r2_key and status='delete_pending';
    update public.banner_media_uploads set status='deleted',deleted_at=coalesce(deleted_at,now()) where r2_key=p_r2_key and status in('attached','delete_pending','verified','pending');
    delete from public.media_cleanup_queue where r2_key=p_r2_key and lock_token=p_lock_token;
  else
    update public.media_cleanup_queue set status=case when v_attempts>=8 then 'dead' else 'pending' end,last_error=left(coalesce(p_error,'Noma’lum cleanup xatosi'),1000),
      next_attempt_at=now()+make_interval(secs=>least(3600,30*(2^least(v_attempts,7))::integer)),locked_at=null,lock_token=null
    where r2_key=p_r2_key and lock_token=p_lock_token;
  end if;
end $$;

create or replace function public.queue_delivery_proof_cleanup(p_proof_id uuid,p_delivery_id uuid,p_courier_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare v_proof public.delivery_proofs%rowtype;
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  select * into v_proof from public.delivery_proofs where id=p_proof_id and delivery_id=p_delivery_id and courier_id=p_courier_id for update;
  if not found then raise exception 'Yetkazish isboti topilmadi' using errcode='P0002'; end if;
  if v_proof.status not in('pending','verified','delete_pending') then raise exception 'Ishlatilgan isbot cleanup qilinmaydi' using errcode='P0001'; end if;
  update public.delivery_proofs set status='delete_pending' where id=p_proof_id and status in('pending','verified');
  insert into public.media_cleanup_queue(r2_key,scope,status,next_attempt_at) values(v_proof.r2_key,'delivery-proofs','pending',now())
  on conflict(r2_key) do update set status='pending',next_attempt_at=now(),last_error=null,locked_at=null,lock_token=null;
  return v_proof.r2_key;
end $$;

create or replace function public.queue_banner_media_cleanup(p_banner_id uuid,p_upload_id uuid,p_r2_key text,p_uploader_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_upload public.banner_media_uploads%rowtype;
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  if exists(select 1 from public.cms_banners where r2_key=p_r2_key) then raise exception 'Banner media ishlatilmoqda' using errcode='P0001'; end if;
  select * into v_upload from public.banner_media_uploads where id=p_upload_id and banner_id=p_banner_id and uploader_id=p_uploader_id and r2_key=p_r2_key for update;
  if not found or v_upload.status not in('pending','verified','delete_pending') then raise exception 'Banner upload cleanup uchun topilmadi' using errcode='P0002'; end if;
  update public.banner_media_uploads set status='delete_pending' where id=p_upload_id and status in('pending','verified');
  insert into public.media_cleanup_queue(r2_key,scope,status,next_attempt_at) values(p_r2_key,'banners','pending',now())
  on conflict(r2_key) do update set status='pending',next_attempt_at=now(),last_error=null,locked_at=null,lock_token=null;
end $$;

revoke all on function public.claim_media_cleanup_batch(integer),public.finish_media_cleanup(text,uuid,boolean,text),public.queue_delivery_proof_cleanup(uuid,uuid,uuid),public.queue_banner_media_cleanup(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.claim_media_cleanup_batch(integer),public.finish_media_cleanup(text,uuid,boolean,text),public.queue_delivery_proof_cleanup(uuid,uuid,uuid),public.queue_banner_media_cleanup(uuid,uuid,text,uuid) to service_role;

create or replace function public.delete_cms_banner(p_banner_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare v_b public.cms_banners%rowtype;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) then raise exception 'Global admin roli talab qilinadi' using errcode='42501'; end if;
  select * into v_b from public.cms_banners where id=p_banner_id for update;
  if not found then raise exception 'Banner topilmadi' using errcode='P0002'; end if;
  if v_b.is_active and (v_b.starts_at is null or v_b.starts_at<=now()) and (v_b.ends_at is null or v_b.ends_at>now()) then raise exception 'Faol banner media faylini o‘chirishdan oldin bannerni faolsizlantiring' using errcode='P0001'; end if;
  insert into public.media_cleanup_queue(r2_key,scope,status,next_attempt_at) values(v_b.r2_key,'banners','pending',now())
  on conflict(r2_key) do update set status='pending',next_attempt_at=now(),last_error=null,locked_at=null,lock_token=null;
  delete from public.cms_banners where id=p_banner_id; return v_b.r2_key;
end $$;

create or replace function public.save_cms_banner(p_banner jsonb,p_upload_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_existing public.cms_banners%rowtype; v_upload public.banner_media_uploads%rowtype; v_result public.cms_banners%rowtype; v_image_url text; v_r2_key text;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) or jsonb_typeof(p_banner)<>'object' then raise exception 'Global admin va banner payloadi talab qilinadi' using errcode='42501'; end if;
  begin v_id=(p_banner->>'id')::uuid; exception when invalid_text_representation then raise exception 'Banner ID noto‘g‘ri' using errcode='22023'; end;
  if v_id is null or nullif(btrim(p_banner->>'title'),'') is null or nullif(btrim(p_banner->>'placement'),'') is null then raise exception 'Banner maydonlari noto‘g‘ri' using errcode='22023'; end if;
  select * into v_existing from public.cms_banners where id=v_id for update;
  if p_upload_id is not null then
    select * into v_upload from public.banner_media_uploads where id=p_upload_id and banner_id=v_id and uploader_id=auth.uid() and status='verified' for update;
    if not found then raise exception 'Tasdiqlangan banner upload topilmadi' using errcode='P0002'; end if;
    v_image_url=v_upload.public_url; v_r2_key=v_upload.r2_key;
  elsif v_existing.id is not null then v_image_url=v_existing.image_url; v_r2_key=v_existing.r2_key;
  else raise exception 'Yangi banner uchun tasdiqlangan upload talab qilinadi' using errcode='22023'; end if;
  insert into public.cms_banners(id,title,image_url,r2_key,target_url,placement,sort_order,starts_at,ends_at,is_active)
  values(v_id,btrim(p_banner->>'title'),v_image_url,v_r2_key,nullif(btrim(p_banner->>'target_url'),''),btrim(p_banner->>'placement'),
    coalesce((p_banner->>'sort_order')::integer,0),nullif(p_banner->>'starts_at','')::timestamptz,nullif(p_banner->>'ends_at','')::timestamptz,coalesce((p_banner->>'is_active')::boolean,true))
  on conflict(id) do update set title=excluded.title,image_url=excluded.image_url,r2_key=excluded.r2_key,target_url=excluded.target_url,placement=excluded.placement,
    sort_order=excluded.sort_order,starts_at=excluded.starts_at,ends_at=excluded.ends_at,is_active=excluded.is_active,updated_at=now()
  returning * into v_result;
  if p_upload_id is not null then update public.banner_media_uploads set status='attached',attached_at=now() where id=p_upload_id and status='verified'; end if;
  if v_existing.id is not null and v_existing.r2_key<>v_r2_key then
    insert into public.media_cleanup_queue(r2_key,scope,status,next_attempt_at) values(v_existing.r2_key,'banners','pending',now())
    on conflict(r2_key) do update set status='pending',next_attempt_at=now(),last_error=null,locked_at=null,lock_token=null;
  end if;
  return to_jsonb(v_result);
end $$;

create or replace function public.save_cms_promotion(p_promotion jsonb,p_product_ids uuid[] default '{}'::uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_result public.cms_promotions%rowtype; v_count integer;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) then raise exception 'Global admin roli talab qilinadi' using errcode='42501'; end if;
  if jsonb_typeof(p_promotion)<>'object' or coalesce(cardinality(p_product_ids),0)>500 then raise exception 'Aksiya payloadi noto‘g‘ri' using errcode='22023'; end if;
  begin v_id=coalesce(nullif(p_promotion->>'id','')::uuid,gen_random_uuid()); exception when invalid_text_representation then raise exception 'Aksiya ID noto‘g‘ri' using errcode='22023'; end;
  if nullif(btrim(p_promotion->>'name'),'') is null or nullif(btrim(p_promotion->>'slug'),'') is null
    or (p_promotion->>'discount_type') not in('percent','fixed') or coalesce((p_promotion->>'discount_value')::numeric,0)<=0
    or (p_promotion->>'starts_at')::timestamptz >= (p_promotion->>'ends_at')::timestamptz
    or jsonb_typeof(coalesce(p_promotion->'rules','{}'::jsonb))<>'object' then raise exception 'Aksiya maydonlari noto‘g‘ri' using errcode='22023'; end if;
  select count(distinct x) into v_count from unnest(coalesce(p_product_ids,'{}'::uuid[])) x;
  if v_count<>coalesce(cardinality(p_product_ids),0) or v_count<>(select count(*) from public.products where id=any(coalesce(p_product_ids,'{}'::uuid[])) and status='active') then
    raise exception 'Aksiya mahsulotlari takrorlangan yoki faol emas' using errcode='22023';
  end if;
  insert into public.cms_promotions(id,name,slug,description,discount_type,discount_value,starts_at,ends_at,is_active,rules)
  values(v_id,btrim(p_promotion->>'name'),btrim(p_promotion->>'slug'),nullif(btrim(p_promotion->>'description'),''),p_promotion->>'discount_type',
    (p_promotion->>'discount_value')::numeric,(p_promotion->>'starts_at')::timestamptz,(p_promotion->>'ends_at')::timestamptz,
    coalesce((p_promotion->>'is_active')::boolean,true),coalesce(p_promotion->'rules','{}'::jsonb))
  on conflict(id) do update set name=excluded.name,slug=excluded.slug,description=excluded.description,discount_type=excluded.discount_type,
    discount_value=excluded.discount_value,starts_at=excluded.starts_at,ends_at=excluded.ends_at,is_active=excluded.is_active,rules=excluded.rules,updated_at=now()
  returning * into v_result;
  delete from public.cms_promotion_products where promotion_id=v_id;
  insert into public.cms_promotion_products(promotion_id,product_id) select v_id,x from unnest(coalesce(p_product_ids,'{}'::uuid[])) x;
  return to_jsonb(v_result)||jsonb_build_object('product_ids',coalesce(to_jsonb(p_product_ids),'[]'::jsonb));
end $$;

create or replace function public.query_audit_log(p_table text default null,p_entity_id text default null,p_actor_id uuid default null,p_from timestamptz default null,p_to timestamptz default null,p_limit integer default 100,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_total bigint; v_items jsonb;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) then raise exception 'Audit uchun global admin roli talab qilinadi' using errcode='42501'; end if;
  if p_limit not between 1 and 500 or p_offset<0 or (p_from is not null and p_to is not null and p_to<p_from) then raise exception 'Audit filtri noto‘g‘ri' using errcode='22023'; end if;
  select count(*) into v_total from public.audit_log where (p_table is null or entity_table=p_table) and (p_entity_id is null or entity_id=p_entity_id)
    and (p_actor_id is null or actor_id=p_actor_id) and (p_from is null or created_at>=p_from) and (p_to is null or created_at<p_to);
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id desc),'[]'::jsonb) into v_items from(
    select * from public.audit_log where (p_table is null or entity_table=p_table) and (p_entity_id is null or entity_id=p_entity_id)
      and (p_actor_id is null or actor_id=p_actor_id) and (p_from is null or created_at>=p_from) and (p_to is null or created_at<p_to)
      order by created_at desc,id desc limit p_limit offset p_offset)q;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

create or replace function public.storefront_catalog(p_query text default null,p_category_id uuid default null,p_limit integer default 24,p_offset integer default 0)
returns jsonb language sql stable security definer set search_path='' as $$
  with filtered as(
    select p.id,p.sku,p.barcode,p.category_id,p.brand_id,p.name,p.slug,p.description,p.seo_title,p.seo_description,p.seo_image_url,p.retail_price,p.compare_at_price,
      p.promotion_price,p.tax_rate,p.created_at,
      (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order,m.id limit 1) primary_media_url,
      (select coalesce(jsonb_agg(jsonb_build_object('code',a.code,'name',a.name,'value',v.value) order by a.sort_order,a.code),'[]'::jsonb)
       from public.product_attribute_values v join public.attribute_definitions a on a.id=v.attribute_id where v.product_id=p.id) attributes,
      (select count(*) from public.inventory_units u join public.locations l on l.id=u.location_id where u.product_id=p.id
        and u.status='available' and u.active_transfer_id is null and l.is_active and l.type in('store','warehouse')) available_stock
    from public.products p where p.status='active' and p.is_published and (p_category_id is null or p.category_id=p_category_id)
      and (nullif(btrim(p_query),'') is null or p.name ilike '%'||btrim(p_query)||'%' or p.sku ilike '%'||btrim(p_query)||'%' or coalesce(p.barcode,'') ilike '%'||btrim(p_query)||'%'))
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(x) order by x.name,x.id) from(select * from filtered order by name,id limit greatest(1,least(p_limit,100)) offset greatest(p_offset,0))x),'[]'::jsonb),'total',(select count(*) from filtered));
$$;

create or replace function public.storefront_cms_payload()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'banners',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'title',b.title,'image_url',b.image_url,
      'target_url',b.target_url,'placement',b.placement,'sort_order',b.sort_order,'starts_at',b.starts_at,'ends_at',b.ends_at)
      order by b.placement,b.sort_order,b.id) from public.cms_banners b where b.is_active and (b.starts_at is null or b.starts_at<=now()) and (b.ends_at is null or b.ends_at>now())),'[]'::jsonb),
    'home_blocks',coalesce((select jsonb_agg(to_jsonb(h) order by h.sort_order,h.id) from public.cms_home_blocks h where h.is_active and (h.starts_at is null or h.starts_at<=now()) and (h.ends_at is null or h.ends_at>now())),'[]'::jsonb),
    'menu_items',coalesce((select jsonb_agg(to_jsonb(m) order by m.location,m.sort_order,m.id) from public.cms_menu_items m where m.is_active),'[]'::jsonb),
    'promotions',coalesce((select jsonb_agg((to_jsonb(p)-'rules')||jsonb_build_object('product_ids',(select coalesce(jsonb_agg(x.product_id),'[]'::jsonb) from public.cms_promotion_products x where x.promotion_id=p.id)) order by p.starts_at,p.id) from public.cms_promotions p where p.is_active and p.starts_at<=now() and p.ends_at>now()),'[]'::jsonb),
    'pages',coalesce((select jsonb_agg(to_jsonb(p)-'created_by'-'updated_by' order by p.slug) from public.cms_pages p where p.is_published and p.published_at<=now()),'[]'::jsonb),
    'settings',coalesce((select jsonb_object_agg(s.key,s.value) from public.system_settings s where s.is_public),'{}'::jsonb));
$$;

create or replace function public.customer_order_history(p_limit integer default 20,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  return jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(q) order by q.placed_at desc) from(
    select o.id,o.order_no,o.status,o.subtotal,o.discount,o.delivery_fee,o.total,o.payment_status,o.shipping_address,o.placed_at,
      (select jsonb_agg(jsonb_build_object('product_id',l.product_id,'product_name',l.product_name,'sku',l.sku,'quantity',l.quantity,'unit_price',l.unit_price,'line_total',l.line_total) order by l.id) from public.order_lines l where l.order_id=o.id) lines,
      (select jsonb_agg(jsonb_build_object('from_status',h.from_status,'to_status',h.to_status,'note',h.note,'created_at',h.created_at) order by h.created_at,h.id) from public.order_status_history h where h.order_id=o.id) history
    from public.orders o where o.customer_user_id=auth.uid() order by o.placed_at desc limit p_limit offset p_offset)q),'[]'::jsonb),
    'total',(select count(*) from public.orders where customer_user_id=auth.uid()));
end $$;

create or replace function public.require_report_access(p_branch_id uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if p_branch_id is null then
    if not public.has_role(array['superadmin','admin']::public.app_role[],null) then raise exception 'Global hisobot uchun admin roli talab qilinadi' using errcode='42501'; end if;
  elsif not(public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager','accountant']::public.app_role[],p_branch_id)) then raise exception 'Filial hisoboti uchun ruxsat yo‘q' using errcode='42501'; end if;
end $$;

create or replace function public.report_sales_rows(p_from date,p_to date,p_branch_id uuid default null)
returns table(sale_no text,sold_at timestamptz,branch_code text,seller_name text,status public.sale_status,subtotal numeric,discount numeric,tax numeric,total numeric,cost numeric,profit numeric,payments jsonb)
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_report_access(p_branch_id); if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023'; end if;
  return query select s.sale_no,s.sold_at,b.code,p.full_name,s.status,s.subtotal,s.discount,s.tax,s.total,
    coalesce(sum(l.unit_cost),0),coalesce(sum(l.line_total-l.tax-l.unit_cost),0),
    coalesce((select jsonb_agg(jsonb_build_object('method_code',pm.code,'amount',sp.amount,'status',sp.status)
      order by sp.paid_at,sp.id) from public.sale_payments sp join public.payment_methods pm on pm.id=sp.payment_method_id where sp.sale_id=s.id),'[]'::jsonb)
  from public.sales s join public.branches b on b.id=s.branch_id join public.profiles p on p.id=s.seller_id left join public.sale_lines l on l.sale_id=s.id
  where s.sold_at>=public.business_day_start(p_from) and s.sold_at<public.business_day_start(p_to+1) and (p_branch_id is null or s.branch_id=p_branch_id)
  group by s.id,b.code,p.full_name order by s.sold_at,s.sale_no;
end $$;

create or replace function public.report_finance_rows(p_from date,p_to date,p_branch_id uuid default null)
returns table(transaction_id uuid,occurred_at timestamptz,branch_code text,account_code text,transaction_type public.finance_type,category text,amount numeric,description text,reference_type text,reference_id uuid)
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_report_access(p_branch_id); if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023'; end if;
  return query select t.id,t.occurred_at,b.code,a.code,t.type,t.category,t.amount,t.description,t.reference_type,t.reference_id
    from public.finance_transactions t join public.finance_accounts a on a.id=t.account_id left join public.branches b on b.id=t.branch_id
    where t.occurred_at>=public.business_day_start(p_from) and t.occurred_at<public.business_day_start(p_to+1) and (p_branch_id is null or t.branch_id=p_branch_id)
    order by t.occurred_at,t.id;
end $$;

create or replace function public.report_debt_rows(p_from date,p_to date,p_branch_id uuid default null)
returns table(debt_id uuid,created_at timestamptz,debtor_branch text,creditor_branch text,transfer_no text,status public.debt_status,currency char(3),amount numeric,paid_amount numeric,remaining_amount numeric,payments jsonb)
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_report_access(p_branch_id);
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023'; end if;
  return query select d.id,d.created_at,db.code,cb.code,t.transfer_no,d.status,d.currency,d.amount,d.paid_amount,d.remaining_amount,
    coalesce((select jsonb_agg(jsonb_build_object('amount',p.amount,'paid_at',p.paid_at,'method',p.method,'reference',p.reference)
      order by p.paid_at,p.id) from public.debt_payments p where p.debt_id=d.id),'[]'::jsonb)
  from public.branch_debts d join public.branches db on db.id=d.debtor_branch_id
    join public.branches cb on cb.id=d.creditor_branch_id join public.transfers t on t.id=d.transfer_id
  where d.created_at>=public.business_day_start(p_from) and d.created_at<public.business_day_start(p_to+1)
    and (p_branch_id is null or p_branch_id in(d.debtor_branch_id,d.creditor_branch_id))
  order by d.created_at,d.id;
end $$;

create or replace function public.report_supplier_ledger(p_from date,p_to date,p_branch_id uuid default null,p_supplier_id uuid default null)
returns table(event_type text,event_id uuid,occurred_at timestamptz,branch_code text,supplier_code text,supplier_name text,amount numeric,balance_effect numeric,reference text)
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_report_access(p_branch_id);
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023'; end if;
  return query
    select 'receipt'::text,r.id,r.received_at,b.code,s.code,s.name,coalesce(sum(sb.quantity*sb.unit_cost),0)::numeric,
      coalesce(sum(sb.quantity*sb.unit_cost),0)::numeric,r.receipt_no
    from public.stock_receipts r join public.branches b on b.id=r.branch_id join public.suppliers s on s.id=r.supplier_id
      join public.stock_batches sb on sb.receipt_id=r.id
    where r.received_at>=public.business_day_start(p_from) and r.received_at<public.business_day_start(p_to+1)
      and (p_branch_id is null or r.branch_id=p_branch_id) and (p_supplier_id is null or r.supplier_id=p_supplier_id)
    group by r.id,b.code,s.code,s.name
    union all
    select 'payment',sp.id,sp.paid_at,b.code,s.code,s.name,sp.amount,-sp.amount,coalesce(sp.reference,sp.id::text)
    from public.supplier_payments sp join public.branches b on b.id=sp.branch_id join public.suppliers s on s.id=sp.supplier_id
    where sp.paid_at>=public.business_day_start(p_from) and sp.paid_at<public.business_day_start(p_to+1)
      and (p_branch_id is null or sp.branch_id=p_branch_id) and (p_supplier_id is null or sp.supplier_id=p_supplier_id)
    union all
    select 'return',sr.id,sr.posted_at,b.code,s.code,s.name,sr.total_amount,-sr.total_amount,sr.return_no
    from public.supplier_returns sr join public.branches b on b.id=sr.branch_id join public.suppliers s on s.id=sr.supplier_id
    where sr.status='posted' and sr.posted_at>=public.business_day_start(p_from) and sr.posted_at<public.business_day_start(p_to+1)
      and (p_branch_id is null or sr.branch_id=p_branch_id) and (p_supplier_id is null or sr.supplier_id=p_supplier_id)
    order by 3,1,2;
end $$;

create or replace function public.report_inventory_rows(p_branch_id uuid default null)
returns table(branch_code text,location_code text,location_name text,sku text,product_name text,on_hand numeric,reserved numeric,available numeric,stock_cost numeric,retail_value numeric)
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_report_access(p_branch_id);
  return query select b.code,l.code,l.name,p.sku,p.name,ib.on_hand,ib.reserved,ib.on_hand-ib.reserved,
    coalesce((select sum(coalesce(sb.unit_cost,p.cost_price)) from public.inventory_units u left join public.stock_batches sb on sb.id=u.batch_id where u.location_id=l.id and u.product_id=p.id and u.status in('available','reserved','returned')),0),
    (ib.on_hand*p.retail_price)::numeric
  from public.inventory_balances ib join public.locations l on l.id=ib.location_id join public.branches b on b.id=l.branch_id join public.products p on p.id=ib.product_id
  where p_branch_id is null or l.branch_id=p_branch_id order by b.code,l.code,p.sku;
end $$;

create or replace function public.report_profit_loss(p_from date,p_to date,p_branch_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_sales numeric; v_cogs numeric; v_cogs_recovered numeric; v_other_income numeric; v_expense numeric; v_refunds numeric;
begin
  perform public.require_report_access(p_branch_id); if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023'; end if;
  select coalesce(sum(s.total),0),coalesce(sum((select sum(l.unit_cost) from public.sale_lines l where l.sale_id=s.id)),0) into v_sales,v_cogs
    from public.sales s where s.sold_at>=public.business_day_start(p_from) and s.sold_at<public.business_day_start(p_to+1) and s.status<>'void' and (p_branch_id is null or s.branch_id=p_branch_id);
  select coalesce(sum(amount) filter(where type='income'),0),coalesce(sum(amount) filter(where type='expense'),0) into v_other_income,v_expense
    from public.finance_transactions where occurred_at>=public.business_day_start(p_from) and occurred_at<public.business_day_start(p_to+1) and (p_branch_id is null or branch_id=p_branch_id);
  select coalesce(sum(refund_amount),0) into v_refunds from public.sale_returns where status='completed' and completed_at>=public.business_day_start(p_from) and completed_at<public.business_day_start(p_to+1) and (p_branch_id is null or branch_id=p_branch_id);
  select coalesce(sum(sl.unit_cost),0) into v_cogs_recovered from public.sale_return_lines x
    join public.sale_returns r on r.id=x.return_id join public.sale_lines sl on sl.id=x.sale_line_id
    where r.status='completed' and x.condition='resellable' and r.completed_at>=public.business_day_start(p_from) and r.completed_at<public.business_day_start(p_to+1)
      and (p_branch_id is null or r.branch_id=p_branch_id);
  return jsonb_build_object('from',p_from,'to',p_to,'branch_id',p_branch_id,'sales_revenue',v_sales,'refunds',v_refunds,
    'net_sales',v_sales-v_refunds,'cost_of_goods',v_cogs-v_cogs_recovered,'gross_profit',v_sales-v_refunds-v_cogs+v_cogs_recovered,'other_income',v_other_income,
    'operating_expenses',v_expense,'net_profit',v_sales-v_refunds-v_cogs+v_cogs_recovered+v_other_income-v_expense);
end $$;

create or replace function public.get_management_dashboard(p_from date,p_to date,p_branch_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_report_access(p_branch_id);
  return jsonb_build_object('profit_loss',public.report_profit_loss(p_from,p_to,p_branch_id),
    'orders',jsonb_build_object('total',(select count(*) from public.orders where placed_at>=public.business_day_start(p_from) and placed_at<public.business_day_start(p_to+1) and (p_branch_id is null or branch_id=p_branch_id)),
      'new',(select count(*) from public.orders where status='new' and placed_at>=public.business_day_start(p_from) and placed_at<public.business_day_start(p_to+1) and (p_branch_id is null or branch_id=p_branch_id)),
      'delivered',(select count(*) from public.orders where status='delivered' and placed_at>=public.business_day_start(p_from) and placed_at<public.business_day_start(p_to+1) and (p_branch_id is null or branch_id=p_branch_id))),
    'inventory',jsonb_build_object('units',(select coalesce(sum(ib.on_hand),0) from public.inventory_balances ib join public.locations l on l.id=ib.location_id where p_branch_id is null or l.branch_id=p_branch_id),
      'reserved',(select coalesce(sum(ib.reserved),0) from public.inventory_balances ib join public.locations l on l.id=ib.location_id where p_branch_id is null or l.branch_id=p_branch_id)),
    'receivables',(select coalesce(sum(remaining_amount),0) from public.branch_debts where status in('open','partially_paid') and (p_branch_id is null or creditor_branch_id=p_branch_id)),
    'payables',(select coalesce(sum(remaining_amount),0) from public.branch_debts where status in('open','partially_paid') and (p_branch_id is null or debtor_branch_id=p_branch_id)));
end $$;

-- -----------------------------------------------------------------------------
-- RLS, append-only audit, realtime, and explicit grants
-- -----------------------------------------------------------------------------

alter table public.product_price_history enable row level security;
alter table public.customer_favorites enable row level security;
alter table public.customer_cart_items enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.sale_refunds enable row level security;
alter table public.order_reserved_units enable row level security;
alter table public.supplier_payments enable row level security;
alter table public.supplier_returns enable row level security;
alter table public.supplier_return_lines enable row level security;

create policy customer_favorites_owner_read on public.customer_favorites for select to authenticated using(user_id=auth.uid());
create policy customer_cart_owner_read on public.customer_cart_items for select to authenticated using(user_id=auth.uid());
create policy customer_addresses_owner_read on public.customer_addresses for select to authenticated using(user_id=auth.uid());
create policy product_price_history_staff_read on public.product_price_history for select to authenticated using(public.current_user_active() and exists(select 1 from public.profile_roles r where r.profile_id=auth.uid() and r.role in('superadmin','admin','manager','accountant')));
create policy order_reserved_units_staff_read on public.order_reserved_units for select to authenticated using(exists(
  select 1 from public.orders o where o.id=order_id and o.branch_id is not null and
    (public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager','warehouse']::public.app_role[],o.branch_id))));
create policy supplier_payments_staff_read on public.supplier_payments for select to authenticated using(public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager','accountant']::public.app_role[],branch_id));
create policy supplier_returns_staff_read on public.supplier_returns for select to authenticated using(
  public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager','accountant','warehouse']::public.app_role[],branch_id));
create policy supplier_return_lines_staff_read on public.supplier_return_lines for select to authenticated using(exists(
  select 1 from public.supplier_returns r where r.id=supplier_return_id and
    (public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager','accountant','warehouse']::public.app_role[],r.branch_id))));
create policy writeoffs_staff_read on public.writeoffs for select to authenticated using(exists(
  select 1 from public.locations l where l.id=location_id and l.branch_id is not null and public.can_access_branch(l.branch_id)));
create policy writeoff_lines_staff_read on public.writeoff_lines for select to authenticated using(exists(
  select 1 from public.writeoffs w join public.locations l on l.id=w.location_id where w.id=writeoff_id and l.branch_id is not null and public.can_access_branch(l.branch_id)));
create policy sale_return_lines_staff_read on public.sale_return_lines for select to authenticated using(exists(
  select 1 from public.sale_returns r where r.id=return_id and public.can_access_branch(r.branch_id)));
create policy sale_refunds_staff_read on public.sale_refunds for select to authenticated using(exists(
  select 1 from public.sales s where s.id=sale_id and
    (public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager','accountant']::public.app_role[],s.branch_id))));
create policy finance_accounts_staff_read on public.finance_accounts for select to authenticated using(public.has_role(array['superadmin','admin']::public.app_role[],null) or (branch_id is not null and public.has_role(array['manager','accountant']::public.app_role[],branch_id)));
-- Keep payroll reads aligned with require_finance_operator used by create/approve/pay.
drop policy if exists payroll_staff_read on public.payroll_runs;
create policy payroll_staff_read on public.payroll_runs for select to authenticated using(
  public.has_role(array['superadmin','admin']::public.app_role[],null) or
  (branch_id is not null and public.has_role(array['manager','accountant']::public.app_role[],branch_id)));
create policy payroll_items_staff_read on public.payroll_items for select to authenticated using(exists(select 1 from public.payroll_runs r where r.id=payroll_run_id and (public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager','accountant']::public.app_role[],r.branch_id))));

create trigger product_price_history_audit after insert on public.product_price_history for each row execute function public.audit_row_change();
create trigger sale_refunds_audit after insert on public.sale_refunds for each row execute function public.audit_row_change();
create trigger supplier_payments_audit after insert on public.supplier_payments for each row execute function public.audit_row_change();
create trigger supplier_returns_audit after insert or update or delete on public.supplier_returns for each row execute function public.audit_row_change();
create trigger supplier_return_lines_audit after insert on public.supplier_return_lines for each row execute function public.audit_row_change();
create trigger order_reserved_units_audit after insert or update on public.order_reserved_units for each row execute function public.audit_row_change();
create trigger customer_addresses_audit after insert or update or delete on public.customer_addresses for each row execute function public.audit_row_change();

-- Realtime publication changes are duplicate-safe and skipped when Supabase has not created the publication.
do $$ declare v_table text;
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach v_table in array array['inventory_balances','orders','deliveries','notifications','cms_banners','cms_home_blocks','cms_pages','cms_promotions','cms_promotion_products','cms_menu_items','system_settings','products'] loop
      if to_regclass('public.'||v_table) is not null and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=v_table) then
        execute format('alter publication supabase_realtime add table public.%I',v_table);
      end if;
    end loop;
  end if;
end $$;

-- Transactional writes remain default-deny. Read grants still pass through RLS.
revoke all on public.product_price_history,public.customer_favorites,public.customer_cart_items,public.customer_addresses,
  public.inventory_counts,public.inventory_count_lines,public.writeoffs,public.writeoff_lines,public.sale_returns,public.sale_return_lines,public.sale_refunds,
  public.orders,public.order_lines,public.order_status_history,public.order_reserved_units,public.deliveries,public.courier_tracking,
  public.finance_accounts,public.finance_transactions,public.supplier_payments,public.supplier_returns,public.supplier_return_lines,
  public.payroll_runs,public.payroll_items,public.notifications from anon,authenticated;
grant select on public.customer_favorites,public.customer_cart_items,public.customer_addresses,public.product_price_history,
  public.inventory_counts,public.inventory_count_lines,public.writeoffs,public.writeoff_lines,public.sale_returns,public.sale_return_lines,public.sale_refunds,
  public.orders,public.order_lines,public.order_status_history,public.order_reserved_units,public.deliveries,
  public.finance_accounts,public.finance_transactions,public.supplier_payments,public.supplier_returns,public.supplier_return_lines,
  public.payroll_runs,public.payroll_items,public.notifications to authenticated;

-- Anon receives no direct table access; only sanitized storefront/order RPCs below.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

do $$ declare r record;
begin
  for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in(
      'capture_product_price_history','save_catalog_product','save_customer_profile','save_customer_address','delete_customer_address','set_customer_favorite','set_customer_cart_item','get_customer_account',
      'create_inventory_count','start_inventory_count','count_inventory_unit','review_inventory_count','post_inventory_count','cancel_inventory_count',
      'create_writeoff','add_writeoff_unit','approve_writeoff','post_writeoff','cancel_writeoff','request_sale_return','approve_sale_return','complete_sale_return','cancel_sale_return',
      'enqueue_order_notification','reserve_online_order_units','transition_online_order','cancel_online_order','assign_order_courier','finalize_online_order_sale',
      'list_courier_deliveries','get_courier_stats','insert_courier_tracking','courier_update_delivery_status','list_notifications','mark_notifications_read',
      'require_finance_operator','save_finance_account','post_finance_transaction','record_supplier_payment','create_supplier_return','post_supplier_return','cancel_supplier_return',
      'create_payroll_run','approve_payroll_run','pay_payroll_run','accrue_supplier_balance_from_receipt_line','reorder_cms_items','delete_cms_banner','save_cms_banner','save_cms_promotion','query_audit_log','storefront_catalog','storefront_cms_payload',
      'customer_order_history','require_report_access','report_sales_rows','report_finance_rows','report_debt_rows','report_supplier_ledger','report_inventory_rows','report_profit_loss','get_management_dashboard','create_online_order','guard_order_reserved_unit','guard_sale_payment_refund_update')
  loop execute format('revoke all on function %s from public,anon,authenticated',r.sig); end loop;
end $$;

-- Public API allow-list.
grant execute on function public.storefront_catalog(text,uuid,integer,integer),public.storefront_cms_payload(),
  public.create_online_order(jsonb,jsonb,jsonb,text,text,text) to anon,authenticated;

-- Authenticated customer/staff API allow-list.
grant execute on function public.save_catalog_product(jsonb,jsonb),public.save_customer_profile(jsonb),public.save_customer_address(jsonb),public.delete_customer_address(uuid),
  public.set_customer_favorite(uuid,boolean),public.set_customer_cart_item(uuid,integer),public.get_customer_account(),public.customer_order_history(integer,integer),
  public.create_inventory_count(uuid,jsonb,text,uuid),public.start_inventory_count(uuid),public.count_inventory_unit(uuid,text),
  public.review_inventory_count(uuid),public.post_inventory_count(uuid),public.cancel_inventory_count(uuid,text),
  public.create_writeoff(uuid,text,uuid),public.add_writeoff_unit(uuid,text),public.approve_writeoff(uuid),public.post_writeoff(uuid),public.cancel_writeoff(uuid,text),
  public.request_sale_return(uuid,public.return_kind,text,jsonb,uuid),public.approve_sale_return(uuid),public.complete_sale_return(uuid,uuid,uuid),public.cancel_sale_return(uuid,text),
  public.transition_online_order(uuid,public.order_status,uuid,text),public.cancel_online_order(uuid,text),public.assign_order_courier(uuid,uuid),
  public.list_courier_deliveries(public.delivery_status,integer,integer),public.get_courier_stats(date,date),public.insert_courier_tracking(uuid,numeric,numeric,numeric),
  public.courier_update_delivery_status(uuid,public.delivery_status,text,uuid),public.list_notifications(boolean,integer,integer),public.mark_notifications_read(uuid[]),
  public.save_finance_account(jsonb),public.post_finance_transaction(uuid,public.finance_type,text,numeric,timestamptz,text,text,uuid,uuid),
  public.record_supplier_payment(uuid,uuid,uuid,numeric,text,text,text,uuid),public.create_supplier_return(uuid,uuid,text,uuid[],uuid),
  public.post_supplier_return(uuid),public.cancel_supplier_return(uuid,text),public.create_payroll_run(uuid,date,date,jsonb,uuid),
  public.approve_payroll_run(uuid),public.pay_payroll_run(uuid,uuid,uuid),public.reorder_cms_items(text,jsonb),public.delete_cms_banner(uuid),public.save_cms_banner(jsonb,uuid),public.save_cms_promotion(jsonb,uuid[]),
  public.query_audit_log(text,text,uuid,timestamptz,timestamptz,integer,integer),public.report_sales_rows(date,date,uuid),
  public.report_finance_rows(date,date,uuid),public.report_debt_rows(date,date,uuid),public.report_supplier_ledger(date,date,uuid,uuid),public.report_inventory_rows(uuid),public.report_profit_loss(date,date,uuid),public.get_management_dashboard(date,date,uuid)
  to authenticated;

-- Internal helpers are service-only; service role also gets all new objects explicitly.
grant execute on function public.capture_product_price_history(),public.enqueue_order_notification(uuid,text,text,jsonb),
  public.reserve_online_order_units(uuid,uuid),public.finalize_online_order_sale(uuid,uuid),public.require_finance_operator(uuid),
  public.require_report_access(uuid),public.guard_order_reserved_unit(),public.guard_sale_payment_refund_update(),public.accrue_supplier_balance_from_receipt_line() to service_role;
grant all on public.product_price_history,public.customer_favorites,public.customer_cart_items,public.customer_addresses,public.sale_refunds,
  public.order_reserved_units,public.supplier_payments,public.supplier_returns,public.supplier_return_lines to service_role;
grant usage,select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Narrow manager read surfaces. These expose only fields needed by the manager
-- workflows and avoid widening direct access to sales, unassigned orders or staff.
create or replace function public.get_sale_for_return(p_branch_id uuid,p_query text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if p_branch_id is null or not public.current_user_active() or not(
    public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager']::public.app_role[],p_branch_id)) then
    raise exception 'Filial menejeri roli talab qilinadi' using errcode='42501';
  end if;
  return jsonb_build_object('items',coalesce((
    select jsonb_agg(to_jsonb(q) order by q.sold_at desc,q.id) from(
      select s.id,s.sale_no,s.status,s.total,s.sold_at,
        coalesce((select jsonb_agg(jsonb_build_object(
          'sale_line_id',sl.id,'unit_id',sl.unit_id,'product_id',sl.product_id,
          'product_name',p.name,'sku',p.sku,'qr_code',u.qr_code,'serial_number',u.serial_number,
          'unit_price',sl.unit_price,'discount',sl.discount,'tax',sl.tax,'line_total',sl.line_total,
          'max_refund',sl.line_total,'eligible',(u.status='sold' and u.sold_sale_id=s.id and not exists(
            select 1 from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id
            where x.sale_line_id=sl.id and r.status in('requested','approved','completed'))),
          'ineligibility_reason',case
            when exists(select 1 from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id
              where x.sale_line_id=sl.id and r.status in('requested','approved','completed')) then 'Birlik qaytarilgan yoki qaytarish jarayonida'
            when u.status<>'sold' or u.sold_sale_id is distinct from s.id then 'Birlik sotilgan holatda emas'
            else null end
        ) order by sl.created_at,sl.id) from public.sale_lines sl
          join public.products p on p.id=sl.product_id join public.inventory_units u on u.id=sl.unit_id
          where sl.sale_id=s.id),'[]'::jsonb) lines
      from public.sales s
      where s.branch_id=p_branch_id and s.status in('completed','partially_returned')
        and (nullif(btrim(p_query),'') is null or s.sale_no ilike '%'||btrim(p_query)||'%'
          or exists(select 1 from public.sale_lines sl join public.inventory_units u on u.id=sl.unit_id
            where sl.sale_id=s.id and (u.qr_code ilike '%'||btrim(p_query)||'%' or coalesce(u.serial_number,'') ilike '%'||btrim(p_query)||'%')))
      order by s.sold_at desc,s.id limit 20
    )q),'[]'::jsonb));
end $$;

create or replace function public.list_manager_orders(p_branch_id uuid,p_status text default null,p_query text default null,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb; v_total bigint;
begin
  if p_branch_id is null or not public.current_user_active() or not(
    public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager']::public.app_role[],p_branch_id)) then
    raise exception 'Filial menejeri roli talab qilinadi' using errcode='42501';
  end if;
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  if nullif(p_status,'') is not null and not exists(select 1 from unnest(enum_range(null::public.order_status)) x where x::text=p_status) then
    raise exception 'Buyurtma statusi noto‘g‘ri' using errcode='22023';
  end if;
  select count(*) into v_total from public.orders o where (o.branch_id=p_branch_id or (o.branch_id is null and o.status='new'))
    and (nullif(p_status,'') is null or o.status::text=p_status)
    and (nullif(btrim(p_query),'') is null or o.order_no ilike '%'||btrim(p_query)||'%' or o.customer_name ilike '%'||btrim(p_query)||'%' or o.customer_phone ilike '%'||btrim(p_query)||'%');
  select coalesce(jsonb_agg(to_jsonb(q) order by q.placed_at desc,q.id),'[]'::jsonb) into v_items from(
    select o.id,o.order_no,o.branch_id,o.status,o.customer_name,o.customer_phone,o.shipping_address,o.notes,
      o.subtotal,o.discount,o.delivery_fee,o.total,o.payment_status,o.placed_at,
      coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'product_id',l.product_id,'product_name',l.product_name,
        'sku',l.sku,'quantity',l.quantity,'unit_price',l.unit_price,'discount',l.discount,'line_total',l.line_total) order by l.id)
        from public.order_lines l where l.order_id=o.id),'[]'::jsonb) order_lines,
      (select jsonb_build_object('id',d.id,'courier_id',d.courier_id,'status',d.status,'tracking_code',d.tracking_code,
        'assigned_at',d.assigned_at,'picked_up_at',d.picked_up_at,'delivered_at',d.delivered_at)
        from public.deliveries d where d.order_id=o.id) delivery
    from public.orders o where (o.branch_id=p_branch_id or (o.branch_id is null and o.status='new'))
      and (nullif(p_status,'') is null or o.status::text=p_status)
      and (nullif(btrim(p_query),'') is null or o.order_no ilike '%'||btrim(p_query)||'%' or o.customer_name ilike '%'||btrim(p_query)||'%' or o.customer_phone ilike '%'||btrim(p_query)||'%')
    order by o.placed_at desc,o.id limit p_limit offset p_offset
  )q;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

create or replace function public.get_manager_workspace_references(p_branch_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if p_branch_id is null or not public.current_user_active() or not(
    public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager','accountant']::public.app_role[],p_branch_id)) then
    raise exception 'Filial menejeri yoki buxgalter roli talab qilinadi' using errcode='42501';
  end if;
  return jsonb_build_object(
    'locations',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'code',l.code,'name',l.name,'type',l.type) order by l.type,l.name)
      from public.locations l where l.branch_id=p_branch_id and l.is_active and l.type in('store','warehouse')),'[]'::jsonb),
    'suppliers',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'code',s.code,'name',s.name,'balance',s.balance) order by s.name)
      from public.suppliers s where s.is_active),'[]'::jsonb),
    'employees',coalesce((select jsonb_agg(to_jsonb(e) order by e.full_name,e.id) from(
      select p.id,p.full_name,array_agg(distinct r.role::text order by r.role::text) roles
      from public.profiles p join public.profile_roles r on r.profile_id=p.id
      where p.is_active and r.branch_id=p_branch_id group by p.id,p.full_name)e),'[]'::jsonb),
    'couriers',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'full_name',p.full_name) order by p.full_name)
      from public.profiles p join public.profile_roles r on r.profile_id=p.id
      where p.is_active and r.branch_id=p_branch_id and r.role='courier'),'[]'::jsonb));
end $$;

create or replace function public.manager_cancel_online_order(p_order_id uuid,p_branch_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_o public.orders%rowtype;
begin
  if p_branch_id is null or not public.current_user_active() or not(
    public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager']::public.app_role[],p_branch_id)) then
    raise exception 'Filial menejeri roli talab qilinadi' using errcode='42501';
  end if;
  select * into v_o from public.orders where id=p_order_id for update;
  if not found then raise exception 'Buyurtma topilmadi' using errcode='P0002'; end if;
  if v_o.branch_id is not null and v_o.branch_id<>p_branch_id then raise exception 'Buyurtma boshqa filialga biriktirilgan' using errcode='P0001'; end if;
  if v_o.branch_id is null then
    if v_o.status<>'new' then raise exception 'Faqat yangi biriktirilmagan buyurtma qabul qilinadi' using errcode='P0001'; end if;
    update public.orders set branch_id=p_branch_id where id=p_order_id;
  end if;
  return public.cancel_online_order(p_order_id,p_reason);
end $$;

create or replace function public.list_admin_orders(p_branch_id uuid default null,p_status text default null,p_query text default null,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb; v_total bigint;
begin
  if not public.current_user_active() or not public.has_role(array['superadmin','admin']::public.app_role[],null) then
    raise exception 'Global administrator roli talab qilinadi' using errcode='42501';
  end if;
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  if nullif(p_status,'') is not null and not exists(select 1 from unnest(enum_range(null::public.order_status)) x where x::text=p_status) then
    raise exception 'Buyurtma statusi noto‘g‘ri' using errcode='22023';
  end if;
  select count(*) into v_total from public.orders o where (p_branch_id is null or o.branch_id=p_branch_id or (o.branch_id is null and o.status='new'))
    and (nullif(p_status,'') is null or o.status::text=p_status)
    and (nullif(btrim(p_query),'') is null or o.order_no ilike '%'||btrim(p_query)||'%' or o.customer_name ilike '%'||btrim(p_query)||'%' or o.customer_phone ilike '%'||btrim(p_query)||'%');
  select coalesce(jsonb_agg(to_jsonb(q) order by q.placed_at desc,q.id),'[]'::jsonb) into v_items from(
    select o.id,o.order_no,o.branch_id,b.code branch_code,b.name branch_name,o.status,o.customer_name,o.customer_phone,o.shipping_address,o.notes,
      o.subtotal,o.discount,o.delivery_fee,o.total,o.payment_status,o.placed_at,
      coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'product_id',l.product_id,'product_name',l.product_name,
        'sku',l.sku,'quantity',l.quantity,'unit_price',l.unit_price,'discount',l.discount,'line_total',l.line_total) order by l.id)
        from public.order_lines l where l.order_id=o.id),'[]'::jsonb) order_lines,
      (select jsonb_build_object('id',d.id,'courier_id',d.courier_id,'status',d.status,'tracking_code',d.tracking_code,
        'assigned_at',d.assigned_at,'picked_up_at',d.picked_up_at,'delivered_at',d.delivered_at,'proof_url',d.proof_url)
        from public.deliveries d where d.order_id=o.id) delivery
    from public.orders o left join public.branches b on b.id=o.branch_id
    where (p_branch_id is null or o.branch_id=p_branch_id or (o.branch_id is null and o.status='new'))
      and (nullif(p_status,'') is null or o.status::text=p_status)
      and (nullif(btrim(p_query),'') is null or o.order_no ilike '%'||btrim(p_query)||'%' or o.customer_name ilike '%'||btrim(p_query)||'%' or o.customer_phone ilike '%'||btrim(p_query)||'%')
    order by o.placed_at desc,o.id limit p_limit offset p_offset
  )q;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

create table if not exists public.telegram_chat_links(
  chat_id bigint primary key,telegram_user_id bigint not null check(telegram_user_id>0),profile_id uuid not null references public.profiles(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,is_active boolean not null default true,
  verified_at timestamptz not null default now(),created_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
update public.telegram_chat_links set is_active=false where telegram_user_id is null;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='telegram_chat_links_sender_required') then
    alter table public.telegram_chat_links add constraint telegram_chat_links_sender_required check(telegram_user_id is not null and telegram_user_id>0) not valid;
  end if;
end $$;
create index if not exists telegram_chat_links_profile_idx on public.telegram_chat_links(profile_id) where is_active;
create trigger telegram_chat_links_set_updated_at before update on public.telegram_chat_links for each row execute function public.set_updated_at();
create trigger telegram_chat_links_audit after insert or update or delete on public.telegram_chat_links for each row execute function public.audit_row_change();
create table if not exists public.telegram_updates(
  update_id bigint primary key,chat_id bigint,status text not null check(status in('processing','dispatching','completed','failed')),
  attempts integer not null default 1 check(attempts>0),claim_token uuid,claimed_at timestamptz,last_error text,
  received_at timestamptz not null default now(),processed_at timestamptz
);
alter table public.telegram_updates add column if not exists claim_token uuid;
alter table public.telegram_updates add column if not exists claimed_at timestamptz;
alter table public.telegram_updates drop constraint if exists telegram_updates_status_check;
alter table public.telegram_updates add constraint telegram_updates_status_check check(status in('processing','dispatching','completed','failed'));
alter table public.telegram_chat_links enable row level security;
alter table public.telegram_updates enable row level security;
revoke all on public.telegram_chat_links,public.telegram_updates from public,anon,authenticated;
grant all on public.telegram_chat_links,public.telegram_updates to service_role;

create or replace function public.storefront_sitemap_entries()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'products',coalesce((select jsonb_agg(jsonb_build_object('slug',p.slug,'updated_at',p.updated_at,'image_url',coalesce(p.seo_image_url,
      (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order,m.id limit 1))) order by p.slug)
      from public.products p where p.status='active' and p.is_published),'[]'::jsonb),
    'categories',coalesce((select jsonb_agg(jsonb_build_object('slug',c.slug,'updated_at',c.updated_at,'image_url',c.seo_image_url) order by c.slug)
      from public.categories c where c.is_active),'[]'::jsonb),
    'pages',coalesce((select jsonb_agg(jsonb_build_object('slug',p.slug,'updated_at',p.updated_at,'image_url',p.seo->>'image_url') order by p.slug)
      from public.cms_pages p where p.is_published and p.published_at<=now()),'[]'::jsonb));
$$;
revoke all on function public.storefront_sitemap_entries() from public,anon,authenticated;
grant execute on function public.storefront_sitemap_entries() to anon,authenticated,service_role;

create or replace function public.list_telegram_chat_links()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_role(array['superadmin']::public.app_role[],null) then raise exception 'Global superadmin roli talab qilinadi' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'chat_id',l.chat_id::text,'telegram_user_id',l.telegram_user_id::text,'profile_id',l.profile_id,'profile_name',p.full_name,
    'branch_id',l.branch_id,'branch_name',b.name,'is_active',l.is_active,'verified_at',l.verified_at) order by p.full_name,l.chat_id)
    from public.telegram_chat_links l join public.profiles p on p.id=l.profile_id left join public.branches b on b.id=l.branch_id),'[]'::jsonb);
end $$;
create or replace function public.save_telegram_chat_link(p_chat_id bigint,p_telegram_user_id bigint,p_profile_id uuid,p_branch_id uuid default null,p_is_active boolean default true)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not public.has_role(array['superadmin']::public.app_role[],null) then raise exception 'Global superadmin roli talab qilinadi' using errcode='42501'; end if;
  if p_chat_id is null or p_chat_id=0 or p_telegram_user_id is null or p_telegram_user_id<=0 or not exists(select 1 from public.profiles p join public.profile_roles r on r.profile_id=p.id
    where p.id=p_profile_id and p.is_active and r.role in('superadmin','admin','manager')
      and ((p_branch_id is null and r.branch_id is null) or (p_branch_id is not null and (r.branch_id=p_branch_id or r.branch_id is null)))) then
    raise exception 'Telegram chat yoki rahbar profili noto‘g‘ri' using errcode='22023';
  end if;
  insert into public.telegram_chat_links(chat_id,telegram_user_id,profile_id,branch_id,is_active,verified_at,created_by)
  values(p_chat_id,p_telegram_user_id,p_profile_id,p_branch_id,coalesce(p_is_active,true),now(),auth.uid())
  on conflict(chat_id) do update set telegram_user_id=excluded.telegram_user_id,profile_id=excluded.profile_id,branch_id=excluded.branch_id,
    is_active=excluded.is_active,verified_at=now(),updated_at=now();
end $$;
create or replace function public.delete_telegram_chat_link(p_chat_id bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not public.has_role(array['superadmin']::public.app_role[],null) then raise exception 'Global superadmin roli talab qilinadi' using errcode='42501'; end if;
  delete from public.telegram_chat_links where chat_id=p_chat_id;
end $$;

create or replace function public.claim_telegram_update(p_update_id bigint,p_chat_id bigint,p_lease_seconds integer default 120)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_token uuid:=gen_random_uuid(); v_claimed uuid;
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  if p_update_id is null or p_update_id<0 or p_chat_id is null or p_chat_id=0 or p_lease_seconds not between 30 and 600 then raise exception 'Telegram update noto‘g‘ri' using errcode='22023'; end if;
  insert into public.telegram_updates(update_id,chat_id,status,attempts,claim_token,claimed_at,last_error,processed_at)
  values(p_update_id,p_chat_id,'processing',1,v_token,now(),null,null)
  on conflict(update_id) do update set chat_id=excluded.chat_id,status='processing',attempts=public.telegram_updates.attempts+1,
    claim_token=excluded.claim_token,claimed_at=now(),last_error=null,processed_at=null
  where public.telegram_updates.status='failed' or (public.telegram_updates.status='processing' and (public.telegram_updates.claimed_at is null or public.telegram_updates.claimed_at<now()-make_interval(secs=>p_lease_seconds)))
  returning claim_token into v_claimed;
  return v_claimed;
end $$;

create or replace function public.mark_telegram_update_dispatching(p_update_id bigint,p_claim_token uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  update public.telegram_updates set status='dispatching' where update_id=p_update_id and claim_token=p_claim_token and status='processing';
  if not found then raise exception 'Telegram dispatch claim topilmadi' using errcode='P0002'; end if;
end $$;

create or replace function public.finish_telegram_update(p_update_id bigint,p_claim_token uuid,p_success boolean,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  update public.telegram_updates set status=case when p_success then 'completed' else 'failed' end,
    last_error=case when p_success then null else left(coalesce(p_error,'Noma’lum xato'),1000) end,processed_at=now(),claim_token=null
  where update_id=p_update_id and claim_token=p_claim_token and status in('processing','dispatching');
  if not found then raise exception 'Telegram update claim topilmadi' using errcode='P0002'; end if;
end $$;

create or replace function public.telegram_daily_summary(p_branch_id uuid,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  if p_from is null or p_to is null or p_to<=p_from or p_to-p_from>interval '2 days'
    or (p_branch_id is not null and not exists(select 1 from public.branches where id=p_branch_id and is_active)) then raise exception 'Telegram hisobot scope noto‘g‘ri' using errcode='22023'; end if;
  with scoped_sales as(
    select s.id,s.seller_id,s.total from public.sales s where s.sold_at>=p_from and s.sold_at<p_to and s.status<>'void' and (p_branch_id is null or s.branch_id=p_branch_id)
  ), totals as(
    select coalesce(sum(s.total),0) revenue,count(*) receipts,coalesce((select sum(l.line_total-l.tax-l.unit_cost) from scoped_sales x join public.sale_lines l on l.sale_id=x.id),0) profit from scoped_sales s
  ), sellers as(
    select s.seller_id,p.full_name,sum(s.total) total from scoped_sales s left join public.profiles p on p.id=s.seller_id group by s.seller_id,p.full_name
  )
  select jsonb_build_object('revenue',t.revenue,'receipts',t.receipts,'profit',t.profit,'sellers',coalesce((select jsonb_agg(jsonb_build_object('seller_id',seller_id,'full_name',full_name,'total',total) order by total desc,seller_id) from sellers),'[]'::jsonb))
  into v_result from totals t;
  return v_result;
end $$;

revoke all on function public.claim_telegram_update(bigint,bigint,integer),public.mark_telegram_update_dispatching(bigint,uuid),public.finish_telegram_update(bigint,uuid,boolean,text),public.telegram_daily_summary(uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_telegram_update(bigint,bigint,integer),public.mark_telegram_update_dispatching(bigint,uuid),public.finish_telegram_update(bigint,uuid,boolean,text),public.telegram_daily_summary(uuid,timestamptz,timestamptz) to service_role;

revoke all on function public.list_telegram_chat_links(),public.save_telegram_chat_link(bigint,bigint,uuid,uuid,boolean),public.delete_telegram_chat_link(bigint) from public,anon,authenticated;
grant execute on function public.list_telegram_chat_links(),public.save_telegram_chat_link(bigint,bigint,uuid,uuid,boolean),public.delete_telegram_chat_link(bigint) to authenticated,service_role;

revoke all on function public.get_sale_for_return(uuid,text),public.list_manager_orders(uuid,text,text,integer,integer),
  public.get_manager_workspace_references(uuid),public.manager_cancel_online_order(uuid,uuid,text),
  public.list_admin_orders(uuid,text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.get_sale_for_return(uuid,text),public.list_manager_orders(uuid,text,text,integer,integer),
  public.get_manager_workspace_references(uuid),public.manager_cancel_online_order(uuid,uuid,text),
  public.list_admin_orders(uuid,text,text,integer,integer) to authenticated,service_role;

commit;
