-- Update list_inventory_balances to return full aggregates (total, total_on_hand, total_reserved, total_value, total_cost)
create or replace function public.list_inventory_balances(
  p_branch_id uuid default null,
  p_location_id uuid default null,
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_category_id uuid default null,
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_availability text default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_items jsonb;
  v_total bigint;
  v_total_on_hand numeric;
  v_total_reserved numeric;
  v_total_value numeric;
  v_total_cost numeric;
  v_target_branch uuid;
  v_default_loc record;
begin
  if p_limit not between 1 and 500 or p_offset < 0 then
    raise exception 'Sahifalash noto''g''ri';
  end if;

  v_target_branch := coalesce(p_branch_id, (select id from public.branches limit 1));

  select l.id, l.name, l.type, br.name as branch_name into v_default_loc
  from public.locations l
  join public.branches br on br.id = l.branch_id
  where l.branch_id = v_target_branch
  order by case when l.type = 'warehouse' then 1 else 2 end, l.created_at
  limit 1;

  with combined as (
    -- 1. Products that have explicit entries in inventory_balances
    select
      ib.location_id,
      l.name as location_name,
      l.type as location_type,
      l.branch_id,
      br.name as branch_name,
      p.id as product_id,
      p.name as product_name,
      p.sku,
      p.retail_price,
      p.cost_price,
      p.category_id,
      ib.on_hand,
      ib.reserved,
      (ib.on_hand - ib.reserved) as available,
      ib.updated_at,
      p.created_at
    from public.inventory_balances ib
    join public.locations l on l.id = ib.location_id
    join public.branches br on br.id = l.branch_id
    join public.products p on p.id = ib.product_id
    where public.can_access_branch(l.branch_id)
      and (v_target_branch is null or l.branch_id = v_target_branch)
      and (p_location_id is null or l.id = p_location_id)
      and p.status <> 'archived'

    union all

    -- 2. Products in catalog that have NO balance in this branch yet
    select
      v_default_loc.id as location_id,
      coalesce(v_default_loc.name, 'Asosiy ombor') as location_name,
      coalesce(v_default_loc.type, 'warehouse') as location_type,
      v_target_branch as branch_id,
      coalesce(v_default_loc.branch_name, 'Filial') as branch_name,
      p.id as product_id,
      p.name as product_name,
      p.sku,
      p.retail_price,
      p.cost_price,
      p.category_id,
      0::numeric as on_hand,
      0::numeric as reserved,
      0::numeric as available,
      p.updated_at,
      p.created_at
    from public.products p
    where p.status <> 'archived'
      and (p_location_id is null or p_location_id = v_default_loc.id)
      and not exists (
        select 1
        from public.inventory_balances ib2
        join public.locations l2 on l2.id = ib2.location_id
        where ib2.product_id = p.id
          and (v_target_branch is null or l2.branch_id = v_target_branch)
      )
  ),
  filtered as (
    select c.*,
      (select m.public_url from public.product_media m where m.product_id = c.product_id order by m.is_primary desc, m.sort_order limit 1) as image
    from combined c
    where (p_query is null or c.product_name ilike '%'||btrim(p_query)||'%' or c.sku ilike '%'||btrim(p_query)||'%')
      and (p_category_id is null or c.category_id = p_category_id)
      and (p_min_price is null or c.retail_price >= p_min_price)
      and (p_max_price is null or c.retail_price <= p_max_price)
      and (p_availability is null
        or (p_availability in ('in_stock', 'available') and c.available > 0)
        or (p_availability in ('out_of_stock', 'empty') and c.available <= 0))
  ),
  aggregates as (
    select
      count(*)::bigint as cnt,
      coalesce(sum(on_hand), 0)::numeric as total_on_hand,
      coalesce(sum(reserved), 0)::numeric as total_reserved,
      coalesce(sum(on_hand * retail_price), 0)::numeric as total_value,
      coalesce(sum(on_hand * coalesce(cost_price, 0)), 0)::numeric as total_cost
    from filtered
  ),
  paged as (
    select *
    from filtered
    order by created_at desc, product_name
    limit p_limit offset p_offset
  )
  select
    coalesce((select cnt from aggregates), 0),
    coalesce((select total_on_hand from aggregates), 0),
    coalesce((select total_reserved from aggregates), 0),
    coalesce((select total_value from aggregates), 0),
    coalesce((select total_cost from aggregates), 0),
    coalesce((select jsonb_agg(to_jsonb(p)) from paged p), '[]'::jsonb)
  into v_total, v_total_on_hand, v_total_reserved, v_total_value, v_total_cost, v_items;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'total_on_hand', v_total_on_hand,
    'total_reserved', v_total_reserved,
    'total_value', v_total_value,
    'total_cost', v_total_cost
  );
end;
$$;

grant execute on function public.list_inventory_balances(uuid, uuid, text, integer, integer, uuid, numeric, numeric, text) to authenticated, service_role;
