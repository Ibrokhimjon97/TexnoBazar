-- Migration: Add video_url to products, add compare_at_price and cost_price to product_variants,
-- update save_product_variants and storefront functions to expose video_url and variant details.

begin;

-- 1. Ensure video_url column exists on public.products
alter table public.products add column if not exists video_url text;

-- 2. Ensure compare_at_price and cost_price exist on public.product_variants
alter table public.product_variants add column if not exists compare_at_price numeric(18,2) check (compare_at_price is null or compare_at_price >= 0);
alter table public.product_variants add column if not exists cost_price numeric(18,2) check (cost_price is null or cost_price >= 0);

-- 3. Update save_product_variants to accept compare_at_price and cost_price
create or replace function public.save_product_variants(p_product_id uuid, p_variants jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_id uuid;
  v_seen uuid[] := '{}';
  v_keep uuid[] := '{}';
  v_sort integer := 0;
  v_referenced boolean;
begin
  if not (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null)) then
    raise exception 'Mahsulot variantlarini saqlash uchun admin yoki menejer roli talab qilinadi' using errcode = '42501';
  end if;
  if not exists(select 1 from public.products where id = p_product_id) then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_variants) is distinct from 'array' then
    raise exception 'Variantlar ro‘yxati massiv bo‘lishi kerak' using errcode = '22023';
  end if;
  if jsonb_array_length(p_variants) > 30 then
    raise exception 'Bir mahsulotda 30 tadan ortiq rang variant bo‘lishi mumkin emas' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_variants) loop
    if nullif(btrim(v_item->>'color_name'), '') is null then
      raise exception 'Rang nomi talab qilinadi' using errcode = '22023';
    end if;
    v_id := nullif(v_item->>'id', '')::uuid;
    if v_id is null then
      insert into public.product_variants(
        product_id, color_name, color_hex, retail_price, wholesale_price, promotion_price,
        minimum_sale_price, compare_at_price, cost_price, sort_order, is_active
      ) values (
        p_product_id,
        btrim(v_item->>'color_name'),
        nullif(btrim(v_item->>'color_hex'), ''),
        nullif(v_item->>'retail_price', '')::numeric,
        nullif(v_item->>'wholesale_price', '')::numeric,
        nullif(v_item->>'promotion_price', '')::numeric,
        nullif(v_item->>'minimum_sale_price', '')::numeric,
        nullif(v_item->>'compare_at_price', '')::numeric,
        nullif(v_item->>'cost_price', '')::numeric,
        v_sort,
        coalesce((v_item->>'is_active')::boolean, true)
      ) returning id into v_id;
    else
      update public.product_variants set
        color_name = btrim(v_item->>'color_name'),
        color_hex = nullif(btrim(v_item->>'color_hex'), ''),
        retail_price = nullif(v_item->>'retail_price', '')::numeric,
        wholesale_price = nullif(v_item->>'wholesale_price', '')::numeric,
        promotion_price = nullif(v_item->>'promotion_price', '')::numeric,
        minimum_sale_price = nullif(v_item->>'minimum_sale_price', '')::numeric,
        compare_at_price = nullif(v_item->>'compare_at_price', '')::numeric,
        cost_price = nullif(v_item->>'cost_price', '')::numeric,
        sort_order = v_sort,
        is_active = coalesce((v_item->>'is_active')::boolean, true)
      where id = v_id and product_id = p_product_id;
      if not found then raise exception 'Variant topilmadi' using errcode = 'P0002'; end if;
    end if;
    v_keep := array_append(v_keep, v_id);
    v_sort := v_sort + 1;
  end loop;

  -- Deactivate (never hard-delete) variants that were dropped from the payload but are
  -- still referenced by stock/media/orders; otherwise remove them entirely.
  for v_id in select id from public.product_variants where product_id = p_product_id and not (id = any(v_keep)) loop
    select exists(
      select 1 from public.inventory_units where variant_id = v_id
      union all select 1 from public.stock_batches where variant_id = v_id
      union all select 1 from public.order_lines where variant_id = v_id
    ) into v_referenced;
    if v_referenced then
      update public.product_variants set is_active = false where id = v_id;
    else
      delete from public.product_media where variant_id = v_id;
      delete from public.product_variants where id = v_id;
    end if;
  end loop;

  return coalesce((
    select jsonb_agg(to_jsonb(v) order by v.sort_order, v.created_at) from public.product_variants v where v.product_id = p_product_id
  ), '[]'::jsonb);
end;
$$;

