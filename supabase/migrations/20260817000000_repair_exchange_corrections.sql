-- Repair, atomic exchanges and append-only business corrections.
-- Enum values are committed before they are referenced by the transactional body.
alter type public.location_type add value if not exists 'repair';
alter type public.unit_status add value if not exists 'in_repair';
alter type public.movement_type add value if not exists 'repair_out';
alter type public.movement_type add value if not exists 'repair_in';

begin;

insert into public.payment_methods(code,name,is_cash,is_online,is_active,sort_order)
values('exchange_credit','Almashtirish krediti',false,false,true,900)
on conflict(code) do update set name=excluded.name,is_active=true;

create table public.repair_orders(
  id uuid primary key default gen_random_uuid(),
  repair_no text not null unique,
  branch_id uuid not null references public.branches(id) on delete restrict,
  unit_id uuid not null references public.inventory_units(id) on delete restrict,
  source_location_id uuid not null references public.locations(id) on delete restrict,
  source_status public.unit_status not null,
  repair_location_id uuid not null references public.locations(id) on delete restrict,
  destination_location_id uuid references public.locations(id) on delete restrict,
  status text not null default 'received' check(status in('received','in_repair','ready','completed','cancelled')),
  issue text not null check(length(btrim(issue)) between 3 and 2000),
  diagnosis text,
  resolution text,
  is_warranty boolean not null default false,
  expected_at timestamptz,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  started_by uuid references public.profiles(id) on delete restrict,
  readied_by uuid references public.profiles(id) on delete restrict,
  completed_by uuid references public.profiles(id) on delete restrict,
  cancelled_by uuid references public.profiles(id) on delete restrict,
  started_at timestamptz,ready_at timestamptz,completed_at timestamptz,cancelled_at timestamptz,
  idempotency_key uuid not null,
  request_hash text not null,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(branch_id,idempotency_key)
);
create unique index repair_orders_open_unit_uidx on public.repair_orders(unit_id) where status in('received','in_repair','ready');
create index repair_orders_branch_status_idx on public.repair_orders(branch_id,status,created_at desc);

