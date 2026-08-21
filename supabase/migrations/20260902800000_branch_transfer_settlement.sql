-- Filial transferini qabul qilish paytida ko‘chirish, ulgurji qiymat va sanali to‘lovlar ledgeri.
begin;

-- To‘lov transfer yaratilgan zahoti (qarz hali yaratilmasidan oldin) ham qayd etilishi mumkin.
alter table public.debt_payments
  add column if not exists transfer_id uuid references public.transfers(id) on delete restrict;

-- Eski reject-all trigger backfillni bloklamasligi uchun avval olib tashlanadi.
drop trigger if exists debt_payments_immutable on public.debt_payments;

update public.debt_payments p
set transfer_id = d.transfer_id
from public.branch_debts d
where d.id = p.debt_id and p.transfer_id is null;

do $$
begin
  if exists(select 1 from public.debt_payments where transfer_id is null) then
    raise exception 'Mavjud qarz to‘lovlarini transferga biriktirib bo‘lmadi';
  end if;
end $$;

alter table public.debt_payments
  alter column transfer_id set not null,
  alter column debt_id drop not null;

create unique index if not exists debt_payments_transfer_idempotency_uidx
  on public.debt_payments(transfer_id,idempotency_key);
create index if not exists debt_payments_transfer_paid_idx
  on public.debt_payments(transfer_id,paid_at desc,id);

-- To‘lov satri o‘zgarmas; faqat transfer qabul qilinganda null debt_id bir marta biriktiriladi.
create or replace function public.guard_transfer_debt_payment()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then
    raise exception 'debt_payments is immutable' using errcode='55000';
  end if;
  if old.transfer_id is distinct from new.transfer_id
    or old.amount is distinct from new.amount
    or old.currency is distinct from new.currency
    or old.paid_at is distinct from new.paid_at
    or old.method is distinct from new.method
    or old.reference is distinct from new.reference
    or old.notes is distinct from new.notes
    or old.idempotency_key is distinct from new.idempotency_key
    or old.created_by is distinct from new.created_by then
    raise exception 'To‘lov tarixini o‘zgartirib bo‘lmaydi' using errcode='55000';
  end if;
  if old.debt_id is not null or new.debt_id is null or not exists(
    select 1 from public.branch_debts d
    where d.id=new.debt_id and d.transfer_id=old.transfer_id
  ) then
    raise exception 'To‘lovni qarzga noto‘g‘ri biriktirish' using errcode='55000';
  end if;
  return new;
end $$;

create trigger debt_payments_immutable before update or delete on public.debt_payments
for each row execute function public.guard_transfer_debt_payment();
drop trigger if exists debt_payments_audit on public.debt_payments;
create trigger debt_payments_audit after insert or update on public.debt_payments
for each row execute function public.audit_row_change();

-- Transferning USD qarzi aynan yaratish paytidagi USD→UZS kursiga bog‘lanadi.
alter table public.transfers
  add column if not exists wholesale_exchange_rate numeric,
  add column if not exists wholesale_rate_date date;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='transfers_wholesale_exchange_rate_chk') then
    alter table public.transfers add constraint transfers_wholesale_exchange_rate_chk check(wholesale_exchange_rate>0);
  end if;
  if not exists(select 1 from pg_constraint where conname='transfers_wholesale_rate_snapshot_pair_chk') then
    alter table public.transfers add constraint transfers_wholesale_rate_snapshot_pair_chk check(
      (wholesale_exchange_rate is null)=(wholesale_rate_date is null));
  end if;
end $$;

create or replace function public.snapshot_transfer_wholesale_rate()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.currency is distinct from 'USD'::char(3) then
    raise exception 'Yangi transfer valyutasi USD bo‘lishi kerak' using errcode='22023';
  end if;
  select r.rate,r.rate_date into new.wholesale_exchange_rate,new.wholesale_rate_date
  from public.exchange_rates r
  where r.currency_from='USD' and r.currency_to='UZS'
  order by r.rate_date desc limit 1;
  if new.wholesale_exchange_rate is null or new.wholesale_exchange_rate<=0 or new.wholesale_rate_date is null then
    raise exception 'USD→UZS ulgurji kursi topilmadi' using errcode='P0002';
  end if;
  return new;
end $$;

drop trigger if exists transfers_wholesale_rate_snapshot on public.transfers;
create trigger transfers_wholesale_rate_snapshot before insert on public.transfers
for each row execute function public.snapshot_transfer_wholesale_rate();

