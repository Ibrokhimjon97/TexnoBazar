-- Fix: get_pos_unit_context originally only matched units sitting in the store
-- location (mirroring find_pos_unit, which is sale-only). The seller also needs
-- to scan units currently in the warehouse in order to move them to the store
-- (and vice versa), so broaden the lookup to both store and warehouse locations
-- of the branch. Selling itself is still enforced at pending-sale creation time
-- (create_pos_pending_sale requires the unit to be in a 'store' location).
create or replace function public.get_pos_unit_context(p_branch_id uuid, p_code text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_code text := nullif(btrim(p_code), '');
  v_unit record;
  v_rate numeric;
  v_result jsonb;
begin
  perform public.require_pos_seller(p_branch_id);
  if v_code is null then
    raise exception 'QR, seriya, shtrix-kod yoki SKU talab qilinadi' using errcode = '22023';
  end if;

  select
    u.id, u.qr_code, u.serial_number, u.status, u.location_id,
    p.id as product_id, p.name as product_name, p.sku, p.barcode, p.slug, p.is_published,
    br.name as brand_name,
    p.retail_price, p.wholesale_price, p.minimum_sale_price, p.tax_rate,
    coalesce(sb.unit_cost, p.cost_price) as unit_cost,
    l.name as location_name, l.type as location_type,
    (select m.public_url from public.product_media m where m.product_id = p.id order by m.is_primary desc, m.sort_order limit 1) as image
  into v_unit
  from public.inventory_units u
  join public.products p on p.id = u.product_id
  join public.locations l on l.id = u.location_id
  left join public.brands br on br.id = p.brand_id
  left join public.stock_batches sb on sb.id = u.batch_id
  where l.branch_id = p_branch_id and l.type in ('store', 'warehouse') and l.is_active and p.status = 'active'
    and u.status = 'available' and u.active_transfer_id is null
    and (upper(u.qr_code) = upper(v_code) or upper(coalesce(u.serial_number, '')) = upper(v_code)
      or upper(coalesce(p.barcode, '')) = upper(v_code) or upper(p.sku) = upper(v_code))
  order by case when upper(u.qr_code) = upper(v_code) then 0
                when upper(coalesce(u.serial_number, '')) = upper(v_code) then 1 else 2 end, u.id
  limit 1;

  if v_unit.id is null then
    raise exception 'Erkin POS mahsulot birligi topilmadi' using errcode = 'P0002';
  end if;

  select rate into v_rate from public.exchange_rates
  where currency_from = 'USD' and currency_to = 'UZS' order by rate_date desc limit 1;

  select jsonb_build_object(
    'id', v_unit.id,
    'qr_code', v_unit.qr_code,
    'serial_number', v_unit.serial_number,
    'status', v_unit.status,
    'location_id', v_unit.location_id,
    'location_name', v_unit.location_name,
    'location_type', v_unit.location_type,
    'product_id', v_unit.product_id,
    'product_name', v_unit.product_name,
    'sku', v_unit.sku,
    'barcode', v_unit.barcode,
    'brand_name', v_unit.brand_name,
    'image', v_unit.image,
    'storefront_url', case when v_unit.is_published and v_unit.slug is not null
      then '/product/' || v_unit.slug else null end,
    'exchange_rate', v_rate,
    'prices', jsonb_build_object(
      'retail_price_uzs', v_unit.retail_price,
      'retail_price_usd', case when v_rate > 0 then round(v_unit.retail_price / v_rate, 2) else null end,
      'wholesale_price_uzs', v_unit.wholesale_price,
      'wholesale_price_usd', case when v_rate > 0 and v_unit.wholesale_price is not null then round(v_unit.wholesale_price / v_rate, 2) else null end,
      'minimum_sale_price_uzs', v_unit.minimum_sale_price,
      'minimum_sale_price_usd', case when v_rate > 0 then round(v_unit.minimum_sale_price / v_rate, 2) else null end,
      'unit_cost_uzs', v_unit.unit_cost,
      'tax_rate', v_unit.tax_rate
    ),
    'branch_stock', jsonb_build_object(
      'store', (select count(*) from public.inventory_units a join public.locations al on al.id = a.location_id
        where a.product_id = v_unit.product_id and al.branch_id = p_branch_id and al.type = 'store'
          and al.is_active and a.status = 'available' and a.active_transfer_id is null),
      'warehouse', (select count(*) from public.inventory_units a join public.locations al on al.id = a.location_id
        where a.product_id = v_unit.product_id and al.branch_id = p_branch_id and al.type = 'warehouse'
          and al.is_active and a.status = 'available' and a.active_transfer_id is null)
    ),
    'other_branches', coalesce((
      select jsonb_agg(jsonb_build_object('branch_id', b.id, 'branch_name', b.name, 'quantity', q.qty) order by q.qty desc)
      from (
        select al.branch_id, count(*) as qty
        from public.inventory_units a
        join public.locations al on al.id = a.location_id
        where a.product_id = v_unit.product_id and al.is_active and al.type in ('store', 'warehouse')
          and a.status = 'available' and a.active_transfer_id is null and al.branch_id <> p_branch_id
        group by al.branch_id
      ) q
      join public.branches b on b.id = q.branch_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end $$;

grant execute on function public.get_pos_unit_context(uuid, text) to authenticated;
