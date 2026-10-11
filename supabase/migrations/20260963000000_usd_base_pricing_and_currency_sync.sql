-- Migration: USD Base Pricing and Automatic Exchange Rate Sync
-- When product or batch cost/prices are entered in USD, their USD values remain fixed.
-- When the USD/UZS exchange rate is updated, UZS prices recalculate dynamically (UZS = USD * new_rate),
-- while the original USD values NEVER change unless explicitly edited by a manager.

begin;

-- 1. Add USD pricing and currency columns
alter table public.products
  add column if not exists currency text default 'USD',
  add column if not exists cost_price_usd numeric(18,2),
  add column if not exists retail_price_usd numeric(18,2),
  add column if not exists wholesale_price_usd numeric(18,2),
  add column if not exists minimum_sale_price_usd numeric(18,2);

alter table public.stock_batches
  add column if not exists currency text default 'USD',
  add column if not exists unit_cost_usd numeric(18,2),
  add column if not exists retail_price_usd numeric(18,2),
  add column if not exists wholesale_price_usd numeric(18,2),
  add column if not exists minimum_sale_price_usd numeric(18,2);

alter table public.product_variants
  add column if not exists cost_price_usd numeric(18,2),
  add column if not exists retail_price_usd numeric(18,2),
  add column if not exists wholesale_price_usd numeric(18,2),
  add column if not exists minimum_sale_price_usd numeric(18,2);

-- 2. Backfill existing rows using current latest USD->UZS rate
do $$
declare
  v_rate numeric := 11850;
begin
  select rate into v_rate
  from public.exchange_rates
  where currency_from = 'USD' and currency_to = 'UZS'
  order by rate_date desc, created_at desc
  limit 1;
  
  if v_rate is null or v_rate <= 0 then
    v_rate := 11850;
  end if;

  -- Backfill stock_batches
  update public.stock_batches sb
  set
    unit_cost_usd = case when sb.unit_cost > 0 then round(sb.unit_cost / v_rate, 2) else 0 end,
    retail_price_usd = case when sb.retail_price > 0 then round(sb.retail_price / v_rate, 2) else null end,
    wholesale_price_usd = case when sb.wholesale_price > 0 then round(sb.wholesale_price / v_rate, 2) else null end,
    minimum_sale_price_usd = case when sb.minimum_sale_price > 0 then round(sb.minimum_sale_price / v_rate, 2) else null end,
    currency = coalesce((select btrim(r.currency::text) from public.stock_receipts r where r.id = sb.receipt_id), 'USD')
  where sb.unit_cost_usd is null;

  -- Backfill products
  update public.products p
  set
    cost_price_usd = case when p.cost_price > 0 then round(p.cost_price / v_rate, 2) else 0 end,
    retail_price_usd = case when p.retail_price > 0 then round(p.retail_price / v_rate, 2) else null end,
    wholesale_price_usd = case when p.wholesale_price > 0 then round(p.wholesale_price / v_rate, 2) else null end,
    minimum_sale_price_usd = case when p.minimum_sale_price > 0 then round(p.minimum_sale_price / v_rate, 2) else null end,
    currency = 'USD'
  where p.cost_price_usd is null;

  -- Backfill product_variants
  update public.product_variants pv
  set
    cost_price_usd = case when pv.cost_price > 0 then round(pv.cost_price / v_rate, 2) else 0 end,
    retail_price_usd = case when pv.retail_price > 0 then round(pv.retail_price / v_rate, 2) else null end,
    wholesale_price_usd = case when pv.wholesale_price > 0 then round(pv.wholesale_price / v_rate, 2) else null end,
    minimum_sale_price_usd = case when pv.minimum_sale_price > 0 then round(pv.minimum_sale_price / v_rate, 2) else null end
  where pv.retail_price_usd is null;
end $$;

