-- Task 13: POS cashier reservation, approval, payment and receipt hardening.
begin;

do $$
declare v_type text;
begin
  select pg_catalog.format_type(a.atttypid,a.atttypmod) into v_type
  from pg_catalog.pg_attribute a
  where a.attrelid='public.products'::regclass and a.attname='minimum_sale_price' and not a.attisdropped;
  if v_type is null then
    alter table public.products add column minimum_sale_price numeric(18,2);
  elsif v_type<>'numeric(18,2)' then
    raise exception 'products.minimum_sale_price turi numeric(18,2) bo‘lishi kerak; remote tur: %',v_type;
  end if;
end $$;
update public.products set minimum_sale_price=least(cost_price,retail_price) where minimum_sale_price is null;
create or replace function public.normalize_product_minimum_sale_price()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.minimum_sale_price is null then
    new.minimum_sale_price:=least(new.cost_price,new.retail_price);
  elsif tg_op='UPDATE' and new.minimum_sale_price is not distinct from old.minimum_sale_price
    and new.retail_price<new.minimum_sale_price then
    new.minimum_sale_price:=new.retail_price;
  end if;
  return new;
end $$;
drop trigger if exists products_minimum_sale_price_normalize on public.products;
create trigger products_minimum_sale_price_normalize before insert or update of cost_price,retail_price,minimum_sale_price
  on public.products for each row execute function public.normalize_product_minimum_sale_price();
alter table public.products alter column minimum_sale_price set not null;
alter table public.products drop constraint if exists products_minimum_sale_price_chk;
alter table public.products add constraint products_minimum_sale_price_chk
  check(minimum_sale_price>=0 and minimum_sale_price<=retail_price);

insert into public.payment_methods(code,name,is_cash,is_online,is_active,sort_order) values
  ('cash','Naqd',true,false,true,10),('card','Bank kartasi / terminal',false,false,true,20),
  ('click','Click',false,true,true,30),('payme','Payme',false,true,true,40),
  ('uzum','Uzum Bank',false,true,true,50),('bank_transfer','Bank o‘tkazmasi',false,false,true,60),
  ('installment','Nasiya',false,false,true,70),('other','Boshqa',false,false,true,80)
on conflict(code) do update set name=excluded.name,is_cash=excluded.is_cash,is_online=excluded.is_online,
  is_active=excluded.is_active,sort_order=excluded.sort_order;

alter table public.pos_pending_sales
  add column if not exists pending_no text,
  add column if not exists store_location_id uuid,
  add column if not exists idempotency_key uuid,
  add column if not exists request_hash text,
  add column if not exists rejected_by uuid,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejection_reason text;
do $$
declare v_name text;v_expected text;v_actual text;
begin
  for v_name,v_expected in select * from (values
    ('pending_no','text'),('store_location_id','uuid'),('idempotency_key','uuid'),('request_hash','text'),
    ('rejected_by','uuid'),('rejected_at','timestamp with time zone'),('rejection_reason','text')) expected(name,data_type)
  loop
    select pg_catalog.format_type(a.atttypid,a.atttypmod) into v_actual from pg_catalog.pg_attribute a
    where a.attrelid='public.pos_pending_sales'::regclass and a.attname=v_name and not a.attisdropped;
    if v_actual is distinct from v_expected then
      raise exception 'pos_pending_sales.% turi % bo‘lishi kerak; remote tur: %',v_name,v_expected,v_actual;
    end if;
  end loop;
  if not exists(select 1 from pg_catalog.pg_constraint where conrelid='public.pos_pending_sales'::regclass and conname='pos_pending_sales_store_location_id_fkey') then
    alter table public.pos_pending_sales add constraint pos_pending_sales_store_location_id_fkey
      foreign key(store_location_id) references public.locations(id) on delete restrict;
  end if;
  if not exists(select 1 from pg_catalog.pg_constraint where conrelid='public.pos_pending_sales'::regclass and conname='pos_pending_sales_rejected_by_fkey') then
    alter table public.pos_pending_sales add constraint pos_pending_sales_rejected_by_fkey
      foreign key(rejected_by) references public.profiles(id) on delete restrict;
  end if;
end $$;

