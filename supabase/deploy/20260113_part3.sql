create or replace function public.list_courier_deliveries(p_status public.delivery_status default null,p_limit integer default 30,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb; v_total bigint;
begin
  if auth.uid() is null or not public.current_user_active() or not exists(select 1 from public.profile_roles where profile_id=auth.uid() and role='courier') then raise exception 'Faol kuryer roli talab qilinadi' using errcode='42501'; end if;
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash notoвЂgвЂri' using errcode='22023'; end if;
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
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>366 then raise exception 'Sana oraligвЂi notoвЂgвЂri' using errcode='22023'; end if;
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
  if p_latitude not between -90 and 90 or p_longitude not between -180 and 180 or (p_accuracy_m is not null and p_accuracy_m<0) then raise exception 'Koordinata notoвЂgвЂri' using errcode='22023'; end if;
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
  if not((v_d.status='assigned' and p_status='picked_up') or (v_d.status='picked_up' and p_status='in_transit') or (v_d.status='in_transit' and p_status in('delivered','failed'))) then raise exception 'Yetkazib berish status oвЂtishi notoвЂgвЂri' using errcode='P0001'; end if;
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
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash notoвЂgвЂri' using errcode='22023'; end if;
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
  begin v_id=nullif(p_account->>'id','')::uuid; v_branch=nullif(p_account->>'branch_id','')::uuid; exception when invalid_text_representation then raise exception 'Hisob identifikatori notoвЂgвЂri' using errcode='22023'; end;
  perform public.require_finance_operator(v_branch); v_currency=upper(coalesce(nullif(btrim(p_account->>'currency'),''),'UZS'));
  if v_currency !~ '^[A-Z]{3}$' or nullif(btrim(p_account->>'code'),'') is null or nullif(btrim(p_account->>'name'),'') is null then raise exception 'Hisob maydonlari notoвЂgвЂri' using errcode='22023'; end if;
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
  if p_idempotency_key is null or p_amount is null or p_amount<=0 or nullif(btrim(p_category),'') is null then raise exception 'Tranzaksiya maydonlari notoвЂgвЂri' using errcode='22023'; end if;
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
      raise exception 'Takroriy kalit boshqa toвЂlovda ishlatilgan' using errcode='22023'; end if;
    return v_existing.id;
  end if;
  select * into v_account from public.finance_accounts where id=p_account_id and is_active and branch_id is not distinct from p_branch_id;
  if not found or not exists(select 1 from public.suppliers where id=p_supplier_id and is_active) then raise exception 'Faol supplier yoki hisob topilmadi' using errcode='P0002'; end if;
  if p_amount<=0 or nullif(btrim(p_method),'') is null then raise exception 'ToвЂlov summasi/usuli notoвЂgвЂri' using errcode='22023'; end if;
  v_tx=public.post_finance_transaction(p_account_id,'expense','supplier_payment',p_amount,now(),'TaвЂ™minotchi toвЂlovi','supplier_payment',v_id,p_idempotency_key);
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
  if p_idempotency_key is null or nullif(btrim(p_reason),'') is null or coalesce(array_length(p_unit_ids,1),0) not between 1 and 500 or not exists(select 1 from public.suppliers where id=p_supplier_id and is_active) then raise exception 'Supplier return maвЂ™lumotlari notoвЂgвЂri' using errcode='22023'; end if;
  if (select count(*) from unnest(p_unit_ids)x)<>(select count(distinct x) from unnest(p_unit_ids)x) then raise exception 'Birliklar takrorlanmasligi kerak' using errcode='22023'; end if;
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('supplier_id',p_supplier_id,'location_id',p_location_id,'reason',btrim(p_reason),'units',(select jsonb_agg(x order by x) from unnest(p_unit_ids)x))::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.supplier_returns where branch_id=v_branch and idempotency_key=p_idempotency_key;
  if found then if v_existing.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa supplier returnda ishlatilgan' using errcode='22023'; end if; return v_existing.id; end if;
  perform 1 from public.inventory_units where id=any(p_unit_ids) order by id for update;
  if (select count(*) from public.inventory_units where id=any(p_unit_ids))<>cardinality(p_unit_ids) then
    raise exception 'SoвЂralgan birliklardan biri topilmadi' using errcode='P0002';
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
  update public.supplier_returns set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),reason=reason||E'\nBekor qilish: '||coalesce(nullif(btrim(p_reason),''),'Sabab koвЂrsatilmagan') where id=p_return_id returning * into v_r; return to_jsonb(v_r);
end $$;

create or replace function public.create_payroll_run(p_branch_id uuid,p_period_start date,p_period_end date,p_items jsonb,p_idempotency_key uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid:=gen_random_uuid(); v_hash text; v_existing public.payroll_runs%rowtype; v_item jsonb; v_total numeric(18,2):=0; v_gross numeric(18,2); v_ded numeric(18,2);
begin
  perform public.require_finance_operator(p_branch_id);
  if p_branch_id is not null then perform 1 from public.branches where id=p_branch_id for update; end if;
  if p_branch_id is null or p_idempotency_key is null or p_period_start is null or p_period_end<p_period_start or p_period_end-p_period_start>366
    or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 1000 then raise exception 'Payroll maвЂ™lumotlari notoвЂgвЂri' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_items)e group by (e->>'employee_id')::uuid having count(*)>1) then raise exception 'Xodim takrorlangan' using errcode='22023'; end if;
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('branch_id',p_branch_id,'period_start',p_period_start,'period_end',p_period_end,'items',p_items)::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.payroll_runs where branch_id=p_branch_id and idempotency_key=p_idempotency_key;
  if found then if v_existing.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa payroll uchun ishlatilgan' using errcode='22023'; end if; return v_existing.id; end if;
  insert into public.payroll_runs(id,branch_id,period_start,period_end,status,total,idempotency_key,request_hash,created_by)
  values(v_id,p_branch_id,p_period_start,p_period_end,'draft',0,p_idempotency_key,v_hash,auth.uid());
  for v_item in select value from jsonb_array_elements(p_items) order by (value->>'employee_id')::uuid loop
    v_gross=(v_item->>'gross')::numeric; v_ded=coalesce((v_item->>'deductions')::numeric,0);
    if v_gross<0 or v_ded<0 or v_ded>v_gross or not exists(select 1 from public.profile_roles where profile_id=(v_item->>'employee_id')::uuid and branch_id=p_branch_id) then raise exception 'Payroll xodimi yoki summasi notoвЂgвЂri' using errcode='22023'; end if;
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
    raise exception 'ToвЂlangan payroll replay parametrlari mos emas' using errcode='22023';
  end if;
  if v_r.status<>'approved' then raise exception 'Faqat approved payroll toвЂlanadi' using errcode='P0001'; end if;
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
  if p_entity not in('banners','home_blocks','menu_items') or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>500 then raise exception 'CMS reorder payload notoвЂgвЂri' using errcode='22023'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    begin v_id=(v_item->>'id')::uuid; v_order=(v_item->>'sort_order')::integer; exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'CMS id/sort_order notoвЂgвЂri' using errcode='22023'; end;
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
  if v_b.is_active and (v_b.starts_at is null or v_b.starts_at<=now()) and (v_b.ends_at is null or v_b.ends_at>now()) then raise exception 'Faol banner media faylini oвЂchirishdan oldin bannerni faolsizlantiring' using errcode='P0001'; end if;
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