-- 3. Procedure to recalculate UZS prices whenever USD/UZS exchange rate changes
create or replace function public.sync_usd_prices_on_rate_change(p_new_rate numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prod_count integer := 0;
  v_batch_count integer := 0;
  v_var_count integer := 0;
begin
  if p_new_rate is null or p_new_rate <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Invalid rate');
  end if;

  -- Update products that are USD-denominated
  with u as (
    update public.products
    set
      cost_price = case
        when cost_price_usd is not null and cost_price_usd > 0 then round(cost_price_usd * p_new_rate)
        else cost_price
      end,
      retail_price = case
        when retail_price_usd is not null and retail_price_usd > 0 then round(retail_price_usd * p_new_rate)
        else retail_price
      end,
      wholesale_price = case
        when wholesale_price_usd is not null and wholesale_price_usd > 0 then round(wholesale_price_usd * p_new_rate)
        else wholesale_price
      end,
      minimum_sale_price = case
        when minimum_sale_price_usd is not null and minimum_sale_price_usd > 0 then round(minimum_sale_price_usd * p_new_rate)
        else minimum_sale_price
      end,
      updated_at = now()
    where currency = 'USD'
       or (cost_price_usd is not null and cost_price_usd > 0)
       or (retail_price_usd is not null and retail_price_usd > 0)
    returning 1
  )
  select count(*) into v_prod_count from u;

  -- Update product variants
  with u as (
    update public.product_variants
    set
      retail_price = case
        when retail_price_usd is not null and retail_price_usd > 0 then round(retail_price_usd * p_new_rate)
        else retail_price
      end,
      wholesale_price = case
        when wholesale_price_usd is not null and wholesale_price_usd > 0 then round(wholesale_price_usd * p_new_rate)
        else wholesale_price
      end,
      minimum_sale_price = case
        when minimum_sale_price_usd is not null and minimum_sale_price_usd > 0 then round(minimum_sale_price_usd * p_new_rate)
        else minimum_sale_price
      end,
      cost_price = case
        when cost_price_usd is not null and cost_price_usd > 0 then round(cost_price_usd * p_new_rate)
        else cost_price
      end,
      updated_at = now()
    where (retail_price_usd is not null and retail_price_usd > 0)
       or (cost_price_usd is not null and cost_price_usd > 0)
    returning 1
  )
  select count(*) into v_var_count from u;

  -- Update stock batches
  with u as (
    update public.stock_batches
    set
      unit_cost = case
        when unit_cost_usd is not null and unit_cost_usd > 0 then round(unit_cost_usd * p_new_rate)
        else unit_cost
      end,
      retail_price = case
        when retail_price_usd is not null and retail_price_usd > 0 then round(retail_price_usd * p_new_rate)
        else retail_price
      end,
      wholesale_price = case
        when wholesale_price_usd is not null and wholesale_price_usd > 0 then round(wholesale_price_usd * p_new_rate)
        else wholesale_price
      end,
      minimum_sale_price = case
        when minimum_sale_price_usd is not null and minimum_sale_price_usd > 0 then round(minimum_sale_price_usd * p_new_rate)
        else minimum_sale_price
      end
    where currency = 'USD'
       or (unit_cost_usd is not null and unit_cost_usd > 0)
       or (retail_price_usd is not null and retail_price_usd > 0)
    returning 1
  )
  select count(*) into v_batch_count from u;

  return jsonb_build_object(
    'ok', true,
    'rate', p_new_rate,
    'products_updated', v_prod_count,
    'variants_updated', v_var_count,
    'batches_updated', v_batch_count
  );
end;
$$;

grant execute on function public.sync_usd_prices_on_rate_change(numeric) to authenticated, service_role;

-- 4. Trigger on exchange_rates to automatically execute price sync
create or replace function public.trg_exchange_rates_price_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_latest_rate numeric;
begin
  if (TG_OP = 'DELETE' and OLD.currency_from = 'USD' and OLD.currency_to = 'UZS')
     or (TG_OP in ('INSERT','UPDATE') and NEW.currency_from = 'USD' and NEW.currency_to = 'UZS') then
    
    select rate into v_latest_rate
    from public.exchange_rates
    where currency_from = 'USD' and currency_to = 'UZS'
    order by rate_date desc, created_at desc
    limit 1;

    if v_latest_rate is not null and v_latest_rate > 0 then
      perform public.sync_usd_prices_on_rate_change(v_latest_rate);
    end if;
  end if;
  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists trg_exchange_rates_price_sync on public.exchange_rates;
create trigger trg_exchange_rates_price_sync
after insert or update or delete on public.exchange_rates
for each row
execute function public.trg_exchange_rates_price_sync();

-- 5. Update receive_stock RPC to support unit_cost_usd and price_usd
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
  v_cost_usd numeric(18,2);
  v_retail numeric(18,2);
  v_retail_usd numeric(18,2);
  v_wholesale numeric(18,2);
  v_wholesale_usd numeric(18,2);
  v_minimum numeric(18,2);
  v_minimum_usd numeric(18,2);
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
  v_rate numeric := 11850;
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

  select rate into v_rate
  from public.exchange_rates
  where currency_from = 'USD' and currency_to = 'UZS'
  order by rate_date desc, created_at desc
  limit 1;
  if v_rate is null or v_rate <= 0 then v_rate := 11850; end if;

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
    v_cost_usd := nullif(nullif(btrim(v_line->>'unit_cost_usd'), '')::numeric, 0);

    v_retail := nullif(nullif(btrim(v_line->>'retail_price'), '')::numeric, 0);
    v_retail_usd := nullif(nullif(btrim(v_line->>'retail_price_usd'), '')::numeric, 0);

    v_wholesale := nullif(nullif(btrim(v_line->>'wholesale_price'), '')::numeric, 0);
    v_wholesale_usd := nullif(nullif(btrim(v_line->>'wholesale_price_usd'), '')::numeric, 0);

    v_minimum := nullif(nullif(btrim(v_line->>'minimum_sale_price'), '')::numeric, 0);
    v_minimum_usd := nullif(nullif(btrim(v_line->>'minimum_sale_price_usd'), '')::numeric, 0);

    v_serials := coalesce(v_line->'serial_numbers', '[]'::jsonb);
    v_variant_id := nullif(btrim(v_line->>'variant_id'), '')::uuid;

    -- If currency is USD, resolve USD and UZS equivalents
    if v_currency = 'USD' then
      if v_cost_usd is not null and v_cost_usd > 0 then
        if v_cost = 0 or v_cost = v_cost_usd then
          v_cost := round(v_cost_usd * v_rate);
        end if;
      elsif v_cost > 0 then
        if v_cost < 20000 then -- Entered directly as USD amount
          v_cost_usd := v_cost;
          v_cost := round(v_cost_usd * v_rate);
        else -- Entered as UZS
          v_cost_usd := round(v_cost / v_rate, 2);
        end if;
      end if;

      if v_retail_usd is not null and v_retail_usd > 0 then
        if v_retail is null or v_retail = v_retail_usd then
          v_retail := round(v_retail_usd * v_rate);
        end if;
      elsif v_retail is not null and v_retail > 0 then
        if v_retail < 20000 then
          v_retail_usd := v_retail;
          v_retail := round(v_retail_usd * v_rate);
        else
          v_retail_usd := round(v_retail / v_rate, 2);
        end if;
      end if;

      if v_wholesale_usd is not null and v_wholesale_usd > 0 then
        if v_wholesale is null or v_wholesale = v_wholesale_usd then
          v_wholesale := round(v_wholesale_usd * v_rate);
        end if;
      elsif v_wholesale is not null and v_wholesale > 0 then
        if v_wholesale < 20000 then
          v_wholesale_usd := v_wholesale;
          v_wholesale := round(v_wholesale_usd * v_rate);
        else
          v_wholesale_usd := round(v_wholesale / v_rate, 2);
        end if;
      end if;

      if v_minimum_usd is not null and v_minimum_usd > 0 then
        if v_minimum is null or v_minimum = v_minimum_usd then
          v_minimum := round(v_minimum_usd * v_rate);
        end if;
      elsif v_minimum is not null and v_minimum > 0 then
        if v_minimum < 20000 then
          v_minimum_usd := v_minimum;
          v_minimum := round(v_minimum_usd * v_rate);
        else
          v_minimum_usd := round(v_minimum / v_rate, 2);
        end if;
      end if;
    end if;

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

    select id, track_individual_units, minimum_sale_price, minimum_sale_price_usd, wholesale_price, retail_price
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
      reference, received_at, expires_at, quantity, unit_cost, unit_cost_usd,
      created_by, retail_price, retail_price_usd, wholesale_price, wholesale_price_usd,
      minimum_sale_price, minimum_sale_price_usd, currency
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
      v_cost_usd,
      auth.uid(),
      v_retail,
      v_retail_usd,
      v_wholesale,
      v_wholesale_usd,
      v_minimum,
      v_minimum_usd,
      v_currency
    ) returning id into v_batch;

    if v_variant_id is not null then
      if v_retail is not null then
        update public.product_variants
        set retail_price = v_retail,
            retail_price_usd = v_retail_usd,
            wholesale_price = v_wholesale,
            wholesale_price_usd = v_wholesale_usd,
            minimum_sale_price = v_effective_minimum,
            minimum_sale_price_usd = coalesce(v_minimum_usd, minimum_sale_price_usd),
            cost_price = case when v_cost > 0 then v_cost else cost_price end,
            cost_price_usd = case when v_cost_usd > 0 then v_cost_usd else cost_price_usd end
        where id = v_variant_id;
      end if;
      if v_cost > 0 then
        update public.products
        set cost_price = case when cost_price = 0 then v_cost else cost_price end,
            cost_price_usd = case when coalesce(cost_price_usd, 0) = 0 then v_cost_usd else cost_price_usd end,
            currency = v_currency
        where id = v_product.id;
      end if;
    elsif v_retail is not null then
      update public.products
      set cost_price = case when v_cost > 0 then v_cost else cost_price end,
          cost_price_usd = case when v_cost_usd > 0 then v_cost_usd else cost_price_usd end,
          retail_price = v_retail,
          retail_price_usd = v_retail_usd,
          wholesale_price = v_wholesale,
          wholesale_price_usd = v_wholesale_usd,
          minimum_sale_price = v_effective_minimum,
          minimum_sale_price_usd = coalesce(v_minimum_usd, minimum_sale_price_usd),
          currency = v_currency
      where id = v_product.id;
    elsif v_cost > 0 then
      update public.products
      set cost_price = case when cost_price = 0 then v_cost else cost_price end,
          cost_price_usd = case when coalesce(cost_price_usd, 0) = 0 then v_cost_usd else cost_price_usd end,
          currency = v_currency
      where id = v_product.id;
    end if;

    -- Generate batch QR
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

      insert into public.stock_ledger(
        product_id, variant_id, batch_id, unit_id, from_location_id, to_location_id,
        direction, quantity, cost_amount, reference_type, reference_id, created_by
      ) values (
        v_product.id,
        v_variant_id,
        v_batch,
        v_unit,
        null,
        v_location,
        'in',
        1,
        v_cost,
        'receipt',
        v_receipt,
        auth.uid()
      );
    end loop;

    v_total_units := v_total_units + v_qty;
    v_total_cost := v_total_cost + (v_qty * v_cost);
  end loop;

  v_debt := case v_payment_status
    when 'paid' then 0
    when 'partial' then greatest(0, v_total_cost - v_paid_amount)
    else v_total_cost
  end;

  if v_supplier is not null and v_debt > 0 then
    update public.suppliers
    set balance = balance + v_debt
    where id = v_supplier;
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
end;
$$;

