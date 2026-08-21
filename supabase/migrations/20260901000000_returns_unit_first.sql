-- Qaytarish (sale returns) — birlik markazidagi jarayon:
--  * QR / seriya skaneri yoki qo'lda kiritish orqali birlikni topish
--  * Birlik haqiqatda shu do'konda sotilganini isbotlash (chek, sotuvchi, mijoz, narx)
--  * Menejer tasdiqlaganda birlik qoldiqqa qaytadi (tannarx va sotilish narxi bilan)
--  * Birlik hayot siklida "Sotildi" va "Qaytarildi" muhrlari saqlanadi
--  * Tarixni qidiruv / QR / sana oralig'i bo'yicha kuzatish
--
-- Muhim: qayta sotiladigan birlik status='available' bo'lib qoladi, chunki POS
-- (find_pos_unit / list_pos_units) faqat 'available' birlikni sotadi. "Qaytarildi"
-- muhri inventory_movements dagi movement_type='returned' qatori bilan beriladi.
begin;

-- -----------------------------------------------------------------------------
-- Yorliq yordamchilari
-- -----------------------------------------------------------------------------

create or replace function public.movement_type_label(p_type text)
returns text language sql immutable set search_path='' as $$
  select case btrim(coalesce(p_type,''))
    when 'received' then 'Qabul qilindi'
    when 'transfer_out' then 'Transferga jo‘natildi'
    when 'transfer_in' then 'Transferdan qabul qilindi'
    when 'reserved' then 'Rezervlandi'
    when 'reservation_released' then 'Rezerv bo‘shatildi'
    when 'sold' then 'Sotildi'
    when 'returned' then 'Qaytarildi'
    when 'writeoff' then 'Hisobdan chiqarildi'
    when 'adjustment' then 'Tuzatish'
    else btrim(coalesce(p_type,'')) end
$$;

create or replace function public.return_condition_label(p_condition text)
returns text language sql immutable set search_path='' as $$
  select case btrim(coalesce(p_condition,''))
    when 'resellable' then 'Qayta sotiladi'
    when 'damaged' then 'Shikastlangan'
    when 'defective' then 'Nuqsonli'
    else null end
$$;

-- -----------------------------------------------------------------------------
-- QR / seriya bo'yicha qaytariladigan birlikni topish va sotuvni isbotlash
-- -----------------------------------------------------------------------------

