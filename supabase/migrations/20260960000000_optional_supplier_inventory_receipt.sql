-- Migration: Make supplier_id optional in stock_receipts so internal inventory
-- (Inventarizatsiya) can be saved without requiring a supplier.

begin;

-- 1. Make supplier_id nullable on stock_receipts
alter table public.stock_receipts alter column supplier_id drop not null;

-- 2. Update receive_stock RPC to allow null supplier_id
create or replace function public.receive_stock(
  p_header jsonb,
  p_lines jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt uuid;
  v_existing uuid;
  v_existing_hash text;
  v_request_hash text;
  v_branch uuid;
  v_location uuid;
  v_supplier uuid;
  v_line jsonb;
  v_batch uuid;
  v_unit uuid;
  v_product record;
  v_variant_id uuid;
  v_qty integer;
  v_cost numeric(18,2);
  v_retail numeric(18,2);
  v_wholesale numeric(18,2);
  v_minimum numeric(18,2);
  v_effective_minimum numeric(18,2);
  v_line_no integer := 0;
  v_seq integer;
  v_serials jsonb;
  v_line_qr text;
  v_qr_attempt integer;
  v_total_units integer := 0;
  v_total_cost numeric(18,2) := 0;
  v_paid_amount numeric(18,2) := 0;
  v_debt numeric(18,2) := 0;
  v_currency text;
  v_payment_status text;
  v_received_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'Idempotency key talab qilinadi' using errcode = '22023';
  end if;
  if p_header is null or jsonb_typeof(p_header) is distinct from 'object' then
    raise exception 'Partiya sarlavhasi obyekt bo''lishi kerak' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Partiya qatorlari massiv bo''lishi kerak' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) not between 1 and 50 then
    raise exception 'Partiyada 1 tadan 50 tagacha mahsulot qatori bo''lishi kerak' using errcode = '22023';
  end if;

  v_request_hash := encode(
    extensions.digest(
      convert_to(jsonb_build_object('header', p_header, 'lines', p_lines)::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_branch := nullif(btrim(p_header->>'branch_id'), '')::uuid;
  v_location := nullif(btrim(p_header->>'receiving_location_id'), '')::uuid;
  v_supplier := nullif(btrim(p_header->>'supplier_id'), '')::uuid;
  if v_branch is null then raise exception 'Filial talab qilinadi' using errcode = '22023'; end if;
  if v_location is null then raise exception 'Qabul joyi talab qilinadi' using errcode = '22023'; end if;

  perform public.require_inventory_operator(v_branch);

  select id, request_hash into v_existing, v_existing_hash
  from public.stock_receipts
  where branch_id = v_branch and idempotency_key = p_idempotency_key;
  if v_existing is not null then
    if v_existing_hash is not null and v_existing_hash is distinct from v_request_hash then
      raise exception 'Takroriy kalit boshqa partiya ma''lumotlari bilan yuborildi' using errcode = '22023';
    end if;
    return public.get_stock_receipt(v_existing);
  end if;

  if not exists(select 1 from public.branches where id = v_branch and is_active) then
    raise exception 'Faol filial topilmadi' using errcode = 'P0002';
  end if;
  if not exists(
    select 1 from public.locations
    where id = v_location and branch_id = v_branch and is_active and type in ('warehouse','store')
  ) then
    raise exception 'Qabul joylashuvi filialga mos emas' using errcode = '23514';
  end if;

  -- Only check supplier if specified (inventory receipts have no supplier)
  if v_supplier is not null and not exists(select 1 from public.suppliers where id = v_supplier and is_active) then
    raise exception 'Faol ta''minotchi topilmadi' using errcode = 'P0002';
  end if;

  if nullif(btrim(p_header->>'receipt_no'), '') is null
    or upper(btrim(p_header->>'receipt_no')) !~ '^[A-Z0-9._-]{3,64}$' then
    raise exception 'Partiya raqami 3-64 ta lotin harfi, raqam, nuqta, pastki chiziq yoki chiziqchadan iborat bo''lishi kerak'
      using errcode = '22023';
  end if;

  v_currency := upper(coalesce(nullif(btrim(p_header->>'currency'), ''), 'USD'));
  if v_currency not in ('USD','UZS','EUR') then
    raise exception 'Valyuta USD, UZS yoki EUR bo''lishi kerak' using errcode = '22023';
  end if;

  v_payment_status := lower(coalesce(nullif(btrim(p_header->>'payment_status'), ''), 'paid'));
  if v_payment_status not in ('unpaid','partial','paid') then
    raise exception 'To''lov holati noto''g''ri' using errcode = '22023';
  end if;

  v_received_at := coalesce(nullif(btrim(p_header->>'received_at'), '')::timestamptz, now());
  v_paid_amount := coalesce(nullif(btrim(p_header->>'paid_amount'), '')::numeric, 0);
  if not (v_paid_amount > '-Infinity'::numeric and v_paid_amount < 'Infinity'::numeric)
    or v_paid_amount < 0 then
    raise exception 'To''langan summa chekli va manfiy bo''lmagan son bo''lishi kerak' using errcode = '22023';
  end if;

  insert into public.stock_receipts(
    receipt_no, branch_id, supplier_id, receiving_location_id,
    invoice_number, currency, payment_status, paid_amount,
    received_at, notes, idempotency_key, request_hash, created_by
  ) values (
    upper(btrim(p_header->>'receipt_no')),
    v_branch,
    v_supplier,
    v_location,
    nullif(btrim(p_header->>'invoice_number'), ''),
    v_currency,
    v_payment_status,
    v_paid_amount,
    v_received_at,
    nullif(btrim(p_header->>'notes'), ''),
    p_idempotency_key,
    v_request_hash,
    auth.uid()
  ) returning id into v_receipt;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_line_no := v_line_no + 1;
    if v_line is null or jsonb_typeof(v_line) is distinct from 'object' then
      raise exception '%-qator ma''lumotlari noto''g''ri', v_line_no using errcode = '22023';
    end if;

    v_qty := nullif(btrim(v_line->>'quantity'), '')::integer;
    v_cost := coalesce(nullif(btrim(v_line->>'unit_cost'), '')::numeric, 0);
    v_retail := nullif(nullif(btrim(v_line->>'retail_price'), '')::numeric, 0);
    v_wholesale := nullif(nullif(btrim(v_line->>'wholesale_price'), '')::numeric, 0);
    v_minimum := nullif(nullif(btrim(v_line->>'minimum_sale_price'), '')::numeric, 0);
    v_serials := coalesce(v_line->'serial_numbers', '[]'::jsonb);
    v_variant_id := nullif(btrim(v_line->>'variant_id'), '')::uuid;

    if v_qty is null or v_qty < 1 or v_qty > 1000 or v_total_units + v_qty > 5000 then
      raise exception '%-qator miqdori noto''g''ri (qator: 1..1000, jami: 5000 gacha)', v_line_no
        using errcode = '22023';
    end if;
    if not (v_cost > '-Infinity'::numeric and v_cost < 'Infinity'::numeric) or v_cost < 0 then
      raise exception '%-qator tannarxi chekli va manfiy bo''lmagan son bo''lishi kerak', v_line_no
        using errcode = '22023';
    end if;
    if (v_retail is not null and not (v_retail > '-Infinity'::numeric and v_retail < 'Infinity'::numeric))
      or (v_wholesale is not null and not (v_wholesale > '-Infinity'::numeric and v_wholesale < 'Infinity'::numeric))
      or (v_minimum is not null and not (v_minimum > '-Infinity'::numeric and v_minimum < 'Infinity'::numeric))
      or coalesce(v_retail, 0) < 0
      or coalesce(v_wholesale, 0) < 0
      or coalesce(v_minimum, 0) < 0 then
      raise exception '%-qator narxlari chekli va manfiy bo''lmagan sonlar bo''lishi kerak', v_line_no
        using errcode = '22023';
    end if;

    select id, track_individual_units, minimum_sale_price, wholesale_price
    into v_product
    from public.products
    where id = nullif(btrim(v_line->>'product_id'), '')::uuid and status <> 'archived';
    if not found then
      raise exception '%-qator mahsuloti topilmadi', v_line_no using errcode = 'P0002';
    end if;

    if v_variant_id is not null and not exists(
      select 1 from public.product_variants where id = v_variant_id and product_id = v_product.id
    ) then
      raise exception '%-qator rang varianti bu mahsulotga tegishli emas', v_line_no using errcode = '23514';
    end if;

    if jsonb_typeof(v_serials) is distinct from 'array'
      or jsonb_array_length(v_serials) not in (0, v_qty) then
      raise exception '%-qator seriya raqamlari soni miqdorga teng bo''lishi kerak', v_line_no
        using errcode = '22023';
    end if;

    if v_retail is not null then
      v_effective_minimum := coalesce(v_minimum, v_product.minimum_sale_price, 0);
    else
      v_effective_minimum := coalesce(v_product.minimum_sale_price, 0);
    end if;

    insert into public.stock_batches(
      receipt_id, line_no, supplier_id, product_id, variant_id, location_id,
      reference, received_at, expires_at, quantity, unit_cost, created_by,
      retail_price, wholesale_price, minimum_sale_price
    ) values (
      v_receipt,
      v_line_no,
      v_supplier,
      v_product.id,
      v_variant_id,
      v_location,
      upper(btrim(p_header->>'receipt_no')),
      v_received_at,
      nullif(btrim(v_line->>'expires_at'), '')::timestamptz,
      v_qty,
      v_cost,
      auth.uid(),
      v_retail,
      v_wholesale,
      v_minimum
    ) returning id into v_batch;

    if v_variant_id is not null then
      if v_retail is not null then
        update public.product_variants
        set retail_price = v_retail,
            wholesale_price = v_wholesale,
            minimum_sale_price = v_effective_minimum,
            promotion_price = case
              when promotion_price between v_effective_minimum and v_retail then promotion_price
              else null
            end
        where id = v_variant_id;
      end if;
      if v_cost > 0 then
        update public.products set cost_price = case when cost_price = 0 then v_cost else cost_price end where id = v_product.id;
      end if;
    elsif v_retail is not null then
      update public.products
      set cost_price = case when v_cost > 0 then v_cost else cost_price end,
          retail_price = v_retail,
          wholesale_price = v_wholesale,
          minimum_sale_price = v_effective_minimum,
          promotion_price = case
            when promotion_price between v_effective_minimum and v_retail then promotion_price
            else null
          end
      where id = v_product.id;
    elsif v_cost > 0 then
      update public.products set cost_price = case when cost_price = 0 then v_cost else cost_price end where id = v_product.id;
    end if;

    -- Umumiy QR generatsiya
    v_line_qr := null;
    for v_qr_attempt in 1..20 loop
      v_line_qr := 'TB' || lpad((floor(random() * 90000000 + 10000000)::bigint)::text, 8, '0');
      exit when not exists(select 1 from public.inventory_units where qr_code = v_line_qr);
    end loop;
    if exists(select 1 from public.inventory_units where qr_code = v_line_qr) then
      v_line_qr := 'TB' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
    end if;

    for v_seq in 1..v_qty loop
      insert into public.inventory_units(
        product_id, variant_id, batch_id, qr_code, serial_number, location_id, status, unit_sequence
      ) values (
        v_product.id,
        v_variant_id,
        v_batch,
        v_line_qr,
        nullif(btrim(v_serials->>(v_seq - 1)), ''),
        v_location,
        'available',
        v_seq
      ) returning id into v_unit;

      insert into public.inventory_movements(
        unit_id, product_id, batch_id, movement_type, to_location_id,
        quantity, unit_cost, reference_type, reference_id, actor_id, metadata
      ) values (
        v_unit,
        v_product.id,
        v_batch,
        'received',
        v_location,
        1,
        v_cost,
        'stock_receipt',
        v_receipt,
        auth.uid(),
        jsonb_build_object('line_no', v_line_no, 'unit_sequence', v_seq)
      );
    end loop;

    v_total_units := v_total_units + v_qty;
    v_total_cost := v_total_cost + (v_qty * v_cost);
  end loop;

  if v_payment_status = 'paid' then
    v_paid_amount := v_total_cost;
    v_debt := 0;
  elsif v_payment_status = 'unpaid' then
    v_paid_amount := 0;
    v_debt := v_total_cost;
  else
    if v_paid_amount <= 0 or v_paid_amount >= v_total_cost then
      raise exception 'Qisman to''lov 0 dan katta va jami summadan kichik bo''lishi kerak'
        using errcode = '22023';
    end if;
    v_debt := v_total_cost - v_paid_amount;
  end if;

  update public.stock_receipts
  set paid_amount = v_paid_amount
  where id = v_receipt and paid_amount is distinct from v_paid_amount;

  -- Only record debt if supplier is present
  if v_debt > 0 and v_supplier is not null then
    update public.suppliers set balance = balance + v_debt where id = v_supplier;
  end if;

  return public.get_stock_receipt(v_receipt);
exception
  when unique_violation then
    select id, request_hash into v_existing, v_existing_hash
    from public.stock_receipts
    where branch_id = v_branch and idempotency_key = p_idempotency_key;
    if v_existing is not null then
      if v_existing_hash is not null and v_existing_hash is distinct from v_request_hash then
        raise exception 'Takroriy kalit boshqa partiya ma''lumotlari bilan yuborildi' using errcode = '22023';
      end if;
      return public.get_stock_receipt(v_existing);
    end if;
    raise;
end $$;

-- 3. Update get_stock_receipt to use LEFT JOIN on suppliers
create or replace function public.get_stock_receipt(p_receipt_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_branch uuid;
begin
  select branch_id into v_branch from public.stock_receipts where id = p_receipt_id;
  if v_branch is null then raise exception 'Partiya topilmadi' using errcode = 'P0002'; end if;
  if not public.can_access_branch(v_branch) then raise exception 'Ruxsat yo‘q' using errcode = '42501'; end if;

  select to_jsonb(r) || jsonb_build_object(
    'branch_name', br.name,
    'supplier_name', coalesce(s.name, case when r.receipt_no like 'INV-%' then 'Inventarizatsiya' else 'Ta’minotchi ko‘rsatilmagan' end),
    'location_name', l.name,
    'lines', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', b.id, 'line_no', b.line_no, 'product_id', b.product_id,
          'product_name', p.name, 'sku', p.sku, 'variant_id', b.variant_id,
          'variant_color', v.color_name, 'quantity', b.quantity, 'unit_cost', b.unit_cost,
          'qr_count', (select count(*) from public.inventory_units u where u.batch_id = b.id)
        ) order by b.line_no
      )
      from public.stock_batches b
      join public.products p on p.id = b.product_id
      left join public.product_variants v on v.id = b.variant_id
      where b.receipt_id = r.id
    ), '[]'::jsonb)
  )
  into v_result
  from public.stock_receipts r
  join public.branches br on br.id = r.branch_id
  left join public.suppliers s on s.id = r.supplier_id
  join public.locations l on l.id = r.receiving_location_id
  where r.id = p_receipt_id;

  return v_result;
end;
$$;

-- 4. Update list_stock_receipts to use LEFT JOIN on suppliers
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

  select coalesce(jsonb_agg(to_jsonb(x) order by x.received_at desc), '[]'::jsonb) into v_items from (
    select
      r.id, r.receipt_no, r.branch_id, br.name as branch_name,
      r.supplier_id, coalesce(s.name, case when r.receipt_no like 'INV-%' then 'Inventarizatsiya' else 'Ta’minotchi ko‘rsatilmagan' end) as supplier_name,
      r.receiving_location_id, l.name as location_name,
      r.invoice_number, r.currency, r.payment_status, r.received_at, r.created_at,
      count(b.id) as line_count,
      coalesce(sum(b.quantity), 0) as unit_count,
      coalesce(sum(b.quantity * case when b.unit_cost > 0 then b.unit_cost else coalesce(p.cost_price, 0) end), 0) as total_cost,
      coalesce(sum(b.quantity * p.retail_price), 0) as total_retail
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
    order by r.received_at desc
    limit p_limit offset p_offset
  ) x;

  return jsonb_build_object('items', v_items, 'total', v_total);
end;
$$;

commit;

notify pgrst, 'reload schema';