-- 6. Update update_stock_receipt RPC to support unit_cost_usd and price_usd
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
  v_uc_usd numeric(18,2);
  v_rp numeric(18,2);
  v_rp_usd numeric(18,2);
  v_wp numeric(18,2);
  v_wp_usd numeric(18,2);
  v_mp numeric(18,2);
  v_mp_usd numeric(18,2);
  v_rate numeric := 11850;
  v_curr text;
begin
  select * into v_r from public.stock_receipts where id = p_receipt_id for update;
  if not found then raise exception 'Partiya topilmadi' using errcode = 'P0002'; end if;
  perform public.require_inventory_operator(v_r.branch_id);

  if p_updates is null or jsonb_typeof(p_updates) is distinct from 'object' then
    raise exception 'Yangilanish obyekti talab qilinadi' using errcode = '22023';
  end if;

  select rate into v_rate
  from public.exchange_rates
  where currency_from = 'USD' and currency_to = 'UZS'
  order by rate_date desc, created_at desc
  limit 1;
  if v_rate is null or v_rate <= 0 then v_rate := 11850; end if;

  v_curr := upper(coalesce(nullif(btrim(p_updates->>'currency'), ''), btrim(v_r.currency::text), 'USD'));

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
        -- Prices
        if v_line ? 'unit_cost' and nullif(btrim(v_line->>'unit_cost'), '') is not null then
          v_uc := (v_line->>'unit_cost')::numeric;
          v_uc_usd := case when v_line ? 'unit_cost_usd' and nullif(btrim(v_line->>'unit_cost_usd'), '') is not null
            then (v_line->>'unit_cost_usd')::numeric else null end;
          if v_curr = 'USD' then
            if v_uc_usd is not null and v_uc_usd > 0 then
              v_uc := round(v_uc_usd * v_rate);
            elsif v_uc > 0 then
              if v_uc < 20000 then
                v_uc_usd := v_uc;
                v_uc := round(v_uc_usd * v_rate);
              else
                v_uc_usd := round(v_uc / v_rate, 2);
              end if;
            end if;
          end if;
          update public.stock_batches
          set unit_cost = v_uc,
              unit_cost_usd = coalesce(v_uc_usd, unit_cost_usd)
          where id = v_batch_id;
        end if;

        v_rp := case when v_line ? 'retail_price' and nullif(btrim(v_line->>'retail_price'), '') is not null then (v_line->>'retail_price')::numeric else null end;
        v_rp_usd := case when v_line ? 'retail_price_usd' and nullif(btrim(v_line->>'retail_price_usd'), '') is not null then (v_line->>'retail_price_usd')::numeric else null end;

        v_wp := case when v_line ? 'wholesale_price' and nullif(btrim(v_line->>'wholesale_price'), '') is not null then (v_line->>'wholesale_price')::numeric else null end;
        v_wp_usd := case when v_line ? 'wholesale_price_usd' and nullif(btrim(v_line->>'wholesale_price_usd'), '') is not null then (v_line->>'wholesale_price_usd')::numeric else null end;

        v_mp := case when v_line ? 'minimum_sale_price' and nullif(btrim(v_line->>'minimum_sale_price'), '') is not null then (v_line->>'minimum_sale_price')::numeric else null end;
        v_mp_usd := case when v_line ? 'minimum_sale_price_usd' and nullif(btrim(v_line->>'minimum_sale_price_usd'), '') is not null then (v_line->>'minimum_sale_price_usd')::numeric else null end;

        if v_curr = 'USD' then
          if v_rp_usd is not null and v_rp_usd > 0 then
            v_rp := round(v_rp_usd * v_rate);
          elsif v_rp is not null and v_rp > 0 then
            if v_rp < 20000 then v_rp_usd := v_rp; v_rp := round(v_rp_usd * v_rate); else v_rp_usd := round(v_rp / v_rate, 2); end if;
          end if;

          if v_wp_usd is not null and v_wp_usd > 0 then
            v_wp := round(v_wp_usd * v_rate);
          elsif v_wp is not null and v_wp > 0 then
            if v_wp < 20000 then v_wp_usd := v_wp; v_wp := round(v_wp_usd * v_rate); else v_wp_usd := round(v_wp / v_rate, 2); end if;
          end if;

          if v_mp_usd is not null and v_mp_usd > 0 then
            v_mp := round(v_mp_usd * v_rate);
          elsif v_mp is not null and v_mp > 0 then
            if v_mp < 20000 then v_mp_usd := v_mp; v_mp := round(v_mp_usd * v_rate); else v_mp_usd := round(v_mp / v_rate, 2); end if;
          end if;
        end if;

        if v_rp is not null or v_wp is not null or v_mp is not null then
          update public.stock_batches set
            retail_price = coalesce(v_rp, retail_price),
            retail_price_usd = coalesce(v_rp_usd, retail_price_usd),
            wholesale_price = coalesce(v_wp, wholesale_price),
            wholesale_price_usd = coalesce(v_wp_usd, wholesale_price_usd),
            minimum_sale_price = coalesce(v_mp, minimum_sale_price),
            minimum_sale_price_usd = coalesce(v_mp_usd, minimum_sale_price_usd)
          where id = v_batch_id;

          update public.products set
            retail_price = coalesce(v_rp, retail_price),
            retail_price_usd = coalesce(v_rp_usd, retail_price_usd),
            wholesale_price = coalesce(v_wp, wholesale_price),
            wholesale_price_usd = coalesce(v_wp_usd, wholesale_price_usd),
            minimum_sale_price = coalesce(v_mp, minimum_sale_price),
            minimum_sale_price_usd = coalesce(v_mp_usd, minimum_sale_price_usd),
            cost_price = coalesce(v_uc, cost_price),
            cost_price_usd = coalesce(v_uc_usd, cost_price_usd),
            currency = v_curr
          where id = v_batch.product_id;

          if v_batch.variant_id is not null then
            update public.product_variants set
              retail_price = coalesce(v_rp, retail_price),
              retail_price_usd = coalesce(v_rp_usd, retail_price_usd),
              wholesale_price = coalesce(v_wp, wholesale_price),
              wholesale_price_usd = coalesce(v_wp_usd, wholesale_price_usd),
              minimum_sale_price = coalesce(v_mp, minimum_sale_price),
              minimum_sale_price_usd = coalesce(v_mp_usd, minimum_sale_price_usd),
              cost_price = coalesce(v_uc, cost_price),
              cost_price_usd = coalesce(v_uc_usd, cost_price_usd)
            where id = v_batch.variant_id;
          end if;
        end if;

        -- Color / Variant
        if v_line ? 'variant_color' then
          v_color := nullif(btrim(v_line->>'variant_color'), '');
          if v_color is not null then
            select id into v_var_id from public.product_variants
            where product_id = v_batch.product_id and lower(btrim(color_name)) = lower(v_color) limit 1;
            if v_var_id is null then
              insert into public.product_variants(product_id, color_name, retail_price, retail_price_usd, wholesale_price, wholesale_price_usd, minimum_sale_price, minimum_sale_price_usd, is_active)
              values(v_batch.product_id, v_color, v_rp, v_rp_usd, v_wp, v_wp_usd, v_mp, v_mp_usd, true)
              returning id into v_var_id;
            end if;
            update public.stock_batches set variant_id = v_var_id where id = v_batch_id;
            update public.inventory_units set variant_id = v_var_id
            where batch_id = v_batch_id and status = 'available';
          end if;
        end if;

        -- Quantity
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
                v_batch.product_id, v_batch.variant_id, v_batch_id, v_qr, v_new_location, 'available', v_seq + i
              );
            end loop;
            update public.stock_batches set quantity = v_new_qty where id = v_batch_id;
          elsif v_new_qty < v_old_qty and v_new_qty >= 1 then
            v_diff := v_old_qty - v_new_qty;
            select count(*) into v_avail from public.inventory_units where batch_id = v_batch_id and status = 'available';
            if v_diff > v_avail then
              raise exception 'Miqdorni % tagacha kamaytirib bo''lmaydi, chunki sotilgan birliklar bor', v_new_qty using errcode = '22023';
            end if;
            delete from public.inventory_units
            where id in (
              select id from public.inventory_units
              where batch_id = v_batch_id and status = 'available'
              order by unit_sequence desc
              limit v_diff
            );
            update public.stock_batches set quantity = v_new_qty where id = v_batch_id;
          end if;
        end if;
      end if;
    end loop;
  end if;

  -- 4. General fields
  update public.stock_receipts set
    supplier_id = v_supplier,
    receiving_location_id = v_new_location,
    currency = case when p_updates ? 'currency' then coalesce(nullif(btrim(p_updates->>'currency'), ''), currency) else currency end,
    invoice_number = case when p_updates ? 'invoice_number' then nullif(btrim(p_updates->>'invoice_number'), '') else invoice_number end,
    payment_status = case when p_updates ? 'payment_status' then coalesce(nullif(btrim(p_updates->>'payment_status'), ''), payment_status) else payment_status end,
    received_at = case when p_updates ? 'received_at' and nullif(btrim(p_updates->>'received_at'), '') is not null then (p_updates->>'received_at')::timestamptz else received_at end,
    notes = case when p_updates ? 'notes' then nullif(btrim(p_updates->>'notes'), '') else notes end,
    updated_at = now()
  where id = p_receipt_id;

  return public.get_stock_receipt(p_receipt_id);
