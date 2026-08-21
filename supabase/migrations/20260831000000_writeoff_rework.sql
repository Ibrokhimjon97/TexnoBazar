-- Hisobdan chiqarish (writeoff) qayta qurilishi:
--  * QR/seriya skaneri va matnli qidiruv orqali birlik tanlash
--  * Sabab kodi (buzuq/yaroqsiz/yo'qolgan/...) + majburiy izoh
--  * Bir amalda hisobdan chiqarish: birlik status -> written_off
--  * Tannarx avtomatik ravishda finance_transactions ga "Hisobdan chiqqan tovarlar"
--    kategoriyasi bilan chiqim sifatida yoziladi (oylik xarajatga qo'shiladi)
--  * Sana/vaqt bilan to'liq tarix ro'yxati va kategoriya bo'yicha xarajat hisoboti
begin;

-- -----------------------------------------------------------------------------
-- Schema
-- -----------------------------------------------------------------------------

alter table public.writeoffs
  add column if not exists reason_code text,
  add column if not exists note text,
  add column if not exists total_cost numeric(18,2) not null default 0,
  add column if not exists finance_transaction_id uuid references public.finance_transactions(id) on delete restrict;

do $$
begin
  if not exists(select 1 from pg_constraint where conname='writeoffs_reason_code_check') then
    alter table public.writeoffs add constraint writeoffs_reason_code_check
      check (reason_code is null or reason_code in ('damaged','unusable','lost','expired','theft','other'));
  end if;
  if not exists(select 1 from pg_constraint where conname='writeoffs_total_cost_check') then
    alter table public.writeoffs add constraint writeoffs_total_cost_check check (total_cost >= 0);
  end if;
end $$;

create index if not exists writeoffs_posted_history_idx on public.writeoffs(location_id, posted_at desc) where status='posted';
create index if not exists writeoff_lines_unit_idx on public.writeoff_lines(unit_id);

-- Hisobdan chiqarilgan birliklar shu tizim joylashuviga ko'chiriladi.
insert into public.locations(code,name,type,branch_id,is_active)
values('SYSTEM-WRITEOFF','Hisobdan chiqarilgan fond','writeoff',null,true)
on conflict(code) do nothing;

-- -----------------------------------------------------------------------------
-- Yordamchi funksiyalar
-- -----------------------------------------------------------------------------

create or replace function public.writeoff_reason_label(p_code text)
returns text language sql immutable set search_path='' as $$
  select case btrim(coalesce(p_code,''))
    when 'damaged' then 'Buzuq / shikastlangan'
    when 'unusable' then 'Yaroqsiz holat'
    when 'lost' then 'Yo‘qolgan'
    when 'expired' then 'Muddati o‘tgan'
    when 'theft' then 'O‘g‘irlangan'
    when 'other' then 'Boshqa sabab'
    else null end
$$;

-- Filialning chiqim yoziladigan asosiy moliya hisobini qaytaradi; bo'lmasa yaratadi.
create or replace function public.ensure_branch_finance_account(p_branch_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_branch public.branches%rowtype; v_code text;
begin
  select * into v_branch from public.branches where id=p_branch_id and is_active;
  if not found then raise exception 'Faol filial topilmadi' using errcode='P0002'; end if;
  select id into v_id from public.finance_accounts where branch_id=p_branch_id and is_active order by created_at, code limit 1;
  if v_id is not null then return v_id; end if;
  v_code=upper(v_branch.code)||'-MAIN';
  begin
    insert into public.finance_accounts(branch_id,code,name,currency,is_active)
    values(p_branch_id,v_code,v_branch.name||' asosiy hisob',v_branch.currency,true)
    returning id into v_id;
  exception when unique_violation then
    select id into v_id from public.finance_accounts where code=v_code and branch_id=p_branch_id;
    if v_id is null then
      raise exception 'Filial uchun moliya hisobi topilmadi. Moliya bo‘limida hisob yarating.' using errcode='P0002';
    end if;
    update public.finance_accounts set is_active=true where id=v_id;
  end;
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- Birlik izlash: QR / seriya aniq mos kelishi
-- -----------------------------------------------------------------------------

create or replace function public.find_writeoff_unit(p_branch_id uuid,p_code text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if p_branch_id is null then raise exception 'Filial talab qilinadi' using errcode='22023'; end if;
  perform public.require_inventory_operator(p_branch_id);
  if nullif(btrim(p_code),'') is null then raise exception 'QR yoki seriya raqami talab qilinadi' using errcode='22023'; end if;
  select jsonb_build_object('id',u.id,'qr_code',u.qr_code,'serial_number',u.serial_number,'status',u.status,
    'location_id',u.location_id,'location_name',l.name,'product_id',p.id,'product_name',p.name,'sku',p.sku,
    'cost_price',coalesce(b.unit_cost,p.cost_price),'retail_price',p.retail_price,
    'image',(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1))
  into v_result
  from public.inventory_units u
    join public.products p on p.id=u.product_id
    join public.locations l on l.id=u.location_id
    left join public.stock_batches b on b.id=u.batch_id
  where l.branch_id=p_branch_id and l.is_active and l.type in('store','warehouse')
    and u.status in('available','returned') and u.active_transfer_id is null
    and (upper(u.qr_code)=upper(btrim(p_code)) or upper(coalesce(u.serial_number,''))=upper(btrim(p_code)))
  limit 1;
  if v_result is null then
    raise exception 'Bu filialda hisobdan chiqarish uchun erkin birlik topilmadi' using errcode='P0002';
  end if;
  return v_result;
end $$;

-- Nomi/SKU/QR bo'yicha erkin birliklarni qidirish (skaner bo'lmasa qo'lda tanlash uchun).
create or replace function public.search_writeoff_units(p_branch_id uuid,p_query text default null,p_location_id uuid default null,p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb; v_q text;
begin
  if p_branch_id is null then raise exception 'Filial talab qilinadi' using errcode='22023'; end if;
  perform public.require_inventory_operator(p_branch_id);
  if p_limit not between 1 and 100 then raise exception 'Limit 1..100 bo‘lishi kerak' using errcode='22023'; end if;
  v_q=nullif(btrim(coalesce(p_query,'')),'');
  select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'qr_code',q.qr_code,'serial_number',q.serial_number,'status',q.status,
    'location_id',q.location_id,'location_name',q.location_name,'product_id',q.product_id,'product_name',q.product_name,
    'sku',q.sku,'cost_price',q.cost_price,'retail_price',q.retail_price,'image',q.image) order by q.product_name,q.qr_code),'[]'::jsonb)
  into v_items
  from (
    select u.id,u.qr_code,u.serial_number,u.status,u.location_id,l.name location_name,p.id product_id,p.name product_name,
      p.sku,coalesce(b.unit_cost,p.cost_price) cost_price,p.retail_price,
      (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1) image
    from public.inventory_units u
      join public.products p on p.id=u.product_id
      join public.locations l on l.id=u.location_id
      left join public.stock_batches b on b.id=u.batch_id
    where l.branch_id=p_branch_id and l.is_active and l.type in('store','warehouse')
      and u.status in('available','returned') and u.active_transfer_id is null
      and (p_location_id is null or u.location_id=p_location_id)
      and (v_q is null or p.name ilike '%'||v_q||'%' or p.sku ilike '%'||v_q||'%'
        or u.qr_code ilike '%'||v_q||'%' or coalesce(u.serial_number,'') ilike '%'||v_q||'%')
    order by p.name,u.qr_code
    limit p_limit
  ) q;
  return jsonb_build_object('items',v_items);
end $$;

-- -----------------------------------------------------------------------------
-- Bir amalda hisobdan chiqarish + moliya chiqimi
-- -----------------------------------------------------------------------------

create or replace function public.execute_writeoff(
  p_branch_id uuid,
  p_unit_ids uuid[],
  p_reason_code text,
  p_note text,
  p_account_id uuid default null,
  p_idempotency_key uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_key uuid:=coalesce(p_idempotency_key,gen_random_uuid());
  v_id uuid:=gen_random_uuid();
  v_no text; v_hash text; v_existing public.writeoffs%rowtype;
  v_label text; v_note text; v_reason text;
  v_location uuid; v_location_count integer; v_unit_count integer; v_dest uuid;
  v_account uuid; v_tx uuid; v_total numeric(18,2):=0;
  v_posted timestamptz:=now(); v_u record;
begin
  if p_branch_id is null then raise exception 'Filial talab qilinadi' using errcode='22023'; end if;
  -- Hujjat tovar harakatini ham, moliya chiqimini ham yozadi.
  perform public.require_inventory_operator(p_branch_id);
  perform public.require_finance_operator(p_branch_id);

  v_label=public.writeoff_reason_label(p_reason_code);
  if v_label is null then raise exception 'Hisobdan chiqarish sababi noto‘g‘ri' using errcode='22023'; end if;
  v_note=nullif(btrim(coalesce(p_note,'')),'');
  if v_note is null or length(v_note)<3 then
    raise exception 'Izoh kamida 3 belgidan iborat bo‘lishi kerak' using errcode='22023';
  end if;
  if length(v_note)>2000 then raise exception 'Izoh 2000 belgidan oshmasligi kerak' using errcode='22023'; end if;
  if coalesce(array_length(p_unit_ids,1),0) not between 1 and 200 then
    raise exception 'Kamida bitta, ko‘pi bilan 200 birlik tanlanadi' using errcode='22023';
  end if;
  if (select count(*) from unnest(p_unit_ids) x)<>(select count(distinct x) from unnest(p_unit_ids) x) then
    raise exception 'Birliklar takrorlanmasligi kerak' using errcode='22023';
  end if;
  v_reason=v_label||': '||v_note;

  -- Takroriy yuborishda mavjud hujjat qaytariladi.
  select w.* into v_existing from public.writeoffs w
    join public.locations l on l.id=w.location_id
    where l.branch_id=p_branch_id and w.idempotency_key=v_key limit 1;
  if found then
    return to_jsonb(v_existing)||jsonb_build_object('reason_label',public.writeoff_reason_label(v_existing.reason_code),'replayed',true);
  end if;

  perform 1 from public.inventory_units where id=any(p_unit_ids) order by id for update;
  select count(*) into v_unit_count from public.inventory_units where id=any(p_unit_ids);
  select count(*) into v_location_count
    from (select distinct location_id from public.inventory_units where id=any(p_unit_ids)) s;
  select location_id into v_location from public.inventory_units where id=any(p_unit_ids) order by id limit 1;
  if v_unit_count<>cardinality(p_unit_ids) then
    raise exception 'Tanlangan birliklardan biri topilmadi' using errcode='P0002';
  end if;
  if v_location_count>1 then
    raise exception 'Barcha birliklar bitta joylashuvda bo‘lishi kerak' using errcode='22023';
  end if;
  if not exists(select 1 from public.locations where id=v_location and branch_id=p_branch_id and is_active and type in('store','warehouse')) then
    raise exception 'Birliklar bu filialning faol joylashuvida emas' using errcode='P0001';
  end if;

  select id into v_dest from public.locations where code='SYSTEM-WRITEOFF' for share;
  if v_dest is null then raise exception 'SYSTEM-WRITEOFF joylashuvi topilmadi' using errcode='P0002'; end if;

  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('branch_id',p_branch_id,'location_id',v_location,
    'reason_code',btrim(p_reason_code),'note',v_note,
    'units',(select jsonb_agg(x order by x) from unnest(p_unit_ids) x))::text,'UTF8'),'sha256'),'hex');
  v_no='WO-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8));

  insert into public.writeoffs(id,writeoff_no,location_id,status,reason,reason_code,note,created_by,approved_by,
    posted_at,idempotency_key,request_hash,total_cost)
  values(v_id,v_no,v_location,'posted',v_reason,btrim(p_reason_code),v_note,auth.uid(),auth.uid(),
    v_posted,v_key,v_hash,0);

  for v_u in
    select u.id,u.product_id,u.batch_id,u.status,u.location_id,u.active_transfer_id,
      coalesce(b.unit_cost,p.cost_price) unit_cost
    from public.inventory_units u
      join public.products p on p.id=u.product_id
      left join public.stock_batches b on b.id=u.batch_id
    where u.id=any(p_unit_ids) order by u.id
  loop
    if v_u.location_id<>v_location or v_u.status not in('available','returned') or v_u.active_transfer_id is not null then
      raise exception 'Birlik hisobdan chiqarish uchun erkin emas: %',v_u.id using errcode='P0001';
    end if;
    insert into public.writeoff_lines(writeoff_id,product_id,unit_id,quantity,unit_cost)
    values(v_id,v_u.product_id,v_u.id,1,v_u.unit_cost);
    update public.inventory_units
      set location_id=v_dest,status='written_off',reserved_until=null,sold_sale_id=null,version=version+1
      where id=v_u.id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,
      quantity,unit_cost,reference_type,reference_id,reason,actor_id)
    values(v_u.id,v_u.product_id,v_u.batch_id,'writeoff',v_location,v_dest,1,v_u.unit_cost,'writeoff',v_id,v_reason,auth.uid())
    on conflict do nothing;
    v_total=v_total+coalesce(v_u.unit_cost,0);
  end loop;

  -- Tannarx do'kon xarajatlariga "Hisobdan chiqqan tovarlar" kategoriyasi bilan tushadi.
  if v_total>0 then
    v_account=coalesce(p_account_id,public.ensure_branch_finance_account(p_branch_id));
    if not exists(select 1 from public.finance_accounts where id=v_account and is_active
      and branch_id is not distinct from p_branch_id) then
      raise exception 'Filialning faol moliya hisobi topilmadi' using errcode='P0002';
    end if;
    v_tx=public.post_finance_transaction(v_account,'expense','Hisobdan chiqqan tovarlar',v_total,v_posted,
      v_no||' · '||v_label||' · '||v_note,'writeoff',v_id,v_key);
  end if;

  update public.writeoffs set total_cost=v_total,finance_transaction_id=v_tx where id=v_id;
  select * into v_existing from public.writeoffs where id=v_id;

  return to_jsonb(v_existing)||jsonb_build_object(
    'reason_label',v_label,
    'unit_count',v_unit_count,
    'finance_account_id',v_account,
    'replayed',false);