create table public.repair_events(
  id bigint generated always as identity primary key,
  repair_id uuid not null references public.repair_orders(id) on delete restrict,
  event_type text not null check(event_type in('received','started','diagnosed','ready','completed','cancelled','cost_added')),
  note text,
  payload jsonb not null default '{}'::jsonb check(jsonb_typeof(payload)='object'),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index repair_events_order_idx on public.repair_events(repair_id,created_at,id);
create trigger repair_events_immutable before update or delete on public.repair_events for each row execute function public.reject_mutation();

create table public.repair_cost_entries(
  id uuid primary key default gen_random_uuid(),
  repair_id uuid not null references public.repair_orders(id) on delete restrict,
  cost_type text not null check(cost_type in('parts','labor','shipping','other')),
  amount numeric(18,2) not null check(amount>0),currency char(3) not null default 'UZS',
  description text not null check(length(btrim(description)) between 2 and 1000),
  idempotency_key uuid not null,
  request_hash text not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(repair_id,idempotency_key)
);
create index repair_cost_entries_order_idx on public.repair_cost_entries(repair_id,created_at,id);
create trigger repair_cost_entries_immutable before update or delete on public.repair_cost_entries for each row execute function public.reject_mutation();
create trigger repair_orders_set_updated_at before update on public.repair_orders for each row execute function public.set_updated_at();

create table public.exchange_transactions(
  id uuid primary key default gen_random_uuid(),
  exchange_no text not null unique,
  return_id uuid not null unique references public.sale_returns(id) on delete restrict,
  original_sale_id uuid not null references public.sales(id) on delete restrict,
  replacement_pending_sale_id uuid not null unique references public.pos_pending_sales(id) on delete restrict,
  replacement_sale_id uuid not null unique references public.sales(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  return_credit numeric(18,2) not null check(return_credit>=0),
  replacement_total numeric(18,2) not null check(replacement_total>=0),
  amount_due numeric(18,2) not null check(amount_due>=0),
  refund_due numeric(18,2) not null check(refund_due>=0),
  settlement_payload jsonb not null default '[]'::jsonb check(jsonb_typeof(settlement_payload)='array'),
  idempotency_key uuid not null,
  request_hash text not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(branch_id,idempotency_key)
);
create index exchange_transactions_branch_time_idx on public.exchange_transactions(branch_id,created_at desc);
create trigger exchange_transactions_immutable before update or delete on public.exchange_transactions for each row execute function public.reject_mutation();

create table public.exchange_refund_disbursements(
  id uuid primary key default gen_random_uuid(),
  exchange_id uuid not null unique references public.exchange_transactions(id) on delete restrict,
  amount numeric(18,2) not null check(amount>0),
  method_code text not null check(method_code in('cash','card','bank_transfer','click','payme')),
  external_reference text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check(method_code='cash' or nullif(btrim(external_reference),'') is not null)
);
create trigger exchange_refund_disbursements_immutable before update or delete on public.exchange_refund_disbursements for each row execute function public.reject_mutation();

create table public.business_corrections(
  id uuid primary key default gen_random_uuid(),
  correction_no text not null unique,
  branch_id uuid not null references public.branches(id) on delete restrict,
  entity_type text not null check(entity_type in('sale')),
  entity_id uuid not null,
  correction_type text not null check(correction_type in('reversal','reversal_replacement')),
  status text not null default 'requested' check(status in('requested','approved','applied','rejected')),
  reason text not null check(length(btrim(reason)) between 5 and 2000),
  payload jsonb not null default '{}'::jsonb check(jsonb_typeof(payload)='object'),
  proposed_snapshot jsonb not null check(jsonb_typeof(proposed_snapshot)='object'),
  approved_snapshot jsonb check(approved_snapshot is null or jsonb_typeof(approved_snapshot)='object'),
  reversal_return_id uuid references public.sale_returns(id) on delete restrict,
  replacement_sale_id uuid references public.sales(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  approved_by uuid references public.profiles(id) on delete restrict,
  applied_by uuid references public.profiles(id) on delete restrict,
  rejected_by uuid references public.profiles(id) on delete restrict,
  approved_at timestamptz,applied_at timestamptz,rejected_at timestamptz,
  idempotency_key uuid not null,
  request_hash text not null,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(branch_id,idempotency_key)
);
create index business_corrections_branch_status_idx on public.business_corrections(branch_id,status,created_at desc);
create trigger business_corrections_set_updated_at before update on public.business_corrections for each row execute function public.set_updated_at();

create table public.business_correction_events(
  id bigint generated always as identity primary key,
  correction_id uuid not null references public.business_corrections(id) on delete restrict,
  event_type text not null check(event_type in('requested','approved','applied','rejected')),
  note text,
  payload jsonb not null default '{}'::jsonb check(jsonb_typeof(payload)='object'),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index business_correction_events_idx on public.business_correction_events(correction_id,created_at,id);
create trigger business_correction_events_immutable before update or delete on public.business_correction_events for each row execute function public.reject_mutation();

create or replace function public.ensure_branch_repair_location(p_branch_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  select id into v_id from public.locations where branch_id=p_branch_id and type='repair' and is_active order by created_at limit 1 for share;
  if v_id is null then
    insert into public.locations(branch_id,code,name,type,is_active)
    values(p_branch_id,'REPAIR-'||upper(substr(replace(p_branch_id::text,'-',''),1,12)),'Ta’mirlash zonasi','repair',true)
    on conflict(code) do update set is_active=true
    returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function public.create_repair_order(p_branch_id uuid,p_unit_code text,p_issue text,p_is_warranty boolean default false,p_expected_at timestamptz default null,p_idempotency_key uuid default gen_random_uuid())
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_u public.inventory_units%rowtype;v_source_branch uuid;v_repair uuid;v_row public.repair_orders%rowtype;v_id uuid:=gen_random_uuid();v_hash text;
begin
  perform public.require_inventory_operator(p_branch_id);
  if p_idempotency_key is null or nullif(btrim(p_unit_code),'') is null or length(btrim(coalesce(p_issue,''))) not between 3 and 2000 then raise exception 'Ta’mirlash ma’lumotlari noto‘g‘ri' using errcode='22023'; end if;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('branch_id',p_branch_id,'unit_code',btrim(p_unit_code),'issue',btrim(p_issue),'is_warranty',coalesce(p_is_warranty,false),'expected_at',p_expected_at)::text,'UTF8'),'sha256'),'hex');
  select * into v_row from public.repair_orders where branch_id=p_branch_id and idempotency_key=p_idempotency_key;
  if found then if v_row.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa ta’mirlash so‘rovida ishlatilgan' using errcode='22023';end if;return to_jsonb(v_row);end if;
  select u.* into v_u from public.inventory_units u where u.qr_code=btrim(p_unit_code) or u.serial_number=btrim(p_unit_code) for update;
  if not found then raise exception 'Birlik topilmadi' using errcode='P0002'; end if;
  select branch_id into v_source_branch from public.locations where id=v_u.location_id;
  if v_source_branch is distinct from p_branch_id or v_u.status not in('available','returned') or v_u.sold_sale_id is not null then raise exception 'Birlik ta’mirlashga qabul qilinmaydi' using errcode='P0001'; end if;
  v_repair:=public.ensure_branch_repair_location(p_branch_id);
  insert into public.repair_orders(id,repair_no,branch_id,unit_id,source_location_id,source_status,repair_location_id,status,issue,is_warranty,expected_at,requested_by,idempotency_key,request_hash)
  values(v_id,'RPR-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8)),p_branch_id,v_u.id,v_u.location_id,v_u.status,v_repair,'received',btrim(p_issue),coalesce(p_is_warranty,false),p_expected_at,auth.uid(),p_idempotency_key,v_hash)
  returning * into v_row;
  update public.inventory_units set location_id=v_repair,status='in_repair',reserved_until=null,version=version+1 where id=v_u.id;
  insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,reference_type,reference_id,reason,actor_id)
  values(v_u.id,v_u.product_id,v_u.batch_id,'repair_out',v_u.location_id,v_repair,1,'repair_order',v_id,v_row.issue,auth.uid());
  insert into public.repair_events(repair_id,event_type,note,actor_id) values(v_id,'received',v_row.issue,auth.uid());
  return to_jsonb(v_row);
end $$;

create or replace function public.transition_repair_order(p_repair_id uuid,p_target text,p_destination_location_id uuid default null,p_diagnosis text default null,p_resolution text default null,p_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.repair_orders%rowtype;v_u public.inventory_units%rowtype;v_dest uuid;v_target text:=lower(btrim(p_target));
begin
  select * into v_r from public.repair_orders where id=p_repair_id for update;
  if not found then raise exception 'Ta’mirlash buyurtmasi topilmadi' using errcode='P0002'; end if;
  perform public.require_inventory_operator(v_r.branch_id);
  select * into v_u from public.inventory_units where id=v_r.unit_id for update;
  if v_target='in_repair' then
    if v_r.status<>'received' then raise exception 'Faqat qabul qilingan buyurtma boshlanadi' using errcode='P0001'; end if;
    update public.repair_orders set status='in_repair',started_by=auth.uid(),started_at=now() where id=v_r.id;
    insert into public.repair_events(repair_id,event_type,note,actor_id) values(v_r.id,'started',nullif(btrim(p_note),''),auth.uid());
  elsif v_target='ready' then
    if v_r.status not in('received','in_repair') or nullif(btrim(p_diagnosis),'') is null or nullif(btrim(p_resolution),'') is null then raise exception 'Tashxis va yechim talab qilinadi' using errcode='22023'; end if;
    update public.repair_orders set status='ready',diagnosis=btrim(p_diagnosis),resolution=btrim(p_resolution),readied_by=auth.uid(),ready_at=now() where id=v_r.id;
    insert into public.repair_events(repair_id,event_type,note,payload,actor_id) values(v_r.id,'ready',nullif(btrim(p_note),''),jsonb_build_object('diagnosis',btrim(p_diagnosis),'resolution',btrim(p_resolution)),auth.uid());
  elsif v_target='completed' then
    if v_r.status<>'ready' then raise exception 'Faqat tayyor buyurtma topshiriladi' using errcode='P0001'; end if;
    select id into v_dest from public.locations where id=p_destination_location_id and branch_id=v_r.branch_id and is_active and type in('store','warehouse');
    if v_dest is null then raise exception 'Topshirish joyi filialga mos emas' using errcode='22023'; end if;
    if v_u.status<>'in_repair' or v_u.location_id<>v_r.repair_location_id then raise exception 'Birlik ta’mirlash zonasida emas' using errcode='P0001'; end if;
    update public.inventory_units set location_id=v_dest,status='available',version=version+1 where id=v_u.id;
    update public.repair_orders set status='completed',destination_location_id=v_dest,completed_by=auth.uid(),completed_at=now() where id=v_r.id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,reference_type,reference_id,reason,actor_id)
    values(v_u.id,v_u.product_id,v_u.batch_id,'repair_in',v_u.location_id,v_dest,1,'repair_order',v_r.id,coalesce(nullif(btrim(p_note),''),v_r.resolution),auth.uid());
    insert into public.repair_events(repair_id,event_type,note,actor_id) values(v_r.id,'completed',nullif(btrim(p_note),''),auth.uid());
  elsif v_target='cancelled' then
    if v_r.status not in('received','in_repair') or nullif(btrim(p_note),'') is null then raise exception 'Bu bosqichda bekor qilib bo‘lmaydi yoki sabab yo‘q' using errcode='P0001'; end if;
    if v_u.status<>'in_repair' then raise exception 'Birlik holati ta’mirlashga mos emas' using errcode='P0001'; end if;
    update public.inventory_units set location_id=v_r.source_location_id,status=v_r.source_status,version=version+1 where id=v_u.id;
    update public.repair_orders set status='cancelled',destination_location_id=v_r.source_location_id,cancelled_by=auth.uid(),cancelled_at=now() where id=v_r.id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,reference_type,reference_id,reason,actor_id)
    values(v_u.id,v_u.product_id,v_u.batch_id,'repair_in',v_u.location_id,v_r.source_location_id,1,'repair_order',v_r.id,btrim(p_note),auth.uid());
    insert into public.repair_events(repair_id,event_type,note,actor_id) values(v_r.id,'cancelled',btrim(p_note),auth.uid());
  else raise exception 'Ta’mirlash o‘tishi noma’lum' using errcode='22023'; end if;
  select * into v_r from public.repair_orders where id=p_repair_id;return to_jsonb(v_r);
end $$;

create or replace function public.add_repair_cost(p_repair_id uuid,p_cost_type text,p_amount numeric,p_description text,p_currency text default 'UZS',p_idempotency_key uuid default gen_random_uuid())
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.repair_orders%rowtype;v_c public.repair_cost_entries%rowtype;v_currency char(3);v_hash text;
begin
  select * into v_r from public.repair_orders where id=p_repair_id for update;
  if not found then raise exception 'Ta’mirlash buyurtmasi topilmadi' using errcode='P0002'; end if;perform public.require_inventory_operator(v_r.branch_id);
  select currency into v_currency from public.branches where id=v_r.branch_id;
  if v_r.status in('completed','cancelled') or p_idempotency_key is null or p_cost_type not in('parts','labor','shipping','other') or coalesce(p_amount,0)<=0 or nullif(btrim(p_description),'') is null or upper(btrim(p_currency))<>btrim(v_currency::text) then raise exception 'Xarajat ma’lumotlari yoki valyutasi noto‘g‘ri' using errcode='22023'; end if;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('repair_id',p_repair_id,'cost_type',p_cost_type,'amount',p_amount,'description',btrim(p_description),'currency',upper(btrim(p_currency)))::text,'UTF8'),'sha256'),'hex');
  select * into v_c from public.repair_cost_entries where repair_id=p_repair_id and idempotency_key=p_idempotency_key;
  if found then if v_c.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa xarajat uchun ishlatilgan' using errcode='22023';end if;return to_jsonb(v_c);end if;
  insert into public.repair_cost_entries(repair_id,cost_type,amount,currency,description,idempotency_key,request_hash,created_by)
  values(v_r.id,p_cost_type,p_amount,v_currency,btrim(p_description),p_idempotency_key,v_hash,auth.uid()) returning * into v_c;
  insert into public.repair_events(repair_id,event_type,note,payload,actor_id) values(v_r.id,'cost_added',v_c.description,jsonb_build_object('cost_id',v_c.id,'type',v_c.cost_type,'amount',v_c.amount,'currency',btrim(v_c.currency::text)),auth.uid());
  return to_jsonb(v_c);
