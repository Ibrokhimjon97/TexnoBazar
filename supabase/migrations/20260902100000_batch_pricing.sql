-- Per-batch pricing: each batch can override product prices
-- When a new shipment arrives at a different price, these fields track what prices apply to units in this batch.

alter table public.stock_batches
  add column if not exists retail_price numeric(18,2),
  add column if not exists wholesale_price numeric(18,2),
  add column if not exists minimum_sale_price numeric(18,2);

comment on column public.stock_batches.retail_price is 'Batch-specific retail price; overrides products.retail_price when set';
comment on column public.stock_batches.wholesale_price is 'Batch-specific wholesale price; overrides products.wholesale_price when set';
comment on column public.stock_batches.minimum_sale_price is 'Batch-specific minimum sale price; overrides products.minimum_sale_price when set';

-- Update receive_stock to accept batch pricing
-- We modify the existing function to handle the new optional price fields in lines
create or replace function public.receive_stock(p_header jsonb, p_lines jsonb, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid; v_supplier uuid; v_location uuid; v_receipt uuid;
  v_line jsonb; v_line_no integer := 0; v_product record; v_batch uuid;
  v_qty integer; v_cost numeric; v_serials jsonb; v_seq integer;
  v_serial text; v_qr text; v_prefix text;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Kamida bitta mahsulot qatori kerak';
  end if;

  v_branch := (p_header->>'branch_id')::uuid;
  if v_branch is null then raise exception 'branch_id talab qilinadi'; end if;
  perform public.require_inventory_operator(v_branch);

  v_supplier := (p_header->>'supplier_id')::uuid;
  if not exists(select 1 from public.suppliers where id = v_supplier and is_active) then
    raise exception 'Ta''minotchi topilmadi yoki faol emas';
  end if;

  v_location := (p_header->>'receiving_location_id')::uuid;
  if not exists(select 1 from public.locations where id = v_location and branch_id = v_branch and is_active) then
    raise exception 'Qabul joyi filialga tegishli emas yoki faol emas';
  end if;

  insert into public.stock_receipts(receipt_no, branch_id, supplier_id, receiving_location_id,
    invoice_number, currency, payment_status, received_at, notes, idempotency_key, created_by)
  values(
    btrim(p_header->>'receipt_no'),
    v_branch, v_supplier, v_location,
    nullif(btrim(p_header->>'invoice_number'),''),
    coalesce(nullif(btrim(p_header->>'currency'),''),'UZS'),
    coalesce(nullif(btrim(p_header->>'payment_status'),''),'unpaid'),
    coalesce((p_header->>'received_at')::timestamptz, now()),
    nullif(btrim(p_header->>'notes'),''),
    p_idempotency_key, auth.uid()
  ) returning id into v_receipt;

  v_prefix := 'TNB' || lpad(floor(random()*10)::text,1,'0') || '-';

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_line_no := v_line_no + 1;
    v_qty := (v_line->>'quantity')::integer;
    v_cost := coalesce((v_line->>'unit_cost')::numeric, 0);
    v_serials := coalesce(v_line->'serial_numbers', '[]'::jsonb);

    if v_qty < 1 or v_qty > 10000 then raise exception 'Miqdor 1..10000 orasida bo''lishi kerak'; end if;

    select id, track_individual_units into v_product from public.products
      where id = (v_line->>'product_id')::uuid and status <> 'archived';
    if not found then raise exception 'Mahsulot topilmadi'; end if;

    if jsonb_typeof(v_serials) <> 'array' or jsonb_array_length(v_serials) not in (0, v_qty) then
      raise exception 'Seriya raqamlari soni miqdorga teng bo''lishi kerak';
    end if;

    insert into public.stock_batches(receipt_id, line_no, supplier_id, product_id, location_id,
      reference, received_at, expires_at, quantity, unit_cost, created_by,
      retail_price, wholesale_price, minimum_sale_price)
    values(
      v_receipt, v_line_no, v_supplier, v_product.id, v_location,
      p_header->>'receipt_no',
      coalesce((p_header->>'received_at')::timestamptz, now()),
      nullif(v_line->>'expires_at','')::timestamptz,
      v_qty, v_cost, auth.uid(),
      nullif((v_line->>'retail_price')::numeric, 0),
      nullif((v_line->>'wholesale_price')::numeric, 0),
      nullif((v_line->>'minimum_sale_price')::numeric, 0)
    ) returning id into v_batch;

    -- Update product prices if new batch prices are provided
    if coalesce((v_line->>'retail_price')::numeric, 0) > 0 then
      update public.products set
        cost_price = case when v_cost > 0 then v_cost else cost_price end,
        retail_price = (v_line->>'retail_price')::numeric,
        minimum_sale_price = coalesce(nullif((v_line->>'minimum_sale_price')::numeric, 0), minimum_sale_price),
        wholesale_price = case
          when nullif((v_line->>'wholesale_price')::numeric, 0) is null then null
          when (v_line->>'wholesale_price')::numeric between
            coalesce(nullif((v_line->>'minimum_sale_price')::numeric, 0), minimum_sale_price, 0)
            and (v_line->>'retail_price')::numeric
          then (v_line->>'wholesale_price')::numeric
          else wholesale_price end
      where id = v_product.id;
    end if;

    for v_seq in 1..v_qty loop
      v_serial := null;
      if jsonb_array_length(v_serials) > 0 then
        v_serial := btrim((v_serials->(v_seq-1))::text, '"');
      end if;
      v_qr := v_prefix || encode(gen_random_bytes(6), 'hex');
      insert into public.inventory_units(product_id, batch_id, qr_code, serial_number, location_id, status)
      values(v_product.id, v_batch, v_qr, v_serial, v_location, 'available');
    end loop;

    insert into public.inventory_movements(unit_id, product_id, batch_id, movement_type,
      to_location_id, quantity, unit_cost, reference_type, reference_id, actor_id)
    select u.id, u.product_id, u.batch_id, 'received', u.location_id, 1, v_cost, 'stock_receipt', v_receipt, auth.uid()
    from public.inventory_units u where u.batch_id = v_batch;
  end loop;

  return public.get_stock_receipt(v_receipt);
end; $$;

-- Update get_inventory_unit_passport to include batch pricing
-- So seller can see both batch-specific prices and product-level (latest) prices
create or replace function public.get_inventory_unit_passport(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb; v_branch uuid; v_found boolean;
begin
  select l.branch_id, true into v_branch, v_found from public.inventory_units u
    join public.locations l on l.id = u.location_id
    where upper(u.qr_code) = upper(btrim(p_code)) or upper(coalesce(u.serial_number,'')) = upper(btrim(p_code)) limit 1;
  if not coalesce(v_found, false) then raise exception 'QR yoki seriya bo''yicha mahsulot topilmadi' using errcode = 'P0002'; end if;
  if not (
    (v_branch is not null and public.can_access_branch(v_branch))
    or public.has_role(array['superadmin','admin']::public.app_role[], null)
    or exists(select 1 from public.inventory_units u join public.sale_lines sl on sl.unit_id = u.id
      join public.sales s on s.id = sl.sale_id
      where (upper(u.qr_code) = upper(btrim(p_code)) or upper(coalesce(u.serial_number,'')) = upper(btrim(p_code)))
        and public.can_access_branch(s.branch_id))
  ) then raise exception 'Bu mahsulot uchun ruxsat yo''q' using errcode = '42501'; end if;

  select jsonb_build_object(
    'id', u.id, 'qr_code', u.qr_code, 'serial_number', u.serial_number, 'status', u.status, 'version', u.version,
    'product', jsonb_build_object(
      'id', p.id, 'name', p.name, 'sku', p.sku, 'barcode', p.barcode, 'brand_name', br.name,
      'retail_price', p.retail_price, 'cost_price', p.cost_price,
      'wholesale_price', p.wholesale_price, 'minimum_sale_price', p.minimum_sale_price,
      'image', (select m.public_url from public.product_media m where m.product_id = p.id order by m.is_primary desc, m.sort_order limit 1)),
    'batch', jsonb_build_object(
      'id', b.id, 'receipt_id', r.id, 'receipt_no', r.receipt_no, 'received_at', r.received_at,
      'supplier_name', s.name, 'unit_cost', b.unit_cost,
      'retail_price', b.retail_price, 'wholesale_price', b.wholesale_price, 'minimum_sale_price', b.minimum_sale_price),
    'latest_batch_prices', (
      select jsonb_build_object(
        'retail_price', lb.retail_price, 'wholesale_price', lb.wholesale_price,
        'minimum_sale_price', lb.minimum_sale_price, 'unit_cost', lb.unit_cost, 'received_at', lr.received_at)
      from public.stock_batches lb
      join public.stock_receipts lr on lr.id = lb.receipt_id
      where lb.product_id = p.id and lb.retail_price is not null
      order by lr.received_at desc limit 1),
    'location', jsonb_build_object('id', l.id, 'name', l.name, 'type', l.type, 'branch_id', l.branch_id, 'branch_name', branch.name),
    'stamps', jsonb_build_object(
      'was_sold', exists(select 1 from public.inventory_movements m where m.unit_id = u.id and m.movement_type = 'sold'),
      'was_returned', exists(select 1 from public.inventory_movements m where m.unit_id = u.id and m.movement_type = 'returned'),
      'sold_count', (select count(*) from public.inventory_movements m where m.unit_id = u.id and m.movement_type = 'sold'),
      'returned_count', (select count(*) from public.inventory_movements m where m.unit_id = u.id and m.movement_type = 'returned')),
    'movements', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'type', m.movement_type,
        'label', public.movement_type_label(m.movement_type::text), 'occurred_at', m.occurred_at,
        'from_location', fl.name, 'to_location', tl.name, 'reason', m.reason, 'actor_name', a.full_name,
        'reference_type', m.reference_type, 'reference_id', m.reference_id, 'unit_cost', m.unit_cost, 'metadata', m.metadata)
      order by m.occurred_at desc, m.id desc)
      from public.inventory_movements m
      left join public.locations fl on fl.id = m.from_location_id
      left join public.locations tl on tl.id = m.to_location_id
      left join public.profiles a on a.id = m.actor_id
      where m.unit_id = u.id), '[]'::jsonb))
  into v_result
  from public.inventory_units u
  join public.products p on p.id = u.product_id
  left join public.brands br on br.id = p.brand_id
  left join public.stock_batches b on b.id = u.batch_id
  left join public.stock_receipts r on r.id = b.receipt_id
  left join public.suppliers s on s.id = b.supplier_id
  join public.locations l on l.id = u.location_id
  left join public.branches branch on branch.id = l.branch_id
  where upper(u.qr_code) = upper(btrim(p_code)) or upper(coalesce(u.serial_number,'')) = upper(btrim(p_code)) limit 1;
  return v_result;
