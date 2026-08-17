-- Task 4: multi-line stock receipts, unique QR units and live balances.
begin;

create table public.stock_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_no text not null unique check (receipt_no ~ '^[A-Z0-9._-]{3,64}$'),
  branch_id uuid not null references public.branches(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  receiving_location_id uuid not null references public.locations(id) on delete restrict,
  invoice_number text, currency char(3) not null default 'UZS',
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','partial','paid')),
  received_at timestamptz not null default now(), notes text,
  idempotency_key uuid not null, created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(branch_id,idempotency_key)
);
create index stock_receipts_branch_time_idx on public.stock_receipts(branch_id,received_at desc);
alter table public.stock_batches add column receipt_id uuid references public.stock_receipts(id) on delete restrict;
alter table public.stock_batches add column line_no integer check (line_no is null or line_no > 0);
create unique index stock_batches_receipt_line_uidx on public.stock_batches(receipt_id,line_no) where receipt_id is not null;
alter table public.inventory_units add column unit_sequence integer check (unit_sequence is null or unit_sequence > 0);
create unique index inventory_units_batch_sequence_uidx on public.inventory_units(batch_id,unit_sequence) where batch_id is not null and unit_sequence is not null;

create trigger stock_receipts_set_updated_at before update on public.stock_receipts for each row execute function public.set_updated_at();
create trigger stock_receipts_audit after insert or update or delete on public.stock_receipts for each row execute function public.audit_row_change();
create trigger stock_batches_audit after insert or update or delete on public.stock_batches for each row execute function public.audit_row_change();
alter table public.stock_receipts enable row level security;
create policy stock_receipts_staff_read on public.stock_receipts for select to authenticated using(public.can_access_branch(branch_id));
revoke all on public.stock_receipts from anon,authenticated;
grant select on public.stock_receipts to authenticated;
grant all on public.stock_receipts to service_role;

create or replace function public.refresh_inventory_balance(p_location_id uuid,p_product_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_on_hand numeric(18,3); v_reserved numeric(18,3);
begin
  select count(*) filter(where status in ('available','reserved','returned')),
         count(*) filter(where status='reserved')
    into v_on_hand,v_reserved from public.inventory_units
    where location_id=p_location_id and product_id=p_product_id;
  if v_on_hand=0 then delete from public.inventory_balances where location_id=p_location_id and product_id=p_product_id;
  else insert into public.inventory_balances(location_id,product_id,on_hand,reserved,updated_at)
    values(p_location_id,p_product_id,v_on_hand,v_reserved,now())
    on conflict(location_id,product_id) do update set on_hand=excluded.on_hand,reserved=excluded.reserved,updated_at=now(); end if;
end; $$;
create or replace function public.sync_inventory_balance_from_unit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op<>'INSERT' then perform public.refresh_inventory_balance(old.location_id,old.product_id); end if;
  if tg_op<>'DELETE' then perform public.refresh_inventory_balance(new.location_id,new.product_id); end if;
  return coalesce(new,old);
end; $$;
drop trigger if exists inventory_units_balance_sync on public.inventory_units;
create trigger inventory_units_balance_sync after insert or update of location_id,product_id,status or delete on public.inventory_units
for each row execute function public.sync_inventory_balance_from_unit();
do $$ declare r record; begin
  delete from public.inventory_balances;
  for r in select distinct location_id,product_id from public.inventory_units loop perform public.refresh_inventory_balance(r.location_id,r.product_id); end loop;
end $$;
create or replace function public.require_inventory_operator(p_branch_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager','warehouse']::public.app_role[],p_branch_id)) then
    raise exception 'Filial menejeri yoki omborchi roli talab qilinadi' using errcode='42501';
  end if;
end; $$;

create or replace function public.get_inventory_references(p_branch_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can_access_branch(p_branch_id) then raise exception 'Ruxsat yo‘q' using errcode='42501'; end if;
  return jsonb_build_object(
    'locations',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'code',l.code,'name',l.name,'type',l.type) order by l.name) from public.locations l where l.branch_id=p_branch_id and l.is_active and l.type in ('store','warehouse')),'[]'::jsonb),
    'suppliers',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'code',s.code,'name',s.name) order by s.name) from public.suppliers s where s.is_active),'[]'::jsonb),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'sku',p.sku,'name',p.name,'track_individual_units',p.track_individual_units,'cost_price',p.cost_price,'image',(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1)) order by p.name) from public.products p where p.status<>'archived'),'[]'::jsonb)
  );