end;
$$;

-- 7. Update get_stock_receipt to include unit_cost_usd, retail_price_usd, etc.
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
          'variant_color', v.color_name, 'quantity', b.quantity,
          'unit_cost', b.unit_cost,
          'unit_cost_usd', coalesce(b.unit_cost_usd, p.cost_price_usd),
          'retail_price', coalesce(v.retail_price, b.retail_price, p.retail_price),
          'retail_price_usd', coalesce(v.retail_price_usd, b.retail_price_usd, p.retail_price_usd),
          'wholesale_price', coalesce(v.wholesale_price, b.wholesale_price, p.wholesale_price),
          'wholesale_price_usd', coalesce(v.wholesale_price_usd, b.wholesale_price_usd, p.wholesale_price_usd),
          'minimum_sale_price', coalesce(v.minimum_sale_price, b.minimum_sale_price, p.minimum_sale_price, 0),
          'minimum_sale_price_usd', coalesce(v.minimum_sale_price_usd, b.minimum_sale_price_usd, p.minimum_sale_price_usd, 0),
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

-- 8. Update list_stock_receipts to include unit_cost_usd
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
          'unit_cost_usd', coalesce(sb.unit_cost_usd, sp.cost_price_usd),
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

commit;

notify pgrst, 'reload schema';