-- 4. Update storefront_product_detail to return video_url and variant image/price details
create or replace function public.storefront_product_detail(p_slug text)
returns jsonb
language sql
stable security definer
set search_path to ''
as $function$
  select to_jsonb(x) from(
    select p.id, p.sku, p.barcode, p.category_id, p.brand_id, br.name as brand_name, p.name, p.slug,
      p.description, p.description_blocks, p.video_url,
      p.seo_title, p.seo_description, p.seo_image_url, p.retail_price, p.compare_at_price, p.promotion_price, p.tax_rate, p.created_at,
      (select m.public_url from public.product_media m where m.product_id=p.id and m.variant_id is null order by m.is_primary desc, m.sort_order, m.id limit 1) primary_media_url,
      (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'url', m.public_url, 'alt', m.alt_text) order by m.is_primary desc, m.sort_order, m.id), '[]'::jsonb) from public.product_media m where m.product_id=p.id and m.variant_id is null) media,
      (select coalesce(jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'value', v.value, 'is_filterable', a.is_filterable) order by a.sort_order, a.code), '[]'::jsonb) from public.product_attribute_values v join public.attribute_definitions a on a.id=v.attribute_id where v.product_id=p.id) attributes,
      (select count(*) from public.inventory_units u join public.locations l on l.id=u.location_id where u.product_id=p.id and u.status='available' and u.active_transfer_id is null and l.is_active and l.type in('store','warehouse')) available_stock,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id', pv.id, 'color_name', pv.color_name, 'color_hex', pv.color_hex,
          'price', coalesce(pv.promotion_price, pv.retail_price, p.promotion_price, p.retail_price),
          'retail_price', coalesce(pv.retail_price, p.retail_price),
          'compare_at_price', coalesce(pv.compare_at_price, p.compare_at_price),
          'cost_price', coalesce(pv.cost_price, p.cost_price),
          'image', (select m.public_url from public.product_media m where m.variant_id=pv.id order by m.is_primary desc, m.sort_order, m.id limit 1),
          'stock', (select count(*) from public.inventory_units u join public.locations l on l.id=u.location_id where u.variant_id=pv.id and u.status='available' and u.active_transfer_id is null and l.is_active and l.type in('store','warehouse')),
          'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'url', m.public_url, 'alt', m.alt_text) order by m.is_primary desc, m.sort_order, m.id) from public.product_media m where m.variant_id=pv.id), '[]'::jsonb)
        ) order by pv.sort_order, pv.created_at), '[]'::jsonb)
        from public.product_variants pv where pv.product_id=p.id and pv.is_active) variants
    from public.products p
    join public.categories c on c.id=p.category_id and c.is_active
    left join public.brands br on br.id=p.brand_id
    where p.slug=p_slug and p.status='active' and p.is_published and (p.brand_id is null or br.is_active)
  ) x;
$function$;

-- 5. Update storefront_catalog to include video_url and variants
create or replace function public.storefront_catalog(p_query text default null::text, p_category_id uuid default null::uuid, p_limit integer default 24, p_offset integer default 0)
returns jsonb
language sql
stable security definer
set search_path to ''
as $function$
  with filtered as(
    select p.id, p.sku, p.barcode, p.category_id, p.brand_id, br.name as brand_name, p.name, p.slug,
      p.description, p.video_url, p.seo_title, p.seo_description, p.seo_image_url, p.retail_price, p.compare_at_price,
      p.promotion_price, p.tax_rate, p.created_at,
      (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc, m.sort_order, m.id limit 1) primary_media_url,
      (select coalesce(jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'value', v.value) order by a.sort_order, a.code), '[]'::jsonb)
       from public.product_attribute_values v join public.attribute_definitions a on a.id=v.attribute_id where v.product_id=p.id) attributes,
      (select count(*) from public.inventory_units u join public.locations l on l.id=u.location_id where u.product_id=p.id
        and u.status='available' and u.active_transfer_id is null and l.is_active and l.type in('store','warehouse')) available_stock,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id', pv.id, 'color_name', pv.color_name, 'color_hex', pv.color_hex,
          'price', coalesce(pv.promotion_price, pv.retail_price, p.promotion_price, p.retail_price),
          'image', (select m.public_url from public.product_media m where m.variant_id=pv.id order by m.is_primary desc, m.sort_order, m.id limit 1)
        ) order by pv.sort_order, pv.created_at), '[]'::jsonb)
        from public.product_variants pv where pv.product_id=p.id and pv.is_active) variants
    from public.products p
    left join public.brands br on br.id=p.brand_id
    where p.status='active' and p.is_published and (p_category_id is null or p.category_id=p_category_id)
      and (nullif(btrim(p_query),'') is null or p.name ilike '%'||btrim(p_query)||'%' or p.sku ilike '%'||btrim(p_query)||'%' or coalesce(p.barcode,'') ilike '%'||btrim(p_query)||'%'))
  select jsonb_build_object('items', coalesce((select jsonb_agg(to_jsonb(x) order by x.name, x.id) from(select * from filtered order by name, id limit greatest(1, least(p_limit, 100)) offset greatest(p_offset, 0)) x), '[]'::jsonb), 'total', (select count(*) from filtered));
$function$;

notify pgrst, 'reload schema';

commit;
