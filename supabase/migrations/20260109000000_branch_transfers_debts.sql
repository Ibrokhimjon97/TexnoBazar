-- Filiallararo transferlar, dona mahsulot hayot sikli va filial qarzlari.
begin;

alter table public.transfers
  add column from_branch_id uuid references public.branches(id) on delete restrict,
  add column to_branch_id uuid references public.branches(id) on delete restrict,
  add column currency char(3) not null default 'UZS',
  add column total_amount numeric(18,2) not null default 0,
  add column idempotency_key uuid,
  add column request_hash text,
  add column created_by uuid references public.profiles(id) on delete restrict,
  add column shipped_by uuid references public.profiles(id) on delete restrict;

update public.transfers t set
  from_branch_id=fl.branch_id,to_branch_id=tl.branch_id,
  idempotency_key=coalesce(t.idempotency_key,gen_random_uuid()),
  request_hash=coalesce(t.request_hash,encode(extensions.digest(t.id::text,'sha256'),'hex')),
  created_by=coalesce(t.created_by,t.requested_by,t.approved_by,t.received_by)
from public.locations fl,public.locations tl
where fl.id=t.from_location_id and tl.id=t.to_location_id;

do $$ begin
  if exists(select 1 from public.transfers where from_branch_id is null or to_branch_id is null
    or idempotency_key is null or request_hash is null or created_by is null) then
    raise exception 'Mavjud transfer ma’lumotlarini yangi shartlarga moslab bo‘lmadi';
  end if;
end $$;

alter table public.transfers
  alter column from_branch_id set not null,alter column to_branch_id set not null,
  alter column idempotency_key set not null,alter column request_hash set not null,
  alter column created_by set not null;
alter table public.transfers add constraint transfers_branches_different_chk check(from_branch_id<>to_branch_id);
alter table public.transfers add constraint transfers_currency_chk check(currency ~ '^[A-Z]{3}$');
alter table public.transfers add constraint transfers_total_amount_chk check(total_amount>=0);
create unique index transfers_from_branch_idempotency_uidx on public.transfers(from_branch_id,idempotency_key);
create index transfers_status_created_idx on public.transfers(status,created_at desc);
create index transfers_from_list_idx on public.transfers(from_branch_id,status,created_at desc);
create index transfers_to_list_idx on public.transfers(to_branch_id,status,created_at desc);

alter table public.transfer_lines add column unit_price numeric(18,2);
update public.transfer_lines x set unit_price=greatest(coalesce(
  (select b.unit_cost from public.inventory_units u left join public.stock_batches b on b.id=u.batch_id where u.id=x.unit_id),
  (select p.cost_price from public.products p where p.id=x.product_id),0),0);
do $$ begin
  if exists(select 1 from public.transfer_lines where unit_id is null or quantity<>1 or unit_price is null) then
    raise exception 'Mavjud transfer qatorlari dona mahsulot talablariga mos emas';
  end if;
end $$;
alter table public.transfer_lines alter column unit_id set not null,alter column unit_price set not null;
alter table public.transfer_lines add column line_amount numeric(18,2) generated always as (unit_price) stored;
alter table public.transfer_lines add constraint transfer_lines_quantity_one_chk check(quantity=1);
alter table public.transfer_lines add constraint transfer_lines_unit_price_nonnegative_chk check(unit_price>=0);
alter table public.transfer_lines add constraint transfer_lines_amount_equals_price_chk check(line_amount=unit_price);

alter table public.inventory_units add column active_transfer_id uuid references public.transfers(id) on delete restrict;
update public.inventory_units u set active_transfer_id=x.transfer_id
from public.transfer_lines x join public.transfers t on t.id=x.transfer_id
where x.unit_id=u.id and t.status in ('draft','requested','approved','in_transit');
create index inventory_units_active_transfer_idx on public.inventory_units(active_transfer_id,id)
  where active_transfer_id is not null;

update public.transfers t set total_amount=coalesce((select sum(x.line_amount) from public.transfer_lines x where x.transfer_id=t.id),0);

alter table public.branch_debts add column currency char(3) not null default 'UZS';
do $$ begin
  if exists(select 1 from public.branch_debts where transfer_id is null) then
    raise exception 'Mavjud filial qarzi transferga biriktirilmagan';
  end if;