end; $$;

create or replace function public.get_stock_receipt(p_receipt_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb; v_branch uuid;
begin
  select branch_id into v_branch from public.stock_receipts where id=p_receipt_id;
  if v_branch is null then raise exception 'Partiya topilmadi' using errcode='P0002'; end if;
  if not public.can_access_branch(v_branch) then raise exception 'Ruxsat yo‘q' using errcode='42501'; end if;
  select to_jsonb(r) || jsonb_build_object('branch_name',br.name,'supplier_name',s.name,'location_name',l.name,
    'lines',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'line_no',b.line_no,'product_id',b.product_id,'product_name',p.name,'sku',p.sku,'quantity',b.quantity,'unit_cost',b.unit_cost,
      'qr_count',(select count(*) from public.inventory_units u where u.batch_id=b.id)) order by b.line_no)
      from public.stock_batches b join public.products p on p.id=b.product_id where b.receipt_id=r.id),'[]'::jsonb))
  into v_result from public.stock_receipts r join public.branches br on br.id=r.branch_id join public.suppliers s on s.id=r.supplier_id
    join public.locations l on l.id=r.receiving_location_id where r.id=p_receipt_id;
  return v_result;
end; $$;

create or replace function public.receive_stock(p_header jsonb,p_lines jsonb,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_receipt uuid; v_existing uuid; v_branch uuid; v_location uuid; v_supplier uuid; v_line jsonb; v_batch uuid;
  v_product record; v_qty integer; v_cost numeric(18,2); v_line_no integer:=0; v_seq integer; v_serials jsonb; v_qr text; v_total integer:=0;
begin
  if auth.uid() is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  if jsonb_typeof(p_header)<>'object' or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 or jsonb_array_length(p_lines)>50 then raise exception 'Partiya ma’lumotlari noto‘g‘ri' using errcode='22023'; end if;
  v_branch:=(p_header->>'branch_id')::uuid; v_location:=(p_header->>'receiving_location_id')::uuid; v_supplier:=(p_header->>'supplier_id')::uuid;
  perform public.require_inventory_operator(v_branch);
  select id into v_existing from public.stock_receipts where branch_id=v_branch and idempotency_key=p_idempotency_key;
  if v_existing is not null then return public.get_stock_receipt(v_existing); end if;
  if not exists(select 1 from public.branches where id=v_branch and is_active) then raise exception 'Faol filial topilmadi'; end if;
  if not exists(select 1 from public.locations where id=v_location and branch_id=v_branch and is_active and type in ('warehouse','store')) then raise exception 'Qabul joylashuvi filialga mos emas' using errcode='23514'; end if;
  if not exists(select 1 from public.suppliers where id=v_supplier and is_active) then raise exception 'Faol ta’minotchi topilmadi'; end if;
  insert into public.stock_receipts(receipt_no,branch_id,supplier_id,receiving_location_id,invoice_number,currency,payment_status,received_at,notes,idempotency_key,created_by)
  values(upper(btrim(p_header->>'receipt_no')),v_branch,v_supplier,v_location,nullif(btrim(p_header->>'invoice_number'),''),upper(coalesce(nullif(p_header->>'currency',''),'UZS')),
    coalesce(nullif(p_header->>'payment_status',''),'unpaid'),coalesce((p_header->>'received_at')::timestamptz,now()),nullif(btrim(p_header->>'notes'),''),p_idempotency_key,auth.uid()) returning id into v_receipt;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_line_no:=v_line_no+1; v_qty:=(v_line->>'quantity')::integer; v_cost:=(v_line->>'unit_cost')::numeric; v_serials:=coalesce(v_line->'serial_numbers','[]'::jsonb);
    if v_qty<1 or v_qty>1000 or v_total+v_qty>5000 or v_cost<0 then raise exception 'Partiya qatori miqdori yoki tannarxi noto‘g‘ri'; end if;
    select id,track_individual_units into v_product from public.products where id=(v_line->>'product_id')::uuid and status<>'archived'; if not found then raise exception 'Mahsulot topilmadi'; end if;
    if jsonb_typeof(v_serials)<>'array' or jsonb_array_length(v_serials) not in (0,v_qty) then raise exception 'Seriya raqamlari soni miqdorga teng bo‘lishi kerak'; end if;
    insert into public.stock_batches(receipt_id,line_no,supplier_id,product_id,location_id,reference,received_at,expires_at,quantity,unit_cost,created_by)
    values(v_receipt,v_line_no,v_supplier,v_product.id,v_location,p_header->>'receipt_no',coalesce((p_header->>'received_at')::timestamptz,now()),nullif(v_line->>'expires_at','')::timestamptz,v_qty,v_cost,auth.uid()) returning id into v_batch;
    for v_seq in 1..v_qty loop
      v_qr:='TNB1-'||upper(encode(extensions.gen_random_bytes(16),'hex'));
      insert into public.inventory_units(product_id,batch_id,qr_code,serial_number,location_id,status,unit_sequence)
      values(v_product.id,v_batch,v_qr,nullif(btrim(v_serials->>(v_seq-1)),''),v_location,'available',v_seq);
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,to_location_id,quantity,unit_cost,reference_type,reference_id,actor_id,metadata)
      select id,v_product.id,v_batch,'received',v_location,1,v_cost,'stock_receipt',v_receipt,auth.uid(),jsonb_build_object('line_no',v_line_no,'unit_sequence',v_seq)
      from public.inventory_units where batch_id=v_batch and unit_sequence=v_seq;
    end loop; v_total:=v_total+v_qty;
  end loop;
  return public.get_stock_receipt(v_receipt);