-- Ochiq eski transferlar yangi USD ulgurji va receipt-bound ownership modeliga atomik o‘tkaziladi.
do $$
declare v_rate numeric; v_rate_date date;
begin
  if exists(select 1 from public.transfers where status in('requested','approved','in_transit')) then
    select r.rate,r.rate_date into v_rate,v_rate_date
    from public.exchange_rates r
    where r.currency_from='USD' and r.currency_to='UZS'
    order by r.rate_date desc limit 1;
    if v_rate is null or v_rate<=0 or v_rate_date is null then
      raise exception 'Ochiq transferlarni USDga baholash uchun USD→UZS kursi topilmadi';
    end if;
    update public.transfers
    set wholesale_exchange_rate=v_rate,wholesale_rate_date=v_rate_date
    where status in('requested','approved','in_transit');
  end if;
  if exists(
    select 1
    from public.transfers t
    left join public.transfer_lines x on x.transfer_id=t.id
    left join public.inventory_units u on u.id=x.unit_id
    left join public.products p on p.id=u.product_id and p.id=x.product_id
    left join public.stock_batches b on b.id=u.batch_id
    where t.status in('requested','approved','in_transit')
      and (t.wholesale_exchange_rate is null or t.wholesale_exchange_rate<=0 or t.wholesale_rate_date is null
        or x.id is null or coalesce(b.wholesale_price,p.wholesale_price) is null
        or coalesce(b.wholesale_price,p.wholesale_price)<=0
        or round(coalesce(b.wholesale_price,p.wholesale_price)/t.wholesale_exchange_rate,2)<=0)
  ) then
    raise exception 'Ochiq transferlarni musbat canonical USD ulgurji narx bilan qayta baholab bo‘lmadi';
  end if;
  if exists(
    select 1
    from public.transfers t
    join public.transfer_lines x on x.transfer_id=t.id
    left join public.inventory_units u on u.id=x.unit_id
    where t.status='in_transit' and (u.id is null or u.status not in('available','in_transit')
      or (select count(*) from public.inventory_movements m where m.reference_type='branch_transfer'
        and m.reference_id=t.id and m.unit_id=x.unit_id and m.movement_type='transfer_out')<>1)
  ) then
    raise exception 'Eski yo‘ldagi transfer birliklari yoki chiqim harakati noto‘g‘ri';
  end if;
end $$;

drop trigger if exists transfer_lines_immutable on public.transfer_lines;
drop trigger if exists transfers_immutable_fields on public.transfers;

update public.transfer_lines x
set unit_price=round(coalesce(b.wholesale_price,p.wholesale_price)/t.wholesale_exchange_rate,2)
from public.transfers t,public.inventory_units u
join public.products p on p.id=u.product_id
left join public.stock_batches b on b.id=u.batch_id
where t.id=x.transfer_id and t.status in('requested','approved','in_transit')
  and u.id=x.unit_id and p.id=x.product_id;

with normalized as(
  select t.id,sum(x.line_amount)::numeric(18,2) total_amount,
    jsonb_agg(jsonb_build_object('unit_id',x.unit_id::text,'unit_price',x.unit_price) order by x.unit_id) lines
  from public.transfers t
  join public.transfer_lines x on x.transfer_id=t.id
  where t.status in('requested','approved','in_transit')
  group by t.id
)
update public.transfers t
set currency='USD',total_amount=n.total_amount,
  request_hash=encode(extensions.digest(convert_to(jsonb_build_object(
    'from_location_id',t.from_location_id::text,'to_location_id',t.to_location_id::text,
    'currency','USD','notes',t.notes,'lines',n.lines)::text,'UTF8'),'sha256'),'hex')
from normalized n where n.id=t.id;

do $$ begin
  if not exists(select 1 from pg_constraint where conname='transfers_unsettled_wholesale_rate_snapshot_chk') then
    alter table public.transfers add constraint transfers_unsettled_wholesale_rate_snapshot_chk check(
      status not in('requested','approved','in_transit')
      or (wholesale_exchange_rate is not null and wholesale_rate_date is not null));
  end if;
end $$;

-- Legacy ship-time movements are retained, but converted to the new accounting representation.
drop trigger if exists inventory_movements_immutable on public.inventory_movements;
update public.inventory_movements m
set unit_cost=coalesce(b.unit_cost,p.cost_price),
  metadata=m.metadata||jsonb_build_object('wholesale_amount_usd',x.unit_price,
    'wholesale_amount_uzs',coalesce(b.wholesale_price,p.wholesale_price),'wholesale_currency','USD',
    'wholesale_exchange_rate',t.wholesale_exchange_rate,'wholesale_rate_date',t.wholesale_rate_date,
    'recognized_at_receipt',true)
from public.transfers t
join public.transfer_lines x on x.transfer_id=t.id
join public.inventory_units u on u.id=x.unit_id
join public.products p on p.id=u.product_id
left join public.stock_batches b on b.id=u.batch_id
where t.status='in_transit' and m.reference_type='branch_transfer' and m.reference_id=t.id
  and m.unit_id=x.unit_id and m.movement_type='transfer_out';