end $$;
alter table public.branch_debts alter column transfer_id set not null;
alter table public.branch_debts add constraint branch_debts_transfer_key unique(transfer_id);
alter table public.branch_debts add column remaining_amount numeric(18,2) generated always as (amount-paid_amount) stored;
alter table public.branch_debts add constraint branch_debts_currency_chk check(currency ~ '^[A-Z]{3}$');
alter table public.branch_debts add constraint branch_debts_state_chk check(
  status='void' or (status='open' and paid_amount=0) or
  (status='partially_paid' and paid_amount>0 and paid_amount<amount) or
  (status='paid' and paid_amount=amount));
create index branch_debts_debtor_status_idx on public.branch_debts(debtor_branch_id,status,created_at desc);
create index branch_debts_creditor_status_idx on public.branch_debts(creditor_branch_id,status,created_at desc);

create table public.debt_payments(
  id uuid primary key default gen_random_uuid(),
  debt_id uuid not null references public.branch_debts(id) on delete restrict,
  amount numeric(18,2) not null check(amount>0),currency char(3) not null check(currency ~ '^[A-Z]{3}$'),
  paid_at timestamptz not null default now(),method text not null check(length(btrim(method)) between 2 and 64),
  reference text,notes text,idempotency_key uuid not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  unique(debt_id,idempotency_key));
create index debt_payments_debt_paid_idx on public.debt_payments(debt_id,paid_at desc);
create unique index inventory_movements_transfer_reference_unit_type_uidx
  on public.inventory_movements(reference_id,unit_id,movement_type)
  where reference_type='branch_transfer' and reference_id is not null
    and unit_id is not null and movement_type in ('transfer_out','transfer_in');

