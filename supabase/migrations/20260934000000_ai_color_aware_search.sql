-- Let the AI assistant answer color-based questions, e.g. "Xolodilnikni qora
-- ranglilardan qaysi modellari bor?". Extends the product-search tools with an
-- optional p_color filter and surfaces each product's available color variants.
begin;

create or replace function public.ai_search_products(p_query text default null, p_limit integer default 10, p_color text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_q text := nullif(btrim(p_query), ''); v_color text := nullif(btrim(p_color), '');
begin
  perform public.require_ai_user();
  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', q.id, 'name', q.name, 'sku', q.sku, 'slug', q.slug,
    'status', q.status, 'is_published', q.is_published,
    'cost_price', q.cost_price, 'retail_price', q.retail_price,
    'wholesale_price', q.wholesale_price, 'minimum_sale_price', q.minimum_sale_price,
    'brand_name', q.brand_name, 'category_name', q.category_name,
    'available_units', q.available_units, 'colors', q.colors
  ) order by q.name), '[]'::jsonb) into v_items
  from (
    select p.id, p.name, p.sku, p.slug, p.status::text as status, p.is_published,
      p.cost_price, p.retail_price, p.wholesale_price, p.minimum_sale_price,
      br.name as brand_name, c.name as category_name,
      (select count(*) from public.inventory_units u where u.product_id = p.id and u.status = 'available') as available_units,
      coalesce((select jsonb_agg(distinct pv.color_name) from public.product_variants pv where pv.product_id = p.id and pv.is_active), '[]'::jsonb) as colors
    from public.products p
    left join public.brands br on br.id = p.brand_id
    left join public.categories c on c.id = p.category_id
    where (v_q is null or p.name ilike '%' || v_q || '%' or p.sku ilike '%' || v_q || '%'
      or coalesce(p.barcode, '') ilike '%' || v_q || '%')
      and (v_color is null or exists(
        select 1 from public.product_variants pv where pv.product_id = p.id and pv.is_active and pv.color_name ilike '%' || v_color || '%'
      ))
    order by p.name
    limit greatest(least(coalesce(p_limit, 10), 30), 1)
  ) q;
  return v_items;
end $$;

create or replace function public.ai_product_stock_by_branch(
  p_query text,
  p_branch_id uuid default null,
  p_limit integer default 5,
  p_color text default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_q text := nullif(btrim(p_query), ''); v_color text := nullif(btrim(p_color), '');
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
      coalesce((select jsonb_agg(distinct pv.color_name) from public.product_variants pv where pv.product_id = p.id and pv.is_active), '[]'::jsonb) as colors,
      (select count(*) from public.inventory_units u2
        join public.locations l2 on l2.id = u2.location_id
        where u2.product_id = p.id and u2.status = 'available'
          and l2.is_active and u2.active_transfer_id is null
          and (v_color is null or exists(select 1 from public.product_variants pv2 where pv2.id = u2.variant_id and pv2.color_name ilike '%' || v_color || '%'))
      ) as total_available,
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
            and (v_color is null or exists(select 1 from public.product_variants pv3 where pv3.id = u.variant_id and pv3.color_name ilike '%' || v_color || '%'))
          group by b.id, b.name
        ) sub
      ), '[]'::jsonb) as branches
    from public.products p
    where (p.name ilike '%' || v_q || '%' or p.sku ilike '%' || v_q || '%'
      or coalesce(p.barcode, '') ilike '%' || v_q || '%')
      and (v_color is null or exists(
        select 1 from public.product_variants pv where pv.product_id = p.id and pv.is_active and pv.color_name ilike '%' || v_color || '%'
      ))
    order by p.name
    limit greatest(least(coalesce(p_limit, 5), 20), 1)
  ) q;

  return v_items;
end $$;

-- Product detail now also lists the product's color variants (name, hex, price, stock).
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
    'colors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'color_name', pv.color_name, 'color_hex', pv.color_hex,
        'price', coalesce(pv.promotion_price, pv.retail_price, p.promotion_price, p.retail_price),
        'available_units', (select count(*) from public.inventory_units u where u.variant_id = pv.id and u.status = 'available')
      ) order by pv.sort_order)
      from public.product_variants pv where pv.product_id = p.id and pv.is_active
    ), '[]'::jsonb),
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

drop function if exists public.ai_search_products(text, integer);
drop function if exists public.ai_product_stock_by_branch(text, uuid, integer);

grant execute on function public.ai_search_products(text, integer, text) to authenticated, service_role;
grant execute on function public.ai_product_stock_by_branch(text, uuid, integer, text) to authenticated, service_role;
grant execute on function public.ai_product_detail(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