update public.pos_pending_sales s set
  pending_no=coalesce(s.pending_no,'POS-'||to_char(s.created_at,'YYYYMMDDHH24MISSMS')||'-'||upper(substr(s.id::text,1,8))),
  store_location_id=coalesce(s.store_location_id,
    (select u.location_id from public.pos_pending_sale_lines x join public.inventory_units u on u.id=x.unit_id
      where x.pending_sale_id=s.id order by x.created_at,x.id limit 1),
    (select l.id from public.locations l where l.branch_id=s.branch_id and l.type='store' order by l.is_active desc,l.created_at limit 1)),
  idempotency_key=coalesce(s.idempotency_key,gen_random_uuid()),
  request_hash=coalesce(s.request_hash,encode(extensions.digest(s.id::text,'sha256'),'hex')),
  rejected_by=case when s.status='rejected' then coalesce(s.rejected_by,s.confirmed_by,s.seller_id) else null end,
  rejected_at=case when s.status='rejected' then coalesce(s.rejected_at,s.updated_at,s.created_at) else null end,
  rejection_reason=case when s.status='rejected' then coalesce(nullif(btrim(s.rejection_reason),''),'Oldingi POS so‘rovi rad etilgan') else null end;

do $$ begin
  if exists(select 1 from public.pos_pending_sales where pending_no is null or store_location_id is null
    or idempotency_key is null or request_hash is null) then
    raise exception 'Mavjud POS navbatlarini yangi shartlarga moslab bo‘lmadi';
  end if;
end $$;

alter table public.pos_pending_sales alter column pending_no set not null,
  alter column store_location_id set not null,alter column idempotency_key set not null,
  alter column request_hash set not null;
alter table public.pos_pending_sales drop constraint if exists pos_pending_sales_pending_no_key;
alter table public.pos_pending_sales add constraint pos_pending_sales_pending_no_key unique(pending_no);
alter table public.pos_pending_sales drop constraint if exists pos_pending_sales_seller_idempotency_key;
alter table public.pos_pending_sales add constraint pos_pending_sales_seller_idempotency_key unique(seller_id,idempotency_key);
alter table public.pos_pending_sales drop constraint if exists pos_pending_sales_rejection_state_chk;
alter table public.pos_pending_sales add constraint pos_pending_sales_rejection_state_chk check(
  (status='rejected' and rejected_by is not null and rejected_at is not null and nullif(btrim(rejection_reason),'') is not null)
  or (status<>'rejected' and rejected_by is null and rejected_at is null and rejection_reason is null));
drop index if exists public.pos_pending_sales_list_idx;
create index pos_pending_sales_list_idx on public.pos_pending_sales(branch_id,status,created_at desc);
drop index if exists public.pos_pending_sales_seller_list_idx;
create index pos_pending_sales_seller_list_idx on public.pos_pending_sales(seller_id,status,created_at desc);
create table if not exists public.pos_pending_sale_payments(
  id uuid primary key default gen_random_uuid(),
  pending_sale_id uuid not null references public.pos_pending_sales(id) on delete restrict,
  payment_method_id uuid not null references public.payment_methods(id) on delete restrict,
  amount numeric(18,2) not null check(amount>0),external_reference text,
  sort_order integer not null check(sort_order between 1 and 10),created_at timestamptz not null default now(),
  unique(pending_sale_id,sort_order));
drop index if exists public.pos_pending_sale_payments_parent_idx;
create index pos_pending_sale_payments_parent_idx on public.pos_pending_sale_payments(pending_sale_id);

drop index if exists public.inventory_movements_pos_reservation_uidx;
create unique index inventory_movements_pos_reservation_uidx
  on public.inventory_movements(reference_id,unit_id,movement_type)
  where reference_type='pos_pending_sale' and reference_id is not null and unit_id is not null
    and movement_type in('reserved','reservation_released');
drop index if exists public.inventory_movements_sale_sold_uidx;
create unique index inventory_movements_sale_sold_uidx
  on public.inventory_movements(reference_id,unit_id,movement_type)
  where reference_type='sale' and reference_id is not null and unit_id is not null and movement_type='sold';

drop trigger if exists pos_pending_sale_lines_immutable on public.pos_pending_sale_lines;
create trigger pos_pending_sale_lines_immutable before update or delete on public.pos_pending_sale_lines
  for each row execute function public.reject_mutation();
drop trigger if exists pos_pending_sale_payments_immutable on public.pos_pending_sale_payments;
create trigger pos_pending_sale_payments_immutable before update or delete on public.pos_pending_sale_payments
  for each row execute function public.reject_mutation();
drop trigger if exists sale_lines_immutable on public.sale_lines;
create trigger sale_lines_immutable before update or delete on public.sale_lines
  for each row execute function public.reject_mutation();
drop trigger if exists sale_payments_immutable on public.sale_payments;
create trigger sale_payments_immutable before update or delete on public.sale_payments
  for each row execute function public.reject_mutation();
