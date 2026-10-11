-- Migration: Batch/Inventarizatsiya full edit, item thumbnails in cards, default newest sort, and stats
begin;

-- 1. Update list_stock_receipts:
-- - Sorts by r.created_at desc, r.receipt_no desc by default
-- - Returns items array with product_name, variant_color, quantity, image_url for each batch
-- - Returns total_min_price for overall batch minimum sale price stats
create or replace function public.list_stock_receipts(
  p_branch_id uuid default null,
  p_query text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  v_total bigint;
begin
  if p_limit not between 1 and 100 or p_offset < 0 then
    raise exception 'Sahifalash noto''g''ri';
  end if;

  select count(*) into v_total
  from public.stock_receipts r
  where public.can_access_branch(r.branch_id)
    and (p_branch_id is null or r.branch_id = p_branch_id)
    and (p_query is null or r.receipt_no ilike '%' || btrim(p_query) || '%' or coalesce(r.invoice_number, '') ilike '%' || btrim(p_query) || '%');

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc, x.receipt_no desc), '[]'::jsonb) into v_items from (
    select
      r.id, r.receipt_no, r.branch_id, br.name as branch_name,
      r.supplier_id, coalesce(s.name, case when r.receipt_no like 'INV-%' then 'Inventarizatsiya' else 'Ta’minotchi ko‘rsatilmagan' end) as supplier_name,
      r.receiving_location_id, l.name as location_name,
      r.invoice_number, r.currency, r.payment_status, r.received_at, r.created_at,
      count(b.id) as line_count,
      coalesce(sum(b.quantity), 0) as unit_count,
      coalesce(sum(b.quantity * case when b.unit_cost > 0 then b.unit_cost else coalesce(p.cost_price, 0) end), 0) as total_cost,
      coalesce(sum(b.quantity * coalesce(p.retail_price, 0)), 0) as total_retail,
      coalesce(sum(b.quantity * coalesce(p.minimum_sale_price, p.retail_price, 0)), 0) as total_min_price,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'batch_id', sb.id,
          'product_id', sb.product_id,
          'product_name', sp.name,
          'variant_id', sb.variant_id,
          'variant_color', sv.color_name,
          'quantity', sb.quantity,
          'unit_cost', sb.unit_cost,
          'image_url', coalesce((select pm.public_url from public.product_media pm where pm.product_id = sp.id order by pm.is_primary desc, pm.sort_order asc limit 1), sp.seo_image_url)
        ) order by sb.line_no)
        from public.stock_batches sb
        join public.products sp on sp.id = sb.product_id
        left join public.product_variants sv on sv.id = sb.variant_id
        where sb.receipt_id = r.id
      ), '[]'::jsonb) as items
    from public.stock_receipts r
    join public.branches br on br.id = r.branch_id
    left join public.suppliers s on s.id = r.supplier_id
    join public.locations l on l.id = r.receiving_location_id
    left join public.stock_batches b on b.receipt_id = r.id
    left join public.products p on p.id = b.product_id
    where public.can_access_branch(r.branch_id)
      and (p_branch_id is null or r.branch_id = p_branch_id)
      and (p_query is null or r.receipt_no ilike '%' || btrim(p_query) || '%' or coalesce(r.invoice_number, '') ilike '%' || btrim(p_query) || '%')
    group by r.id, br.name, s.name, l.name
    order by r.created_at desc, r.receipt_no desc
    limit p_limit offset p_offset
  ) x;

  return jsonb_build_object('items', v_items, 'total', v_total);
end;
$$;