end; $$;
create or replace function public.list_stock_receipts(p_branch_id uuid default null,p_query text default null,p_limit integer default 20,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_total bigint;
begin
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri'; end if;
  select count(*) into v_total from public.stock_receipts r where public.can_access_branch(r.branch_id)
    and (p_branch_id is null or r.branch_id=p_branch_id) and (p_query is null or r.receipt_no ilike '%'||btrim(p_query)||'%' or coalesce(r.invoice_number,'') ilike '%'||btrim(p_query)||'%');
  select coalesce(jsonb_agg(to_jsonb(x) order by x.received_at desc),'[]'::jsonb) into v_items from (
    select r.id,r.receipt_no,r.branch_id,br.name branch_name,r.supplier_id,s.name supplier_name,r.receiving_location_id,l.name location_name,
      r.invoice_number,r.currency,r.payment_status,r.received_at,r.created_at,count(b.id) line_count,coalesce(sum(b.quantity),0) unit_count,coalesce(sum(b.quantity*b.unit_cost),0) total_cost
    from public.stock_receipts r join public.branches br on br.id=r.branch_id join public.suppliers s on s.id=r.supplier_id join public.locations l on l.id=r.receiving_location_id left join public.stock_batches b on b.receipt_id=r.id
    where public.can_access_branch(r.branch_id) and (p_branch_id is null or r.branch_id=p_branch_id)
      and (p_query is null or r.receipt_no ilike '%'||btrim(p_query)||'%' or coalesce(r.invoice_number,'') ilike '%'||btrim(p_query)||'%')
    group by r.id,br.name,s.name,l.name order by r.received_at desc limit p_limit offset p_offset) x;
  return jsonb_build_object('items',v_items,'total',v_total);
end; $$;

create or replace function public.list_inventory_balances(p_branch_id uuid default null,p_location_id uuid default null,p_query text default null,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_total bigint;
begin
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri'; end if;
  select count(*) into v_total from public.inventory_balances ib join public.locations l on l.id=ib.location_id join public.products p on p.id=ib.product_id
   where l.branch_id is not null and public.can_access_branch(l.branch_id) and (p_branch_id is null or l.branch_id=p_branch_id) and (p_location_id is null or l.id=p_location_id)
    and (p_query is null or p.name ilike '%'||btrim(p_query)||'%' or p.sku ilike '%'||btrim(p_query)||'%');
  select coalesce(jsonb_agg(to_jsonb(x) order by x.product_name,x.location_name),'[]'::jsonb) into v_items from(
   select ib.location_id,l.name location_name,l.type location_type,l.branch_id,br.name branch_name,ib.product_id,p.name product_name,p.sku,p.retail_price,
    ib.on_hand,ib.reserved,ib.on_hand-ib.reserved available,ib.updated_at,(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1) image
   from public.inventory_balances ib join public.locations l on l.id=ib.location_id join public.branches br on br.id=l.branch_id join public.products p on p.id=ib.product_id
   where public.can_access_branch(l.branch_id) and (p_branch_id is null or l.branch_id=p_branch_id) and (p_location_id is null or l.id=p_location_id)
    and (p_query is null or p.name ilike '%'||btrim(p_query)||'%' or p.sku ilike '%'||btrim(p_query)||'%')
   order by p.name,l.name limit p_limit offset p_offset)x;
  return jsonb_build_object('items',v_items,'total',v_total);
end; $$;
create or replace function public.get_inventory_unit_passport(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb; v_branch uuid;
begin
  select l.branch_id into v_branch from public.inventory_units u join public.locations l on l.id=u.location_id
   where upper(u.qr_code)=upper(btrim(p_code)) or upper(coalesce(u.serial_number,''))=upper(btrim(p_code)) limit 1;
  if v_branch is null then raise exception 'QR yoki seriya bo‘yicha mahsulot topilmadi' using errcode='P0002'; end if;
  if not public.can_access_branch(v_branch) then raise exception 'Bu mahsulot uchun ruxsat yo‘q' using errcode='42501'; end if;
  select jsonb_build_object('id',u.id,'qr_code',u.qr_code,'serial_number',u.serial_number,'status',u.status,'version',u.version,
    'product',jsonb_build_object('id',p.id,'name',p.name,'sku',p.sku,'barcode',p.barcode,'brand_name',br.name,'retail_price',p.retail_price,
      'image',(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1)),
    'batch',jsonb_build_object('id',b.id,'receipt_id',r.id,'receipt_no',r.receipt_no,'received_at',r.received_at,'supplier_name',s.name,'unit_cost',b.unit_cost),
    'location',jsonb_build_object('id',l.id,'name',l.name,'type',l.type,'branch_id',l.branch_id,'branch_name',branch.name),
    'movements',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'type',m.movement_type,'occurred_at',m.occurred_at,'from_location',fl.name,'to_location',tl.name,'reason',m.reason,'actor_name',a.full_name) order by m.occurred_at desc)
      from public.inventory_movements m left join public.locations fl on fl.id=m.from_location_id left join public.locations tl on tl.id=m.to_location_id left join public.profiles a on a.id=m.actor_id where m.unit_id=u.id),'[]'::jsonb))
  into v_result from public.inventory_units u join public.products p on p.id=u.product_id left join public.brands br on br.id=p.brand_id
   left join public.stock_batches b on b.id=u.batch_id left join public.stock_receipts r on r.id=b.receipt_id left join public.suppliers s on s.id=b.supplier_id
   join public.locations l on l.id=u.location_id join public.branches branch on branch.id=l.branch_id
   where upper(u.qr_code)=upper(btrim(p_code)) or upper(coalesce(u.serial_number,''))=upper(btrim(p_code)) limit 1;
  return v_result;
