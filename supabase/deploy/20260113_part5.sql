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
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash notoвЂgвЂri' using errcode='22023'; end if;
  if nullif(p_status,'') is not null and not exists(select 1 from unnest(enum_range(null::public.order_status)) x where x::text=p_status) then
    raise exception 'Buyurtma statusi notoвЂgвЂri' using errcode='22023';
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
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash notoвЂgвЂri' using errcode='22023'; end if;
  if nullif(p_status,'') is not null and not exists(select 1 from unnest(enum_range(null::public.order_status)) x where x::text=p_status) then
    raise exception 'Buyurtma statusi notoвЂgвЂri' using errcode='22023';
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
    raise exception 'Telegram chat yoki rahbar profili notoвЂgвЂri' using errcode='22023';
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
  if p_update_id is null or p_update_id<0 or p_chat_id is null or p_chat_id=0 or p_lease_seconds not between 30 and 600 then raise exception 'Telegram update notoвЂgвЂri' using errcode='22023'; end if;
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
    last_error=case when p_success then null else left(coalesce(p_error,'NomaвЂ™lum xato'),1000) end,processed_at=now(),claim_token=null
  where update_id=p_update_id and claim_token=p_claim_token and status in('processing','dispatching');
  if not found then raise exception 'Telegram update claim topilmadi' using errcode='P0002'; end if;
end $$;

create or replace function public.telegram_daily_summary(p_branch_id uuid,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  if p_from is null or p_to is null or p_to<=p_from or p_to-p_from>interval '2 days'
    or (p_branch_id is not null and not exists(select 1 from public.branches where id=p_branch_id and is_active)) then raise exception 'Telegram hisobot scope notoвЂgвЂri' using errcode='22023'; end if;
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