create trigger inventory_movements_immutable before update or delete on public.inventory_movements
for each row execute function public.reject_mutation();

update public.inventory_units u
set location_id=t.from_location_id,status='available',active_transfer_id=t.id,reserved_until=null,version=u.version+1
from public.transfer_lines x
join public.transfers t on t.id=x.transfer_id and t.status='in_transit'
where u.id=x.unit_id;

create or replace function public.guard_transfer_wholesale_snapshot()
returns trigger language plpgsql set search_path='' as $$
begin
  if old.wholesale_exchange_rate is distinct from new.wholesale_exchange_rate
    or old.wholesale_rate_date is distinct from new.wholesale_rate_date then
    raise exception 'Transfer ulgurji kursi snapshotini o‘zgartirib bo‘lmaydi' using errcode='55000';
  end if;
  return new;
end $$;

create trigger transfers_immutable_fields before update on public.transfers
for each row execute function public.guard_branch_transfer_data();
drop trigger if exists transfers_wholesale_snapshot_immutable on public.transfers;
create trigger transfers_wholesale_snapshot_immutable before update on public.transfers
for each row execute function public.guard_transfer_wholesale_snapshot();
create trigger transfer_lines_immutable before update or delete on public.transfer_lines
for each row execute function public.guard_branch_transfer_data();

-- Transfer qiymati mijoz yuborgan ixtiyoriy qiymat emas, birlikning USD canonical ulgurji narxidir.
create or replace function public.enforce_transfer_wholesale_price()
returns trigger language plpgsql set search_path='' as $$
declare v_wholesale_uzs numeric; v_wholesale_usd numeric(18,2); v_currency char(3);
  v_rate numeric; v_rate_date date;
begin
  select coalesce(b.wholesale_price,p.wholesale_price),t.currency,t.wholesale_exchange_rate,t.wholesale_rate_date
  into v_wholesale_uzs,v_currency,v_rate,v_rate_date
  from public.inventory_units u
  join public.products p on p.id=u.product_id
  left join public.stock_batches b on b.id=u.batch_id
  join public.transfers t on t.id=new.transfer_id
  where u.id=new.unit_id and p.id=new.product_id;
  if v_currency is distinct from 'USD'::char(3) then
    raise exception 'Transfer valyutasi USD bo‘lishi kerak' using errcode='22023';
  end if;
  if v_rate is null or v_rate<=0 or v_rate_date is null then
    raise exception 'Transfer uchun USD→UZS kursi snapshoti noto‘g‘ri' using errcode='22023';
  end if;
  if v_wholesale_uzs is null or v_wholesale_uzs<=0 then
    raise exception 'Mahsulot uchun musbat UZS ulgurji narx belgilanmagan' using errcode='22023';
  end if;
  v_wholesale_usd=round(v_wholesale_uzs/v_rate,2);
  if v_wholesale_usd<=0 then
    raise exception 'Mahsulotning USD ulgurji narxi musbat bo‘lishi kerak' using errcode='22023';
  end if;
  if new.unit_price is distinct from v_wholesale_usd then
    raise exception 'Transfer narxi snapshotted kursdagi canonical USD narxga teng bo‘lishi kerak: %',v_wholesale_usd using errcode='22023';
  end if;
  return new;
end $$;

drop trigger if exists transfer_lines_wholesale_price on public.transfer_lines;
create trigger transfer_lines_wholesale_price before insert on public.transfer_lines
for each row execute function public.enforce_transfer_wholesale_price();

