begin;

-- Task 4: authorized report exports and durable, sanitized electronic receipts.

create or replace function public.report_sales_rows(p_from date,p_to date,p_branch_id uuid default null)
returns table(sale_no text,sold_at timestamptz,branch_code text,seller_name text,status public.sale_status,subtotal numeric,discount numeric,tax numeric,total numeric,cost numeric,profit numeric,payments jsonb)
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_report_access(p_branch_id);
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023'; end if;
  return query select s.sale_no,s.sold_at,b.code,p.full_name,s.status,s.subtotal,s.discount,s.tax,s.total,
    coalesce(sum(l.unit_cost*l.quantity),0),coalesce(sum(l.line_total-l.tax-(l.unit_cost*l.quantity)),0),
    coalesce((select jsonb_agg(jsonb_build_object('method_code',pm.code,'amount',sp.amount,'status',sp.status)
      order by sp.paid_at,sp.id) from public.sale_payments sp join public.payment_methods pm on pm.id=sp.payment_method_id where sp.sale_id=s.id),'[]'::jsonb)
  from public.sales s join public.branches b on b.id=s.branch_id join public.profiles p on p.id=s.seller_id left join public.sale_lines l on l.sale_id=s.id
  where s.status<>'void' and s.sold_at>=public.business_day_start(p_from) and s.sold_at<public.business_day_start(p_to+1)
    and (p_branch_id is null or s.branch_id=p_branch_id)
  group by s.id,b.code,p.full_name order by s.sold_at,s.sale_no;
end $$;