create or replace function public.require_transfer_access(p_from uuid,p_to uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not(public.can_access_branch(p_from) or public.can_access_branch(p_to)) then
    raise exception 'Transfer uchun ruxsat yo‘q' using errcode='42501';
  end if;
end $$;
create or replace function public.require_source_manager(p_branch uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not(public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager']::public.app_role[],p_branch)) then
    raise exception 'Jo‘natuvchi filial menejeri yoki global administrator roli talab qilinadi' using errcode='42501';
  end if;
end $$;
create or replace function public.require_source_shipper(p_branch uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not(public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager','warehouse']::public.app_role[],p_branch)) then
    raise exception 'Jo‘natuvchi filial menejeri yoki omborchisi roli talab qilinadi' using errcode='42501';
  end if;
end $$;
create or replace function public.require_destination_receiver(p_branch uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not(public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager','warehouse']::public.app_role[],p_branch)) then
    raise exception 'Qabul qiluvchi filial menejeri yoki omborchisi roli talab qilinadi' using errcode='42501';
  end if;
end $$;
create or replace function public.require_creditor_payment_operator(p_branch uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not(public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager','accountant']::public.app_role[],p_branch)) then
    raise exception 'Kreditor filial menejeri yoki hisobchisi roli talab qilinadi' using errcode='42501';
  end if;
end $$;

create or replace function public.guard_branch_transfer_data() returns trigger
language plpgsql set search_path='' as $$
declare v_old jsonb:=to_jsonb(old); v_new jsonb:=to_jsonb(new);
begin
  if tg_table_name='transfers' and (v_old->>'transfer_no' is distinct from v_new->>'transfer_no'
    or v_old->>'from_location_id' is distinct from v_new->>'from_location_id' or v_old->>'to_location_id' is distinct from v_new->>'to_location_id'
    or v_old->>'from_branch_id' is distinct from v_new->>'from_branch_id' or v_old->>'to_branch_id' is distinct from v_new->>'to_branch_id'
    or v_old->>'currency' is distinct from v_new->>'currency' or v_old->>'total_amount' is distinct from v_new->>'total_amount'
    or v_old->>'idempotency_key' is distinct from v_new->>'idempotency_key' or v_old->>'request_hash' is distinct from v_new->>'request_hash'
    or v_old->>'created_by' is distinct from v_new->>'created_by') then
    raise exception 'Transferning asosiy ma’lumotlarini o‘zgartirib bo‘lmaydi' using errcode='55000';
  elsif tg_table_name='transfer_lines' and (tg_op='DELETE' or v_old->>'transfer_id' is distinct from v_new->>'transfer_id'
    or v_old->>'product_id' is distinct from v_new->>'product_id' or v_old->>'unit_id' is distinct from v_new->>'unit_id'
    or v_old->>'quantity' is distinct from v_new->>'quantity' or v_old->>'unit_price' is distinct from v_new->>'unit_price') then
    raise exception 'Transfer qatorlari o‘zgarmas' using errcode='55000';
  elsif tg_table_name='branch_debts' and (v_old->>'debtor_branch_id' is distinct from v_new->>'debtor_branch_id'
    or v_old->>'creditor_branch_id' is distinct from v_new->>'creditor_branch_id' or v_old->>'transfer_id' is distinct from v_new->>'transfer_id'
    or v_old->>'amount' is distinct from v_new->>'amount' or v_old->>'currency' is distinct from v_new->>'currency') then
    raise exception 'Qarzning asosiy ma’lumotlarini o‘zgartirib bo‘lmaydi' using errcode='55000';
  end if;
  return coalesce(new,old);
end $$;
drop trigger if exists transfers_immutable_fields on public.transfers;
drop trigger if exists transfer_lines_immutable on public.transfer_lines;
drop trigger if exists branch_debts_immutable_fields on public.branch_debts;
create trigger transfers_immutable_fields before update on public.transfers for each row execute function public.guard_branch_transfer_data();
create trigger transfer_lines_immutable before update or delete on public.transfer_lines for each row execute function public.guard_branch_transfer_data();
create trigger branch_debts_immutable_fields before update on public.branch_debts for each row execute function public.guard_branch_transfer_data();
drop trigger if exists transfer_lines_audit on public.transfer_lines;
create trigger transfer_lines_audit after insert or update or delete on public.transfer_lines for each row execute function public.audit_row_change();
create trigger debt_payments_audit after insert on public.debt_payments for each row execute function public.audit_row_change();
create trigger debt_payments_immutable before update or delete on public.debt_payments for each row execute function public.reject_mutation();

create or replace function public.get_transfer_references(p_branch_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_currency char(3);
begin
  if not public.can_access_branch(p_branch_id) then raise exception 'Filial uchun ruxsat yo‘q' using errcode='42501'; end if;
  select currency into v_currency from public.branches where id=p_branch_id and is_active;
  if not found then raise exception 'Faol filial topilmadi' using errcode='P0002'; end if;
  return jsonb_build_object('branch_id',p_branch_id,'currency',btrim(v_currency::text),
    'source_locations',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'code',l.code,'name',l.name,'type',l.type) order by l.name)
      from public.locations l where l.branch_id=p_branch_id and l.is_active and l.type in ('store','warehouse')),'[]'::jsonb),
    'destination_branches',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'code',b.code,'name',b.name,'currency',btrim(b.currency::text),
      'locations',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'code',l.code,'name',l.name,'type',l.type) order by l.name)
       from public.locations l where l.branch_id=b.id and l.is_active and l.type in ('store','warehouse')),'[]'::jsonb)) order by b.name)
      from public.branches b where b.is_active and b.id<>p_branch_id
       and exists(select 1 from public.locations l where l.branch_id=b.id and l.is_active and l.type in ('store','warehouse'))),'[]'::jsonb));
end $$;