create or replace function public.find_transfer_unit(p_branch_id uuid,p_from_location_id uuid,p_code text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb; v_rate numeric; v_rate_date date;
begin
  perform public.require_source_shipper(p_branch_id);
  if not exists(select 1 from public.locations where id=p_from_location_id and branch_id=p_branch_id and is_active and type in('store','warehouse')) then
    raise exception 'Faol jo‘natish joyi topilmadi' using errcode='P0002';
  end if;
  if nullif(btrim(p_code),'') is null then raise exception 'QR yoki seriya raqami talab qilinadi' using errcode='22023'; end if;
  select r.rate,r.rate_date into v_rate,v_rate_date from public.exchange_rates r
  where r.currency_from='USD' and r.currency_to='UZS' order by r.rate_date desc limit 1;
  if v_rate is null or v_rate<=0 or v_rate_date is null then
    raise exception 'USD→UZS ulgurji kursi topilmadi' using errcode='P0002';
  end if;
  select jsonb_build_object('id',u.id,'qr_code',u.qr_code,'serial_number',u.serial_number,'location_id',u.location_id,
    'product_id',p.id,'product_name',p.name,'sku',p.sku,'cost_price',coalesce(b.unit_cost,p.cost_price),
    'wholesale_price',round(coalesce(b.wholesale_price,p.wholesale_price)/v_rate,2),'currency','USD',
    'wholesale_exchange_rate',v_rate,'wholesale_rate_date',v_rate_date,
    'image',(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1))
  into v_result from public.inventory_units u join public.products p on p.id=u.product_id
    left join public.stock_batches b on b.id=u.batch_id
  where u.location_id=p_from_location_id and u.status='available' and u.active_transfer_id is null
    and (upper(u.qr_code)=upper(btrim(p_code)) or upper(coalesce(u.serial_number,''))=upper(btrim(p_code))) limit 1;
  if v_result is null then raise exception 'Erkin mahsulot birligi topilmadi' using errcode='P0002'; end if;
  if nullif(v_result->>'wholesale_price','') is null or (v_result->>'wholesale_price')::numeric<=0 then
    raise exception 'Mahsulot uchun musbat USD ulgurji narx belgilanmagan' using errcode='22023';
  end if;
  return v_result;
end $$;

create or replace function public.search_transfer_units(p_branch_id uuid,p_from_location_id uuid,p_query text,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_query text:=nullif(btrim(p_query),''); v_rate numeric; v_rate_date date;
begin
  perform public.require_source_shipper(p_branch_id);
  if not exists(select 1 from public.locations where id=p_from_location_id and branch_id=p_branch_id and is_active and type in('store','warehouse')) then
    raise exception 'Faol jo‘natish joyi topilmadi' using errcode='P0002';
  end if;
  if v_query is null or length(v_query)<2 then raise exception 'Qidiruv kamida 2 belgidan iborat bo‘lsin' using errcode='22023'; end if;
  if p_limit is null or p_limit not between 1 and 50 then raise exception 'Natijalar limiti noto‘g‘ri' using errcode='22023'; end if;
  select r.rate,r.rate_date into v_rate,v_rate_date from public.exchange_rates r
  where r.currency_from='USD' and r.currency_to='UZS' order by r.rate_date desc limit 1;
  if v_rate is null or v_rate<=0 or v_rate_date is null then
    raise exception 'USD→UZS ulgurji kursi topilmadi' using errcode='P0002';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(q) order by q.product_name,q.qr_code) from(
    select u.id,u.qr_code,u.serial_number,u.location_id,p.id product_id,p.name product_name,p.sku,
      coalesce(b.unit_cost,p.cost_price) cost_price,
      round(coalesce(b.wholesale_price,p.wholesale_price)/v_rate,2) wholesale_price,'USD'::text currency,
      v_rate wholesale_exchange_rate,v_rate_date wholesale_rate_date,
      (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1) image
    from public.inventory_units u join public.products p on p.id=u.product_id
    left join public.stock_batches b on b.id=u.batch_id
    where u.location_id=p_from_location_id and u.status='available' and u.active_transfer_id is null
      and round(coalesce(b.wholesale_price,p.wholesale_price)/v_rate,2)>0
      and (u.qr_code ilike '%'||v_query||'%' or coalesce(u.serial_number,'') ilike '%'||v_query||'%'
        or p.name ilike '%'||v_query||'%' or p.sku ilike '%'||v_query||'%')
    limit p_limit
  )q),'[]'::jsonb);
end $$;

