-- Transfer birlik qidiruv natijalariga ombordagi qoldiq va oxirgi partiya narxi/sanasini qo'shish.
begin;

create or replace function public.find_transfer_unit(p_branch_id uuid,p_from_location_id uuid,p_code text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb; v_rate numeric; v_rate_date date;
begin
  perform public.require_source_shipper(p_branch_id);
  if not exists(select 1 from public.locations where id=p_from_location_id and branch_id=p_branch_id and is_active and type in('store','warehouse')) then
    raise exception 'Faol jo''natish joyi topilmadi' using errcode='P0002';
  end if;
  if nullif(btrim(p_code),'') is null then raise exception 'QR yoki seriya raqami talab qilinadi' using errcode='22023'; end if;
  select r.rate,r.rate_date into v_rate,v_rate_date from public.exchange_rates r
  where r.currency_from='USD' and r.currency_to='UZS' order by r.rate_date desc limit 1;
  if v_rate is null or v_rate<=0 or v_rate_date is null then
    raise exception 'USD/UZS ulgurji kursi topilmadi' using errcode='P0002';
  end if;
  select jsonb_build_object('id',u.id,'qr_code',u.qr_code,'serial_number',u.serial_number,'location_id',u.location_id,
    'product_id',p.id,'product_name',p.name,'sku',p.sku,'cost_price',coalesce(b.unit_cost,p.cost_price),
    'wholesale_price',round(coalesce(b.wholesale_price,p.wholesale_price)/v_rate,2),'currency','USD',
    'wholesale_exchange_rate',v_rate,'wholesale_rate_date',v_rate_date,
    'available_count',(select count(*) from public.inventory_units iu
      where iu.product_id=p.id and iu.location_id=p_from_location_id and iu.status='available' and iu.active_transfer_id is null),
    'latest_batch_price',round(coalesce(
      (select lb.wholesale_price from public.stock_batches lb join public.stock_receipts lr on lr.id=lb.receipt_id
        where lb.product_id=p.id and lb.wholesale_price is not null and lb.wholesale_price>0
        order by lr.received_at desc limit 1),
      p.wholesale_price)/v_rate,2),
    'latest_batch_date',(select lr.received_at::date from public.stock_batches lb join public.stock_receipts lr on lr.id=lb.receipt_id
      where lb.product_id=p.id and lb.wholesale_price is not null and lb.wholesale_price>0
      order by lr.received_at desc limit 1),
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
    raise exception 'Faol jo''natish joyi topilmadi' using errcode='P0002';
  end if;
  if v_query is null or length(v_query)<2 then raise exception 'Qidiruv kamida 2 belgidan iborat bo''lsin' using errcode='22023'; end if;
  if p_limit is null or p_limit not between 1 and 50 then raise exception 'Natijalar limiti noto''g''ri' using errcode='22023'; end if;
  select r.rate,r.rate_date into v_rate,v_rate_date from public.exchange_rates r
  where r.currency_from='USD' and r.currency_to='UZS' order by r.rate_date desc limit 1;
  if v_rate is null or v_rate<=0 or v_rate_date is null then
    raise exception 'USD/UZS ulgurji kursi topilmadi' using errcode='P0002';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(q) order by q.product_name,q.qr_code) from(
    select u.id,u.qr_code,u.serial_number,u.location_id,p.id product_id,p.name product_name,p.sku,
      coalesce(b.unit_cost,p.cost_price) cost_price,
      round(coalesce(b.wholesale_price,p.wholesale_price)/v_rate,2) wholesale_price,'USD'::text currency,
      v_rate wholesale_exchange_rate,v_rate_date wholesale_rate_date,
      (select count(*) from public.inventory_units iu
        where iu.product_id=p.id and iu.location_id=p_from_location_id and iu.status='available' and iu.active_transfer_id is null) available_count,
      round(coalesce(
        (select lb.wholesale_price from public.stock_batches lb join public.stock_receipts lr on lr.id=lb.receipt_id
          where lb.product_id=p.id and lb.wholesale_price is not null and lb.wholesale_price>0
          order by lr.received_at desc limit 1),
        p.wholesale_price)/v_rate,2) latest_batch_price,
      (select lr.received_at::date from public.stock_batches lb join public.stock_receipts lr on lr.id=lb.receipt_id
        where lb.product_id=p.id and lb.wholesale_price is not null and lb.wholesale_price>0
        order by lr.received_at desc limit 1) latest_batch_date,
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

notify pgrst,'reload schema';
commit;
