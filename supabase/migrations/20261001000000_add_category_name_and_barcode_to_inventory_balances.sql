-- Migration: 20261001000000_add_category_name_and_barcode_to_inventory_balances.sql
-- Description: Include category_name and barcode in list_inventory_balances RPC response

CREATE OR REPLACE FUNCTION public.list_inventory_balances(
  p_branch_id uuid DEFAULT NULL::uuid,
  p_location_id uuid DEFAULT NULL::uuid,
  p_query text DEFAULT NULL::text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_category_id uuid DEFAULT NULL::uuid,
  p_min_price numeric DEFAULT NULL::numeric,
  p_max_price numeric DEFAULT NULL::numeric,
  p_availability text DEFAULT NULL::text,
  p_has_image text DEFAULT NULL::text,
  p_sort_by text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
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
  if p_limit not between 1 and 5000 or p_offset < 0 then
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
      p.barcode,
      p.retail_price,
      p.cost_price,
      p.retail_price_usd,
      p.cost_price_usd,
      p.wholesale_price,
      p.wholesale_price_usd,
      p.minimum_sale_price,
      p.minimum_sale_price_usd,
      p.currency,
      p.category_id,
      c.name as category_name,
      ib.on_hand,
      ib.reserved,
      (ib.on_hand - ib.reserved) as available,
      ib.updated_at,
      p.created_at
    from public.inventory_balances ib
    join public.locations l on l.id = ib.location_id
    join public.branches br on br.id = l.branch_id
    join public.products p on p.id = ib.product_id
    left join public.categories c on c.id = p.category_id
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
      p.barcode,
      p.retail_price,
      p.cost_price,
      p.retail_price_usd,
      p.cost_price_usd,
      p.wholesale_price,
      p.wholesale_price_usd,
      p.minimum_sale_price,
      p.minimum_sale_price_usd,
      p.currency,
      p.category_id,
      c.name as category_name,
      0::numeric as on_hand,
      0::numeric as reserved,
      0::numeric as available,
      p.updated_at,
      p.created_at
    from public.products p
    left join public.categories c on c.id = p.category_id
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
    where (p_query is null 
      or c.product_name ilike '%'||btrim(p_query)||'%' 
      or c.sku ilike '%'||btrim(p_query)||'%'
      or coalesce(c.barcode, '') ilike '%'||btrim(p_query)||'%')
      and (p_category_id is null or c.category_id = p_category_id)
      and (p_min_price is null or c.retail_price >= p_min_price)
      and (p_max_price is null or c.retail_price <= p_max_price)
      and (p_availability is null
        or (p_availability in ('in_stock', 'available') and c.available > 0)
        or (p_availability in ('out_of_stock', 'empty') and c.available <= 0))
  ),
  with_image_filter as (
    select f.*
    from filtered f
    where (
      p_has_image is null or p_has_image = '' or p_has_image = 'all'
      or (p_has_image in ('with_image', 'true', 'has_image') and f.image is not null)
      or (p_has_image in ('without_image', 'false', 'no_image') and f.image is null)
    )
  ),
  aggregates as (
    select
      count(*)::bigint as cnt,
      coalesce(sum(on_hand), 0)::numeric as total_on_hand,
      coalesce(sum(reserved), 0)::numeric as total_reserved,
      coalesce(sum(on_hand * retail_price), 0)::numeric as total_value,
      coalesce(sum(on_hand * coalesce(cost_price, 0)), 0)::numeric as total_cost
    from with_image_filter
  ),
  paged as (
    select *
    from with_image_filter
    order by
      case when p_sort_by = 'image_first' then (case when image is not null then 0 else 1 end) end asc,
      case when p_sort_by = 'no_image_first' then (case when image is null then 0 else 1 end) end asc,
      case when p_sort_by = 'price_desc' then retail_price end desc,
      case when p_sort_by = 'price_asc' then retail_price end asc,
      case when p_sort_by = 'qty_desc' then available end desc,
      case when p_sort_by = 'qty_asc' then available end asc,
      case when p_sort_by = 'name_asc' then product_name end asc,
      created_at desc,
      product_name asc
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

GRANT EXECUTE ON FUNCTION public.list_inventory_balances(uuid, uuid, text, integer, integer, uuid, numeric, numeric, text, text, text) TO authenticated, service_role;
