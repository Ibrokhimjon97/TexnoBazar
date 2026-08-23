begin;

-- Warehouse units are sellable now, so the seller unit list must show them too
-- and expose the location type for the UI badges.
create or replace function public.list_pos_units(p_branch_id uuid, p_query text, p_limit integer default 30, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_items jsonb; v_total bigint; v_q text := nullif(btrim(p_query), '');
begin
  perform public.require_pos_seller(p_branch_id);
  if p_limit not between 1 and 100 or p_offset < 0 then
    raise exception 'Sahifalash noto‘g‘ri' using errcode = '22023';
  end if;

  select count(*) into v_total
  from public.inventory_units u
  join public.locations l on l.id = u.location_id
  join public.products p on p.id = u.product_id
  where l.branch_id = p_branch_id and l.type in ('store', 'warehouse') and l.is_active
    and u.status = 'available' and u.active_transfer_id is null and p.status = 'active'
    and (v_q is null or p.name ilike '%'||v_q||'%' or p.sku ilike '%'||v_q||'%'
      or coalesce(p.barcode, '') ilike '%'||v_q||'%'
      or u.qr_code ilike '%'||v_q||'%' or coalesce(u.serial_number, '') ilike '%'||v_q||'%');

  select coalesce(jsonb_agg(to_jsonb(q) order by q.product_name, q.id), '[]'::jsonb) into v_items
  from (
    select u.id, u.qr_code, u.serial_number, u.location_id, l.name location_name, l.type location_type,
      p.id product_id, p.name product_name, p.sku, p.barcode, br.name brand_name,
      p.retail_price, p.minimum_sale_price, p.tax_rate,
      coalesce(sb.unit_cost, p.cost_price) unit_cost,
      (select m.public_url from public.product_media m where m.product_id = p.id order by m.is_primary desc, m.sort_order limit 1) image,
      (select count(*) from public.inventory_units a join public.locations al on al.id = a.location_id
        where a.product_id = p.id and al.branch_id = p_branch_id and al.type in ('store', 'warehouse')
          and al.is_active and a.status = 'available' and a.active_transfer_id is null) available_branch_count
    from public.inventory_units u
    join public.locations l on l.id = u.location_id
    join public.products p on p.id = u.product_id
    left join public.brands br on br.id = p.brand_id
    left join public.stock_batches sb on sb.id = u.batch_id
    where l.branch_id = p_branch_id and l.type in ('store', 'warehouse') and l.is_active
      and u.status = 'available' and u.active_transfer_id is null and p.status = 'active'
      and (v_q is null or p.name ilike '%'||v_q||'%' or p.sku ilike '%'||v_q||'%'
        or coalesce(p.barcode, '') ilike '%'||v_q||'%'
        or u.qr_code ilike '%'||v_q||'%' or coalesce(u.serial_number, '') ilike '%'||v_q||'%')
    order by p.name, u.id
    limit p_limit offset p_offset
  ) q;

  return jsonb_build_object('items', v_items, 'total', v_total);
end;
$$;

revoke all on function public.list_pos_units(uuid, text, integer, integer) from public, anon;
grant execute on function public.list_pos_units(uuid, text, integer, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