end; $$;

create or replace function public.place_inventory_units(p_target_location_id uuid,p_codes jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_branch uuid; v_code text; v_unit record; v_count integer:=0;
begin
  if jsonb_typeof(p_codes)<>'array' or jsonb_array_length(p_codes)=0 or jsonb_array_length(p_codes)>500 then raise exception 'QR ro‘yxati noto‘g‘ri'; end if;
  select branch_id into v_branch from public.locations where id=p_target_location_id and is_active and type in ('store','warehouse');
  if v_branch is null then raise exception 'Maqsad joylashuvi topilmadi'; end if; perform public.require_inventory_operator(v_branch);
  for v_code in select distinct btrim(value#>>'{}') from jsonb_array_elements(p_codes) loop
    select u.*,l.branch_id into v_unit from public.inventory_units u join public.locations l on l.id=u.location_id
      where upper(u.qr_code)=upper(v_code) or upper(coalesce(u.serial_number,''))=upper(v_code) for update of u;
    if not found then raise exception 'Kod topilmadi: %',v_code; end if;
    if v_unit.branch_id<>v_branch or v_unit.status not in ('available','returned') then raise exception 'Mahsulotni bu joyga o‘tkazib bo‘lmaydi: %',v_code; end if;
    if v_unit.location_id<>p_target_location_id then
      update public.inventory_units set location_id=p_target_location_id,status='available',version=version+1 where id=v_unit.id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,unit_cost,reference_type,reference_id,actor_id,metadata)
      values(v_unit.id,v_unit.product_id,v_unit.batch_id,'adjustment',v_unit.location_id,p_target_location_id,1,null,'placement',p_request_id,auth.uid(),jsonb_build_object('operation','placement'));
    end if; v_count:=v_count+1;
  end loop;
  return jsonb_build_object('placed_count',v_count,'target_location_id',p_target_location_id);
end; $$;

drop policy if exists inventory_movements_staff_read on public.inventory_movements;
create policy inventory_movements_staff_read on public.inventory_movements for select to authenticated using(
  exists(select 1 from public.locations l where l.id=from_location_id and l.branch_id is not null and public.can_access_branch(l.branch_id))
  or exists(select 1 from public.locations l where l.id=to_location_id and l.branch_id is not null and public.can_access_branch(l.branch_id)));
create policy inventory_balances_staff_read on public.inventory_balances for select to authenticated using(
  exists(select 1 from public.locations l where l.id=location_id and l.branch_id is not null and public.can_access_branch(l.branch_id)));
grant select on public.inventory_balances to authenticated;

revoke all on function public.refresh_inventory_balance(uuid,uuid),public.sync_inventory_balance_from_unit(),public.require_inventory_operator(uuid) from public,anon,authenticated;
revoke all on function public.get_inventory_references(uuid),public.get_stock_receipt(uuid),public.receive_stock(jsonb,jsonb,uuid),public.list_stock_receipts(uuid,text,integer,integer),public.list_inventory_balances(uuid,uuid,text,integer,integer),public.get_inventory_unit_passport(text),public.place_inventory_units(uuid,jsonb,uuid) from public,anon;
grant execute on function public.get_inventory_references(uuid),public.get_stock_receipt(uuid),public.receive_stock(jsonb,jsonb,uuid),public.list_stock_receipts(uuid,text,integer,integer),public.list_inventory_balances(uuid,uuid,text,integer,integer),public.get_inventory_unit_passport(text),public.place_inventory_units(uuid,jsonb,uuid) to authenticated;
grant execute on function public.refresh_inventory_balance(uuid,uuid),public.sync_inventory_balance_from_unit(),public.require_inventory_operator(uuid),public.get_inventory_references(uuid),public.get_stock_receipt(uuid),public.receive_stock(jsonb,jsonb,uuid),public.list_stock_receipts(uuid,text,integer,integer),public.list_inventory_balances(uuid,uuid,text,integer,integer),public.get_inventory_unit_passport(text),public.place_inventory_units(uuid,jsonb,uuid) to service_role;
commit;