drop trigger if exists pos_pending_sale_lines_audit on public.pos_pending_sale_lines;
create trigger pos_pending_sale_lines_audit after insert on public.pos_pending_sale_lines
  for each row execute function public.audit_row_change();
drop trigger if exists pos_pending_sale_payments_audit on public.pos_pending_sale_payments;
create trigger pos_pending_sale_payments_audit after insert on public.pos_pending_sale_payments
  for each row execute function public.audit_row_change();
drop trigger if exists sale_lines_audit on public.sale_lines;
create trigger sale_lines_audit after insert on public.sale_lines for each row execute function public.audit_row_change();
drop trigger if exists sale_payments_audit on public.sale_payments;
create trigger sale_payments_audit after insert on public.sale_payments for each row execute function public.audit_row_change();

create or replace function public.require_pos_seller(p_branch uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not(public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager','seller']::public.app_role[],p_branch)) then
    raise exception 'POS sotuvchisi roli talab qilinadi' using errcode='42501';
  end if;
end $$;

create or replace function public.require_pos_manager(p_branch uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not(public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager']::public.app_role[],p_branch)) then
    raise exception 'Filial menejeri roli talab qilinadi' using errcode='42501';
  end if;
end $$;

create or replace function public.release_pos_reservation(p_pending_id uuid,p_status public.pending_sale_status,
  p_reason text,p_actor uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_s public.pos_pending_sales%rowtype; v_x record;
begin
  if p_status not in('expired','rejected') then raise exception 'Yakuniy bekor qilish holati noto‘g‘ri' using errcode='22023'; end if;
  select * into v_s from public.pos_pending_sales where id=p_pending_id for update;
  if not found then raise exception 'POS so‘rovi topilmadi' using errcode='P0002'; end if;
  if v_s.status=p_status then return; end if;
  if v_s.status<>'pending' then raise exception 'Yakunlangan POS so‘rovini bekor qilib bo‘lmaydi' using errcode='P0001'; end if;
  perform 1 from public.inventory_units u join public.pos_pending_sale_lines x on x.unit_id=u.id
    where x.pending_sale_id=p_pending_id order by u.id for update of u;
  for v_x in select x.*,u.batch_id,u.location_id from public.pos_pending_sale_lines x
    join public.inventory_units u on u.id=x.unit_id where x.pending_sale_id=p_pending_id order by u.id loop
    if exists(select 1 from public.inventory_units where id=v_x.unit_id and status='reserved' and sold_sale_id is null) then
      update public.inventory_units set status='available',reserved_until=null,version=version+1 where id=v_x.unit_id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,
        quantity,reference_type,reference_id,reason,actor_id)
      values(v_x.unit_id,v_x.product_id,v_x.batch_id,'reservation_released',v_x.location_id,v_x.location_id,
        1,'pos_pending_sale',p_pending_id,nullif(btrim(p_reason),''),p_actor) on conflict do nothing;
    end if;
  end loop;
  update public.pos_pending_sales set status=p_status,
    rejected_by=case when p_status='rejected' then p_actor end,
    rejected_at=case when p_status='rejected' then now() end,
    rejection_reason=case when p_status='rejected' then coalesce(nullif(btrim(p_reason),''),'Menejer tomonidan rad etildi') end
  where id=p_pending_id;
end $$;
create or replace function public.get_pos_references(p_branch_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_currency text;
begin
  perform public.require_pos_seller(p_branch_id);
  select btrim(currency::text) into v_currency from public.branches where id=p_branch_id and is_active;
  if not found then raise exception 'Faol filial topilmadi' using errcode='P0002'; end if;
  return jsonb_build_object('branch_id',p_branch_id,'currency',v_currency,
    'store_locations',coalesce((select jsonb_agg(jsonb_build_object('id',id,'code',code,'name',name) order by name)
      from public.locations where branch_id=p_branch_id and type='store' and is_active),'[]'::jsonb),
    'payment_methods',coalesce((select jsonb_agg(jsonb_build_object('id',id,'code',code,'name',name,
      'is_cash',is_cash,'is_online',is_online) order by sort_order,code) from public.payment_methods
      where is_active and code<>'cod'),'[]'::jsonb),
    'discount_policy',jsonb_build_object('seller_max_line_discount_percent',20));
end $$;

create or replace function public.find_pos_unit(p_branch_id uuid,p_code text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb; v_code text:=nullif(btrim(p_code),'');
begin
  perform public.require_pos_seller(p_branch_id);
  if v_code is null then raise exception 'QR, seriya, shtrix-kod yoki SKU talab qilinadi' using errcode='22023'; end if;
  select jsonb_build_object('id',u.id,'qr_code',u.qr_code,'serial_number',u.serial_number,'status',u.status,
    'product_id',p.id,'product_name',p.name,'sku',p.sku,'barcode',p.barcode,'brand_name',br.name,
    'image',(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1),
    'location_id',l.id,'location_name',l.name,'retail_price',p.retail_price,
    'minimum_sale_price',p.minimum_sale_price,'tax_rate',p.tax_rate,
    'unit_cost',coalesce(sb.unit_cost,p.cost_price),
    'available_branch_count',(select count(*) from public.inventory_units a join public.locations al on al.id=a.location_id
      where a.product_id=p.id and al.branch_id=p_branch_id and al.type='store' and al.is_active
        and a.status='available' and a.active_transfer_id is null))
  into v_result from public.inventory_units u join public.products p on p.id=u.product_id
    join public.locations l on l.id=u.location_id left join public.brands br on br.id=p.brand_id
    left join public.stock_batches sb on sb.id=u.batch_id
  where l.branch_id=p_branch_id and l.type='store' and l.is_active and p.status='active'
    and u.status='available' and u.active_transfer_id is null
    and (upper(u.qr_code)=upper(v_code) or upper(coalesce(u.serial_number,''))=upper(v_code)
      or upper(coalesce(p.barcode,''))=upper(v_code) or upper(p.sku)=upper(v_code))
  order by case when upper(u.qr_code)=upper(v_code) then 0 when upper(coalesce(u.serial_number,''))=upper(v_code) then 1 else 2 end,u.id limit 1;
  if v_result is null then raise exception 'Erkin POS mahsulot birligi topilmadi' using errcode='P0002'; end if;
  return v_result;
end $$;

create or replace function public.list_pos_units(p_branch_id uuid,p_query text,p_limit integer default 30,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb; v_total bigint; v_q text:=nullif(btrim(p_query),'');
begin
  perform public.require_pos_seller(p_branch_id);
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  select count(*) into v_total from public.inventory_units u join public.locations l on l.id=u.location_id
    join public.products p on p.id=u.product_id where l.branch_id=p_branch_id and l.type='store' and l.is_active
    and u.status='available' and u.active_transfer_id is null and p.status='active' and (v_q is null or p.name ilike '%'||v_q||'%'
      or p.sku ilike '%'||v_q||'%' or coalesce(p.barcode,'') ilike '%'||v_q||'%'
      or u.qr_code ilike '%'||v_q||'%' or coalesce(u.serial_number,'') ilike '%'||v_q||'%');
  select coalesce(jsonb_agg(to_jsonb(q) order by q.product_name,q.id),'[]'::jsonb) into v_items from(
    select u.id,u.qr_code,u.serial_number,u.location_id,l.name location_name,p.id product_id,p.name product_name,
      p.sku,p.barcode,br.name brand_name,p.retail_price,p.minimum_sale_price,p.tax_rate,
      coalesce(sb.unit_cost,p.cost_price) unit_cost,
      (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1) image,
      (select count(*) from public.inventory_units a join public.locations al on al.id=a.location_id where a.product_id=p.id
        and al.branch_id=p_branch_id and al.type='store' and al.is_active and a.status='available' and a.active_transfer_id is null) available_branch_count
    from public.inventory_units u join public.locations l on l.id=u.location_id join public.products p on p.id=u.product_id
      left join public.brands br on br.id=p.brand_id left join public.stock_batches sb on sb.id=u.batch_id
    where l.branch_id=p_branch_id and l.type='store' and l.is_active and u.status='available' and u.active_transfer_id is null
      and p.status='active' and (v_q is null or p.name ilike '%'||v_q||'%' or p.sku ilike '%'||v_q||'%'
        or coalesce(p.barcode,'') ilike '%'||v_q||'%' or u.qr_code ilike '%'||v_q||'%'
        or coalesce(u.serial_number,'') ilike '%'||v_q||'%') order by p.name,u.id limit p_limit offset p_offset)q;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;
create or replace function public.get_pos_pending_sale(p_pending_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_s public.pos_pending_sales%rowtype; v_result jsonb; v_manager boolean;
begin
  select * into v_s from public.pos_pending_sales where id=p_pending_id;
  if not found then raise exception 'POS so‘rovi topilmadi' using errcode='P0002'; end if;
  v_manager=public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager']::public.app_role[],v_s.branch_id);
  if not v_manager and not(v_s.seller_id=auth.uid() and public.has_role(array['seller']::public.app_role[],v_s.branch_id)) then
    raise exception 'POS so‘rovi uchun ruxsat yo‘q' using errcode='42501'; end if;
  if v_s.status='pending' and v_s.expires_at<=now() then
    perform public.release_pos_reservation(v_s.id,'expired','Rezerv muddati tugadi',auth.uid());
  end if;
  select to_jsonb(s)||jsonb_build_object('seller_name',seller.full_name,'location_name',loc.name,
    'lines',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'unit_id',x.unit_id,'product_id',x.product_id,
      'product_name',p.name,'sku',p.sku,'qr_code',u.qr_code,'serial_number',u.serial_number,
      'unit_price',x.unit_price,'discount',x.discount,'tax',x.tax,'line_total',x.line_total,
      'unit_cost',coalesce(sb.unit_cost,p.cost_price),'profit',x.line_total-x.tax-coalesce(sb.unit_cost,p.cost_price)) order by x.created_at,x.id)
      from public.pos_pending_sale_lines x join public.products p on p.id=x.product_id join public.inventory_units u on u.id=x.unit_id
      left join public.stock_batches sb on sb.id=u.batch_id where x.pending_sale_id=s.id),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(jsonb_build_object('method_id',pm.id,'method_code',pm.code,'method_name',pm.name,
      'amount',pp.amount,'external_reference',pp.external_reference,'sort_order',pp.sort_order) order by pp.sort_order)
      from public.pos_pending_sale_payments pp join public.payment_methods pm on pm.id=pp.payment_method_id
      where pp.pending_sale_id=s.id),'[]'::jsonb),
    'can_confirm',s.status='pending' and s.expires_at>now() and v_manager,
    'can_reject',s.status='pending' and v_manager,
    'remaining_seconds',greatest(0,floor(extract(epoch from(s.expires_at-now())))::integer))
  into v_result from public.pos_pending_sales s join public.profiles seller on seller.id=s.seller_id
    join public.locations loc on loc.id=s.store_location_id where s.id=p_pending_id;
  return v_result;
end $$;

create or replace function public.create_pos_pending_sale(p_branch_id uuid,p_lines jsonb,p_payments jsonb,
  p_idempotency_key uuid,p_notes text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid:=gen_random_uuid(); v_existing public.pos_pending_sales%rowtype; v_item jsonb; v_u public.inventory_units%rowtype;
  v_p record; v_unit_id uuid; v_price numeric(18,2); v_discount numeric(18,2); v_tax numeric(18,2); v_line_total numeric(18,2);
  v_subtotal numeric(18,2):=0; v_discount_total numeric(18,2):=0; v_tax_total numeric(18,2):=0;
  v_total numeric(18,2); v_paid numeric(18,2):=0; v_store uuid; v_method public.payment_methods%rowtype;
  v_norm_lines jsonb; v_norm_payments jsonb; v_hash text; v_minutes integer:=15; v_sort integer:=0; v_is_seller boolean;
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
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('branch_id',p_branch_id::text,'notes',nullif(btrim(p_notes),''),
    'lines',v_norm_lines,'payments',v_norm_payments)::text,'UTF8'),'sha256'),'hex');
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
    if v_price is null or v_discount is null or v_price<=0 or v_price>v_p.retail_price*2 then
      raise exception 'Sotuv narxi ruxsat etilgan chegaradan tashqarida' using errcode='22023'; end if;
    if v_discount<0 or v_discount>v_price or v_price-v_discount<v_p.minimum_sale_price
      or (v_is_seller and v_discount>round(v_price*0.20,2)) then
      raise exception 'Chegirma yakuniy narxni minimumdan pasaytirdi yoki ruxsat etilgan chegaradan oshdi' using errcode='22023'; end if;
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
  insert into public.pos_pending_sales(id,pending_no,branch_id,store_location_id,seller_id,status,subtotal,discount,tax,total,
    expires_at,idempotency_key,request_hash,notes)
  values(v_id,'POS-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8)),p_branch_id,v_store,
    auth.uid(),'pending',v_subtotal,v_discount_total,v_tax_total,v_total,now()+make_interval(mins=>v_minutes),p_idempotency_key,v_hash,nullif(btrim(p_notes),''));
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
create or replace function public.release_expired_pos_sales(p_branch_id uuid default null)
returns integer language plpgsql security definer set search_path='' as $$
declare v_global boolean; v_count integer:=0; v_id uuid;
begin
  if auth.uid() is null or not public.current_user_active() then raise exception 'Faol xodim profili talab qilinadi' using errcode='42501'; end if;
  v_global=public.has_role(array['superadmin','admin']::public.app_role[],null);
  if p_branch_id is null and not v_global then raise exception 'Filial identifikatori talab qilinadi' using errcode='42501'; end if;
  if p_branch_id is not null and not public.can_access_branch(p_branch_id) then raise exception 'Filial uchun ruxsat yo‘q' using errcode='42501'; end if;
  for v_id in select id from public.pos_pending_sales where status='pending' and expires_at<=now()
    and (p_branch_id is null or branch_id=p_branch_id) order by id for update skip locked loop
    perform public.release_pos_reservation(v_id,'expired','Rezerv muddati tugadi',auth.uid()); v_count=v_count+1;
  end loop;
  return v_count;
end $$;

create or replace function public.list_pos_pending_sales(p_branch_id uuid,p_status public.pending_sale_status default null,
  p_query text default null,p_limit integer default 30,p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_manager boolean; v_items jsonb; v_total bigint; v_summary jsonb; v_q text:=nullif(btrim(p_query),'');
begin
  perform public.require_pos_seller(p_branch_id); perform public.release_expired_pos_sales(p_branch_id);
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  v_manager=public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager']::public.app_role[],p_branch_id);
  select count(*) into v_total from public.pos_pending_sales s where s.branch_id=p_branch_id
    and (v_manager or s.seller_id=auth.uid()) and (p_status is null or s.status=p_status)
    and (v_q is null or s.pending_no ilike '%'||v_q||'%' or exists(select 1 from public.profiles p where p.id=s.seller_id and p.full_name ilike '%'||v_q||'%'));
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb) into v_items from(
    select s.id,s.pending_no,s.status,s.seller_id,p.full_name seller_name,s.store_location_id,l.name location_name,
      (select count(*) from public.pos_pending_sale_lines x where x.pending_sale_id=s.id) unit_count,
      s.total,s.created_at,s.expires_at from public.pos_pending_sales s join public.profiles p on p.id=s.seller_id
      join public.locations l on l.id=s.store_location_id where s.branch_id=p_branch_id and (v_manager or s.seller_id=auth.uid())
      and (p_status is null or s.status=p_status) and (v_q is null or s.pending_no ilike '%'||v_q||'%' or p.full_name ilike '%'||v_q||'%')
      order by s.created_at desc limit p_limit offset p_offset)q;
  select jsonb_build_object('pending_count',count(*) filter(where status='pending'),
    'pending_amount',coalesce(sum(total) filter(where status='pending'),0),
    'confirmed_today_count',count(*) filter(where status='confirmed' and confirmed_at>=date_trunc('day',now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent'),
    'confirmed_today_amount',coalesce(sum(total) filter(where status='confirmed' and confirmed_at>=date_trunc('day',now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent'),0))
  into v_summary from public.pos_pending_sales where branch_id=p_branch_id and (v_manager or seller_id=auth.uid());
  return jsonb_build_object('items',v_items,'total',v_total,'summary',v_summary);
end $$;

create or replace function public.reject_pos_pending_sale(p_pending_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_s public.pos_pending_sales%rowtype;
begin
  select * into v_s from public.pos_pending_sales where id=p_pending_id for update;
  if not found then raise exception 'POS so‘rovi topilmadi' using errcode='P0002'; end if;
  perform public.require_pos_manager(v_s.branch_id);
  if v_s.status='rejected' then return public.get_pos_pending_sale(v_s.id); end if;
  if v_s.status='confirmed' then raise exception 'Tasdiqlangan sotuvni rad etib bo‘lmaydi' using errcode='P0001'; end if;
  if v_s.status='expired' then return public.get_pos_pending_sale(v_s.id); end if;
  if nullif(btrim(p_reason),'') is null then raise exception 'Rad etish sababi talab qilinadi' using errcode='22023'; end if;
  perform public.release_pos_reservation(v_s.id,'rejected',p_reason,auth.uid());
  return public.get_pos_pending_sale(v_s.id);
end $$;

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
  if exists(select 1 from public.inventory_units u join public.pos_pending_sale_lines x on x.unit_id=u.id
    where x.pending_sale_id=v_s.id and (u.status<>'reserved' or u.reserved_until<=now() or u.sold_sale_id is not null
      or u.active_transfer_id is not null or u.location_id<>v_s.store_location_id)) then
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
create or replace function public.list_my_pos_sales(p_branch_id uuid,p_limit integer default 20,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_manager boolean; v_items jsonb; v_total bigint; v_kpi jsonb; v_day timestamptz;
begin
  perform public.require_pos_seller(p_branch_id);
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  v_manager=public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager']::public.app_role[],p_branch_id);
  select date_trunc('day',now() at time zone coalesce((select timezone from public.branches where id=p_branch_id),'Asia/Tashkent'))
    at time zone coalesce((select timezone from public.branches where id=p_branch_id),'Asia/Tashkent') into v_day;
  select count(*) into v_total from public.sales where branch_id=p_branch_id and (v_manager or seller_id=auth.uid());
  select coalesce(jsonb_agg(to_jsonb(q) order by q.sold_at desc),'[]'::jsonb) into v_items from(
    select s.id,s.sale_no,s.pending_sale_id,s.seller_id,p.full_name seller_name,s.manager_id,m.full_name manager_name,
      s.subtotal,s.discount,s.tax,s.total,s.status,s.sold_at,
      (select count(*) from public.sale_lines x where x.sale_id=s.id) unit_count,
      (select coalesce(sum(x.line_total-x.tax-x.unit_cost),0) from public.sale_lines x where x.sale_id=s.id) profit
    from public.sales s join public.profiles p on p.id=s.seller_id left join public.profiles m on m.id=s.manager_id
    where s.branch_id=p_branch_id and (v_manager or s.seller_id=auth.uid()) order by s.sold_at desc limit p_limit offset p_offset)q;
  select jsonb_build_object('count',count(*),'total',coalesce(sum(q.total),0),
    'profit',coalesce(sum(q.profit),0),'avg_check',coalesce(round(avg(q.total),2),0),
    'discount',coalesce(sum(q.discount),0)) into v_kpi
  from(select s.total,s.discount,coalesce((select sum(x.line_total-x.tax-x.unit_cost)
    from public.sale_lines x where x.sale_id=s.id),0) profit from public.sales s
    where s.branch_id=p_branch_id and s.seller_id=auth.uid() and s.sold_at>=v_day)q;
  return jsonb_build_object('items',v_items,'total',v_total,'today',v_kpi);
end $$;

create or replace function public.get_sale_receipt(p_sale_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_s public.sales%rowtype; v_result jsonb;
begin
  select * into v_s from public.sales where id=p_sale_id;
  if not found then raise exception 'Sotuv topilmadi' using errcode='P0002'; end if;
  if not(v_s.seller_id=auth.uid() and public.has_role(array['seller']::public.app_role[],v_s.branch_id))
    and not(public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager']::public.app_role[],v_s.branch_id)) then
    raise exception 'Chek uchun ruxsat yo‘q' using errcode='42501'; end if;
  select to_jsonb(s)||jsonb_build_object('branch_name',b.name,'branch_phone',b.phone,'branch_address',b.address,
    'currency',btrim(b.currency::text),'seller_name',seller.full_name,'manager_name',manager.full_name,
    'lines',coalesce((select jsonb_agg(jsonb_build_object('product_name',p.name,'sku',p.sku,'qr_code',u.qr_code,
      'serial_number',u.serial_number,'quantity',x.quantity,'unit_price',x.unit_price,'discount',x.discount,'tax',x.tax,
      'line_total',x.line_total,'unit_cost',x.unit_cost,'profit',x.line_total-x.tax-x.unit_cost) order by x.created_at,x.id)
      from public.sale_lines x join public.products p on p.id=x.product_id join public.inventory_units u on u.id=x.unit_id
      where x.sale_id=s.id),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(jsonb_build_object('method_code',pm.code,'method_name',pm.name,
      'amount',sp.amount,'status',sp.status,'external_reference',sp.external_reference,'paid_at',sp.paid_at) order by sp.paid_at,sp.id)
      from public.sale_payments sp join public.payment_methods pm on pm.id=sp.payment_method_id where sp.sale_id=s.id),'[]'::jsonb),
    'profit',(select coalesce(sum(x.line_total-x.tax-x.unit_cost),0) from public.sale_lines x where x.sale_id=s.id))
  into v_result from public.sales s join public.branches b on b.id=s.branch_id join public.profiles seller on seller.id=s.seller_id
    left join public.profiles manager on manager.id=s.manager_id where s.id=p_sale_id;
  return v_result;
end $$;

alter table public.pos_pending_sale_payments enable row level security;
drop policy if exists pending_sales_staff_read on public.pos_pending_sales;
create policy pending_sales_staff_read on public.pos_pending_sales for select to authenticated using(
  public.has_role(array['superadmin','admin','manager']::public.app_role[],branch_id)
  or (seller_id=auth.uid() and public.has_role(array['seller']::public.app_role[],branch_id)));
drop policy if exists pending_sale_lines_parent_read on public.pos_pending_sale_lines;
create policy pending_sale_lines_parent_read on public.pos_pending_sale_lines for select to authenticated using(exists(
  select 1 from public.pos_pending_sales s where s.id=pending_sale_id and (public.has_role(array['superadmin','admin','manager']::public.app_role[],s.branch_id)
    or (s.seller_id=auth.uid() and public.has_role(array['seller']::public.app_role[],s.branch_id)))));
drop policy if exists pending_sale_payments_parent_read on public.pos_pending_sale_payments;
create policy pending_sale_payments_parent_read on public.pos_pending_sale_payments for select to authenticated using(exists(
  select 1 from public.pos_pending_sales s where s.id=pending_sale_id and (public.has_role(array['superadmin','admin','manager']::public.app_role[],s.branch_id)
    or (s.seller_id=auth.uid() and public.has_role(array['seller']::public.app_role[],s.branch_id)))));
drop policy if exists sale_lines_parent_read on public.sale_lines;
create policy sale_lines_parent_read on public.sale_lines for select to authenticated using(exists(
  select 1 from public.sales s where s.id=sale_id and (public.has_role(array['superadmin','admin','manager']::public.app_role[],s.branch_id)
    or (s.seller_id=auth.uid() and public.has_role(array['seller']::public.app_role[],s.branch_id)))));
drop policy if exists sale_payments_parent_read on public.sale_payments;
create policy sale_payments_parent_read on public.sale_payments for select to authenticated using(exists(
  select 1 from public.sales s where s.id=sale_id and (public.has_role(array['superadmin','admin','manager']::public.app_role[],s.branch_id)
    or (s.seller_id=auth.uid() and public.has_role(array['seller']::public.app_role[],s.branch_id)))));

revoke all on public.pos_pending_sales,public.pos_pending_sale_lines,public.pos_pending_sale_payments,
  public.sales,public.sale_lines,public.sale_payments from anon,authenticated;
grant all on public.pos_pending_sales,public.pos_pending_sale_lines,public.pos_pending_sale_payments,
  public.sales,public.sale_lines,public.sale_payments to service_role;

drop function if exists public.create_pos_pending_sale(uuid,uuid,jsonb,numeric,text);

revoke all on function public.normalize_product_minimum_sale_price(),public.require_pos_seller(uuid),public.require_pos_manager(uuid),
  public.release_pos_reservation(uuid,public.pending_sale_status,text,uuid) from public,anon,authenticated;
revoke all on function public.get_pos_references(uuid),public.find_pos_unit(uuid,text),public.list_pos_units(uuid,text,integer,integer),
  public.create_pos_pending_sale(uuid,jsonb,jsonb,uuid,text),public.release_expired_pos_sales(uuid),public.get_pos_pending_sale(uuid),
  public.list_pos_pending_sales(uuid,public.pending_sale_status,text,integer,integer),public.reject_pos_pending_sale(uuid,text),
  public.manager_confirm_sale(uuid,jsonb),public.list_my_pos_sales(uuid,integer,integer),public.get_sale_receipt(uuid) from public,anon;
grant execute on function public.get_pos_references(uuid),public.find_pos_unit(uuid,text),public.list_pos_units(uuid,text,integer,integer),
  public.create_pos_pending_sale(uuid,jsonb,jsonb,uuid,text),public.release_expired_pos_sales(uuid),public.get_pos_pending_sale(uuid),
  public.list_pos_pending_sales(uuid,public.pending_sale_status,text,integer,integer),public.reject_pos_pending_sale(uuid,text),
  public.manager_confirm_sale(uuid,jsonb),public.list_my_pos_sales(uuid,integer,integer),public.get_sale_receipt(uuid) to authenticated;
grant execute on function public.normalize_product_minimum_sale_price(),public.require_pos_seller(uuid),public.require_pos_manager(uuid),
  public.release_pos_reservation(uuid,public.pending_sale_status,text,uuid),public.get_pos_references(uuid),public.find_pos_unit(uuid,text),
  public.list_pos_units(uuid,text,integer,integer),public.create_pos_pending_sale(uuid,jsonb,jsonb,uuid,text),
  public.release_expired_pos_sales(uuid),public.get_pos_pending_sale(uuid),
  public.list_pos_pending_sales(uuid,public.pending_sale_status,text,integer,integer),public.reject_pos_pending_sale(uuid,text),
  public.manager_confirm_sale(uuid,jsonb),public.list_my_pos_sales(uuid,integer,integer),public.get_sale_receipt(uuid) to service_role;

commit;