create or replace function public.report_profit_loss(p_from date,p_to date,p_branch_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_sales numeric; v_tax numeric; v_cogs numeric; v_cogs_recovered numeric; v_other_income numeric; v_expense numeric; v_refunds numeric;
begin
  perform public.require_report_access(p_branch_id);
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023'; end if;
  select coalesce(sum(l.line_total-l.tax),0),coalesce(sum(l.tax),0),coalesce(sum(l.unit_cost*l.quantity),0)
    into v_sales,v_tax,v_cogs
  from public.sales s join public.sale_lines l on l.sale_id=s.id
  where s.sold_at>=public.business_day_start(p_from) and s.sold_at<public.business_day_start(p_to+1)
    and s.status<>'void' and (p_branch_id is null or s.branch_id=p_branch_id);
  select coalesce(sum(amount) filter(where type='income'),0),coalesce(sum(amount) filter(where type='expense'),0)
    into v_other_income,v_expense from public.finance_transactions
    where occurred_at>=public.business_day_start(p_from) and occurred_at<public.business_day_start(p_to+1)
      and (p_branch_id is null or branch_id=p_branch_id);
  select coalesce(sum(x.refund_amount*case when sl.line_total=0 then 0 else (sl.line_total-sl.tax)/sl.line_total end),0)
    into v_refunds from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id
    join public.sale_lines sl on sl.id=x.sale_line_id
    where r.status='completed' and r.completed_at>=public.business_day_start(p_from) and r.completed_at<public.business_day_start(p_to+1)
      and (p_branch_id is null or r.branch_id=p_branch_id);
  select coalesce(sum(sl.unit_cost*x.quantity),0) into v_cogs_recovered from public.sale_return_lines x
    join public.sale_returns r on r.id=x.return_id join public.sale_lines sl on sl.id=x.sale_line_id
    where r.status='completed' and x.condition='resellable' and r.completed_at>=public.business_day_start(p_from)
      and r.completed_at<public.business_day_start(p_to+1) and (p_branch_id is null or r.branch_id=p_branch_id);
  return jsonb_build_object('from',p_from,'to',p_to,'branch_id',p_branch_id,'sales_revenue',v_sales,'tax_collected',v_tax,
    'refunds',v_refunds,'net_sales',v_sales-v_refunds,'cost_of_goods',v_cogs-v_cogs_recovered,
    'gross_profit',v_sales-v_refunds-v_cogs+v_cogs_recovered,'other_income',v_other_income,
    'operating_expenses',v_expense,'net_profit',v_sales-v_refunds-v_cogs+v_cogs_recovered+v_other_income-v_expense);
end $$;

create or replace function public.report_seller_performance(p_from date,p_to date,p_branch_id uuid default null)
returns table(sold_at date,seller_id uuid,seller_name text,branch_code text,sales_count bigint,units_sold numeric,revenue numeric,cost numeric,profit numeric)
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_report_access(p_branch_id);
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then
    raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023';
  end if;
  return query
  select (s.sold_at at time zone 'Asia/Tashkent')::date,s.seller_id,p.full_name,b.code,count(distinct s.id),coalesce(sum(l.quantity),0),
    coalesce(sum(l.line_total-l.tax),0),coalesce(sum(l.unit_cost*l.quantity),0),
    coalesce(sum(l.line_total-l.tax-(l.unit_cost*l.quantity)),0)
  from public.sales s
  join public.profiles p on p.id=s.seller_id
  join public.branches b on b.id=s.branch_id
  left join public.sale_lines l on l.sale_id=s.id
  where s.status<>'void' and s.sold_at>=public.business_day_start(p_from)
    and s.sold_at<public.business_day_start(p_to+1)
    and (p_branch_id is null or s.branch_id=p_branch_id)
  group by (s.sold_at at time zone 'Asia/Tashkent')::date,s.seller_id,p.full_name,b.code
  order by 1,7 desc,3,2;
end $$;

create or replace function public.report_product_performance(p_from date,p_to date,p_branch_id uuid default null)
returns table(sold_at date,product_id uuid,sku text,product_name text,sales_count bigint,units_sold numeric,revenue numeric,cost numeric,profit numeric)
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_report_access(p_branch_id);
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then
    raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023';
  end if;
  return query
  select (s.sold_at at time zone 'Asia/Tashkent')::date,l.product_id,p.sku,p.name,count(distinct s.id),coalesce(sum(l.quantity),0),
    coalesce(sum(l.line_total-l.tax),0),coalesce(sum(l.unit_cost*l.quantity),0),
    coalesce(sum(l.line_total-l.tax-(l.unit_cost*l.quantity)),0)
  from public.sale_lines l
  join public.sales s on s.id=l.sale_id
  join public.products p on p.id=l.product_id
  where s.status<>'void' and s.sold_at>=public.business_day_start(p_from)
    and s.sold_at<public.business_day_start(p_to+1)
    and (p_branch_id is null or s.branch_id=p_branch_id)
  group by (s.sold_at at time zone 'Asia/Tashkent')::date,l.product_id,p.sku,p.name
  order by 1,7 desc,4,2;
end $$;

create or replace function public.report_inventory_count_rows(p_from date,p_to date,p_branch_id uuid default null)
returns table(count_id uuid,count_no text,created_at timestamptz,started_at timestamptz,posted_at timestamptz,
  branch_code text,location_code text,location_name text,status text,expected_quantity numeric,counted_quantity numeric,variance numeric)
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_report_access(p_branch_id);
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then
    raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023';
  end if;
  return query
  select c.id,c.count_no,c.created_at,c.started_at,c.posted_at,b.code,l.code,l.name,c.status,
    coalesce(sum(x.expected_quantity),0),coalesce(sum(x.counted_quantity),0),coalesce(sum(x.variance),0)
  from public.inventory_counts c
  join public.locations l on l.id=c.location_id
  join public.branches b on b.id=l.branch_id
  left join public.inventory_count_lines x on x.inventory_count_id=c.id
  where c.created_at>=public.business_day_start(p_from) and c.created_at<public.business_day_start(p_to+1)
    and (p_branch_id is null or l.branch_id=p_branch_id)
  group by c.id,c.count_no,c.created_at,c.started_at,c.posted_at,b.code,l.code,l.name,c.status
  order by c.created_at,c.id;
end $$;

create or replace function public.can_access_safe_sale_receipt(p_sale_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.role()='service_role' or exists(
    select 1 from public.sales s
    left join public.customers c on c.id=s.customer_id
    left join public.orders o on o.id=s.order_id
    where s.id=p_sale_id and public.current_user_active() and (
      (s.seller_id=auth.uid() and public.has_role(array['seller']::public.app_role[],s.branch_id))
      or public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager']::public.app_role[],s.branch_id)
      or c.auth_user_id=auth.uid() or o.customer_user_id=auth.uid()
    )
  )
$$;

create or replace function public.get_safe_sale_receipt(p_sale_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if not exists(select 1 from public.sales where id=p_sale_id) then
    raise exception 'Sotuv topilmadi' using errcode='P0002';
  end if;
  if not public.can_access_safe_sale_receipt(p_sale_id) then
    raise exception 'Chek uchun ruxsat yo‘q' using errcode='42501';
  end if;
  select jsonb_build_object(
    'version',1,'sale_no',s.sale_no,'order_no',o.order_no,'status',s.status,'sold_at',s.sold_at,
    'currency',btrim(b.currency::text),'branch_name',b.name,'branch_phone',b.phone,'branch_address',b.address,
    'seller_name',seller.full_name,'manager_name',manager.full_name,
    'company',jsonb_build_object(
      'name',coalesce(nullif((select value#>>'{}' from public.system_settings where key='receipt.company_name'),''),b.name),
      'logo_url',nullif((select value#>>'{}' from public.system_settings where key='receipt.logo_url'),''),
      'logo_text',upper(left(coalesce(nullif((select value#>>'{}' from public.system_settings where key='receipt.company_name'),''),b.name,'T'),1)),
      'phone',b.phone,'address',b.address),
    'operator',jsonb_build_object('label','Sotuvchi','name',seller.full_name),
    'lines',coalesce((select jsonb_agg(jsonb_build_object(
      'product_name',p.name,'sku',p.sku,'serial_number',u.serial_number,'quantity',x.quantity,
      'unit_price',x.unit_price,'discount',x.discount,'tax',x.tax,'line_total',x.line_total)
      order by x.created_at,x.id)
      from public.sale_lines x join public.products p on p.id=x.product_id
      join public.inventory_units u on u.id=x.unit_id where x.sale_id=s.id),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(jsonb_build_object(
      'method_code',pm.code,'method_name',pm.name,'amount',sp.amount,'status',sp.status,'paid_at',sp.paid_at)
      order by sp.paid_at,sp.id)
      from public.sale_payments sp join public.payment_methods pm on pm.id=sp.payment_method_id
      where sp.sale_id=s.id),'[]'::jsonb),
    'subtotal',s.subtotal,'discount',s.discount,'tax',s.tax,'total',s.total,
    'totals',jsonb_build_object('subtotal',s.subtotal,'discount',s.discount,'tax',s.tax,'total',s.total)
  ) into v_result
  from public.sales s join public.branches b on b.id=s.branch_id
  join public.profiles seller on seller.id=s.seller_id
  left join public.profiles manager on manager.id=s.manager_id
  left join public.orders o on o.id=s.order_id
  where s.id=p_sale_id;
  return v_result;
end $$;

create table public.receipt_delivery_outbox(
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  order_id uuid references public.orders(id) on delete restrict,
  channel public.notification_channel not null default 'email' check(channel='email'),
  recipient_email extensions.citext not null,
  receipt_payload jsonb not null check(jsonb_typeof(receipt_payload)='object'),
  status text not null default 'pending' check(status in('pending','processing','sent','dead','ambiguous')),
  attempts integer not null default 0 check(attempts>=0),
  idempotency_key uuid not null unique,
  request_hash text not null,
  requested_by uuid references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_token uuid,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  check((status='processing')=(locked_at is not null and lock_token is not null)),
  check(status<>'sent' or sent_at is not null)
);
create index receipt_delivery_due_idx on public.receipt_delivery_outbox(status,next_attempt_at,requested_at);
create index receipt_delivery_sale_idx on public.receipt_delivery_outbox(sale_id,requested_at desc);
create index receipt_delivery_order_idx on public.receipt_delivery_outbox(order_id,requested_at desc) where order_id is not null;
alter table public.receipt_delivery_outbox enable row level security;
revoke all on public.receipt_delivery_outbox from public,anon,authenticated;
grant all on public.receipt_delivery_outbox to service_role;

create or replace function public.guard_receipt_delivery_outbox()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'Elektron chek outbox yozuvi o‘chirilmaydi' using errcode='55000'; end if;
  if old.id is distinct from new.id or old.sale_id is distinct from new.sale_id or old.order_id is distinct from new.order_id
    or old.channel is distinct from new.channel or old.recipient_email is distinct from new.recipient_email
    or old.receipt_payload is distinct from new.receipt_payload or old.idempotency_key is distinct from new.idempotency_key
    or old.request_hash is distinct from new.request_hash or old.requested_by is distinct from new.requested_by
    or old.requested_at is distinct from new.requested_at then
    raise exception 'Elektron chek snapshoti o‘zgarmas' using errcode='55000';
  end if;
  return new;
end $$;
create trigger receipt_delivery_outbox_guard before update or delete on public.receipt_delivery_outbox
  for each row execute function public.guard_receipt_delivery_outbox();

create or replace function public.queue_receipt_delivery_internal(p_sale_id uuid,p_order_id uuid,p_email text,p_idempotency_key uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_email text:=lower(btrim(p_email)); v_hash text; v_existing public.receipt_delivery_outbox%rowtype; v_id uuid:=gen_random_uuid(); v_payload jsonb;
begin
  if p_idempotency_key is null or v_email is null or length(v_email) not between 5 and 254
    or v_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Yaroqli email va idempotency key talab qilinadi' using errcode='22023';
  end if;
  v_payload=public.get_safe_sale_receipt(p_sale_id);
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('sale_id',p_sale_id,'order_id',p_order_id,'email',v_email)::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.receipt_delivery_outbox where idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_hash<>v_hash or v_existing.requested_by is distinct from p_actor then
      raise exception 'Takroriy kalit boshqa elektron chek so‘rovida ishlatilgan' using errcode='22023';
    end if;
    return jsonb_build_object('id',v_existing.id,'status',v_existing.status,'attempts',v_existing.attempts,
      'requested_at',v_existing.requested_at,'next_attempt_at',v_existing.next_attempt_at,'sent_at',v_existing.sent_at);
  end if;
  insert into public.receipt_delivery_outbox(id,sale_id,order_id,recipient_email,receipt_payload,idempotency_key,request_hash,requested_by)
  values(v_id,p_sale_id,p_order_id,v_email,v_payload,p_idempotency_key,v_hash,p_actor)
  returning * into v_existing;
  return jsonb_build_object('id',v_existing.id,'status',v_existing.status,'attempts',v_existing.attempts,
    'requested_at',v_existing.requested_at,'next_attempt_at',v_existing.next_attempt_at,'sent_at',v_existing.sent_at);
exception when unique_violation then
  select * into v_existing from public.receipt_delivery_outbox where idempotency_key=p_idempotency_key;
  if found and v_existing.request_hash=v_hash and v_existing.requested_by is not distinct from p_actor then
    return jsonb_build_object('id',v_existing.id,'status',v_existing.status,'attempts',v_existing.attempts,
      'requested_at',v_existing.requested_at,'next_attempt_at',v_existing.next_attempt_at,'sent_at',v_existing.sent_at);
  end if;
  raise;
end $$;

create or replace function public.queue_sale_receipt_delivery(p_sale_id uuid,p_email text,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role()<>'service_role' and (not public.current_user_active() or not exists(
    select 1 from public.sales s where s.id=p_sale_id and (
      (s.seller_id=auth.uid() and public.has_role(array['seller']::public.app_role[],s.branch_id))
      or public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager']::public.app_role[],s.branch_id)
    )
  )) then raise exception 'Chek yuborish uchun faol sotuvchi yoki boshqaruvchi roli talab qilinadi' using errcode='42501'; end if;
  return public.queue_receipt_delivery_internal(p_sale_id,(select order_id from public.sales where id=p_sale_id),p_email,p_idempotency_key,auth.uid());
end $$;

create or replace function public.queue_order_receipt_delivery(p_order_id uuid,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_o public.orders%rowtype; v_sale uuid;
begin
  select * into v_o from public.orders where id=p_order_id;
  if not found then raise exception 'Buyurtma topilmadi' using errcode='P0002'; end if;
  if auth.role()<>'service_role' and (not public.current_user_active() or not(
    public.has_role(array['superadmin','admin']::public.app_role[],null)
    or (v_o.branch_id is not null and public.has_role(array['manager']::public.app_role[],v_o.branch_id)))) then
    raise exception 'Buyurtma chekini yuborish uchun ruxsat yo‘q' using errcode='42501';
  end if;
  if v_o.status<>'delivered' then raise exception 'Elektron chek faqat yetkazilgan buyurtma uchun yuboriladi' using errcode='P0001'; end if;
  if v_o.customer_email is null then raise exception 'Buyurtmada mijoz emaili mavjud emas' using errcode='P0001'; end if;
  select id into v_sale from public.sales where order_id=p_order_id;
  if v_sale is null then raise exception 'Yetkazilgan buyurtma sotuv cheki topilmadi' using errcode='P0002'; end if;
  return public.queue_receipt_delivery_internal(v_sale,p_order_id,v_o.customer_email::text,p_idempotency_key,auth.uid());
end $$;

create or replace function public.get_receipt_delivery_status(p_delivery_id uuid default null,p_sale_id uuid default null,p_order_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_row public.receipt_delivery_outbox%rowtype; v_sale uuid;
begin
  if p_delivery_id is null and p_sale_id is null and p_order_id is null then
    raise exception 'Delivery, sale yoki order ID talab qilinadi' using errcode='22023';
  end if;
  if auth.role()<>'service_role' and not public.current_user_active() then
    raise exception 'Faol profil talab qilinadi' using errcode='42501';
  end if;
  if p_delivery_id is not null then
    select * into v_row from public.receipt_delivery_outbox where id=p_delivery_id;
  elsif p_sale_id is not null then
    select * into v_row from public.receipt_delivery_outbox where sale_id=p_sale_id order by requested_at desc,id desc limit 1;
  else
    select * into v_row from public.receipt_delivery_outbox where order_id=p_order_id order by requested_at desc,id desc limit 1;
  end if;
  if not found then return null; end if;
  v_sale=v_row.sale_id;
  if auth.role()<>'service_role' and v_row.requested_by is distinct from auth.uid() and not public.can_access_safe_sale_receipt(v_sale) then
    raise exception 'Elektron chek holati uchun ruxsat yo‘q' using errcode='42501';
  end if;
  return jsonb_build_object('id',v_row.id,'sale_id',v_row.sale_id,'order_id',v_row.order_id,'status',v_row.status,
    'attempts',v_row.attempts,'requested_at',v_row.requested_at,'next_attempt_at',v_row.next_attempt_at,
    'last_attempt_at',v_row.last_attempt_at,'sent_at',v_row.sent_at,
    'recipient_hint',left(v_row.recipient_email::text,1)||'***@'||split_part(v_row.recipient_email::text,'@',2),
    'message',case v_row.status when 'pending' then 'Elektron chek navbatda' when 'processing' then 'Elektron chek yuborilmoqda'
      when 'sent' then 'Elektron chek yuborildi' when 'ambiguous' then 'Provider javobi noaniq, operator tekshiruvi talab qilinadi'
      else 'Elektron chek yuborilmadi' end);
end $$;

create or replace function public.claim_receipt_delivery_batch(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_items jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  if p_limit not between 1 and 100 then raise exception 'Delivery limit noto‘g‘ri' using errcode='22023'; end if;
  with candidates as(
    select id from public.receipt_delivery_outbox
    where (status='pending' and next_attempt_at<=now()) or (status='processing' and locked_at<now()-interval '15 minutes')
    order by next_attempt_at,requested_at for update skip locked limit p_limit
  ),claimed as(
    update public.receipt_delivery_outbox q set status='processing',attempts=q.attempts+1,locked_at=now(),
      last_attempt_at=now(),lock_token=gen_random_uuid(),last_error=null
    from candidates c where q.id=c.id
    returning q.id,q.recipient_email::text recipient_email,q.receipt_payload,q.attempts,q.lock_token,q.idempotency_key
  ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) into v_items from claimed;
  return v_items;
end $$;

create or replace function public.finish_receipt_delivery(p_delivery_id uuid,p_lock_token uuid,p_outcome text,
  p_provider_message_id text default null,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_attempts integer; v_final text;
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  if p_outcome not in('sent','retry','dead','ambiguous') then raise exception 'Delivery outcome noto‘g‘ri' using errcode='22023'; end if;
  select attempts into v_attempts from public.receipt_delivery_outbox
    where id=p_delivery_id and lock_token=p_lock_token and status='processing' for update;
  if not found then raise exception 'Elektron chek delivery lease topilmadi' using errcode='P0002'; end if;
  v_final=case when p_outcome='retry' and v_attempts>=8 then 'dead' when p_outcome='retry' then 'pending' else p_outcome end;
  update public.receipt_delivery_outbox set status=v_final,
    provider_message_id=case when v_final='sent' then nullif(left(p_provider_message_id,500),'') else provider_message_id end,
    sent_at=case when v_final='sent' then now() else sent_at end,
    last_error=case when v_final='sent' then null else left(coalesce(p_error,'Noma’lum elektron chek xatosi'),1000) end,
    next_attempt_at=case when v_final='pending' then now()+make_interval(secs=>least(3600,30*(2^least(v_attempts,7))::integer)) else next_attempt_at end,
    locked_at=null,lock_token=null
  where id=p_delivery_id and lock_token=p_lock_token;
end $$;

revoke all on function public.report_sales_rows(date,date,uuid),public.report_profit_loss(date,date,uuid),
  public.report_seller_performance(date,date,uuid),public.report_product_performance(date,date,uuid),
  public.report_inventory_count_rows(date,date,uuid),public.can_access_safe_sale_receipt(uuid),public.get_safe_sale_receipt(uuid),
  public.guard_receipt_delivery_outbox(),public.queue_receipt_delivery_internal(uuid,uuid,text,uuid,uuid),
  public.queue_sale_receipt_delivery(uuid,text,uuid),public.queue_order_receipt_delivery(uuid,uuid),
  public.get_receipt_delivery_status(uuid,uuid,uuid),public.claim_receipt_delivery_batch(integer),
  public.finish_receipt_delivery(uuid,uuid,text,text,text)
  from public,anon,authenticated;

grant execute on function public.report_sales_rows(date,date,uuid),public.report_profit_loss(date,date,uuid),
  public.report_seller_performance(date,date,uuid),public.report_product_performance(date,date,uuid),
  public.report_inventory_count_rows(date,date,uuid),public.get_safe_sale_receipt(uuid),
  public.queue_sale_receipt_delivery(uuid,text,uuid),public.queue_order_receipt_delivery(uuid,uuid),
  public.get_receipt_delivery_status(uuid,uuid,uuid) to authenticated;

grant execute on function public.report_sales_rows(date,date,uuid),public.report_profit_loss(date,date,uuid),
  public.report_seller_performance(date,date,uuid),public.report_product_performance(date,date,uuid),
  public.report_inventory_count_rows(date,date,uuid),public.can_access_safe_sale_receipt(uuid),public.get_safe_sale_receipt(uuid),
  public.guard_receipt_delivery_outbox(),public.queue_receipt_delivery_internal(uuid,uuid,text,uuid,uuid),
  public.queue_sale_receipt_delivery(uuid,text,uuid),public.queue_order_receipt_delivery(uuid,uuid),
  public.get_receipt_delivery_status(uuid,uuid,uuid),public.claim_receipt_delivery_batch(integer),
  public.finish_receipt_delivery(uuid,uuid,text,text,text) to service_role;

commit;