create or replace function public.get_branch_transfer(p_transfer_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_t public.transfers%rowtype; v_result jsonb; v_can_settlement boolean;
begin
  select * into v_t from public.transfers where id=p_transfer_id;
  if not found then raise exception 'Transfer topilmadi' using errcode='P0002'; end if;
  perform public.require_transfer_access(v_t.from_branch_id,v_t.to_branch_id);
  v_can_settlement=public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager','accountant']::public.app_role[],v_t.from_branch_id)
    or public.has_role(array['manager','accountant']::public.app_role[],v_t.to_branch_id);
  select to_jsonb(t)||jsonb_build_object('from_branch_name',fb.name,'to_branch_name',tb.name,
    'from_location_name',fl.name,'to_location_name',tl.name,
    'can_approve',t.status='requested' and (public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager']::public.app_role[],t.from_branch_id)),
    'can_ship',t.status='approved' and (public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager','warehouse']::public.app_role[],t.from_branch_id)),
    'can_receive',t.status='in_transit' and (public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager','warehouse']::public.app_role[],t.to_branch_id)),
    'can_record_payment',v_can_settlement and t.status<>'cancelled'
      and coalesce((select sum(dp.amount) from public.debt_payments dp where dp.transfer_id=t.id),0)<t.total_amount
      and (public.has_role(array['superadmin','admin']::public.app_role[],null)
        or public.has_role(array['manager','accountant']::public.app_role[],t.from_branch_id)),
    'paid_amount',case when v_can_settlement then
      coalesce((select sum(dp.amount) from public.debt_payments dp where dp.transfer_id=t.id),0) else null end,
    'remaining_amount',case when v_can_settlement then
      t.total_amount-coalesce((select sum(dp.amount) from public.debt_payments dp where dp.transfer_id=t.id),0) else null end,
    'debt',case when v_can_settlement then (select jsonb_build_object('id',d.id,'status',d.status,'amount',d.amount,
      'paid_amount',d.paid_amount,'remaining_amount',d.remaining_amount,'created_at',d.created_at)
      from public.branch_debts d where d.transfer_id=t.id) else null end,
    'payments',case when v_can_settlement then coalesce((select jsonb_agg(jsonb_build_object(
      'id',dp.id,'amount',dp.amount,'currency',dp.currency,'paid_at',dp.paid_at,'method',dp.method,
      'reference',dp.reference,'notes',dp.notes) order by dp.paid_at desc,dp.id)
      from public.debt_payments dp where dp.transfer_id=t.id),'[]'::jsonb) else '[]'::jsonb end,
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

create or replace function public.record_branch_transfer_payment(p_transfer_id uuid,p_amount numeric,p_currency char(3),
  p_paid_at timestamptz,p_method text,p_reference text,p_notes text,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_t public.transfers%rowtype; v_d public.branch_debts%rowtype; v_p public.debt_payments%rowtype;
  v_paid numeric(18,2); v_when timestamptz;
begin
  if p_idempotency_key is null then raise exception 'Takroriy so‘rov kaliti talab qilinadi' using errcode='22023'; end if;
  select * into v_t from public.transfers where id=p_transfer_id for update;
  if not found then raise exception 'Transfer topilmadi' using errcode='P0002'; end if;
  perform public.require_creditor_payment_operator(v_t.from_branch_id);
  select * into v_p from public.debt_payments where transfer_id=p_transfer_id and idempotency_key=p_idempotency_key;
  v_when=coalesce(p_paid_at,case when found then v_p.paid_at else now() end);
  if found then
    if v_p.amount is distinct from p_amount or v_p.currency is distinct from upper(p_currency::text)::char(3)
      or v_p.paid_at is distinct from v_when or v_p.method is distinct from btrim(p_method)
      or v_p.reference is distinct from nullif(btrim(p_reference),'')
      or v_p.notes is distinct from nullif(btrim(p_notes),'') then
      raise exception 'Takroriy kalit boshqa to‘lov mazmuni bilan yuborildi' using errcode='22023'; end if;
    return public.get_branch_transfer(p_transfer_id);
  end if;
  if v_t.status='cancelled' then raise exception 'Bekor qilingan transferga to‘lov kiritib bo‘lmaydi' using errcode='P0001'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'To‘lov summasi musbat bo‘lishi kerak' using errcode='22023'; end if;
  if upper(p_currency::text)::char(3)<>v_t.currency then raise exception 'To‘lov valyutasi transfer valyutasiga mos emas' using errcode='22023'; end if;
  if v_when>now()+interval '5 minutes' then raise exception 'To‘lov sanasi kelajakda bo‘lishi mumkin emas' using errcode='22023'; end if;
  if nullif(btrim(p_method),'') is null or length(btrim(p_method)) not between 2 and 64 then raise exception 'To‘lov usuli noto‘g‘ri' using errcode='22023'; end if;
  select coalesce(sum(amount),0) into v_paid from public.debt_payments where transfer_id=p_transfer_id;
  if p_amount>v_t.total_amount-v_paid then raise exception 'To‘lov qoldiq summadan oshmasligi kerak' using errcode='22023'; end if;
  select * into v_d from public.branch_debts where transfer_id=p_transfer_id for update;
  if found and v_d.status='void' then raise exception 'Bekor qilingan qarzga to‘lov kiritib bo‘lmaydi' using errcode='P0001'; end if;
  insert into public.debt_payments(debt_id,transfer_id,amount,currency,paid_at,method,reference,notes,idempotency_key,created_by)
  values(case when v_d.id is null then null else v_d.id end,p_transfer_id,p_amount,upper(p_currency::text)::char(3),v_when,
    btrim(p_method),nullif(btrim(p_reference),''),nullif(btrim(p_notes),''),p_idempotency_key,auth.uid());
  if v_d.id is not null then
    v_paid=v_paid+p_amount;
    update public.branch_debts set paid_amount=v_paid,status=case when v_paid=amount then 'paid'::public.debt_status
      when v_paid>0 then 'partially_paid'::public.debt_status else 'open'::public.debt_status end where id=v_d.id;
  end if;
  return public.get_branch_transfer(p_transfer_id);
end $$;

-- Eski create RPCni ichkarida chaqiradi: transfer va boshlang‘ich to‘lov bitta DB tranzaksiyasida.
create or replace function public.create_branch_transfer_with_payment(p_header jsonb,p_lines jsonb,p_initial_payment jsonb,
  p_transfer_idempotency_key uuid,p_payment_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_transfer jsonb; v_amount numeric; v_paid_at timestamptz; v_method text;
begin
  if jsonb_typeof(p_header)<>'object' then
    raise exception 'Transfer sarlavhasi noto‘g‘ri' using errcode='22023';
  end if;
  if p_header ? 'currency' and upper(coalesce(nullif(btrim(p_header->>'currency'),''),'USD'))<>'USD' then
    raise exception 'Transfer valyutasi USD bo‘lishi kerak' using errcode='22023';
  end if;
  if p_initial_payment is not null then
    if jsonb_typeof(p_initial_payment)<>'object'
      or not(p_initial_payment ? 'amount') or jsonb_typeof(p_initial_payment->'amount') not in('number','string')
      or not(p_initial_payment ? 'method') or jsonb_typeof(p_initial_payment->'method')<>'string'
      or (p_initial_payment ? 'paid_at' and jsonb_typeof(p_initial_payment->'paid_at') not in('string','null'))
      or (p_initial_payment ? 'reference' and jsonb_typeof(p_initial_payment->'reference') not in('string','null'))
      or (p_initial_payment ? 'notes' and jsonb_typeof(p_initial_payment->'notes') not in('string','null')) then
      raise exception 'Boshlang‘ich to‘lov obyekti noto‘g‘ri' using errcode='22023';
    end if;
    begin
      v_amount=nullif(btrim(p_initial_payment->>'amount'),'')::numeric;
      v_paid_at=nullif(btrim(p_initial_payment->>'paid_at'),'')::timestamptz;
    exception when invalid_text_representation or invalid_datetime_format or numeric_value_out_of_range then
      raise exception 'Boshlang‘ich to‘lov summasi yoki sanasi noto‘g‘ri' using errcode='22023';
    end;
    v_method=nullif(btrim(p_initial_payment->>'method'),'');
    if v_amount is null or v_amount<=0 then
      raise exception 'Boshlang‘ich to‘lov summasi musbat bo‘lishi kerak' using errcode='22023';
    end if;
    if v_method is null or length(v_method) not between 2 and 64 then
      raise exception 'Boshlang‘ich to‘lov usuli noto‘g‘ri' using errcode='22023';
    end if;
    if p_payment_idempotency_key is null then
      raise exception 'Boshlang‘ich to‘lov kaliti talab qilinadi' using errcode='22023';
    end if;
  end if;
  v_transfer=public.create_branch_transfer(p_header||jsonb_build_object('currency','USD'),p_lines,p_transfer_idempotency_key);
  if p_initial_payment is not null then
    v_transfer=public.record_branch_transfer_payment((v_transfer->>'id')::uuid,v_amount,'USD'::char(3),
      v_paid_at,v_method,p_initial_payment->>'reference',p_initial_payment->>'notes',p_payment_idempotency_key);
  end if;
  return v_transfer;
end $$;

-- Jo‘natish faqat jarayon holatini o‘zgartiradi. Birlik eski filial balansida receiver tasdig‘igacha qoladi.
create or replace function public.ship_branch_transfer(p_transfer_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_t public.transfers%rowtype; v_line record; v_u public.inventory_units%rowtype;
begin
  select * into v_t from public.transfers where id=p_transfer_id for update;
  if not found then raise exception 'Transfer topilmadi' using errcode='P0002'; end if;
  perform public.require_source_shipper(v_t.from_branch_id);
  if v_t.status='in_transit' then return public.get_branch_transfer(p_transfer_id); end if;
  if v_t.status<>'approved' then raise exception 'Faqat tasdiqlangan transfer jo‘natiladi' using errcode='P0001'; end if;
  perform 1 from public.inventory_units u join public.transfer_lines x on x.unit_id=u.id
    where x.transfer_id=p_transfer_id order by u.id for update of u;
  for v_line in select * from public.transfer_lines where transfer_id=p_transfer_id order by unit_id loop
    select * into v_u from public.inventory_units where id=v_line.unit_id;
    if v_u.active_transfer_id is distinct from p_transfer_id or v_u.location_id<>v_t.from_location_id or v_u.status<>'available' then
      raise exception 'Mahsulot jo‘natishga tayyor emas: %',v_line.unit_id using errcode='P0001'; end if;
  end loop;
  update public.transfers set status='in_transit',shipped_by=auth.uid(),shipped_at=now() where id=p_transfer_id;
  return public.get_branch_transfer(p_transfer_id);
end $$;

-- Qabul qiluvchi tasdig‘i: transfer_out + location move + transfer_in + debt settlement atomik bajariladi.
create or replace function public.receive_branch_transfer(p_transfer_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_t public.transfers%rowtype; v_line record; v_u public.inventory_units%rowtype;
  v_debt_id uuid; v_paid numeric(18,2); v_unit_cost numeric(18,2); v_wholesale_uzs numeric; v_out_count integer;
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
    if v_u.active_transfer_id is distinct from p_transfer_id or v_u.location_id<>v_t.from_location_id
      or v_u.status<>'available' then
      raise exception 'Transfer mahsuloti holati buzilgan: %',v_line.unit_id using errcode='P0001'; end if;
    select coalesce(b.unit_cost,p.cost_price),coalesce(b.wholesale_price,p.wholesale_price)
    into v_unit_cost,v_wholesale_uzs
    from public.products p left join public.stock_batches b on b.id=v_u.batch_id where p.id=v_u.product_id;
    select count(*) into v_out_count from public.inventory_movements where reference_type='branch_transfer'
      and reference_id=p_transfer_id and unit_id=v_u.id and movement_type='transfer_out';
    if v_out_count=0 then
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,
        quantity,unit_cost,reference_type,reference_id,actor_id,metadata)
      values(v_u.id,v_u.product_id,v_u.batch_id,'transfer_out',v_t.from_location_id,v_t.to_location_id,1,v_unit_cost,
        'branch_transfer',p_transfer_id,auth.uid(),jsonb_build_object('wholesale_amount_usd',v_line.unit_price,
          'wholesale_amount_uzs',v_wholesale_uzs,
          'wholesale_currency','USD','wholesale_exchange_rate',v_t.wholesale_exchange_rate,
          'wholesale_rate_date',v_t.wholesale_rate_date,'recognized_at_receipt',true));
    elsif v_out_count=1 then
      null; -- Legacy ship-time transfer_out is retained and must not be duplicated.
    else
      raise exception 'Mahsulot chiqim harakati noto‘g‘ri: %',v_u.id using errcode='P0001';
    end if;
    update public.inventory_units set location_id=v_t.to_location_id,status='available',active_transfer_id=null,
      reserved_until=null,version=version+1 where id=v_u.id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,
      quantity,unit_cost,reference_type,reference_id,actor_id,metadata)
    values(v_u.id,v_u.product_id,v_u.batch_id,'transfer_in',v_t.from_location_id,v_t.to_location_id,1,v_unit_cost,
      'branch_transfer',p_transfer_id,auth.uid(),jsonb_build_object('wholesale_amount_usd',v_line.unit_price,
        'wholesale_amount_uzs',v_wholesale_uzs,
        'wholesale_currency','USD','wholesale_exchange_rate',v_t.wholesale_exchange_rate,
        'wholesale_rate_date',v_t.wholesale_rate_date,'recognized_at_receipt',true));
  end loop;
  select coalesce(sum(amount),0) into v_paid from public.debt_payments where transfer_id=p_transfer_id;
  if v_paid>v_t.total_amount then raise exception 'Transfer to‘lovlari jami qiymatdan oshib ketgan' using errcode='P0001'; end if;
  if v_t.total_amount>0 then
    insert into public.branch_debts(debtor_branch_id,creditor_branch_id,transfer_id,amount,paid_amount,status,notes,currency)
    values(v_t.to_branch_id,v_t.from_branch_id,p_transfer_id,v_t.total_amount,v_paid,
      case when v_paid=0 then 'open'::public.debt_status when v_paid=v_t.total_amount then 'paid'::public.debt_status
        else 'partially_paid'::public.debt_status end,
      'Transfer '||v_t.transfer_no||' bo‘yicha ulgurji qarz',v_t.currency)
    on conflict(transfer_id) do update set paid_amount=excluded.paid_amount,status=excluded.status
    returning id into v_debt_id;
    update public.debt_payments set debt_id=v_debt_id where transfer_id=p_transfer_id and debt_id is null;
  end if;
  update public.transfers set status='received',received_by=auth.uid(),received_at=now() where id=p_transfer_id;
  return public.get_branch_transfer(p_transfer_id);
end $$;

create or replace function public.get_branch_debt(p_debt_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_d public.branch_debts%rowtype; v_result jsonb;
begin
  select * into v_d from public.branch_debts where id=p_debt_id;
  if not found then raise exception 'Filial qarzi topilmadi' using errcode='P0002'; end if;
  if not(public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager','accountant']::public.app_role[],v_d.debtor_branch_id)
    or public.has_role(array['manager','accountant']::public.app_role[],v_d.creditor_branch_id)) then
    raise exception 'Qarz uchun moliyaviy rol talab qilinadi' using errcode='42501';
  end if;
  select to_jsonb(d)||jsonb_build_object('debtor_branch_name',db.name,'creditor_branch_name',cb.name,'transfer_no',t.transfer_no,
    'transfer',jsonb_build_object('id',t.id,'requested_at',t.requested_at,'approved_at',t.approved_at,'shipped_at',t.shipped_at,
      'received_at',t.received_at,'from_location_name',fl.name,'to_location_name',tl.name,'notes',t.notes,
      'lines',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'unit_id',x.unit_id,'qr_code',u.qr_code,
        'serial_number',u.serial_number,'product_name',p.name,'sku',p.sku,'quantity',x.quantity,
        'unit_price',x.unit_price,'line_amount',x.line_amount,
        'image',(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1)) order by p.name,u.id)
        from public.transfer_lines x join public.inventory_units u on u.id=x.unit_id join public.products p on p.id=x.product_id
        where x.transfer_id=t.id),'[]'::jsonb)),
    'payments',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'amount',p.amount,'currency',p.currency,
      'paid_at',p.paid_at,'method',p.method,'reference',p.reference,'notes',p.notes) order by p.paid_at desc,p.id)
      from public.debt_payments p where p.transfer_id=t.id),'[]'::jsonb),
    'can_record_payment',d.status not in('paid','void') and (public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager','accountant']::public.app_role[],d.creditor_branch_id)))
  into v_result from public.branch_debts d join public.branches db on db.id=d.debtor_branch_id
    join public.branches cb on cb.id=d.creditor_branch_id join public.transfers t on t.id=d.transfer_id
    join public.locations fl on fl.id=t.from_location_id join public.locations tl on tl.id=t.to_location_id
    where d.id=p_debt_id;
  return v_result;
end $$;

create or replace function public.record_branch_debt_payment(p_debt_id uuid,p_amount numeric,p_currency char(3),
  p_method text,p_reference text,p_notes text,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_d public.branch_debts%rowtype; v_paid_at timestamptz;
begin
  select * into v_d from public.branch_debts where id=p_debt_id;
  if not found then raise exception 'Filial qarzi topilmadi' using errcode='P0002'; end if;
  perform 1 from public.transfers where id=v_d.transfer_id for update;
  select paid_at into v_paid_at from public.debt_payments
  where transfer_id=v_d.transfer_id and idempotency_key=p_idempotency_key;
  perform public.record_branch_transfer_payment(v_d.transfer_id,p_amount,p_currency,coalesce(v_paid_at,now()),
    p_method,p_reference,p_notes,p_idempotency_key);
  return public.get_branch_debt(p_debt_id);
end $$;

-- To‘lov jadvalining direct SELECT yo‘li ham faqat moliyaviy rollarga ochiq.
drop policy if exists debt_payments_staff_read on public.debt_payments;
create policy debt_payments_staff_read on public.debt_payments for select to authenticated using(exists(
  select 1 from public.transfers t where t.id=transfer_id and (
    public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager','accountant']::public.app_role[],t.from_branch_id)
    or public.has_role(array['manager','accountant']::public.app_role[],t.to_branch_id)
  )
));

revoke all on function public.guard_transfer_debt_payment(),public.snapshot_transfer_wholesale_rate(),
  public.guard_transfer_wholesale_snapshot(),public.enforce_transfer_wholesale_price() from public,anon,authenticated;
revoke all on function public.search_transfer_units(uuid,uuid,text,integer),
  public.create_branch_transfer_with_payment(jsonb,jsonb,jsonb,uuid,uuid),
  public.record_branch_transfer_payment(uuid,numeric,char(3),timestamptz,text,text,text,uuid) from public,anon;
grant execute on function public.search_transfer_units(uuid,uuid,text,integer),
  public.create_branch_transfer_with_payment(jsonb,jsonb,jsonb,uuid,uuid),
  public.record_branch_transfer_payment(uuid,numeric,char(3),timestamptz,text,text,text,uuid) to authenticated;
grant execute on function public.guard_transfer_debt_payment(),public.snapshot_transfer_wholesale_rate(),
  public.guard_transfer_wholesale_snapshot(),public.enforce_transfer_wholesale_price(),
  public.search_transfer_units(uuid,uuid,text,integer),public.create_branch_transfer_with_payment(jsonb,jsonb,jsonb,uuid,uuid),
  public.record_branch_transfer_payment(uuid,numeric,char(3),timestamptz,text,text,text,uuid) to service_role;

notify pgrst,'reload schema';
commit;