create or replace function public.find_sale_return_unit(p_branch_id uuid,p_code text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_code text:=nullif(btrim(p_code),'');
  v_u public.inventory_units%rowtype;
  v_sale public.sales%rowtype;
  v_line public.sale_lines%rowtype;
  v_eligible boolean:=true; v_reason text; v_sale_branch uuid; v_sale_branch_name text;
  v_pending jsonb; v_provider_count integer:=0; v_line_count integer:=0; v_warning text;
  v_result jsonb;
begin
  if p_branch_id is null then raise exception 'Filial talab qilinadi' using errcode='22023'; end if;
  perform public.require_pos_manager(p_branch_id);
  if v_code is null then raise exception 'QR yoki seriya raqami talab qilinadi' using errcode='22023'; end if;

  select * into v_u from public.inventory_units
    where upper(qr_code)=upper(v_code) or upper(coalesce(serial_number,''))=upper(v_code) limit 1;
  if not found then
    raise exception 'QR yoki seriya bo‘yicha birlik topilmadi: %',v_code using errcode='P0002';
  end if;

  -- Eng oxirgi sotuv qatori: birlik qaytarilgandan keyin qayta sotilishi mumkin.
  select sl.* into v_line from public.sale_lines sl join public.sales s on s.id=sl.sale_id
    where sl.unit_id=v_u.id order by s.sold_at desc,sl.created_at desc limit 1;
  if found then select * into v_sale from public.sales where id=v_line.sale_id; end if;

  if v_sale.id is null then
    v_eligible=false; v_reason='Bu birlik hech qachon sotilmagan — qaytarish uchun sotuv tarixi yo‘q.';
  else
    v_sale_branch=v_sale.branch_id;
    select name into v_sale_branch_name from public.branches where id=v_sale.branch_id;
    if v_sale_branch is distinct from p_branch_id then
      v_eligible=false;
      v_reason='Bu birlik boshqa filialda sotilgan: '||coalesce(v_sale_branch_name,'—')||'. Qaytarishni shu filial bajaradi.';
    elsif v_sale.status='void' then
      v_eligible=false; v_reason='Asl sotuv bekor qilingan (void) — qaytarish mumkin emas.';
    elsif v_u.status<>'sold' or v_u.sold_sale_id is distinct from v_sale.id then
      v_eligible=false;
      v_reason='Birlik hozirda sotilgan holatda emas (holat: '||v_u.status::text||'). Ehtimol allaqachon qaytarilgan yoki hisobdan chiqarilgan.';
    elsif exists(select 1 from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id
      where x.sale_line_id=v_line.id and r.status in('requested','approved','completed')) then
      v_eligible=false; v_reason='Bu birlik uchun qaytarish allaqachon mavjud yoki jarayonda.';
    end if;
  end if;

  if v_sale.id is not null then
    select jsonb_build_object('id',r.id,'return_no',r.return_no,'status',r.status,'kind',r.kind,
      'refund_amount',r.refund_amount,'created_at',r.created_at)
    into v_pending from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id
      where x.sale_line_id=v_line.id and r.status in('requested','approved') order by r.created_at desc limit 1;
    select count(*) into v_line_count from public.sale_lines where sale_id=v_sale.id;
    select count(*) into v_provider_count from public.sale_payments sp join public.payment_methods pm on pm.id=sp.payment_method_id
      where sp.sale_id=v_sale.id and pm.code in('click','payme') and sp.status in('paid','partially_refunded');
    if v_provider_count>0 and v_line_count>1 then
      v_warning='Sotuv Click/Payme orqali to‘langan. Provayder qismiy qaytarishni qo‘llamaydi — chekdagi barcha birliklarni birga qaytarish talab qilinishi mumkin.';
    end if;
  end if;

  select jsonb_build_object(
    'eligible',v_eligible,
    'reason',v_reason,
    'warning',v_warning,
    'unit',jsonb_build_object('id',u.id,'qr_code',u.qr_code,'serial_number',u.serial_number,'status',u.status,
      'status_label',case u.status::text when 'sold' then 'Sotilgan' when 'available' then 'Sotuvda'
        when 'returned' then 'Qaytarilgan' when 'written_off' then 'Hisobdan chiqarilgan'
        when 'reserved' then 'Rezervda' when 'in_transit' then 'Yo‘lda' else u.status::text end,
      'location_id',u.location_id,'location_name',l.name,'location_type',l.type,'branch_id',l.branch_id),
    'product',jsonb_build_object('id',p.id,'name',p.name,'sku',p.sku,'barcode',p.barcode,'brand_name',br.name,
      'retail_price',p.retail_price,'cost_price',p.cost_price,
      'image',(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1)),
    'batch',case when b.id is null then null else jsonb_build_object('id',b.id,'reference',b.reference,
      'received_at',b.received_at,'unit_cost',b.unit_cost,'supplier_name',sup.name) end,
    'unit_cost',coalesce(v_line.unit_cost,b.unit_cost,p.cost_price),
    'sale',case when v_sale.id is null then null else jsonb_build_object('id',v_sale.id,'sale_no',v_sale.sale_no,
      'status',v_sale.status,'sold_at',v_sale.sold_at,'total',v_sale.total,'branch_id',v_sale.branch_id,
      'branch_name',v_sale_branch_name,'line_count',v_line_count,
      'seller_id',v_sale.seller_id,'seller_name',(select full_name from public.profiles where id=v_sale.seller_id),
      'manager_name',(select full_name from public.profiles where id=v_sale.manager_id),
      'customer_id',v_sale.customer_id,
      'customer_name',(select full_name from public.customers where id=v_sale.customer_id),
      'customer_phone',(select phone from public.customers where id=v_sale.customer_id),
      'payment_methods',coalesce((select jsonb_agg(distinct pm.name) from public.sale_payments sp
        join public.payment_methods pm on pm.id=sp.payment_method_id where sp.sale_id=v_sale.id),'[]'::jsonb)) end,
    'sale_line',case when v_line.id is null then null else jsonb_build_object('id',v_line.id,
      'unit_cost',v_line.unit_cost,'unit_price',v_line.unit_price,'discount',v_line.discount,'tax',v_line.tax,
      'line_total',v_line.line_total,'max_refund',v_line.line_total) end,
    'pending_return',v_pending,
    'stamps',jsonb_build_object(
      'sold_count',(select count(*) from public.inventory_movements m where m.unit_id=u.id and m.movement_type='sold'),
      'returned_count',(select count(*) from public.inventory_movements m where m.unit_id=u.id and m.movement_type='returned'),
      'last_sold_at',(select max(m.occurred_at) from public.inventory_movements m where m.unit_id=u.id and m.movement_type='sold'),
      'last_returned_at',(select max(m.occurred_at) from public.inventory_movements m where m.unit_id=u.id and m.movement_type='returned')),
    'previous_returns',coalesce((select jsonb_agg(jsonb_build_object('return_no',r.return_no,'status',r.status,
        'kind',r.kind,'condition',x.condition,'condition_label',public.return_condition_label(x.condition),
        'refund_amount',x.refund_amount,'completed_at',r.completed_at,'created_at',r.created_at,
        'sale_no',os.sale_no) order by r.created_at desc)
      from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id
        join public.sales os on os.id=r.original_sale_id
      where x.unit_id=u.id),'[]'::jsonb),
    'default_resell_location_id',coalesce(
      (select l2.id from public.locations l2 where l2.id=u.location_id and l2.branch_id=p_branch_id
        and l2.is_active and l2.type in('store','warehouse')),
      (select l3.id from public.locations l3 where l3.branch_id=p_branch_id and l3.is_active and l3.type='store'
        order by l3.name limit 1))
  ) into v_result
  from public.inventory_units u
    join public.products p on p.id=u.product_id
    join public.locations l on l.id=u.location_id
    left join public.brands br on br.id=p.brand_id
    left join public.stock_batches b on b.id=u.batch_id
    left join public.suppliers sup on sup.id=b.supplier_id
  where u.id=v_u.id;

  return v_result;
end $$;

-- -----------------------------------------------------------------------------
-- Bir amalda qaytarib olish (so'rov -> tasdiq -> yakun)
-- -----------------------------------------------------------------------------

create or replace function public.execute_sale_return(
  p_branch_id uuid,
  p_unit_id uuid,
  p_condition text,
  p_reason text,
  p_refund_amount numeric default null,
  p_resell_location_id uuid default null,
  p_idempotency_key uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_key uuid:=coalesce(p_idempotency_key,gen_random_uuid());
  v_u public.inventory_units%rowtype;
  v_line public.sale_lines%rowtype;
  v_sale public.sales%rowtype;
  v_reason text; v_condition text; v_refund numeric(18,2); v_dest uuid;
  v_return jsonb; v_return_id uuid; v_row public.sale_returns%rowtype;
begin
  if p_branch_id is null or p_unit_id is null then
    raise exception 'Filial va birlik talab qilinadi' using errcode='22023';
  end if;
  perform public.require_pos_manager(p_branch_id);

  v_condition=btrim(coalesce(p_condition,''));
  if public.return_condition_label(v_condition) is null then
    raise exception 'Qaytarish holati noto‘g‘ri (resellable/damaged/defective)' using errcode='22023';
  end if;
  v_reason=nullif(btrim(coalesce(p_reason,'')),'');
  if v_reason is null or length(v_reason)<3 then
    raise exception 'Qaytarish sababi kamida 3 belgidan iborat bo‘lishi kerak' using errcode='22023';
  end if;
  if length(v_reason)>2000 then raise exception 'Sabab 2000 belgidan oshmasligi kerak' using errcode='22023'; end if;

  select * into v_u from public.inventory_units where id=p_unit_id for update;
  if not found then raise exception 'Birlik topilmadi' using errcode='P0002'; end if;

  select sl.* into v_line from public.sale_lines sl join public.sales s on s.id=sl.sale_id
    where sl.unit_id=v_u.id order by s.sold_at desc,sl.created_at desc limit 1;
  if not found then raise exception 'Bu birlik uchun sotuv qatori topilmadi' using errcode='P0002'; end if;
  select * into v_sale from public.sales where id=v_line.sale_id;
  if v_sale.branch_id is distinct from p_branch_id then
    raise exception 'Bu birlik boshqa filialda sotilgan; qaytarishni o‘sha filial bajaradi' using errcode='P0001';
  end if;
  if v_u.status<>'sold' or v_u.sold_sale_id is distinct from v_sale.id then
    raise exception 'Birlik sotilgan holatda emas (holat: %)',v_u.status::text using errcode='P0001';
  end if;

  v_refund=round(coalesce(p_refund_amount,v_line.line_total),2);
  if v_refund<0 or v_refund>v_line.line_total then
    raise exception 'Qaytarish summasi 0 va % orasida bo‘lishi kerak',v_line.line_total using errcode='22023';
  end if;

  select id into v_dest from public.locations
    where id=coalesce(p_resell_location_id,v_u.location_id) and branch_id=p_branch_id
      and is_active and type in('store','warehouse');
  if v_dest is null then
    select id into v_dest from public.locations where branch_id=p_branch_id and is_active and type='store'
      order by name limit 1;
  end if;
  if v_dest is null then raise exception 'Filialda faol do‘kon joylashuvi topilmadi' using errcode='P0002'; end if;

  -- Mavjud, sinovdan o'tgan jarayonni qayta ishlatamiz: so'rov -> tasdiq -> yakun.
  v_return=public.request_sale_return(v_line.sale_id,'return',v_reason,
    jsonb_build_array(jsonb_build_object('sale_line_id',v_line.id,'condition',v_condition,'refund_amount',v_refund)),
    v_key);
  v_return_id=(v_return->>'id')::uuid;
  perform public.approve_sale_return(v_return_id);
  perform public.complete_sale_return(v_return_id,v_dest,null::uuid);

  select * into v_row from public.sale_returns where id=v_return_id;
  return to_jsonb(v_row)||jsonb_build_object(
    'condition',v_condition,
    'condition_label',public.return_condition_label(v_condition),
    'unit_id',v_u.id,
    'unit_qr_code',v_u.qr_code,
    'unit_cost',v_line.unit_cost,
    'unit_price',v_line.unit_price,
    'resell_location_id',v_dest,
    'resell_location_name',(select name from public.locations where id=v_dest),
    'product_name',(select name from public.products where id=v_line.product_id),
    'sale_no',v_sale.sale_no,
    'restocked',v_condition='resellable');
end $$;

-- -----------------------------------------------------------------------------
-- Qaytarilgan tovarlar tarixi: sana/vaqt, tovar, QR, sabab, tannarx, sotuv narxi
-- -----------------------------------------------------------------------------

create or replace function public.list_sale_return_history(
  p_branch_id uuid,
  p_from date default null,
  p_to date default null,
  p_query text default null,
  p_condition text default null,
  p_status text default null,
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
  if nullif(btrim(coalesce(p_condition,'')),'') is not null and public.return_condition_label(btrim(p_condition)) is null then
    raise exception 'Holat filtri noto‘g‘ri' using errcode='22023';
  end if;
  if nullif(btrim(coalesce(p_status,'')),'') is not null
    and not exists(select 1 from unnest(enum_range(null::public.return_status)) x where x::text=btrim(p_status)) then
    raise exception 'Status filtri noto‘g‘ri' using errcode='22023';
  end if;
  v_q=nullif(btrim(coalesce(p_query,'')),'');
  v_month_start=date_trunc('month',(now() at time zone 'Asia/Tashkent'))::date;

  with return_rows as (
    select x.id line_id,r.id return_id,r.return_no,r.status,r.kind,r.reason,r.refund_amount return_total,
      coalesce(r.completed_at,r.created_at) occurred_at,r.created_at requested_at,r.completed_at,
      x.condition,x.refund_amount,x.quantity,
      sl.unit_cost,sl.unit_price,sl.line_total,
      s.id sale_id,s.sale_no,s.sold_at,
      p.id product_id,p.name product_name,p.sku,
      u.id unit_id,u.qr_code,u.serial_number,u.status unit_status,
      seller.full_name seller_name,actor.full_name actor_name,
      cust.full_name customer_name,cust.phone customer_phone,
      (select m.to_location_id from public.inventory_movements m
        where m.unit_id=u.id and m.reference_type='sale_return' and m.reference_id=r.id limit 1) restock_location_id
    from public.sale_return_lines x
      join public.sale_returns r on r.id=x.return_id
      join public.sale_lines sl on sl.id=x.sale_line_id
      join public.sales s on s.id=r.original_sale_id
      join public.products p on p.id=sl.product_id
      join public.inventory_units u on u.id=x.unit_id
      left join public.profiles seller on seller.id=s.seller_id
      left join public.profiles actor on actor.id=r.requested_by
      left join public.customers cust on cust.id=r.customer_id
    where r.branch_id=p_branch_id
      and (p_from is null or coalesce(r.completed_at,r.created_at)>=public.business_day_start(p_from))
      and (p_to is null or coalesce(r.completed_at,r.created_at)<public.business_day_start(p_to+1))
      and (nullif(btrim(coalesce(p_condition,'')),'') is null or x.condition=btrim(p_condition))
      and (nullif(btrim(coalesce(p_status,'')),'') is null or r.status::text=btrim(p_status))
      and (v_q is null or p.name ilike '%'||v_q||'%' or p.sku ilike '%'||v_q||'%'
        or u.qr_code ilike '%'||v_q||'%' or coalesce(u.serial_number,'') ilike '%'||v_q||'%'
        or r.return_no ilike '%'||v_q||'%' or s.sale_no ilike '%'||v_q||'%'
        or coalesce(r.reason,'') ilike '%'||v_q||'%' or coalesce(cust.full_name,'') ilike '%'||v_q||'%')
  ), month_rows as (
    select x.refund_amount,sl.unit_cost
    from public.sale_return_lines x
      join public.sale_returns r on r.id=x.return_id
      join public.sale_lines sl on sl.id=x.sale_line_id
    where r.branch_id=p_branch_id and r.status='completed'
      and coalesce(r.completed_at,r.created_at)>=public.business_day_start(v_month_start)
  )
  select jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
        'line_id',t.line_id,'return_id',t.return_id,'return_no',t.return_no,'status',t.status,'kind',t.kind,
        'occurred_at',t.occurred_at,'requested_at',t.requested_at,'completed_at',t.completed_at,
        'condition',t.condition,'condition_label',public.return_condition_label(t.condition),
        'refund_amount',t.refund_amount,'return_total',t.return_total,'reason',t.reason,
        'unit_cost',t.unit_cost,'unit_price',t.unit_price,'line_total',t.line_total,
        'sale_id',t.sale_id,'sale_no',t.sale_no,'sold_at',t.sold_at,'seller_name',t.seller_name,
        'actor_name',t.actor_name,'customer_name',t.customer_name,'customer_phone',t.customer_phone,
        'product_id',t.product_id,'product_name',t.product_name,'sku',t.sku,
        'unit_id',t.unit_id,'qr_code',t.qr_code,'serial_number',t.serial_number,'unit_status',t.unit_status,
        'restock_location_name',(select name from public.locations where id=t.restock_location_id))
      order by t.occurred_at desc,t.line_id)
      from (select * from return_rows order by occurred_at desc,line_id limit p_limit offset p_offset) t),'[]'::jsonb),
    'total',(select count(*) from return_rows),
    'document_count',(select count(distinct return_id) from return_rows),
    'refund_total',(select coalesce(sum(refund_amount),0) from return_rows),
    'cost_total',(select coalesce(sum(unit_cost*quantity),0) from return_rows),
    'sale_total',(select coalesce(sum(line_total),0) from return_rows),
    'month_refund',(select coalesce(sum(refund_amount),0) from month_rows),
    'month_units',(select count(*) from month_rows),
    'month_start',v_month_start,
    'by_condition',coalesce((select jsonb_agg(jsonb_build_object('condition',g.condition,
        'label',public.return_condition_label(g.condition),'units',g.units,'refund',g.refund,'cost',g.cost)
        order by g.refund desc)
      from (select condition,count(*) units,coalesce(sum(refund_amount),0) refund,
        coalesce(sum(unit_cost*quantity),0) cost from return_rows group by condition) g),'[]'::jsonb)
  ) into v_result;

  return v_result;
