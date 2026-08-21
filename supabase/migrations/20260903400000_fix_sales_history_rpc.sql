-- Fix: CTE scope bug — `filtered` was referenced by two separate statements.
-- Now a single statement computes both the page items and the total via a window function.
create or replace function public.list_sales_history(
  p_branch_id uuid default null,
  p_from date default current_date,
  p_to date default current_date,
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_items jsonb;
  v_total bigint;
begin
  perform public.require_report_access(p_branch_id);

  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Sana oraligi notogri' using errcode = '22023';
  end if;

  with filtered as (
    select
      sl.id as line_id,
      sl.unit_id,
      sl.product_id,
      sl.unit_price,
      sl.discount,
      sl.tax,
      sl.line_total,
      sl.unit_cost,
      s.id as sale_id,
      s.sale_no,
      s.sold_at,
      s.status::text as sale_status,
      s.branch_id,
      b.name as branch_name,
      b.code as branch_code,
      seller.full_name as seller_name,
      manager.full_name as manager_name,
      p.name as product_name,
      p.sku,
      p.slug as product_slug,
      p.is_published,
      p.primary_media_url,
      u.qr_code,
      u.serial_number,
      count(*) over () as total_count
    from public.sale_lines sl
    join public.sales s on s.id = sl.sale_id
    join public.branches b on b.id = s.branch_id
    join public.profiles seller on seller.id = s.seller_id
    left join public.profiles manager on manager.id = s.manager_id
    join public.products p on p.id = sl.product_id
    left join public.inventory_units u on u.id = sl.unit_id
    where s.status <> 'void'
      and s.sold_at >= public.business_day_start(p_from)
      and s.sold_at < public.business_day_start(p_to + 1)
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and (
        p_query is null or btrim(p_query) = ''
        or p.name ilike '%' || btrim(p_query) || '%'
        or p.sku ilike '%' || btrim(p_query) || '%'
        or coalesce(u.qr_code, '') ilike '%' || btrim(p_query) || '%'
        or coalesce(u.serial_number, '') ilike '%' || btrim(p_query) || '%'
      )
    order by s.sold_at desc, sl.id desc
    limit greatest(coalesce(p_limit, 50), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select
    coalesce(jsonb_agg((to_jsonb(f) - 'total_count') order by f.sold_at desc, f.line_id desc), '[]'::jsonb),
    coalesce(max(f.total_count), 0)
  into v_items, v_total
  from filtered f;

  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

grant execute on function public.list_sales_history(uuid, date, date, text, integer, integer) to authenticated;