end $$;

-- -----------------------------------------------------------------------------
-- Tarix: sana/vaqt, tovar, QR, sabab, tannarx
-- -----------------------------------------------------------------------------

create or replace function public.list_writeoff_history(
  p_branch_id uuid,
  p_from date default null,
  p_to date default null,
  p_reason_code text default null,
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb; v_q text; v_month_start date;
begin
  if p_branch_id is null then raise exception 'Filial talab qilinadi' using errcode='22023'; end if;
  if not public.can_access_branch(p_branch_id) then raise exception 'Ruxsat yo‘q' using errcode='42501'; end if;
  if p_limit not between 1 and 200 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  if p_from is not null and p_to is not null and p_to<p_from then
    raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023';
  end if;
  v_q=nullif(btrim(coalesce(p_query,'')),'');
  v_month_start=date_trunc('month',(now() at time zone 'Asia/Tashkent'))::date;

  with lines as (
    select w.id writeoff_id,w.writeoff_no,w.status,w.reason,w.reason_code,w.note,
      coalesce(w.posted_at,w.created_at) occurred_at,w.total_cost,w.finance_transaction_id,
      l.name location_name,pr.full_name actor_name,
      x.id line_id,x.unit_id,x.quantity,x.unit_cost,
      (x.unit_cost*x.quantity) line_cost,
      p.id product_id,p.name product_name,p.sku,
      u.qr_code,u.serial_number
    from public.writeoff_lines x
      join public.writeoffs w on w.id=x.writeoff_id
      join public.locations l on l.id=w.location_id
      join public.products p on p.id=x.product_id
      left join public.inventory_units u on u.id=x.unit_id
      left join public.profiles pr on pr.id=w.created_by
    where l.branch_id=p_branch_id and w.status='posted'
      and (p_from is null or coalesce(w.posted_at,w.created_at)>=public.business_day_start(p_from))
      and (p_to is null or coalesce(w.posted_at,w.created_at)<public.business_day_start(p_to+1))
      and (nullif(btrim(coalesce(p_reason_code,'')),'') is null or w.reason_code=btrim(p_reason_code))
      and (v_q is null or p.name ilike '%'||v_q||'%' or p.sku ilike '%'||v_q||'%'
        or coalesce(u.qr_code,'') ilike '%'||v_q||'%' or coalesce(u.serial_number,'') ilike '%'||v_q||'%'
        or w.writeoff_no ilike '%'||v_q||'%' or coalesce(w.note,'') ilike '%'||v_q||'%')
  ), month_lines as (
    select (x.unit_cost*x.quantity) line_cost
    from public.writeoff_lines x
      join public.writeoffs w on w.id=x.writeoff_id
      join public.locations l on l.id=w.location_id
    where l.branch_id=p_branch_id and w.status='posted'
      and coalesce(w.posted_at,w.created_at)>=public.business_day_start(v_month_start)
  )
  select jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
        'line_id',t.line_id,'writeoff_id',t.writeoff_id,'writeoff_no',t.writeoff_no,
        'occurred_at',t.occurred_at,'location_name',t.location_name,'actor_name',t.actor_name,
        'product_id',t.product_id,'product_name',t.product_name,'sku',t.sku,
        'unit_id',t.unit_id,'qr_code',t.qr_code,'serial_number',t.serial_number,
        'quantity',t.quantity,'unit_cost',t.unit_cost,'line_cost',t.line_cost,
        'reason_code',t.reason_code,'reason_label',public.writeoff_reason_label(t.reason_code),
        'reason',t.reason,'note',t.note,'finance_transaction_id',t.finance_transaction_id)
      order by t.occurred_at desc,t.line_id)
      from (select * from lines order by occurred_at desc,line_id limit p_limit offset p_offset) t),'[]'::jsonb),
    'total',(select count(*) from lines),
    'total_cost',(select coalesce(sum(line_cost),0) from lines),
    'document_count',(select count(distinct writeoff_id) from lines),
    'month_cost',(select coalesce(sum(line_cost),0) from month_lines),
    'month_units',(select count(*) from month_lines),
    'month_start',v_month_start,
    'by_reason',coalesce((select jsonb_agg(jsonb_build_object('reason_code',g.reason_code,
        'label',public.writeoff_reason_label(g.reason_code),'units',g.units,'cost',g.cost) order by g.cost desc)
      from (select reason_code,count(*) units,coalesce(sum(line_cost),0) cost from lines group by reason_code) g),'[]'::jsonb)
  ) into v_result;

  return v_result;
