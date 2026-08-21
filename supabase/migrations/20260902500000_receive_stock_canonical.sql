-- Establish one canonical stock-receiving contract after earlier migrations
-- independently replaced receiving, short-QR, batch-pricing, and debt behavior.
begin;

alter table public.stock_receipts
  add column if not exists request_hash text
  check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$');

-- Allow free pricing: drop the rigid wholesale/promotion constraints
alter table public.products drop constraint if exists products_wholesale_price_chk;
alter table public.products drop constraint if exists products_promotion_price_chk;

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
  v_qty integer;
  v_cost numeric(18,2);
  v_retail numeric(18,2);
  v_wholesale numeric(18,2);
  v_minimum numeric(18,2);
  v_effective_minimum numeric(18,2);
  v_line_no integer := 0;
  v_seq integer;
  v_serials jsonb;
  v_qr text;
  v_qr_attempt integer;
  v_constraint_name text;
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
  if v_supplier is null then raise exception 'Ta''minotchi talab qilinadi' using errcode = '22023'; end if;

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
  if not exists(select 1 from public.suppliers where id = v_supplier and is_active) then
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
      receipt_id, line_no, supplier_id, product_id, location_id,
      reference, received_at, expires_at, quantity, unit_cost, created_by,
      retail_price, wholesale_price, minimum_sale_price
    ) values (
      v_receipt,
      v_line_no,
      v_supplier,
      v_product.id,
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

    if v_retail is not null then
      update public.products
      set cost_price = case when v_cost > 0 then v_cost else cost_price end,
          retail_price = v_retail,
          minimum_sale_price = v_effective_minimum,
          wholesale_price = v_wholesale,
          promotion_price = case
            when promotion_price between v_effective_minimum and v_retail then promotion_price
            else null
          end,
          compare_at_price = case
            when compare_at_price is null or compare_at_price >= v_retail then compare_at_price
            else null
          end
      where id = v_product.id;
    elsif v_cost > 0 then
      update public.products set cost_price = v_cost where id = v_product.id;
    end if;

    for v_seq in 1..v_qty loop
      v_qr_attempt := 0;
      loop
        v_qr := public.generate_short_qr();
        begin
          insert into public.inventory_units(
            product_id, batch_id, qr_code, serial_number, location_id, status, unit_sequence
          ) values (
            v_product.id,
            v_batch,
            v_qr,
            nullif(btrim(v_serials->>(v_seq - 1)), ''),
            v_location,
            'available',
            v_seq
          ) returning id into v_unit;
          exit;
        exception
          when unique_violation then
            get stacked diagnostics v_constraint_name = constraint_name;
            if v_constraint_name <> 'inventory_units_qr_code_key' then raise; end if;
            v_qr_attempt := v_qr_attempt + 1;
            if v_qr_attempt >= 20 then
              raise exception 'Noyob QR kod yaratib bo''lmadi' using errcode = 'P0001';
            end if;
        end;
      end loop;

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

  if v_debt > 0 then
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
end;
$$;

-- Keep supplier balances correct when payment state or supplier changes.
create or replace function public.sync_supplier_balance_on_payment_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total numeric(18,2);
  v_old_debt numeric(18,2);
  v_new_debt numeric(18,2);
begin
  if old.payment_status is not distinct from new.payment_status
    and old.paid_amount is not distinct from new.paid_amount
    and old.supplier_id is not distinct from new.supplier_id then
    return new;
  end if;

  select coalesce(sum(b.quantity * b.unit_cost), 0) into v_total
  from public.stock_batches b where b.receipt_id = new.id;

  v_old_debt := case old.payment_status
    when 'paid' then 0
    when 'partial' then greatest(0, v_total - coalesce(old.paid_amount, 0))
    else v_total
  end;
  v_new_debt := case new.payment_status
    when 'paid' then 0
    when 'partial' then greatest(0, v_total - coalesce(new.paid_amount, 0))
    else v_total
  end;

  perform 1 from public.suppliers
  where id in (old.supplier_id, new.supplier_id)
  order by id
  for update;

  if old.supplier_id = new.supplier_id then
    update public.suppliers set balance = balance + (v_new_debt - v_old_debt)
    where id = new.supplier_id and v_new_debt is distinct from v_old_debt;
  else
    update public.suppliers set balance = balance - v_old_debt where id = old.supplier_id;
    update public.suppliers set balance = balance + v_new_debt where id = new.supplier_id;
  end if;
  return new;
end;
$$;

drop trigger if exists stock_receipts_payment_sync on public.stock_receipts;
create trigger stock_receipts_payment_sync
after update of payment_status, paid_amount, supplier_id on public.stock_receipts
for each row execute function public.sync_supplier_balance_on_payment_change();

-- Generic receipt edits keep payment values internally consistent. Changing debt
-- is restricted to superadmin; ordinary operators may still edit metadata.
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
begin
  select * into v_r from public.stock_receipts where id = p_receipt_id for update;
  if not found then raise exception 'Partiya topilmadi' using errcode = 'P0002'; end if;
  perform public.require_inventory_operator(v_r.branch_id);
  if p_updates is null or jsonb_typeof(p_updates) is distinct from 'object' then
    raise exception 'Yangilanish obyekti talab qilinadi' using errcode = '22023';
  end if;

  select coalesce(sum(quantity * unit_cost), 0) into v_total
  from public.stock_batches where receipt_id = p_receipt_id;

  v_supplier := coalesce(nullif(btrim(p_updates->>'supplier_id'), '')::uuid, v_r.supplier_id);
  if not exists(select 1 from public.suppliers where id = v_supplier and is_active) then
    raise exception 'Faol ta''minotchi topilmadi' using errcode = 'P0002';
  end if;

  v_status := case when p_updates ? 'payment_status'
    then lower(nullif(btrim(p_updates->>'payment_status'), '')) else v_r.payment_status end;
  if v_status not in ('unpaid','partial','paid') then
    raise exception 'To''lov holati noto''g''ri' using errcode = '22023';
  end if;

  v_payment_change := p_updates ? 'paid_amount'
    or ((p_updates ? 'payment_status') and v_status is distinct from v_r.payment_status);
  v_paid := v_r.paid_amount;
  if v_payment_change then
    if not public.has_role(array['superadmin']::public.app_role[], null) then
      raise exception 'Faqat superadmin to''lov miqdorini o''zgartira oladi' using errcode = '42501';
    end if;
    if p_updates ? 'paid_amount' then
      v_paid := coalesce(nullif(btrim(p_updates->>'paid_amount'), '')::numeric, 0);
    elsif v_status = 'paid' then
      v_paid := v_total;
    elsif v_status = 'unpaid' then
      v_paid := 0;
    end if;
    if not (v_paid > '-Infinity'::numeric and v_paid < 'Infinity'::numeric)
      or v_paid < 0 or v_paid > v_total then
      raise exception 'To''langan summa 0 va jami summa orasida bo''lishi kerak' using errcode = '22023';
    end if;
    if v_status = 'paid' and v_paid <> v_total
      or v_status = 'unpaid' and v_paid <> 0
      or v_status = 'partial' and (v_paid <= 0 or v_paid >= v_total) then
      raise exception 'To''lov holati va to''langan summa bir-biriga mos emas' using errcode = '22023';
    end if;
  end if;

  update public.stock_receipts set
    supplier_id = v_supplier,
    invoice_number = case when p_updates ? 'invoice_number' then nullif(btrim(p_updates->>'invoice_number'), '') else invoice_number end,
    payment_status = v_status,
    paid_amount = v_paid,
    received_at = coalesce(nullif(btrim(p_updates->>'received_at'), '')::timestamptz, received_at),
    notes = case when p_updates ? 'notes' then nullif(btrim(p_updates->>'notes'), '') else notes end,
    updated_at = now()
  where id = p_receipt_id returning * into v_r;

  if v_supplier is distinct from v_r.supplier_id then
    raise exception 'Ta''minotchini yangilashda ichki xato' using errcode = 'P0001';
  end if;
  update public.stock_batches set supplier_id = v_supplier
  where receipt_id = p_receipt_id and supplier_id is distinct from v_supplier;
  if p_updates ? 'received_at' and nullif(btrim(p_updates->>'received_at'), '') is not null then
    update public.stock_batches set received_at = (p_updates->>'received_at')::timestamptz
    where receipt_id = p_receipt_id;
  end if;

  return to_jsonb(v_r);
end;
$$;

-- Payment settlement is a superadmin-only operation; status is derived from amount.
create or replace function public.update_receipt_payment(
  p_receipt_id uuid,
  p_paid_amount numeric,
  p_payment_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.stock_receipts%rowtype;
  v_total numeric(18,2);
  v_status text;
begin
  if not public.has_role(array['superadmin']::public.app_role[], null) then
    raise exception 'Faqat superadmin to''lov miqdorini o''zgartira oladi' using errcode = '42501';
  end if;
  select * into v_receipt from public.stock_receipts where id = p_receipt_id for update;
  if not found then raise exception 'Partiya topilmadi' using errcode = 'P0002'; end if;
  select coalesce(sum(quantity * unit_cost), 0) into v_total
  from public.stock_batches where receipt_id = p_receipt_id;

  if p_paid_amount is null
    or not (p_paid_amount > '-Infinity'::numeric and p_paid_amount < 'Infinity'::numeric)
    or p_paid_amount < 0 or p_paid_amount > v_total then
    raise exception 'To''langan summa 0 va jami summa orasida bo''lishi kerak' using errcode = '22023';
  end if;
  v_status := case
    when p_paid_amount = 0 then 'unpaid'
    when p_paid_amount >= v_total then 'paid'
    else 'partial'
  end;
  if p_payment_status is not null and lower(btrim(p_payment_status)) <> v_status then
    raise exception 'To''lov holati to''langan summaga mos emas' using errcode = '22023';
  end if;

  update public.stock_receipts
  set paid_amount = p_paid_amount, payment_status = v_status
  where id = p_receipt_id;

  return jsonb_build_object(
    'id', p_receipt_id,
    'paid_amount', p_paid_amount,
    'payment_status', v_status,
    'total_cost', v_total
  );
end;
$$;

-- Deleting an unpaid receipt must reverse the debt it originally accrued.
create or replace function public.delete_stock_receipt(p_receipt_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.stock_receipts%rowtype;
  v_batch_ids uuid[];
  v_unit_ids uuid[];
  v_repair_ids uuid[];
  v_total numeric(18,2);
  v_debt numeric(18,2);
begin
  select * into v_r from public.stock_receipts where id = p_receipt_id for update;
  if not found then raise exception 'Partiya topilmadi' using errcode = 'P0002'; end if;
  perform public.require_inventory_operator(v_r.branch_id);

  select coalesce(sum(quantity * unit_cost), 0) into v_total
  from public.stock_batches where receipt_id = p_receipt_id;
  v_debt := case v_r.payment_status
    when 'paid' then 0
    when 'partial' then greatest(0, v_total - coalesce(v_r.paid_amount, 0))
    else v_total
  end;

  select array_agg(id) into v_batch_ids from public.stock_batches where receipt_id = p_receipt_id;
  if v_batch_ids is null then v_batch_ids := '{}'::uuid[]; end if;
  select array_agg(id) into v_unit_ids from public.inventory_units where batch_id = any(v_batch_ids);
  if v_unit_ids is null then v_unit_ids := '{}'::uuid[]; end if;

  if exists(select 1 from public.sale_lines where unit_id = any(v_unit_ids)) then
    raise exception 'Bu partiya birliklaridan sotilganlari bor — o''chirish mumkin emas' using errcode = 'P0001';
  end if;

  select array_agg(id) into v_repair_ids from public.repair_orders where unit_id = any(v_unit_ids);
  if v_repair_ids is not null then
    alter table public.repair_events disable trigger repair_events_immutable;
    alter table public.repair_cost_entries disable trigger repair_cost_entries_immutable;
    delete from public.repair_events where repair_id = any(v_repair_ids);
    delete from public.repair_cost_entries where repair_id = any(v_repair_ids);
    alter table public.repair_events enable trigger repair_events_immutable;
    alter table public.repair_cost_entries enable trigger repair_cost_entries_immutable;
    delete from public.repair_orders where id = any(v_repair_ids);
  end if;

  alter table public.inventory_movements disable trigger inventory_movements_immutable;
  delete from public.inventory_movements where unit_id = any(v_unit_ids);
  alter table public.inventory_movements enable trigger inventory_movements_immutable;

  delete from public.inventory_count_lines where unit_id = any(v_unit_ids);
  delete from public.transfer_lines where unit_id = any(v_unit_ids);
  delete from public.writeoff_lines where unit_id = any(v_unit_ids);
  delete from public.inventory_units where id = any(v_unit_ids);
  delete from public.stock_batches where id = any(v_batch_ids);
  delete from public.stock_receipts where id = p_receipt_id;
  if v_debt > 0 then
    update public.suppliers set balance = balance - v_debt where id = v_r.supplier_id;
  end if;
end;
$$;

comment on function public.receive_stock(jsonb,jsonb,uuid) is
  'Canonical stock receipt RPC: validation, request-bound idempotency, batch pricing, short QR units, and supplier debt tracking.';

revoke all on function public.receive_stock(jsonb,jsonb,uuid) from public, anon;
grant execute on function public.receive_stock(jsonb,jsonb,uuid) to authenticated, service_role;
revoke all on function public.update_stock_receipt(uuid,jsonb) from public, anon;
grant execute on function public.update_stock_receipt(uuid,jsonb) to authenticated, service_role;
revoke all on function public.update_receipt_payment(uuid,numeric,text) from public, anon;
grant execute on function public.update_receipt_payment(uuid,numeric,text) to authenticated, service_role;
revoke all on function public.delete_stock_receipt(uuid) from public, anon;
grant execute on function public.delete_stock_receipt(uuid) to authenticated, service_role;
revoke all on function public.generate_short_qr() from public, anon, authenticated;
grant execute on function public.generate_short_qr() to service_role;

do $$
declare
  v_arg_names text[];
begin
  if pg_catalog.to_regprocedure('public.receive_stock(jsonb,jsonb,uuid)') is null then
    raise exception 'public.receive_stock(jsonb,jsonb,uuid) yaratilmadi';
  end if;
  select proargnames into v_arg_names
  from pg_catalog.pg_proc
  where oid = pg_catalog.to_regprocedure('public.receive_stock(jsonb,jsonb,uuid)');
  if v_arg_names is distinct from array['p_header','p_lines','p_idempotency_key']::text[] then
    raise exception 'receive_stock parametr nomlari noto''g''ri: %', v_arg_names;
  end if;
  if not pg_catalog.has_function_privilege('authenticated', 'public.receive_stock(jsonb,jsonb,uuid)', 'EXECUTE') then
    raise exception 'authenticated roli receive_stock EXECUTE huquqiga ega emas';
  end if;
end;
$$;

-- RPC to update batch unit_cost and product prices (manager/admin only)
create or replace function public.update_batch_prices(
  p_batch_id uuid,
  p_unit_cost numeric,
  p_retail_price numeric,
  p_wholesale_price numeric default null,
  p_minimum_sale_price numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch record;
  v_branch uuid;
begin
  if auth.uid() is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;

  select b.id, b.product_id, b.receipt_id, r.branch_id
  into v_batch
  from public.stock_batches b
  join public.stock_receipts r on r.id = b.receipt_id
  where b.id = p_batch_id;
  if not found then raise exception 'Partiya topilmadi' using errcode = 'P0002'; end if;

  perform public.require_inventory_operator(v_batch.branch_id);

  if p_unit_cost < 0 or p_retail_price < 0 then
    raise exception 'Narxlar manfiy bo''la olmaydi' using errcode = '22023';
  end if;

  update public.stock_batches
  set unit_cost = p_unit_cost
  where id = p_batch_id;

  update public.products
  set cost_price = p_unit_cost,
      retail_price = p_retail_price,
      wholesale_price = p_wholesale_price,
      minimum_sale_price = coalesce(p_minimum_sale_price, 0)
  where id = v_batch.product_id;

  return jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'product_id', v_batch.product_id);
end;
$$;

revoke all on function public.update_batch_prices(uuid,numeric,numeric,numeric,numeric) from public, anon;
grant execute on function public.update_batch_prices(uuid,numeric,numeric,numeric,numeric) to authenticated, service_role;

-- PostgREST processes this notification after the transaction commits.
notify pgrst, 'reload schema';

commit;
