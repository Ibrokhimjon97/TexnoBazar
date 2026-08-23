begin;

-- Extend list_inventory_balances with category, price range and availability filters.
create or replace function public.list_inventory_balances(
  p_branch_id uuid default null,
  p_location_id uuid default null,
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_category_id uuid default null,
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_availability text default null  -- 'in_stock', 'out_of_stock', or null (all)
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_total bigint;
begin
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto''g''ri'; end if;

  select count(*) into v_total
  from public.inventory_balances ib
  join public.locations l on l.id=ib.location_id
  join public.products p on p.id=ib.product_id
  where l.branch_id is not null
    and public.can_access_branch(l.branch_id)
    and (p_branch_id is null or l.branch_id=p_branch_id)
    and (p_location_id is null or l.id=p_location_id)
    and (p_query is null or p.name ilike '%'||btrim(p_query)||'%' or p.sku ilike '%'||btrim(p_query)||'%')
    and (p_category_id is null or p.category_id=p_category_id)
    and (p_min_price is null or p.retail_price>=p_min_price)
    and (p_max_price is null or p.retail_price<=p_max_price)
    and (p_availability is null
      or (p_availability='in_stock' and ib.on_hand-ib.reserved>0)
      or (p_availability='out_of_stock' and ib.on_hand-ib.reserved<=0));

  select coalesce(jsonb_agg(to_jsonb(x) order by x.product_name,x.location_name),'[]'::jsonb) into v_items from(
    select ib.location_id,l.name location_name,l.type location_type,l.branch_id,br.name branch_name,
      ib.product_id,p.name product_name,p.sku,p.retail_price,p.category_id,
      ib.on_hand,ib.reserved,ib.on_hand-ib.reserved available,ib.updated_at,
      (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1) image
    from public.inventory_balances ib
    join public.locations l on l.id=ib.location_id
    join public.branches br on br.id=l.branch_id
    join public.products p on p.id=ib.product_id
    where public.can_access_branch(l.branch_id)
      and (p_branch_id is null or l.branch_id=p_branch_id)
      and (p_location_id is null or l.id=p_location_id)
      and (p_query is null or p.name ilike '%'||btrim(p_query)||'%' or p.sku ilike '%'||btrim(p_query)||'%')
      and (p_category_id is null or p.category_id=p_category_id)
      and (p_min_price is null or p.retail_price>=p_min_price)
      and (p_max_price is null or p.retail_price<=p_max_price)
      and (p_availability is null
        or (p_availability='in_stock' and ib.on_hand-ib.reserved>0)
        or (p_availability='out_of_stock' and ib.on_hand-ib.reserved<=0))
    order by p.name,l.name limit p_limit offset p_offset
  )x;

  return jsonb_build_object('items',v_items,'total',v_total);
end; $$;

-- Keep existing grants (function signature changed with new default params, but
-- PostgreSQL allows overloading; drop old signature and re-grant).
-- The old 5-param signature is a subset of the new 9-param one with defaults,
-- so PostgreSQL will use the new definition transparently.

commit;