end $$;

create or replace function public.list_repair_orders(p_branch_id uuid,p_status text default null,p_query text default null,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb;v_total bigint;
begin
  perform public.require_inventory_operator(p_branch_id);if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  select count(*) into v_total from public.repair_orders r join public.inventory_units u on u.id=r.unit_id join public.products p on p.id=u.product_id
  where r.branch_id=p_branch_id and (p_status is null or r.status=p_status) and (p_query is null or r.repair_no ilike '%'||btrim(p_query)||'%' or u.qr_code ilike '%'||btrim(p_query)||'%' or coalesce(u.serial_number,'') ilike '%'||btrim(p_query)||'%' or p.name ilike '%'||btrim(p_query)||'%');
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb) into v_items from(
    select r.*,btrim(br.currency::text) currency,u.qr_code,u.serial_number,p.name product_name,p.sku,sl.name source_location_name,rl.name repair_location_name,dl.name destination_location_name,
      coalesce((select sum(c.amount) from public.repair_cost_entries c where c.repair_id=r.id),0) total_cost,
      coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at,e.id) from public.repair_events e where e.repair_id=r.id),'[]'::jsonb) events,
      coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at,c.id) from public.repair_cost_entries c where c.repair_id=r.id),'[]'::jsonb) costs
    from public.repair_orders r join public.branches br on br.id=r.branch_id join public.inventory_units u on u.id=r.unit_id join public.products p on p.id=u.product_id
    join public.locations sl on sl.id=r.source_location_id join public.locations rl on rl.id=r.repair_location_id left join public.locations dl on dl.id=r.destination_location_id
    where r.branch_id=p_branch_id and (p_status is null or r.status=p_status) and (p_query is null or r.repair_no ilike '%'||btrim(p_query)||'%' or u.qr_code ilike '%'||btrim(p_query)||'%' or coalesce(u.serial_number,'') ilike '%'||btrim(p_query)||'%' or p.name ilike '%'||btrim(p_query)||'%')
    order by r.created_at desc limit p_limit offset p_offset)q;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