create or replace function public.find_transfer_unit(p_branch_id uuid,p_from_location_id uuid,p_code text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform public.require_source_shipper(p_branch_id);
  if not exists(select 1 from public.locations where id=p_from_location_id and branch_id=p_branch_id and is_active and type in ('store','warehouse')) then
    raise exception 'Faol jo‘natish joyi topilmadi' using errcode='P0002';
  end if;
  if nullif(btrim(p_code),'') is null then raise exception 'QR yoki seriya raqami talab qilinadi' using errcode='22023'; end if;
  select jsonb_build_object('id',u.id,'qr_code',u.qr_code,'serial_number',u.serial_number,'location_id',u.location_id,
    'product_id',p.id,'product_name',p.name,'sku',p.sku,'cost_price',coalesce(b.unit_cost,p.cost_price),
    'image',(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1))
  into v_result from public.inventory_units u join public.products p on p.id=u.product_id
    left join public.stock_batches b on b.id=u.batch_id
  where u.location_id=p_from_location_id and u.status='available' and u.active_transfer_id is null
    and (upper(u.qr_code)=upper(btrim(p_code)) or upper(coalesce(u.serial_number,''))=upper(btrim(p_code))) limit 1;
  if v_result is null then raise exception 'Erkin mahsulot birligi topilmadi' using errcode='P0002'; end if;
  return v_result;
end $$;

create or replace function public.get_branch_transfer(p_transfer_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_t public.transfers%rowtype; v_result jsonb;
begin
  select * into v_t from public.transfers where id=p_transfer_id;
  if not found then raise exception 'Transfer topilmadi' using errcode='P0002'; end if;
  perform public.require_transfer_access(v_t.from_branch_id,v_t.to_branch_id);
  select to_jsonb(t)||jsonb_build_object('from_branch_name',fb.name,'to_branch_name',tb.name,
    'from_location_name',fl.name,'to_location_name',tl.name,
    'can_approve',t.status='requested' and (public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager']::public.app_role[],t.from_branch_id)),
    'can_ship',t.status='approved' and (public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager','warehouse']::public.app_role[],t.from_branch_id)),
    'can_receive',t.status='in_transit' and (public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager','warehouse']::public.app_role[],t.to_branch_id)),
    'lines',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'unit_id',x.unit_id,'qr_code',u.qr_code,
      'serial_number',u.serial_number,'product_id',p.id,'product_name',p.name,'sku',p.sku,
      'image',(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1),
      'quantity',x.quantity,'unit_price',x.unit_price,'line_amount',x.line_amount) order by u.id)
      from public.transfer_lines x join public.inventory_units u on u.id=x.unit_id join public.products p on p.id=x.product_id
      where x.transfer_id=t.id),'[]'::jsonb))
  into v_result from public.transfers t join public.branches fb on fb.id=t.from_branch_id
    join public.branches tb on tb.id=t.to_branch_id join public.locations fl on fl.id=t.from_location_id
    join public.locations tl on tl.id=t.to_location_id where t.id=p_transfer_id;
  return v_result;
end $$;

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
  -- Lock all requested units in deterministic order before validating any of them.
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

create or replace function public.approve_branch_transfer(p_transfer_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_t public.transfers%rowtype;
begin
  select * into v_t from public.transfers where id=p_transfer_id for update;
  if not found then raise exception 'Transfer topilmadi' using errcode='P0002'; end if;
  perform public.require_source_manager(v_t.from_branch_id);
  if v_t.status='approved' then return public.get_branch_transfer(p_transfer_id); end if;
  if v_t.status<>'requested' then raise exception 'Faqat so‘ralgan transfer tasdiqlanadi' using errcode='P0001'; end if;
  update public.transfers set status='approved',approved_by=auth.uid(),approved_at=now() where id=p_transfer_id;
  return public.get_branch_transfer(p_transfer_id);
end $$;

create or replace function public.ship_branch_transfer(p_transfer_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_t public.transfers%rowtype; v_line record; v_u public.inventory_units%rowtype;
begin
  select * into v_t from public.transfers where id=p_transfer_id for update;
  if not found then raise exception 'Transfer topilmadi' using errcode='P0002'; end if;
  perform public.require_source_shipper(v_t.from_branch_id);
  if v_t.status<>'approved' then raise exception 'Faqat tasdiqlangan transfer jo‘natiladi' using errcode='P0001'; end if;
  perform 1 from public.inventory_units u join public.transfer_lines x on x.unit_id=u.id
    where x.transfer_id=p_transfer_id order by u.id for update of u;
  for v_line in select * from public.transfer_lines where transfer_id=p_transfer_id order by unit_id loop
    select * into v_u from public.inventory_units where id=v_line.unit_id;
    if v_u.active_transfer_id is distinct from p_transfer_id or v_u.location_id<>v_t.from_location_id or v_u.status<>'available' then
      raise exception 'Mahsulot jo‘natishga tayyor emas: %',v_line.unit_id using errcode='P0001'; end if;
    update public.inventory_units set status='in_transit',reserved_until=null,version=version+1 where id=v_u.id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,
      quantity,unit_cost,reference_type,reference_id,actor_id,metadata)
    values(v_u.id,v_u.product_id,v_u.batch_id,'transfer_out',v_t.from_location_id,v_t.to_location_id,1,v_line.unit_price,
      'branch_transfer',p_transfer_id,auth.uid(),jsonb_build_object('currency',btrim(v_t.currency::text)));
  end loop;
  update public.transfers set status='in_transit',shipped_by=auth.uid(),shipped_at=now() where id=p_transfer_id;
  return public.get_branch_transfer(p_transfer_id);
end $$;

create or replace function public.receive_branch_transfer(p_transfer_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_t public.transfers%rowtype; v_line record; v_u public.inventory_units%rowtype;
begin
  select * into v_t from public.transfers where id=p_transfer_id for update;
  if not found then raise exception 'Transfer topilmadi' using errcode='P0002'; end if;
  perform public.require_destination_receiver(v_t.to_branch_id);
  if v_t.status='received' then return public.get_branch_transfer(p_transfer_id); end if;
  if v_t.status<>'in_transit' then raise exception 'Faqat yo‘ldagi transfer qabul qilinadi' using errcode='P0001'; end if;
  perform 1 from public.inventory_units u join public.transfer_lines x on x.unit_id=u.id
    where x.transfer_id=p_transfer_id order by u.id for update of u;
  for v_line in select * from public.transfer_lines where transfer_id=p_transfer_id order by unit_id loop
    select * into v_u from public.inventory_units where id=v_line.unit_id;
    if v_u.active_transfer_id is distinct from p_transfer_id or v_u.location_id<>v_t.from_location_id or v_u.status<>'in_transit' then
      raise exception 'Yo‘ldagi mahsulot holati buzilgan: %',v_line.unit_id using errcode='P0001'; end if;
    if (select count(*) from public.inventory_movements where reference_type='branch_transfer' and reference_id=p_transfer_id
      and unit_id=v_u.id and movement_type='transfer_out')<>1 then
      raise exception 'Mahsulot uchun yagona chiqim harakati topilmadi: %',v_u.id using errcode='P0001'; end if;
    update public.inventory_units set location_id=v_t.to_location_id,status='available',active_transfer_id=null,version=version+1 where id=v_u.id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,
      quantity,unit_cost,reference_type,reference_id,actor_id,metadata)
    values(v_u.id,v_u.product_id,v_u.batch_id,'transfer_in',v_t.from_location_id,v_t.to_location_id,1,v_line.unit_price,
      'branch_transfer',p_transfer_id,auth.uid(),jsonb_build_object('currency',btrim(v_t.currency::text)));
  end loop;
  if v_t.total_amount>0 then
    insert into public.branch_debts(debtor_branch_id,creditor_branch_id,transfer_id,amount,paid_amount,status,notes,currency)
    values(v_t.to_branch_id,v_t.from_branch_id,p_transfer_id,v_t.total_amount,0,'open','Transfer '||v_t.transfer_no||' bo‘yicha qarz',v_t.currency)
    on conflict(transfer_id) do nothing;
  end if;
  update public.transfers set status='received',received_by=auth.uid(),received_at=now() where id=p_transfer_id;
  return public.get_branch_transfer(p_transfer_id);
end $$;

create or replace function public.list_branch_transfers(p_branch_id uuid,p_direction text default 'all',
  p_status public.transfer_status default null,p_query text default null,p_limit integer default 30,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb; v_total bigint; v_direction text:=lower(coalesce(p_direction,'all'));
begin
  if not public.can_access_branch(p_branch_id) then raise exception 'Filial uchun ruxsat yo‘q' using errcode='42501'; end if;
  if v_direction not in('all','incoming','outgoing') then raise exception 'Yo‘nalish all, incoming yoki outgoing bo‘lishi kerak' using errcode='22023'; end if;
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  select count(*) into v_total from public.transfers t where
    ((v_direction='all' and p_branch_id in(t.from_branch_id,t.to_branch_id)) or (v_direction='incoming' and t.to_branch_id=p_branch_id)
      or (v_direction='outgoing' and t.from_branch_id=p_branch_id)) and (p_status is null or t.status=p_status)
    and (nullif(btrim(p_query),'') is null or t.transfer_no ilike '%'||btrim(p_query)||'%'
      or exists(select 1 from public.transfer_lines x join public.inventory_units u on u.id=x.unit_id join public.products p on p.id=x.product_id
        where x.transfer_id=t.id and (u.qr_code ilike '%'||btrim(p_query)||'%' or coalesce(u.serial_number,'') ilike '%'||btrim(p_query)||'%'
          or p.name ilike '%'||btrim(p_query)||'%' or p.sku ilike '%'||btrim(p_query)||'%')));
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb) into v_items from(
    select t.id,t.transfer_no,t.from_branch_id,fb.name from_branch_name,t.to_branch_id,tb.name to_branch_name,
      t.from_location_id,fl.name from_location_name,t.to_location_id,tl.name to_location_name,t.status,t.currency,t.total_amount,
      t.created_at,t.requested_at,t.approved_at,t.shipped_at,t.received_at,count(x.id) unit_count
    from public.transfers t join public.branches fb on fb.id=t.from_branch_id join public.branches tb on tb.id=t.to_branch_id
      join public.locations fl on fl.id=t.from_location_id join public.locations tl on tl.id=t.to_location_id
      left join public.transfer_lines x on x.transfer_id=t.id
    where ((v_direction='all' and p_branch_id in(t.from_branch_id,t.to_branch_id)) or (v_direction='incoming' and t.to_branch_id=p_branch_id)
      or (v_direction='outgoing' and t.from_branch_id=p_branch_id)) and (p_status is null or t.status=p_status)
      and (nullif(btrim(p_query),'') is null or t.transfer_no ilike '%'||btrim(p_query)||'%'
       or exists(select 1 from public.transfer_lines sx join public.inventory_units u on u.id=sx.unit_id join public.products p on p.id=sx.product_id
        where sx.transfer_id=t.id and (u.qr_code ilike '%'||btrim(p_query)||'%' or coalesce(u.serial_number,'') ilike '%'||btrim(p_query)||'%'
          or p.name ilike '%'||btrim(p_query)||'%' or p.sku ilike '%'||btrim(p_query)||'%')))
    group by t.id,fb.name,tb.name,fl.name,tl.name order by t.created_at desc limit p_limit offset p_offset)q;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

create or replace function public.list_branch_debts(p_branch_id uuid,p_direction text default 'all',
  p_status public.debt_status default null,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb; v_total bigint; v_summary jsonb; v_direction text:=lower(coalesce(p_direction,'all'));
begin
  if not public.can_access_branch(p_branch_id) then raise exception 'Filial uchun ruxsat yo‘q' using errcode='42501'; end if;
  if v_direction not in('all','debtor','creditor') then raise exception 'Yo‘nalish all, debtor yoki creditor bo‘lishi kerak' using errcode='22023'; end if;
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  select count(*) into v_total from public.branch_debts d where
    ((v_direction='all' and p_branch_id in(d.debtor_branch_id,d.creditor_branch_id)) or (v_direction='debtor' and d.debtor_branch_id=p_branch_id)
      or (v_direction='creditor' and d.creditor_branch_id=p_branch_id)) and (p_status is null or d.status=p_status);
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb) into v_items from(
    select d.*,db.name debtor_branch_name,cb.name creditor_branch_name,t.transfer_no
    from public.branch_debts d join public.branches db on db.id=d.debtor_branch_id join public.branches cb on cb.id=d.creditor_branch_id
      join public.transfers t on t.id=d.transfer_id
    where ((v_direction='all' and p_branch_id in(d.debtor_branch_id,d.creditor_branch_id)) or (v_direction='debtor' and d.debtor_branch_id=p_branch_id)
      or (v_direction='creditor' and d.creditor_branch_id=p_branch_id)) and (p_status is null or d.status=p_status)
    order by d.created_at desc limit p_limit offset p_offset)q;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.currency),'[]'::jsonb) into v_summary from(
    select currency,sum(amount) amount,sum(paid_amount) paid_amount,sum(remaining_amount) remaining_amount,count(*) debt_count
    from public.branch_debts d where ((v_direction='all' and p_branch_id in(d.debtor_branch_id,d.creditor_branch_id))
      or (v_direction='debtor' and d.debtor_branch_id=p_branch_id) or (v_direction='creditor' and d.creditor_branch_id=p_branch_id))
      and (p_status is null or d.status=p_status) group by currency)s;
  return jsonb_build_object('items',v_items,'total',v_total,'summary',v_summary);
