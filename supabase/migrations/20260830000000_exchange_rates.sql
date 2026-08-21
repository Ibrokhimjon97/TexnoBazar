-- Kunlik valyuta kurslari jadvali
create table if not exists public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  rate_date date not null,
  currency_from text not null default 'USD',
  currency_to text not null default 'UZS',
  rate numeric not null check (rate > 0),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique(rate_date, currency_from, currency_to)
);

-- RLS
alter table public.exchange_rates enable row level security;
drop policy if exists exchange_rates_read on public.exchange_rates;
create policy exchange_rates_read on public.exchange_rates for select to authenticated using (true);
drop policy if exists exchange_rates_admin on public.exchange_rates;
create policy exchange_rates_admin on public.exchange_rates for all to authenticated
  using (public.has_role(array['superadmin','admin','manager']::public.app_role[], null))
  with check (public.has_role(array['superadmin','admin','manager']::public.app_role[], null));

-- Oxirgi kursni olish funksiyasi
create or replace function public.get_latest_exchange_rate(p_from text default 'USD', p_to text default 'UZS')
returns numeric language sql stable security definer set search_path='' as $$
  select rate from public.exchange_rates
  where currency_from = p_from and currency_to = p_to
  order by rate_date desc limit 1;
$$;

-- Tovar pasporti: birlik ID bo'yicha to'liq ma'lumot
create or replace function public.get_unit_passport(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  select jsonb_build_object(
    'unit_id', u.id,
    'qr_code', u.qr_code,
    'serial_number', u.serial_number,
    'status', u.status,
    'product', jsonb_build_object(
      'id', p.id, 'name', p.name, 'sku', p.sku, 'slug', p.slug,
      'cost_price', p.cost_price, 'retail_price', p.retail_price,
      'wholesale_price', p.wholesale_price, 'category', c.name, 'brand', b.name,
      'image', (select m.public_url from public.product_media m where m.product_id = p.id order by m.is_primary desc, m.sort_order limit 1)
    ),
    'location', jsonb_build_object(
      'name', l.name, 'type', l.type,
      'branch_name', br.name, 'branch_code', br.code
    ),
    'batch', jsonb_build_object(
      'id', sb.id, 'batch_number', sb.batch_number,
      'supplier', s.name, 'received_at', sb.received_at,
      'cost_price', sb.cost_price
    ),
    'exchange_rate', (select rate from public.exchange_rates where currency_from = 'USD' and currency_to = 'UZS' order by rate_date desc limit 1),
    'rate_date', (select rate_date from public.exchange_rates where currency_from = 'USD' and currency_to = 'UZS' order by rate_date desc limit 1)
  ) into v_result
  from public.inventory_units u
  join public.products p on p.id = u.product_id
  left join public.categories c on c.id = p.category_id
  left join public.brands b on b.id = p.brand_id
  left join public.locations l on l.id = u.location_id
  left join public.branches br on br.id = l.branch_id
  left join public.stock_batches sb on sb.id = u.batch_id
  left join public.suppliers s on s.id = sb.supplier_id
  where u.id = p_unit_id;

  return coalesce(v_result, '{}'::jsonb);
end $$;

grant execute on function public.get_latest_exchange_rate(text, text) to authenticated;
grant execute on function public.get_unit_passport(uuid) to authenticated;
grant select, insert, update on public.exchange_rates to authenticated;

commit;