end; $$;

-- Also update find_pos_unit to include batch pricing for seller
create or replace function public.find_pos_unit(p_branch_id uuid, p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if not public.can_access_branch(p_branch_id) then raise exception 'Filialga ruxsat yo''q' using errcode = '42501'; end if;
  select jsonb_build_object(
    'id', u.id, 'qr_code', u.qr_code, 'serial_number', u.serial_number, 'status', u.status,
    'product_id', p.id, 'product_name', p.name, 'sku', p.sku, 'brand_name', br.name,
    'retail_price', coalesce(b.retail_price, p.retail_price),
    'wholesale_price', coalesce(b.wholesale_price, p.wholesale_price),
    'minimum_sale_price', coalesce(b.minimum_sale_price, p.minimum_sale_price),
    'cost_price', p.cost_price, 'unit_cost', b.unit_cost, 'tax_rate', p.tax_rate,
    'batch_retail_price', b.retail_price,
    'product_retail_price', p.retail_price,
    'latest_batch_retail', (select lb.retail_price from public.stock_batches lb
      join public.stock_receipts lr on lr.id = lb.receipt_id
      where lb.product_id = p.id and lb.retail_price is not null
      order by lr.received_at desc limit 1),
    'image', (select m.public_url from public.product_media m where m.product_id = p.id order by m.is_primary desc, m.sort_order limit 1),
    'available_branch_count', (select count(*) from public.inventory_units iu
      join public.locations il on il.id = iu.location_id
      where iu.product_id = p.id and il.branch_id = p_branch_id and iu.status = 'available'))
  into v_result
  from public.inventory_units u
  join public.products p on p.id = u.product_id
  left join public.brands br on br.id = p.brand_id
  left join public.stock_batches b on b.id = u.batch_id
  join public.locations l on l.id = u.location_id
  where l.branch_id = p_branch_id and u.status = 'available'
    and (upper(u.qr_code) = upper(btrim(p_code)) or upper(coalesce(u.serial_number,'')) = upper(btrim(p_code))
      or upper(coalesce(p.barcode,'')) = upper(btrim(p_code)) or upper(p.sku) = upper(btrim(p_code)))
  limit 1;
  if v_result is null then raise exception 'Mahsulot topilmadi yoki sotuvga tayyor emas' using errcode = 'P0002'; end if;
  return v_result;
end; $$;