end $$;

-- -----------------------------------------------------------------------------
-- Birlik hayot sikli: "Sotildi" va "Qaytarildi" muhrlari bilan to'liq tarix
-- -----------------------------------------------------------------------------

create or replace function public.get_unit_lifecycle(p_code text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_u public.inventory_units%rowtype; v_branch uuid; v_result jsonb; v_code text:=nullif(btrim(p_code),'');
begin
  if v_code is null then raise exception 'QR yoki seriya raqami talab qilinadi' using errcode='22023'; end if;
  select * into v_u from public.inventory_units
    where upper(qr_code)=upper(v_code) or upper(coalesce(serial_number,''))=upper(v_code) limit 1;
  if not found then raise exception 'QR yoki seriya bo‘yicha birlik topilmadi' using errcode='P0002'; end if;

  -- Ruxsat: birlikning joriy filiali yoki uni sotgan filiallardan biri.
  select l.branch_id into v_branch from public.locations l where l.id=v_u.location_id;
  if not (
    (v_branch is not null and public.can_access_branch(v_branch))
    or public.has_role(array['superadmin','admin']::public.app_role[],null)
    or exists(select 1 from public.sale_lines sl join public.sales s on s.id=sl.sale_id
      where sl.unit_id=v_u.id and public.can_access_branch(s.branch_id))
  ) then
    raise exception 'Bu birlik uchun ruxsat yo‘q' using errcode='42501';
  end if;

  select jsonb_build_object(
    'unit',jsonb_build_object('id',u.id,'qr_code',u.qr_code,'serial_number',u.serial_number,'status',u.status,
      'version',u.version,'created_at',u.created_at,
      'location_id',u.location_id,'location_name',l.name,'location_type',l.type,
      'branch_id',l.branch_id,'branch_name',br.name),
    'product',jsonb_build_object('id',p.id,'name',p.name,'sku',p.sku,'barcode',p.barcode,'brand_name',brand.name,
      'retail_price',p.retail_price,'cost_price',p.cost_price,
      'image',(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1)),
    'batch',case when b.id is null then null else jsonb_build_object('id',b.id,'reference',b.reference,
      'received_at',b.received_at,'unit_cost',b.unit_cost,'supplier_name',sup.name,'receipt_no',rc.receipt_no) end,
    'stamps',jsonb_build_object(
      'was_sold',exists(select 1 from public.inventory_movements m where m.unit_id=u.id and m.movement_type='sold'),
      'was_returned',exists(select 1 from public.inventory_movements m where m.unit_id=u.id and m.movement_type='returned'),
      'was_written_off',exists(select 1 from public.inventory_movements m where m.unit_id=u.id and m.movement_type='writeoff'),
      'sold_count',(select count(*) from public.inventory_movements m where m.unit_id=u.id and m.movement_type='sold'),
      'returned_count',(select count(*) from public.inventory_movements m where m.unit_id=u.id and m.movement_type='returned'),
      'last_sold_at',(select max(m.occurred_at) from public.inventory_movements m where m.unit_id=u.id and m.movement_type='sold'),
      'last_returned_at',(select max(m.occurred_at) from public.inventory_movements m where m.unit_id=u.id and m.movement_type='returned')),
    'sales',coalesce((select jsonb_agg(jsonb_build_object('sale_id',s.id,'sale_no',s.sale_no,'status',s.status,
        'sold_at',s.sold_at,'branch_name',sb.name,'seller_name',sp.full_name,
        'customer_name',cu.full_name,'customer_phone',cu.phone,
        'unit_cost',sl.unit_cost,'unit_price',sl.unit_price,'discount',sl.discount,'tax',sl.tax,'line_total',sl.line_total,
        'returned',exists(select 1 from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id
          where x.sale_line_id=sl.id and r.status='completed')) order by s.sold_at desc)
      from public.sale_lines sl join public.sales s on s.id=sl.sale_id
        join public.branches sb on sb.id=s.branch_id
        left join public.profiles sp on sp.id=s.seller_id
        left join public.customers cu on cu.id=s.customer_id
      where sl.unit_id=u.id),'[]'::jsonb),
    'returns',coalesce((select jsonb_agg(jsonb_build_object('return_id',r.id,'return_no',r.return_no,'status',r.status,
        'kind',r.kind,'condition',x.condition,'condition_label',public.return_condition_label(x.condition),
        'refund_amount',x.refund_amount,'reason',r.reason,'created_at',r.created_at,'completed_at',r.completed_at,
        'sale_no',os.sale_no,'actor_name',ap.full_name) order by r.created_at desc)
      from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id
        join public.sales os on os.id=r.original_sale_id
        left join public.profiles ap on ap.id=r.requested_by
      where x.unit_id=u.id),'[]'::jsonb),
    'movements',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'type',m.movement_type,
        'label',public.movement_type_label(m.movement_type::text),'occurred_at',m.occurred_at,
        'from_location',fl.name,'to_location',tl.name,'quantity',m.quantity,'unit_cost',m.unit_cost,
        'reference_type',m.reference_type,'reference_id',m.reference_id,'reason',m.reason,
        'actor_name',a.full_name,'metadata',m.metadata) order by m.occurred_at desc,m.id desc)
      from public.inventory_movements m
        left join public.locations fl on fl.id=m.from_location_id
        left join public.locations tl on tl.id=m.to_location_id
        left join public.profiles a on a.id=m.actor_id
      where m.unit_id=u.id),'[]'::jsonb)
  ) into v_result
  from public.inventory_units u
    join public.products p on p.id=u.product_id
    join public.locations l on l.id=u.location_id
    left join public.branches br on br.id=l.branch_id
    left join public.brands brand on brand.id=p.brand_id
    left join public.stock_batches b on b.id=u.batch_id
    left join public.suppliers sup on sup.id=b.supplier_id
    left join public.stock_receipts rc on rc.id=b.receipt_id
  where u.id=v_u.id;

  return v_result;
