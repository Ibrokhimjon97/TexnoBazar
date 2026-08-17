grant all on public.media_cleanup_queue to service_role;

create or replace function public.claim_media_cleanup_batch(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_items jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  if p_limit not between 1 and 100 then raise exception 'Cleanup limit notoвЂgвЂri' using errcode='22023'; end if;
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
    update public.media_cleanup_queue set status=case when v_attempts>=8 then 'dead' else 'pending' end,last_error=left(coalesce(p_error,'NomaвЂ™lum cleanup xatosi'),1000),
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
  if v_b.is_active and (v_b.starts_at is null or v_b.starts_at<=now()) and (v_b.ends_at is null or v_b.ends_at>now()) then raise exception 'Faol banner media faylini oвЂchirishdan oldin bannerni faolsizlantiring' using errcode='P0001'; end if;
  insert into public.media_cleanup_queue(r2_key,scope,status,next_attempt_at) values(v_b.r2_key,'banners','pending',now())
  on conflict(r2_key) do update set status='pending',next_attempt_at=now(),last_error=null,locked_at=null,lock_token=null;
  delete from public.cms_banners where id=p_banner_id; return v_b.r2_key;
end $$;

create or replace function public.save_cms_banner(p_banner jsonb,p_upload_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_existing public.cms_banners%rowtype; v_upload public.banner_media_uploads%rowtype; v_result public.cms_banners%rowtype; v_image_url text; v_r2_key text;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) or jsonb_typeof(p_banner)<>'object' then raise exception 'Global admin va banner payloadi talab qilinadi' using errcode='42501'; end if;
  begin v_id=(p_banner->>'id')::uuid; exception when invalid_text_representation then raise exception 'Banner ID notoвЂgвЂri' using errcode='22023'; end;
  if v_id is null or nullif(btrim(p_banner->>'title'),'') is null or nullif(btrim(p_banner->>'placement'),'') is null then raise exception 'Banner maydonlari notoвЂgвЂri' using errcode='22023'; end if;
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
  if jsonb_typeof(p_promotion)<>'object' or coalesce(cardinality(p_product_ids),0)>500 then raise exception 'Aksiya payloadi notoвЂgвЂri' using errcode='22023'; end if;
  begin v_id=coalesce(nullif(p_promotion->>'id','')::uuid,gen_random_uuid()); exception when invalid_text_representation then raise exception 'Aksiya ID notoвЂgвЂri' using errcode='22023'; end;
  if nullif(btrim(p_promotion->>'name'),'') is null or nullif(btrim(p_promotion->>'slug'),'') is null
    or (p_promotion->>'discount_type') not in('percent','fixed') or coalesce((p_promotion->>'discount_value')::numeric,0)<=0
    or (p_promotion->>'starts_at')::timestamptz >= (p_promotion->>'ends_at')::timestamptz
    or jsonb_typeof(coalesce(p_promotion->'rules','{}'::jsonb))<>'object' then raise exception 'Aksiya maydonlari notoвЂgвЂri' using errcode='22023'; end if;
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
  if p_limit not between 1 and 500 or p_offset<0 or (p_from is not null and p_to is not null and p_to<p_from) then raise exception 'Audit filtri notoвЂgвЂri' using errcode='22023'; end if;
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
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash notoвЂgвЂri' using errcode='22023'; end if;
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
  elsif not(public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager','accountant']::public.app_role[],p_branch_id)) then raise exception 'Filial hisoboti uchun ruxsat yoвЂq' using errcode='42501'; end if;
end $$;

create or replace function public.report_sales_rows(p_from date,p_to date,p_branch_id uuid default null)
returns table(sale_no text,sold_at timestamptz,branch_code text,seller_name text,status public.sale_status,subtotal numeric,discount numeric,tax numeric,total numeric,cost numeric,profit numeric,payments jsonb)
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_report_access(p_branch_id); if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Sana oraligвЂi notoвЂgвЂri' using errcode='22023'; end if;
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
  perform public.require_report_access(p_branch_id); if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Sana oraligвЂi notoвЂgвЂri' using errcode='22023'; end if;
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
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Sana oraligвЂi notoвЂgвЂri' using errcode='22023'; end if;
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
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Sana oraligвЂi notoвЂgвЂri' using errcode='22023'; end if;
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
  perform public.require_report_access(p_branch_id); if p_from is null or p_to is null or p_to<p_from or p_to-p_from>3660 then raise exception 'Sana oraligвЂi notoвЂgвЂri' using errcode='22023'; end if;
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