create or replace function public.get_exchange_quote(p_return_id uuid,p_replacement_pending_sale_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_r public.sale_returns%rowtype;v_p public.pos_pending_sales%rowtype;
begin
  select * into v_r from public.sale_returns where id=p_return_id;if not found then raise exception 'Almashtirish topilmadi' using errcode='P0002'; end if;perform public.require_pos_manager(v_r.branch_id);
  select * into v_p from public.pos_pending_sales where id=p_replacement_pending_sale_id and branch_id=v_r.branch_id;
  if not found or v_r.kind<>'exchange' or v_r.status<>'approved' or v_p.status<>'pending' or v_p.expires_at<=now() then raise exception 'Almashtirish yoki replacement POS so‘rovi tayyor emas' using errcode='P0001'; end if;
  return jsonb_build_object('return_id',v_r.id,'pending_sale_id',v_p.id,'return_credit',v_r.refund_amount,'replacement_total',v_p.total,'amount_due',greatest(v_p.total-v_r.refund_amount,0),'refund_due',greatest(v_r.refund_amount-v_p.total,0));
end $$;

create or replace function public.execute_sale_exchange(p_return_id uuid,p_replacement_pending_sale_id uuid,p_resell_location_id uuid,p_settlements jsonb default '[]'::jsonb,p_refund_settlement jsonb default null,p_idempotency_key uuid default gen_random_uuid())
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.sale_returns%rowtype;v_p public.pos_pending_sales%rowtype;v_existing public.exchange_transactions%rowtype;v_sale uuid;v_credit numeric(18,2);v_due numeric(18,2);v_refund numeric(18,2);v_paid numeric(18,2);v_payments jsonb;v_id uuid:=gen_random_uuid();v_hash text;
begin
  select * into v_r from public.sale_returns where id=p_return_id for update;if not found then raise exception 'Almashtirish topilmadi' using errcode='P0002'; end if;perform public.require_pos_manager(v_r.branch_id);
  if p_idempotency_key is null or jsonb_typeof(coalesce(p_settlements,'[]'::jsonb))<>'array' or (p_refund_settlement is not null and jsonb_typeof(p_refund_settlement)<>'object') then raise exception 'Settlement ma’lumotlari noto‘g‘ri' using errcode='22023'; end if;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('return_id',p_return_id,'pending_sale_id',p_replacement_pending_sale_id,'location_id',p_resell_location_id,'settlements',coalesce(p_settlements,'[]'::jsonb),'refund_settlement',p_refund_settlement)::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.exchange_transactions where branch_id=v_r.branch_id and idempotency_key=p_idempotency_key;if found then if v_existing.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa almashtirish uchun ishlatilgan' using errcode='22023';end if;return to_jsonb(v_existing);end if;
  select * into v_p from public.pos_pending_sales where id=p_replacement_pending_sale_id and branch_id=v_r.branch_id for update;
  if not found or v_r.kind<>'exchange' or v_r.status<>'approved' or v_p.status<>'pending' or v_p.expires_at<=now() then raise exception 'Almashtirish yoki replacement POS so‘rovi tayyor emas' using errcode='P0001'; end if;
  if v_p.customer_id is distinct from (select customer_id from public.sales where id=v_r.original_sale_id) then raise exception 'Replacement xaridori original sotuvga mos emas' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_settlements,'[]'::jsonb)) e where lower(e->>'method_code')='exchange_credit') then raise exception 'Ichki exchange kreditini qo‘lda yuborish mumkin emas' using errcode='22023'; end if;
  select coalesce(sum((e->>'amount')::numeric),0) into v_paid from jsonb_array_elements(coalesce(p_settlements,'[]'::jsonb)) e;
  v_credit:=least(v_r.refund_amount,v_p.total);v_due:=greatest(v_p.total-v_r.refund_amount,0);v_refund:=greatest(v_r.refund_amount-v_p.total,0);
  if v_paid<>v_due then raise exception 'Qo‘shimcha to‘lov almashtirish farqiga teng emas' using errcode='22023'; end if;
  if v_refund>0 and (p_refund_settlement is null or (p_refund_settlement->>'amount')::numeric is distinct from v_refund or coalesce(p_refund_settlement->>'method_code','') not in('cash','card','bank_transfer','click','payme') or (p_refund_settlement->>'method_code'<>'cash' and nullif(btrim(p_refund_settlement->>'external_reference'),'') is null)) then raise exception 'Mijozga refund settlement to‘liq ko‘rsatilishi kerak' using errcode='22023';end if;
  if v_refund=0 and p_refund_settlement is not null then raise exception 'Refund bo‘lmagan almashtirish payout qabul qilmaydi' using errcode='22023';end if;
  v_payments:=coalesce(p_settlements,'[]'::jsonb);if v_credit>0 then v_payments:=jsonb_build_array(jsonb_build_object('method_code','exchange_credit','amount',v_credit,'external_reference',v_r.return_no))||v_payments;end if;
  v_sale:=public.manager_confirm_sale(v_p.id,v_payments);
  if v_sale is null then raise exception 'Replacement rezerv muddati tugagan' using errcode='P0001'; end if;
  perform public.complete_sale_return(v_r.id,p_resell_location_id,v_sale);
  insert into public.exchange_transactions(id,exchange_no,return_id,original_sale_id,replacement_pending_sale_id,replacement_sale_id,branch_id,return_credit,replacement_total,amount_due,refund_due,settlement_payload,idempotency_key,request_hash,created_by)
  values(v_id,'EXC-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8)),v_r.id,v_r.original_sale_id,v_p.id,v_sale,v_r.branch_id,v_r.refund_amount,v_p.total,v_due,v_refund,coalesce(p_settlements,'[]'::jsonb),p_idempotency_key,v_hash,auth.uid()) returning * into v_existing;
  if v_refund>0 then insert into public.exchange_refund_disbursements(exchange_id,amount,method_code,external_reference,created_by) values(v_id,v_refund,p_refund_settlement->>'method_code',nullif(btrim(p_refund_settlement->>'external_reference'),''),auth.uid());end if;
  return to_jsonb(v_existing);
end $$;

create or replace function public.compute_business_correction_snapshot(p_branch_id uuid,p_entity_id uuid,p_correction_type text,p_payload jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_lines jsonb;v_condition text;v_location uuid;v_pending public.pos_pending_sales%rowtype;v_credit numeric(18,2);v_snapshot jsonb;
begin
  v_condition:=coalesce(nullif(p_payload->>'condition',''),'resellable');if v_condition not in('resellable','damaged','defective') then raise exception 'Correction condition noto‘g‘ri' using errcode='22023';end if;
  v_location:=nullif(p_payload->>'resell_location_id','')::uuid;if not exists(select 1 from public.locations where id=v_location and branch_id=p_branch_id and is_active and type in('store','warehouse')) then raise exception 'Qaytarish joyi filialga mos emas' using errcode='22023';end if;
  select jsonb_agg(jsonb_build_object('sale_line_id',sl.id,'unit_id',sl.unit_id,'product_name',p.name,'sku',p.sku,'qr_code',u.qr_code,'serial_number',u.serial_number,'condition',v_condition,'refund_amount',sl.line_total) order by sl.id),coalesce(sum(sl.line_total),0) into v_lines,v_credit
  from public.sale_lines sl join public.products p on p.id=sl.product_id join public.inventory_units u on u.id=sl.unit_id where sl.sale_id=p_entity_id and not exists(select 1 from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id where x.sale_line_id=sl.id and r.status in('requested','approved','completed'));
  if coalesce(jsonb_array_length(v_lines),0)=0 then raise exception 'Correction uchun qaytariladigan birlik qolmagan' using errcode='P0001';end if;
  v_snapshot:=jsonb_build_object('lines',v_lines,'return_credit',v_credit,'condition',v_condition,'resell_location_id',v_location);
  if p_correction_type='reversal_replacement' then
    select * into v_pending from public.pos_pending_sales where id=(p_payload->>'replacement_pending_sale_id')::uuid and branch_id=p_branch_id;
    if not found or v_pending.status<>'pending' or v_pending.expires_at<=now() then raise exception 'Replacement POS so‘rovi tayyor emas' using errcode='P0001';end if;
    if v_pending.customer_id is distinct from (select customer_id from public.sales where id=p_entity_id) then raise exception 'Replacement xaridori original sotuvga mos emas' using errcode='22023';end if;
    v_snapshot:=v_snapshot||jsonb_build_object('replacement_pending_sale_id',v_pending.id,'replacement_total',v_pending.total,'amount_due',greatest(v_pending.total-v_credit,0),'refund_due',greatest(v_credit-v_pending.total,0));
  end if;
  return v_snapshot;
end $$;

create or replace function public.request_business_correction(p_entity_type text,p_entity_id uuid,p_reason text,p_payload jsonb default '{}'::jsonb,p_idempotency_key uuid default gen_random_uuid())
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_sale public.sales%rowtype;v_row public.business_corrections%rowtype;v_id uuid:=gen_random_uuid();v_type text;v_hash text;v_snapshot jsonb;
begin
  if lower(btrim(p_entity_type))<>'sale' or p_idempotency_key is null or length(btrim(coalesce(p_reason,''))) not between 5 and 2000 or jsonb_typeof(coalesce(p_payload,'{}'::jsonb))<>'object' then raise exception 'Correction ma’lumotlari noto‘g‘ri' using errcode='22023'; end if;
  select * into v_sale from public.sales where id=p_entity_id;if not found then raise exception 'Sotuv topilmadi' using errcode='P0002'; end if;perform public.require_pos_manager(v_sale.branch_id);
  if v_sale.status='void' then raise exception 'Void sotuv correction qilinmaydi' using errcode='P0001'; end if;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('entity_type','sale','entity_id',p_entity_id,'reason',btrim(p_reason),'payload',coalesce(p_payload,'{}'::jsonb))::text,'UTF8'),'sha256'),'hex');
  select * into v_row from public.business_corrections where branch_id=v_sale.branch_id and idempotency_key=p_idempotency_key;if found then if v_row.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa correction uchun ishlatilgan' using errcode='22023';end if;return to_jsonb(v_row);end if;
  v_type:=case when nullif(p_payload->>'replacement_pending_sale_id','') is null then 'reversal' else 'reversal_replacement' end;
  v_snapshot:=public.compute_business_correction_snapshot(v_sale.branch_id,v_sale.id,v_type,coalesce(p_payload,'{}'::jsonb));
  insert into public.business_corrections(id,correction_no,branch_id,entity_type,entity_id,correction_type,status,reason,payload,proposed_snapshot,requested_by,idempotency_key,request_hash)
  values(v_id,'COR-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8)),v_sale.branch_id,'sale',v_sale.id,v_type,'requested',btrim(p_reason),coalesce(p_payload,'{}'::jsonb),v_snapshot,auth.uid(),p_idempotency_key,v_hash) returning * into v_row;
  insert into public.business_correction_events(correction_id,event_type,note,payload,actor_id) values(v_id,'requested',v_row.reason,v_row.payload,auth.uid());return to_jsonb(v_row);
end $$;

create or replace function public.approve_business_correction(p_correction_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_c public.business_corrections%rowtype;v_current jsonb;
begin
  select * into v_c from public.business_corrections where id=p_correction_id for update;if not found then raise exception 'Correction topilmadi' using errcode='P0002'; end if;perform public.require_pos_manager(v_c.branch_id);
  if v_c.status='approved' then return to_jsonb(v_c);end if;if v_c.status<>'requested' then raise exception 'Faqat requested correction tasdiqlanadi' using errcode='P0001';end if;
  if v_c.requested_by=auth.uid() then raise exception 'Correction so‘rovchisi o‘z so‘rovini tasdiqlay olmaydi' using errcode='42501';end if;
  v_current:=public.compute_business_correction_snapshot(v_c.branch_id,v_c.entity_id,v_c.correction_type,v_c.payload);
  if v_current is distinct from v_c.proposed_snapshot then raise exception 'Correction proposal holati o‘zgargan; yangi so‘rov yarating' using errcode='40001';end if;
  update public.business_corrections set status='approved',approved_snapshot=v_c.proposed_snapshot,approved_by=auth.uid(),approved_at=now() where id=v_c.id returning * into v_c;
  insert into public.business_correction_events(correction_id,event_type,note,payload,actor_id) values(v_c.id,'approved','Oldindan ko‘rilgan correction proposal tasdiqlandi',v_c.approved_snapshot,auth.uid());return to_jsonb(v_c);
end $$;

create or replace function public.reject_business_correction(p_correction_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_c public.business_corrections%rowtype;
begin
  select * into v_c from public.business_corrections where id=p_correction_id for update;if not found then raise exception 'Correction topilmadi' using errcode='P0002'; end if;perform public.require_pos_manager(v_c.branch_id);
  if v_c.status='rejected' then return to_jsonb(v_c);end if;if v_c.status not in('requested','approved') or nullif(btrim(p_reason),'') is null then raise exception 'Correction rad etilmaydi yoki sabab yo‘q' using errcode='P0001';end if;
  update public.business_corrections set status='rejected',rejected_by=auth.uid(),rejected_at=now() where id=v_c.id returning * into v_c;
  insert into public.business_correction_events(correction_id,event_type,note,actor_id) values(v_c.id,'rejected',btrim(p_reason),auth.uid());return to_jsonb(v_c);
end $$;

create or replace function public.apply_business_correction(p_correction_id uuid,p_settlements jsonb default '[]'::jsonb,p_refund_settlement jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_c public.business_corrections%rowtype;v_lines jsonb;v_ret jsonb;v_return_id uuid;v_exchange jsonb;v_replacement uuid;v_location uuid;
begin
  select * into v_c from public.business_corrections where id=p_correction_id for update;if not found then raise exception 'Correction topilmadi' using errcode='P0002'; end if;perform public.require_pos_manager(v_c.branch_id);
  if v_c.status='applied' then return to_jsonb(v_c);end if;if v_c.status<>'approved' or v_c.approved_snapshot is null then raise exception 'Faqat scope tasdiqlangan correction qo‘llanadi' using errcode='P0001';end if;
  if v_c.requested_by=auth.uid() then raise exception 'Correction so‘rovchisi correctionni qo‘llay olmaydi' using errcode='42501';end if;
  v_location:=(v_c.approved_snapshot->>'resell_location_id')::uuid;v_lines:=v_c.approved_snapshot->'lines';
  if exists(select 1 from jsonb_array_elements(v_lines)e where exists(select 1 from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id where x.sale_line_id=(e->>'sale_line_id')::uuid and r.status in('requested','approved','completed'))) then raise exception 'Tasdiqlangan correction scope boshqa jarayon bilan band' using errcode='P0001';end if;
  v_ret:=public.request_sale_return(v_c.entity_id,case when v_c.correction_type='reversal_replacement' then 'exchange'::public.return_kind else 'return'::public.return_kind end,'Correction '||v_c.correction_no||': '||v_c.reason,v_lines,v_c.id);
  v_return_id:=(v_ret->>'id')::uuid;perform public.approve_sale_return(v_return_id);
  if v_c.correction_type='reversal_replacement' then
    v_exchange:=public.execute_sale_exchange(v_return_id,(v_c.approved_snapshot->>'replacement_pending_sale_id')::uuid,v_location,coalesce(p_settlements,'[]'::jsonb),p_refund_settlement,v_c.id);
    v_replacement:=(v_exchange->>'replacement_sale_id')::uuid;
  else
    if jsonb_array_length(coalesce(p_settlements,'[]'::jsonb))>0 or p_refund_settlement is not null then raise exception 'Oddiy reversal settlement qabul qilmaydi' using errcode='22023';end if;
    perform public.complete_sale_return(v_return_id,v_location,null);
  end if;
  update public.business_corrections set status='applied',reversal_return_id=v_return_id,replacement_sale_id=v_replacement,applied_by=auth.uid(),applied_at=now() where id=v_c.id returning * into v_c;
  insert into public.business_correction_events(correction_id,event_type,note,payload,actor_id) values(v_c.id,'applied','Tasdiqlangan reversal ledger yaratildi',jsonb_build_object('return_id',v_return_id,'replacement_sale_id',v_replacement),auth.uid());return to_jsonb(v_c);
end $$;

create or replace function public.list_business_corrections(p_branch_id uuid,p_status text default null,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb;v_total bigint;
begin
  perform public.require_pos_manager(p_branch_id);if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023';end if;
  select count(*) into v_total from public.business_corrections where branch_id=p_branch_id and (p_status is null or status=p_status);
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb) into v_items from(
    select c.*,s.sale_no,s.total sale_total,s.status sale_status,p.full_name requested_by_name,
      coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at,e.id) from public.business_correction_events e where e.correction_id=c.id),'[]'::jsonb) events
    from public.business_corrections c join public.sales s on s.id=c.entity_id join public.profiles p on p.id=c.requested_by
    where c.branch_id=p_branch_id and (p_status is null or c.status=p_status) order by c.created_at desc limit p_limit offset p_offset)q;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

alter table public.repair_orders enable row level security;
alter table public.repair_events enable row level security;
alter table public.repair_cost_entries enable row level security;
alter table public.exchange_transactions enable row level security;
alter table public.exchange_refund_disbursements enable row level security;
alter table public.business_corrections enable row level security;
alter table public.business_correction_events enable row level security;

revoke all on public.repair_orders,public.repair_events,public.repair_cost_entries,public.exchange_transactions,public.exchange_refund_disbursements,public.business_corrections,public.business_correction_events from anon,authenticated;
grant all on public.repair_orders,public.repair_events,public.repair_cost_entries,public.exchange_transactions,public.exchange_refund_disbursements,public.business_corrections,public.business_correction_events to service_role;

revoke all on function public.compute_business_correction_snapshot(uuid,uuid,text,jsonb),public.ensure_branch_repair_location(uuid),public.create_repair_order(uuid,text,text,boolean,timestamptz,uuid),public.transition_repair_order(uuid,text,uuid,text,text,text),public.add_repair_cost(uuid,text,numeric,text,text,uuid),public.list_repair_orders(uuid,text,text,integer,integer),public.get_exchange_quote(uuid,uuid),public.execute_sale_exchange(uuid,uuid,uuid,jsonb,jsonb,uuid),public.request_business_correction(text,uuid,text,jsonb,uuid),public.approve_business_correction(uuid),public.reject_business_correction(uuid,text),public.apply_business_correction(uuid,jsonb,jsonb),public.list_business_corrections(uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.create_repair_order(uuid,text,text,boolean,timestamptz,uuid),public.transition_repair_order(uuid,text,uuid,text,text,text),public.add_repair_cost(uuid,text,numeric,text,text,uuid),public.list_repair_orders(uuid,text,text,integer,integer),public.get_exchange_quote(uuid,uuid),public.execute_sale_exchange(uuid,uuid,uuid,jsonb,jsonb,uuid),public.request_business_correction(text,uuid,text,jsonb,uuid),public.approve_business_correction(uuid),public.reject_business_correction(uuid,text),public.apply_business_correction(uuid,jsonb,jsonb),public.list_business_corrections(uuid,text,integer,integer) to authenticated;
grant execute on function public.compute_business_correction_snapshot(uuid,uuid,text,jsonb),public.ensure_branch_repair_location(uuid),public.create_repair_order(uuid,text,text,boolean,timestamptz,uuid),public.transition_repair_order(uuid,text,uuid,text,text,text),public.add_repair_cost(uuid,text,numeric,text,text,uuid),public.list_repair_orders(uuid,text,text,integer,integer),public.get_exchange_quote(uuid,uuid),public.execute_sale_exchange(uuid,uuid,uuid,jsonb,jsonb,uuid),public.request_business_correction(text,uuid,text,jsonb,uuid),public.approve_business_correction(uuid),public.reject_business_correction(uuid,text),public.apply_business_correction(uuid,jsonb,jsonb),public.list_business_corrections(uuid,text,integer,integer) to service_role;

commit;
