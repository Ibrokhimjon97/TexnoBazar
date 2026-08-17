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
    if v_u.location_id<>v_w.location_id or v_u.status not in('available','returned') or v_u.active_transfer_id is not null then raise exception 'Birlik holati oвЂzgargan: %',v_u.id using errcode='P0001'; end if;
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
  update public.writeoffs set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),reason=reason||E'\nBekor qilish: '||coalesce(nullif(btrim(p_reason),''),'Sabab koвЂrsatilmagan')
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
    raise exception 'Sale payment oвЂzgarmas; faqat refund status oвЂtishi mumkin' using errcode='55000';
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
  if p_idempotency_key is null or nullif(btrim(p_reason),'') is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'Qaytarish maвЂ™lumotlari notoвЂgвЂri' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_lines)e group by (e->>'sale_line_id')::uuid having count(*)>1) then raise exception 'Sotuv qatori takrorlangan' using errcode='22023'; end if;
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('sale_id',p_sale_id,'kind',p_kind,'reason',btrim(p_reason),'lines',p_lines)::text,'UTF8'),'sha256'),'hex');
  select * into v_row from public.sale_returns where branch_id=v_sale.branch_id and idempotency_key=p_idempotency_key;
  if found then if v_row.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa qaytarishda ishlatilgan' using errcode='22023'; end if; return to_jsonb(v_row); end if;
  insert into public.sale_returns(id,return_no,original_sale_id,kind,status,branch_id,customer_id,reason,refund_amount,requested_by,idempotency_key,request_hash)
  values(v_id,'RET-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8)),p_sale_id,p_kind,'requested',v_sale.branch_id,v_sale.customer_id,btrim(p_reason),0,auth.uid(),p_idempotency_key,v_hash);
  for v_item in select value from jsonb_array_elements(p_lines) order by (value->>'sale_line_id')::uuid loop
    select * into v_line from public.sale_lines where id=(v_item->>'sale_line_id')::uuid and sale_id=p_sale_id;
    if not found then raise exception 'Sotuv qatori topilmadi' using errcode='P0002'; end if;
    if coalesce(v_item->>'condition','') not in('resellable','damaged','defective') then raise exception 'Qaytarish condition notoвЂgвЂri' using errcode='22023'; end if;
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
      raise exception 'Replacement sale shu filialdagi yakunlangan sotuv boвЂlishi kerak' using errcode='22023'; end if;
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
  update public.sale_returns set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),reason=reason||E'\nBekor qilish: '||coalesce(nullif(btrim(p_reason),''),'Sabab koвЂrsatilmagan') where id=p_return_id returning * into v_r; return to_jsonb(v_r);
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
    raise exception 'Order rezerv ledgeri oвЂzgarmas' using errcode='55000'; end if;
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
    or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'Buyurtma payload yoki idempotency key notoвЂgвЂri' using errcode='22023'; end if;
  if nullif(btrim(p_customer->>'name'),'') is null or nullif(btrim(p_customer->>'phone'),'') is null then raise exception 'Mijoz ismi va telefoni talab qilinadi' using errcode='22023'; end if;
  select id into v_method from public.payment_methods where code=lower(btrim(p_payment_method_code)) and is_active and (is_online or is_cash or code='cod');
  if v_method is null then raise exception 'Faol toвЂlov usuli topilmadi' using errcode='P0002'; end if;
  begin
    if exists(select 1 from jsonb_array_elements(p_lines)e where (e->>'quantity')::numeric<>trunc((e->>'quantity')::numeric)
      or (e->>'quantity')::integer not between 1 and 100) then raise exception 'Online buyurtma miqdori 1..100 butun son boвЂlishi kerak' using errcode='22023'; end if;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Buyurtma miqdori notoвЂgвЂri' using errcode='22023'; end;
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
      raise exception 'Buyurtma rezervlari toвЂliq emas; qoвЂlda tekshiruv talab qilinadi' using errcode='P0001';
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
  if not((v_o.status='new' and p_target='confirmed') or (v_o.status='confirmed' and p_target='processing') or (v_o.status='processing' and p_target='ready')) then raise exception 'Online buyurtma status oвЂtishi notoвЂgвЂri' using errcode='P0001'; end if;
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
  elsif v_o.branch_id is null or not(public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager']::public.app_role[],v_o.branch_id)) then raise exception 'Bekor qilish ruxsati yoвЂq' using errcode='42501'; end if;
  if v_o.status='cancelled' then return to_jsonb(v_o); end if;
  if v_o.status in('shipped','delivered','returned') then raise exception 'JoвЂnatilgan/yakunlangan buyurtma bekor qilinmaydi' using errcode='P0001'; end if;
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