end $$;

-- -----------------------------------------------------------------------------
-- Mavjud passport RPC larini tuzatish
-- -----------------------------------------------------------------------------

-- SYSTEM-WRITEOFF joylashuvida branch_id null bo'lgani uchun ilgari inner join
-- natijani yo'q qilardi; harakat qatorlariga sotuv/qaytarish havolalari qo'shildi.
create or replace function public.get_inventory_unit_passport(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb; v_branch uuid; v_found boolean;
begin
  select l.branch_id,true into v_branch,v_found from public.inventory_units u join public.locations l on l.id=u.location_id
   where upper(u.qr_code)=upper(btrim(p_code)) or upper(coalesce(u.serial_number,''))=upper(btrim(p_code)) limit 1;
  if not coalesce(v_found,false) then raise exception 'QR yoki seriya bo‘yicha mahsulot topilmadi' using errcode='P0002'; end if;
  if not (
    (v_branch is not null and public.can_access_branch(v_branch))
    or public.has_role(array['superadmin','admin']::public.app_role[],null)
    or exists(select 1 from public.inventory_units u join public.sale_lines sl on sl.unit_id=u.id
      join public.sales s on s.id=sl.sale_id
      where (upper(u.qr_code)=upper(btrim(p_code)) or upper(coalesce(u.serial_number,''))=upper(btrim(p_code)))
        and public.can_access_branch(s.branch_id))
  ) then raise exception 'Bu mahsulot uchun ruxsat yo‘q' using errcode='42501'; end if;
  select jsonb_build_object('id',u.id,'qr_code',u.qr_code,'serial_number',u.serial_number,'status',u.status,'version',u.version,
    'product',jsonb_build_object('id',p.id,'name',p.name,'sku',p.sku,'barcode',p.barcode,'brand_name',br.name,'retail_price',p.retail_price,
      'cost_price',p.cost_price,
      'image',(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1)),
    'batch',jsonb_build_object('id',b.id,'receipt_id',r.id,'receipt_no',r.receipt_no,'received_at',r.received_at,'supplier_name',s.name,'unit_cost',b.unit_cost),
    'location',jsonb_build_object('id',l.id,'name',l.name,'type',l.type,'branch_id',l.branch_id,'branch_name',branch.name),
    'stamps',jsonb_build_object(
      'was_sold',exists(select 1 from public.inventory_movements m where m.unit_id=u.id and m.movement_type='sold'),
      'was_returned',exists(select 1 from public.inventory_movements m where m.unit_id=u.id and m.movement_type='returned'),
      'sold_count',(select count(*) from public.inventory_movements m where m.unit_id=u.id and m.movement_type='sold'),
      'returned_count',(select count(*) from public.inventory_movements m where m.unit_id=u.id and m.movement_type='returned')),
    'movements',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'type',m.movement_type,
      'label',public.movement_type_label(m.movement_type::text),'occurred_at',m.occurred_at,
      'from_location',fl.name,'to_location',tl.name,'reason',m.reason,'actor_name',a.full_name,
      'reference_type',m.reference_type,'reference_id',m.reference_id,'unit_cost',m.unit_cost,'metadata',m.metadata)
      order by m.occurred_at desc,m.id desc)
      from public.inventory_movements m left join public.locations fl on fl.id=m.from_location_id left join public.locations tl on tl.id=m.to_location_id left join public.profiles a on a.id=m.actor_id where m.unit_id=u.id),'[]'::jsonb))
  into v_result from public.inventory_units u join public.products p on p.id=u.product_id left join public.brands br on br.id=p.brand_id
   left join public.stock_batches b on b.id=u.batch_id left join public.stock_receipts r on r.id=b.receipt_id left join public.suppliers s on s.id=b.supplier_id
   join public.locations l on l.id=u.location_id left join public.branches branch on branch.id=l.branch_id
   where upper(u.qr_code)=upper(btrim(p_code)) or upper(coalesce(u.serial_number,''))=upper(btrim(p_code)) limit 1;
  return v_result;