-- 2. Update update_stock_receipt to allow manager to fully edit:
-- receiving location, lines quantity, unit cost, retail price, color variant, invoice, etc.
create or replace function public.update_stock_receipt(p_receipt_id uuid, p_updates jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.stock_receipts%rowtype;
  v_total numeric(18,2);
  v_supplier uuid;
  v_status text;
  v_paid numeric(18,2);
  v_payment_change boolean;
  v_new_location uuid;
  v_line jsonb;
  v_batch_id uuid;
  v_batch public.stock_batches%rowtype;
  v_new_qty integer;
  v_old_qty integer;
  v_diff integer;
  v_avail integer;
  v_color text;
  v_var_id uuid;
  v_seq integer;
  v_qr text;
  v_uc numeric(18,2);
  v_rp numeric(18,2);
  v_wp numeric(18,2);
  v_mp numeric(18,2);
begin
  select * into v_r from public.stock_receipts where id = p_receipt_id for update;
  if not found then raise exception 'Partiya topilmadi' using errcode = 'P0002'; end if;
  perform public.require_inventory_operator(v_r.branch_id);

  if p_updates is null or jsonb_typeof(p_updates) is distinct from 'object' then
    raise exception 'Yangilanish obyekti talab qilinadi' using errcode = '22023';
  end if;

  -- 1. Supplier
  if p_updates ? 'supplier_id' then
    v_supplier := nullif(btrim(p_updates->>'supplier_id'), '')::uuid;
    if v_supplier is not null and not exists(select 1 from public.suppliers where id = v_supplier and is_active) then
      raise exception 'Faol ta''minotchi topilmadi' using errcode = 'P0002';
    end if;
  else
    v_supplier := v_r.supplier_id;
  end if;

  -- 2. Receiving location
  if p_updates ? 'receiving_location_id' and nullif(btrim(p_updates->>'receiving_location_id'), '') is not null then
    v_new_location := (p_updates->>'receiving_location_id')::uuid;
    if not exists(select 1 from public.locations where id = v_new_location and branch_id = v_r.branch_id and is_active) then
      raise exception 'Noto''g''ri qabul joylashuvi' using errcode = 'P0002';
    end if;
    if v_new_location is distinct from v_r.receiving_location_id then
      update public.inventory_units set location_id = v_new_location
      where batch_id in (select id from public.stock_batches where receipt_id = p_receipt_id)
        and status = 'available';
    end if;
  else
    v_new_location := v_r.receiving_location_id;
  end if;

  -- 3. Lines update
  if p_updates ? 'lines' and jsonb_typeof(p_updates->'lines') = 'array' then
    for v_line in select * from jsonb_array_elements(p_updates->'lines') loop
      v_batch_id := (v_line->>'id')::uuid;
      select * into v_batch from public.stock_batches where id = v_batch_id and receipt_id = p_receipt_id for update;
      if found then
        -- A. Prices
        if v_line ? 'unit_cost' and nullif(btrim(v_line->>'unit_cost'), '') is not null then
          v_uc := (v_line->>'unit_cost')::numeric;
          update public.stock_batches set unit_cost = v_uc where id = v_batch_id;
        end if;
        v_rp := case when v_line ? 'retail_price' and nullif(btrim(v_line->>'retail_price'), '') is not null then (v_line->>'retail_price')::numeric else null end;
        v_wp := case when v_line ? 'wholesale_price' and nullif(btrim(v_line->>'wholesale_price'), '') is not null then (v_line->>'wholesale_price')::numeric else null end;
        v_mp := case when v_line ? 'minimum_sale_price' and nullif(btrim(v_line->>'minimum_sale_price'), '') is not null then (v_line->>'minimum_sale_price')::numeric else null end;
        if v_rp is not null or v_wp is not null or v_mp is not null then
          update public.products set
            retail_price = coalesce(v_rp, retail_price),
            wholesale_price = coalesce(v_wp, wholesale_price),
            minimum_sale_price = coalesce(v_mp, minimum_sale_price)
          where id = v_batch.product_id;
          if v_batch.variant_id is not null then
            update public.product_variants set
              retail_price = coalesce(v_rp, retail_price),
              wholesale_price = coalesce(v_wp, wholesale_price),
              minimum_sale_price = coalesce(v_mp, minimum_sale_price)
            where id = v_batch.variant_id;
          end if;
        end if;

        -- B. Color / Variant
        if v_line ? 'variant_color' then
          v_color := nullif(btrim(v_line->>'variant_color'), '');
          if v_color is not null then
            select id into v_var_id from public.product_variants
            where product_id = v_batch.product_id and lower(btrim(color_name)) = lower(v_color) limit 1;
            if v_var_id is null then
              insert into public.product_variants(product_id, color_name, retail_price, wholesale_price, minimum_sale_price, is_active)
              values(v_batch.product_id, v_color, v_rp, v_wp, v_mp, true)
              returning id into v_var_id;
            end if;
            update public.stock_batches set variant_id = v_var_id where id = v_batch_id;
            update public.inventory_units set variant_id = v_var_id
            where batch_id = v_batch_id and status = 'available';
          end if;
        end if;

        -- C. Quantity
        if v_line ? 'quantity' and nullif(btrim(v_line->>'quantity'), '') is not null then
          v_new_qty := (v_line->>'quantity')::integer;
          v_old_qty := v_batch.quantity;
          if v_new_qty > v_old_qty then
            v_diff := v_new_qty - v_old_qty;
            select qr_code into v_qr from public.inventory_units where batch_id = v_batch_id limit 1;
            select coalesce(max(unit_sequence), 0) into v_seq from public.inventory_units where batch_id = v_batch_id;
            for i in 1..v_diff loop
              insert into public.inventory_units(
                product_id, variant_id, batch_id, qr_code, location_id, status, unit_sequence
              ) values (
                v_batch.product_id, v_batch.variant_id, v_batch_id,
                v_qr, v_new_location, 'available', v_seq + i
              );
            end loop;
            update public.stock_batches set quantity = v_new_qty where id = v_batch_id;
          elsif v_new_qty < v_old_qty and v_new_qty > 0 then
            v_diff := v_old_qty - v_new_qty;
            select count(*) into v_avail from public.inventory_units where batch_id = v_batch_id and status = 'available';
            if v_avail < v_diff then
              raise exception 'Miqdorni % tagacha kamaytirib bo''lmadi, chunki tovarlar sotilgan yoki ko''chirilgan', v_new_qty using errcode = '22023';
            end if;
            delete from public.inventory_units where id in (
              select id from public.inventory_units
              where batch_id = v_batch_id and status = 'available'
              order by unit_sequence desc limit v_diff
            );
            update public.stock_batches set quantity = v_new_qty where id = v_batch_id;
          end if;
        end if;
      end if;
    end loop;
  end if;

  -- 4. Re-calculate totals
  select coalesce(sum(quantity * unit_cost), 0) into v_total
  from public.stock_batches where receipt_id = p_receipt_id;

  -- 5. Payment status & amount
  v_status := case when p_updates ? 'payment_status'
    then lower(nullif(btrim(p_updates->>'payment_status'), '')) else v_r.payment_status end;
  if v_status not in ('unpaid','partial','paid') then
    raise exception 'To''lov holati noto''g''ri' using errcode = '22023';
  end if;

  v_payment_change := p_updates ? 'paid_amount'
    or ((p_updates ? 'payment_status') and v_status is distinct from v_r.payment_status);
  v_paid := v_r.paid_amount;
  if v_payment_change then
    if p_updates ? 'paid_amount' then
      v_paid := coalesce(nullif(btrim(p_updates->>'paid_amount'), '')::numeric, 0);
    elsif v_status = 'paid' then
      v_paid := v_total;
    elsif v_status = 'unpaid' then
      v_paid := 0;
    end if;
  end if;

  -- 6. Update receipt header
  update public.stock_receipts set
    supplier_id = v_supplier,
    receiving_location_id = v_new_location,
    currency = case when p_updates ? 'currency' then coalesce(nullif(btrim(p_updates->>'currency'), ''), currency) else currency end,
    invoice_number = case when p_updates ? 'invoice_number' then nullif(btrim(p_updates->>'invoice_number'), '') else invoice_number end,
    payment_status = v_status,
    paid_amount = v_paid,
    received_at = coalesce(nullif(btrim(p_updates->>'received_at'), '')::timestamptz, received_at),
    notes = case when p_updates ? 'notes' then nullif(btrim(p_updates->>'notes'), '') else notes end,
    updated_at = now()
  where id = p_receipt_id returning * into v_r;

  return public.get_stock_receipt(p_receipt_id);
end;
$$;

-- 3. Enhance attach_product_media so products.seo_image_url is automatically updated
create or replace function public.attach_product_media(
  p_actor_id uuid,
  p_product_id uuid,
  p_r2_key text,
  p_public_url text,
  p_mime_type text,
  p_bytes bigint,
  p_alt_text text default null,
  p_variant_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_primary boolean;
begin
  perform public.require_catalog_actor(p_actor_id);
  if not exists(select 1 from public.products where id=p_product_id) then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if;
  if p_variant_id is not null and not exists(select 1 from public.product_variants where id=p_variant_id and product_id=p_product_id) then
    raise exception 'Variant bu mahsulotga tegishli emas' using errcode='P0002';
  end if;
  v_primary := not exists(select 1 from public.product_media where product_id=p_product_id and variant_id is not distinct from p_variant_id);
  insert into public.product_media(product_id,variant_id,r2_key,public_url,mime_type,bytes,alt_text,sort_order,is_primary)
  values(p_product_id,p_variant_id,p_r2_key,p_public_url,p_mime_type,p_bytes,nullif(btrim(p_alt_text),''),
    coalesce((select max(sort_order)+1 from public.product_media where product_id=p_product_id and variant_id is not distinct from p_variant_id),0),v_primary)
  returning id into v_id;

  -- Set seo_image_url as canonical product thumbnail if null or if this is primary media
  if v_primary or (select seo_image_url from public.products where id=p_product_id) is null then
    update public.products set seo_image_url = p_public_url where id = p_product_id;
  end if;

  return v_id;
end;
$$;

grant execute on function public.list_stock_receipts(uuid,text,integer,integer) to authenticated, service_role;
grant execute on function public.update_stock_receipt(uuid,jsonb) to authenticated, service_role;
grant execute on function public.attach_product_media(uuid,uuid,text,text,text,bigint,text,uuid) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