end $$;

create or replace function public.get_branch_debt_summary(p_branch_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.can_access_branch(p_branch_id) then raise exception 'Filial uchun ruxsat yo‘q' using errcode='42501'; end if;
  return jsonb_build_object('branch_id',p_branch_id,
    'debtor',coalesce((select jsonb_agg(to_jsonb(q) order by q.currency) from(select currency,sum(amount) amount,
      sum(paid_amount) paid_amount,sum(remaining_amount) remaining_amount,count(*) debt_count from public.branch_debts
      where debtor_branch_id=p_branch_id and status<>'void' group by currency)q),'[]'::jsonb),
    'creditor',coalesce((select jsonb_agg(to_jsonb(q) order by q.currency) from(select currency,sum(amount) amount,
      sum(paid_amount) paid_amount,sum(remaining_amount) remaining_amount,count(*) debt_count from public.branch_debts
      where creditor_branch_id=p_branch_id and status<>'void' group by currency)q),'[]'::jsonb));
end $$;

create or replace function public.get_branch_debt(p_debt_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_d public.branch_debts%rowtype; v_result jsonb;
begin
  select * into v_d from public.branch_debts where id=p_debt_id;
  if not found then raise exception 'Filial qarzi topilmadi' using errcode='P0002'; end if;
  if not(public.can_access_branch(v_d.debtor_branch_id) or public.can_access_branch(v_d.creditor_branch_id)) then
    raise exception 'Qarz uchun ruxsat yo‘q' using errcode='42501'; end if;
  select to_jsonb(d)||jsonb_build_object('debtor_branch_name',db.name,'creditor_branch_name',cb.name,'transfer_no',t.transfer_no,
    'payments',coalesce((select jsonb_agg(to_jsonb(p) order by p.paid_at desc,p.id) from public.debt_payments p where p.debt_id=d.id),'[]'::jsonb),
    'can_record_payment',public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager','accountant']::public.app_role[],d.creditor_branch_id))
  into v_result from public.branch_debts d join public.branches db on db.id=d.debtor_branch_id
    join public.branches cb on cb.id=d.creditor_branch_id join public.transfers t on t.id=d.transfer_id where d.id=p_debt_id;
  return v_result;
end $$;

create or replace function public.record_branch_debt_payment(p_debt_id uuid,p_amount numeric,p_currency char(3),
  p_method text,p_reference text,p_notes text,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_d public.branch_debts%rowtype; v_p public.debt_payments%rowtype; v_paid numeric(18,2);
begin
  if p_idempotency_key is null then raise exception 'Takroriy so‘rov kaliti talab qilinadi' using errcode='22023'; end if;
  select * into v_d from public.branch_debts where id=p_debt_id for update;
  if not found then raise exception 'Filial qarzi topilmadi' using errcode='P0002'; end if;
  perform public.require_creditor_payment_operator(v_d.creditor_branch_id);
  select * into v_p from public.debt_payments where debt_id=p_debt_id and idempotency_key=p_idempotency_key;
  if found then
    if v_p.amount is distinct from p_amount or v_p.currency is distinct from upper(p_currency::text)::char(3)
      or v_p.method is distinct from btrim(p_method) or v_p.reference is distinct from nullif(btrim(p_reference),'')
      or v_p.notes is distinct from nullif(btrim(p_notes),'') then
      raise exception 'Takroriy kalit boshqa to‘lov mazmuni bilan yuborildi' using errcode='22023'; end if;
    return public.get_branch_debt(p_debt_id);
  end if;
  if p_amount is null or p_amount<=0 then raise exception 'To‘lov summasi musbat bo‘lishi kerak' using errcode='22023'; end if;
  if upper(p_currency::text)::char(3)<>v_d.currency then raise exception 'To‘lov valyutasi qarz valyutasiga mos emas' using errcode='22023'; end if;
  if p_amount>v_d.remaining_amount then raise exception 'To‘lov qoldiq qarzdan oshmasligi kerak' using errcode='22023'; end if;
  if v_d.status in('paid','void') then raise exception 'Yopilgan qarzga to‘lov kiritib bo‘lmaydi' using errcode='P0001'; end if;
  if nullif(btrim(p_method),'') is null or length(btrim(p_method)) not between 2 and 64 then raise exception 'To‘lov usuli noto‘g‘ri' using errcode='22023'; end if;
  insert into public.debt_payments(debt_id,amount,currency,method,reference,notes,idempotency_key,created_by)
  values(p_debt_id,p_amount,upper(p_currency::text)::char(3),btrim(p_method),nullif(btrim(p_reference),''),
    nullif(btrim(p_notes),''),p_idempotency_key,auth.uid());
  v_paid=v_d.paid_amount+p_amount;
  update public.branch_debts set paid_amount=v_paid,status=case when v_paid=amount then 'paid'::public.debt_status
    else 'partially_paid'::public.debt_status end where id=p_debt_id;
  return public.get_branch_debt(p_debt_id);
end $$;

alter table public.debt_payments enable row level security;
drop policy if exists transfers_staff_read on public.transfers;
create policy transfers_staff_read on public.transfers for select to authenticated using(
  public.can_access_branch(from_branch_id) or public.can_access_branch(to_branch_id));
drop policy if exists transfer_lines_staff_read on public.transfer_lines;
create policy transfer_lines_staff_read on public.transfer_lines for select to authenticated using(exists(
  select 1 from public.transfers t where t.id=transfer_id and (public.can_access_branch(t.from_branch_id) or public.can_access_branch(t.to_branch_id))));
drop policy if exists branch_debts_staff_read on public.branch_debts;
create policy branch_debts_staff_read on public.branch_debts for select to authenticated using(
  public.can_access_branch(debtor_branch_id) or public.can_access_branch(creditor_branch_id));
drop policy if exists debt_payments_staff_read on public.debt_payments;
create policy debt_payments_staff_read on public.debt_payments for select to authenticated using(exists(
  select 1 from public.branch_debts d where d.id=debt_id and (public.can_access_branch(d.debtor_branch_id) or public.can_access_branch(d.creditor_branch_id))));

revoke all on public.transfers,public.transfer_lines,public.branch_debts,public.debt_payments from anon,authenticated;
grant select on public.transfers,public.transfer_lines,public.branch_debts,public.debt_payments to authenticated;
grant all on public.transfers,public.transfer_lines,public.branch_debts,public.debt_payments to service_role;
revoke execute on function public.move_units(uuid,public.transfer_status) from public,anon,authenticated;

drop function if exists public.request_branch_transfer(uuid);
drop function if exists public.cancel_branch_transfer(uuid,text);
drop function if exists public.find_transfer_unit(uuid,text);
drop function if exists public.get_branch_debt_detail(uuid);
drop function if exists public.list_branch_debts(uuid,integer,integer);
drop function if exists public.list_branch_transfers(uuid,public.transfer_status,integer,integer);
drop function if exists public.record_branch_debt_payment(uuid,numeric,text,text,text,uuid);
drop function if exists public.record_branch_debt_payment(uuid,numeric,char(3),timestamptz,text,text,text,uuid);

revoke all on function public.require_transfer_access(uuid,uuid),public.require_source_manager(uuid),
  public.require_source_shipper(uuid),public.require_destination_receiver(uuid),public.require_creditor_payment_operator(uuid),
  public.guard_branch_transfer_data() from public,anon,authenticated;
revoke all on function public.get_transfer_references(uuid),public.find_transfer_unit(uuid,uuid,text),
  public.create_branch_transfer(jsonb,jsonb,uuid),public.list_branch_transfers(uuid,text,public.transfer_status,text,integer,integer),
  public.get_branch_transfer(uuid),public.approve_branch_transfer(uuid),public.ship_branch_transfer(uuid),public.receive_branch_transfer(uuid),
  public.list_branch_debts(uuid,text,public.debt_status,integer,integer),public.get_branch_debt_summary(uuid),
  public.get_branch_debt(uuid),public.record_branch_debt_payment(uuid,numeric,char(3),text,text,text,uuid) from public,anon;
grant execute on function public.get_transfer_references(uuid),public.find_transfer_unit(uuid,uuid,text),
  public.create_branch_transfer(jsonb,jsonb,uuid),public.list_branch_transfers(uuid,text,public.transfer_status,text,integer,integer),
  public.get_branch_transfer(uuid),public.approve_branch_transfer(uuid),public.ship_branch_transfer(uuid),public.receive_branch_transfer(uuid),
  public.list_branch_debts(uuid,text,public.debt_status,integer,integer),public.get_branch_debt_summary(uuid),
  public.get_branch_debt(uuid),public.record_branch_debt_payment(uuid,numeric,char(3),text,text,text,uuid) to authenticated;
grant execute on function public.require_transfer_access(uuid,uuid),public.require_source_manager(uuid),public.require_source_shipper(uuid),
  public.require_destination_receiver(uuid),public.require_creditor_payment_operator(uuid),public.guard_branch_transfer_data(),
  public.get_transfer_references(uuid),public.find_transfer_unit(uuid,uuid,text),public.create_branch_transfer(jsonb,jsonb,uuid),
  public.list_branch_transfers(uuid,text,public.transfer_status,text,integer,integer),public.get_branch_transfer(uuid),
  public.approve_branch_transfer(uuid),public.ship_branch_transfer(uuid),public.receive_branch_transfer(uuid),
  public.list_branch_debts(uuid,text,public.debt_status,integer,integer),public.get_branch_debt_summary(uuid),
  public.get_branch_debt(uuid),public.record_branch_debt_payment(uuid,numeric,char(3),text,text,text,uuid) to service_role;

commit;