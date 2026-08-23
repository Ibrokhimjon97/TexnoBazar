begin;

-- 1. New tool: product stock breakdown by branch/location
-- Answers: "Nechta ARTEL 55 TV bor do'kon va filiallarda?"
create or replace function public.ai_product_stock_by_branch(
  p_query text,
  p_branch_id uuid default null,
  p_limit integer default 5
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_q text := nullif(btrim(p_query), '');
begin
  perform public.require_ai_user();
  if v_q is null then
    raise exception 'Mahsulot nomi yoki SKU talab qilinadi' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_items
  from (
    select
      p.id as product_id,
      p.name as product_name,
      p.sku,
      p.retail_price,
      p.cost_price,
      (select count(*) from public.inventory_units u2
        join public.locations l2 on l2.id = u2.location_id
        where u2.product_id = p.id and u2.status = 'available'
          and l2.is_active and u2.active_transfer_id is null) as total_available,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'branch_name', sub.branch_name,
          'branch_id', sub.branch_id,
          'store_count', sub.store_count,
          'warehouse_count', sub.warehouse_count,
          'total', sub.store_count + sub.warehouse_count
        ) order by sub.branch_name)
        from (
          select
            b.name as branch_name, b.id as branch_id,
            count(*) filter (where l.type = 'store') as store_count,
            count(*) filter (where l.type = 'warehouse') as warehouse_count
          from public.inventory_units u
          join public.locations l on l.id = u.location_id
          join public.branches b on b.id = l.branch_id
          where u.product_id = p.id
            and u.status = 'available'
            and u.active_transfer_id is null
            and l.is_active
            and b.is_active
            and (p_branch_id is null or b.id = p_branch_id)
          group by b.id, b.name
        ) sub
      ), '[]'::jsonb) as branches
    from public.products p
    where p.name ilike '%' || v_q || '%' or p.sku ilike '%' || v_q || '%'
      or coalesce(p.barcode, '') ilike '%' || v_q || '%'
    order by p.name
    limit greatest(least(coalesce(p_limit, 5), 20), 1)
  ) q;

  return v_items;
end $$;

-- 2. New tool: product detail with description
-- Gives the AI full product info including description for a specific product
create or replace function public.ai_product_detail(p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.require_ai_user();
  select jsonb_build_object(
    'product_id', p.id,
    'name', p.name,
    'sku', p.sku,
    'barcode', p.barcode,
    'slug', p.slug,
    'status', p.status::text,
    'is_published', p.is_published,
    'cost_price', p.cost_price,
    'retail_price', p.retail_price,
    'wholesale_price', p.wholesale_price,
    'minimum_sale_price', p.minimum_sale_price,
    'promotion_price', p.promotion_price,
    'compare_at_price', p.compare_at_price,
    'tax_rate', p.tax_rate,
    'brand_name', br.name,
    'category_name', c.name,
    'description', left(p.description, 2000),
    'video_url', p.metadata->>'video_url',
    'available_units', (select count(*) from public.inventory_units u where u.product_id = p.id and u.status = 'available'),
    'sold_units', (select count(*) from public.inventory_units u where u.product_id = p.id and u.status = 'sold'),
    'total_units', (select count(*) from public.inventory_units u where u.product_id = p.id),
    'created_at', p.created_at
  ) into v_result
  from public.products p
  left join public.brands br on br.id = p.brand_id
  left join public.categories c on c.id = p.category_id
  where p.id = p_product_id;

  if v_result is null then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;
  return v_result;
end $$;

grant execute on function public.ai_product_stock_by_branch(text, uuid, integer) to authenticated, service_role;
grant execute on function public.ai_product_detail(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
