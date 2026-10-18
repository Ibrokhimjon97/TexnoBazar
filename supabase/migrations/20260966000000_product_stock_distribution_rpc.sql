-- Product stock distribution across all branches and locations for seller/manager product inspection

create or replace function public.get_product_stock_distribution(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb)
  into v_res
  from (
    select 
      b.id as branch_id,
      b.name as branch_name,
      b.code as branch_code,
      l.id as location_id,
      l.name as location_name,
      l.type as location_type,
      ib.on_hand::numeric as on_hand,
      ib.reserved::numeric as reserved,
      greatest(0, (ib.on_hand - ib.reserved))::numeric as available,
      ib.updated_at
    from public.inventory_balances ib
    join public.locations l on l.id = ib.location_id
    join public.branches b on b.id = l.branch_id
    where ib.product_id = p_product_id and ib.on_hand > 0
    order by 
      b.name, 
      case when l.type = 'store' then 1 when l.type = 'warehouse' then 2 else 3 end,
      l.name
  ) t;

  return v_res;
end;
$$;

grant execute on function public.get_product_stock_distribution(uuid) to authenticated, anon;