end; $$;

-- get_unit_passport mavjud bo'lmagan stock_batches.batch_number / cost_price
-- ustunlariga murojaat qilgani uchun ishga tushganda xato berardi; ACL ham yo'q edi.
create or replace function public.get_unit_passport(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb; v_branch uuid; v_found boolean;
begin
  if p_unit_id is null then raise exception 'Birlik identifikatori talab qilinadi' using errcode='22023'; end if;
  select l.branch_id,true into v_branch,v_found from public.inventory_units u
    join public.locations l on l.id=u.location_id where u.id=p_unit_id;
  if not coalesce(v_found,false) then raise exception 'Birlik topilmadi' using errcode='P0002'; end if;
  if not (
    (v_branch is not null and public.can_access_branch(v_branch))
    or public.has_role(array['superadmin','admin']::public.app_role[],null)
    or exists(select 1 from public.sale_lines sl join public.sales s on s.id=sl.sale_id
      where sl.unit_id=p_unit_id and public.can_access_branch(s.branch_id))
  ) then raise exception 'Bu birlik uchun ruxsat yo‘q' using errcode='42501'; end if;
  select jsonb_build_object('unit_id',u.id,'qr_code',u.qr_code,'serial_number',u.serial_number,'status',u.status,
    'product',jsonb_build_object('id',p.id,'name',p.name,'sku',p.sku,'retail_price',p.retail_price,
      'wholesale_price',p.wholesale_price,'cost_price',p.cost_price),
    'location',jsonb_build_object('id',l.id,'name',l.name,'type',l.type,'branch_id',l.branch_id),
    'batch',case when sb.id is null then null else jsonb_build_object('id',sb.id,'reference',sb.reference,
      'supplier',s.name,'received_at',sb.received_at,'unit_cost',sb.unit_cost) end)
  into v_result
  from public.inventory_units u
    join public.products p on p.id=u.product_id
    join public.locations l on l.id=u.location_id
    left join public.stock_batches sb on sb.id=u.batch_id
    left join public.suppliers s on s.id=sb.supplier_id
  where u.id=p_unit_id;
  return v_result;
end $$;

-- -----------------------------------------------------------------------------
-- Grantlar
-- -----------------------------------------------------------------------------

revoke all on function public.movement_type_label(text),public.return_condition_label(text),
  public.find_sale_return_unit(uuid,text),
  public.execute_sale_return(uuid,uuid,text,text,numeric,uuid,uuid),
  public.list_sale_return_history(uuid,date,date,text,text,text,integer,integer),
  public.get_unit_lifecycle(text) from public,anon,authenticated;

grant execute on function public.movement_type_label(text),public.return_condition_label(text),
  public.find_sale_return_unit(uuid,text),
  public.execute_sale_return(uuid,uuid,text,text,numeric,uuid,uuid),
  public.list_sale_return_history(uuid,date,date,text,text,text,integer,integer),
  public.get_unit_lifecycle(text) to authenticated;

grant execute on function public.get_inventory_unit_passport(text),public.get_unit_passport(uuid) to authenticated;
grant execute on all functions in schema public to service_role;

commit;