end $$;

-- -----------------------------------------------------------------------------
-- Xarajatlar kategoriya bo'yicha (oylik hisobot uchun)
-- -----------------------------------------------------------------------------

create or replace function public.report_expense_breakdown(p_from date,p_to date,p_branch_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_categories jsonb; v_total numeric(18,2); v_income numeric(18,2);
begin
  if p_branch_id is null then
    if not public.has_role(array['superadmin','admin']::public.app_role[],null) then
      raise exception 'Ruxsat yo‘q' using errcode='42501';
    end if;
  elsif not(public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager','accountant']::public.app_role[],p_branch_id)) then
    raise exception 'Ruxsat yo‘q' using errcode='42501';
  end if;
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then
    raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('category',g.category,'amount',g.amount,'entries',g.entries)
      order by g.amount desc,g.category),'[]'::jsonb),
    coalesce(sum(g.amount),0)
  into v_categories,v_total
  from (
    select category,coalesce(sum(amount),0) amount,count(*) entries
    from public.finance_transactions
    where type='expense'
      and occurred_at>=public.business_day_start(p_from) and occurred_at<public.business_day_start(p_to+1)
      and (p_branch_id is null or branch_id=p_branch_id)
    group by category
  ) g;
  select coalesce(sum(amount),0) into v_income from public.finance_transactions
    where type='income' and occurred_at>=public.business_day_start(p_from)
      and occurred_at<public.business_day_start(p_to+1) and (p_branch_id is null or branch_id=p_branch_id);
  return jsonb_build_object('from',p_from,'to',p_to,'branch_id',p_branch_id,
    'total_expense',v_total,'total_income',v_income,'categories',v_categories,
    'writeoff_expense',coalesce((select amount from jsonb_to_recordset(v_categories) as x(category text,amount numeric)
      where category='Hisobdan chiqqan tovarlar' limit 1),0));
end $$;

-- -----------------------------------------------------------------------------
-- Grantlar
-- -----------------------------------------------------------------------------

revoke all on function public.writeoff_reason_label(text),public.ensure_branch_finance_account(uuid),
  public.find_writeoff_unit(uuid,text),public.search_writeoff_units(uuid,text,uuid,integer),
  public.execute_writeoff(uuid,uuid[],text,text,uuid,uuid),
  public.list_writeoff_history(uuid,date,date,text,text,integer,integer),
  public.report_expense_breakdown(date,date,uuid) from public,anon,authenticated;

grant execute on function public.writeoff_reason_label(text),
  public.find_writeoff_unit(uuid,text),public.search_writeoff_units(uuid,text,uuid,integer),
  public.execute_writeoff(uuid,uuid[],text,text,uuid,uuid),
  public.list_writeoff_history(uuid,date,date,text,text,integer,integer),
  public.report_expense_breakdown(date,date,uuid) to authenticated;

grant execute on function public.ensure_branch_finance_account(uuid) to service_role;
grant execute on all functions in schema public to service_role;

commit;
