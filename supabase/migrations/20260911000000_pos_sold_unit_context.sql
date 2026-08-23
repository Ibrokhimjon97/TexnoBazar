begin;

-- Scanning a QR must always explain the unit, including units that are already
-- sold, reserved or written off. Sale details are exposed only for sales that
-- belong to the seller's own branch; sellability is reported separately so the
-- client can keep sale actions disabled.
create or replace function public.get_pos_unit_context(p_branch_id uuid, p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := nullif(btrim(p_code), '');
  v_unit record;
  v_rate numeric;
  v_sale jsonb := null;
  v_result jsonb;
begin
  perform public.require_pos_seller(p_branch_id);
  if v_code is null then
    raise exception 'QR, seriya, shtrix-kod yoki SKU talab qilinadi' using errcode = '22023';
  end if;

  select
    u.id, u.qr_code, u.serial_number, u.status, u.location_id, u.active_transfer_id, u.sold_sale_id,
    p.id as product_id, p.name as product_name, p.sku, p.barcode, p.slug,
    p.status as product_status, p.is_published,
    br.name as brand_name,
    p.retail_price, p.wholesale_price, p.minimum_sale_price, p.tax_rate,
    coalesce(sb.unit_cost, p.cost_price) as unit_cost,
    l.name as location_name, l.type as location_type, l.is_active as location_active,
    l.branch_id as unit_branch_id,
    ub.name as unit_branch_name,
    ub.code as unit_branch_code,
    (l.branch_id = p_branch_id) as in_current_branch,
    (l.branch_id = p_branch_id and l.is_active and l.type in ('store','warehouse')
      and u.status = 'available' and u.active_transfer_id is null and p.status = 'active') as is_sellable,
    (select m.public_url from public.product_media m where m.product_id = p.id order by m.is_primary desc, m.sort_order limit 1) as image
  into v_unit
  from public.inventory_units u
  join public.products p on p.id = u.product_id
  join public.locations l on l.id = u.location_id
  join public.branches ub on ub.id = l.branch_id and ub.is_active
  left join public.brands br on br.id = p.brand_id
  left join public.stock_batches sb on sb.id = u.batch_id
  where l.type in ('store', 'warehouse')
    and (
      upper(u.qr_code) = upper(v_code)
      or upper(coalesce(u.serial_number, '')) = upper(v_code)
      or (l.branch_id = p_branch_id and l.is_active and u.status = 'available' and u.active_transfer_id is null
        and (upper(coalesce(p.barcode, '')) = upper(v_code) or upper(p.sku) = upper(v_code)))
    )
  order by
    case when l.branch_id = p_branch_id then 0 else 1 end,
    case when u.status = 'available' and u.active_transfer_id is null then 0 else 1 end,
    case when upper(u.qr_code) = upper(v_code) then 0
         when upper(coalesce(u.serial_number, '')) = upper(v_code) then 1
         else 2 end,
    u.id
  limit 1;

  if v_unit.id is null then
    raise exception 'Bu kod bo‘yicha mahsulot birligi topilmadi' using errcode = 'P0002';
  end if;

  -- Sale history for units that already left stock.
  if v_unit.sold_sale_id is not null then
    select jsonb_build_object(
      'sale_id', s.id,
      'sale_no', s.sale_no,
      'sold_at', s.sold_at,
      'status', s.status,
      'branch_id', s.branch_id,
      'branch_name', b.name,
      'in_current_branch', s.branch_id = p_branch_id,
      'details_visible', s.branch_id = p_branch_id,
      'seller_name', case when s.branch_id = p_branch_id then seller.full_name end,
      'manager_name', case when s.branch_id = p_branch_id then manager.full_name end,
      'customer_name', case when s.branch_id = p_branch_id then c.full_name end,
      'customer_phone', case when s.branch_id = p_branch_id then c.phone end,
      'unit_price', case when s.branch_id = p_branch_id then x.unit_price end,
      'discount', case when s.branch_id = p_branch_id then x.discount end,
      'tax', case when s.branch_id = p_branch_id then x.tax end,
      'line_total', case when s.branch_id = p_branch_id then x.line_total end,
      'sale_total', case when s.branch_id = p_branch_id then s.total end,
      'payments', case when s.branch_id = p_branch_id then coalesce((
        select jsonb_agg(jsonb_build_object('method_name', pm.name, 'amount', sp.amount) order by sp.paid_at, sp.id)
        from public.sale_payments sp join public.payment_methods pm on pm.id = sp.payment_method_id
        where sp.sale_id = s.id), '[]'::jsonb) end
    )
    into v_sale
    from public.sales s
    join public.branches b on b.id = s.branch_id
    left join public.profiles seller on seller.id = s.seller_id
    left join public.profiles manager on manager.id = s.manager_id
    left join public.customers c on c.id = s.customer_id
    left join public.sale_lines x on x.sale_id = s.id and x.unit_id = v_unit.id
    where s.id = v_unit.sold_sale_id;
  end if;

  select rate into v_rate
  from public.exchange_rates
  where currency_from = 'USD' and currency_to = 'UZS'
  order by rate_date desc
  limit 1;

  select jsonb_build_object(
    'id', v_unit.id,
    'qr_code', v_unit.qr_code,
    'serial_number', v_unit.serial_number,
    'status', v_unit.status,
    'is_sellable', v_unit.is_sellable,
    'location_id', v_unit.location_id,
    'location_name', v_unit.location_name,
    'location_type', v_unit.location_type,
    'location_active', v_unit.location_active,
    'unit_branch_id', v_unit.unit_branch_id,
    'unit_branch_name', v_unit.unit_branch_name,
    'unit_branch_code', v_unit.unit_branch_code,
    'requested_branch_id', p_branch_id,
    'in_current_branch', v_unit.in_current_branch,
    'product_id', v_unit.product_id,
    'product_name', v_unit.product_name,
    'product_status', v_unit.product_status,
    'sku', v_unit.sku,
    'barcode', v_unit.barcode,
    'brand_name', v_unit.brand_name,
    'image', v_unit.image,
    'storefront_url', case when v_unit.product_status = 'active' and v_unit.is_published and v_unit.slug is not null
      then '/product/' || v_unit.slug else null end,
    'sale', v_sale,
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
        where a.product_id = v_unit.product_id and al.branch_id = v_unit.unit_branch_id and al.type = 'store'
          and al.is_active and a.status = 'available' and a.active_transfer_id is null),
      'warehouse', (select count(*) from public.inventory_units a join public.locations al on al.id = a.location_id
        where a.product_id = v_unit.product_id and al.branch_id = v_unit.unit_branch_id and al.type = 'warehouse'
          and al.is_active and a.status = 'available' and a.active_transfer_id is null)
    ),
    'other_branches', coalesce((
      select jsonb_agg(jsonb_build_object('branch_id', b.id, 'branch_name', b.name, 'quantity', q.qty) order by q.qty desc)
      from (
        select al.branch_id, count(*) as qty
        from public.inventory_units a
        join public.locations al on al.id = a.location_id
        where a.product_id = v_unit.product_id and al.is_active and al.type in ('store', 'warehouse')
          and a.status = 'available' and a.active_transfer_id is null and al.branch_id <> v_unit.unit_branch_id
        group by al.branch_id
      ) q
      join public.branches b on b.id = q.branch_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_pos_unit_context(uuid, text) from public, anon;
grant execute on function public.get_pos_unit_context(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
