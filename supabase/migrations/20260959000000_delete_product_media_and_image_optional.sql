-- Migration: Allow deleting product media via Supabase RPC and allow products without images
-- to be saved, published, and displayed on the storefront.

begin;

-- 1. Create delete_product_media RPC callable by authenticated managers and admins
create or replace function public.delete_product_media(p_media_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_product uuid;
  v_variant uuid;
  v_was_primary boolean;
begin
  perform public.require_catalog_admin();

  delete from public.product_media
  where id = p_media_id
  returning r2_key, product_id, variant_id, is_primary
  into v_key, v_product, v_variant, v_was_primary;

  if v_product is null then
    return jsonb_build_object('success', true, 'deleted', false);
  end if;

  -- If this was primary and there are remaining images, set the first one as primary
  if v_was_primary then
    update public.product_media
    set is_primary = true
    where id = (
      select id from public.product_media
      where product_id = v_product and variant_id is not distinct from v_variant
      order by sort_order, created_at
      limit 1
    );
  end if;

  return jsonb_build_object('success', true, 'deleted', true, 'key', v_key);
end;
$$;

-- 2. Update assert_product_publishable so images are optional
create or replace function public.assert_product_publishable(p_product_id uuid)
returns void
language plpgsql
stable security definer
set search_path = ''
as $$
declare
  v_category uuid;
begin
  select category_id into v_category from public.products where id = p_product_id;
  if not found then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;

  -- Image is optional: products without images are allowed to be published and displayed!

  if exists (
    select 1 from public.attribute_definitions a
    where a.is_required and (a.category_id is null or a.category_id = v_category)
      and not exists (
        select 1 from public.product_attribute_values v
        where v.product_id = p_product_id and v.attribute_id = a.id
      )
  ) then
    raise exception 'Barcha majburiy atributlarni to‘ldiring' using errcode = '23514';
  end if;
end;
$$;

-- 3. Update list_inventory_catalog_candidates to not treat missing image as a blocking issue
create or replace function public.list_inventory_catalog_candidates(
  p_query text default null,
  p_only_unpublished boolean default true,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform public.require_catalog_admin();
  if p_limit not between 1 and 200 or p_offset < 0 then
    raise exception 'Sahifalash noto‘g‘ri' using errcode = '22023';
  end if;

  with candidates as (
    select
      p.id,
      p.sku,
      p.name,
      p.retail_price,
      p.is_published,
      p.created_at,
      c.name as category_name,
      br.name as brand_name,
      (select m.public_url from public.product_media m where m.product_id = p.id and m.variant_id is null order by m.is_primary desc, m.sort_order, m.id limit 1) as primary_image,
      exists(select 1 from public.product_media m where m.product_id = p.id and m.variant_id is null and m.is_primary) as has_primary_media,
      c.is_active as category_active,
      (p.brand_id is null or br.is_active) as brand_active,
      not exists(
        select 1 from public.attribute_definitions a
        where a.is_required and (a.category_id is null or a.category_id = c.id)
          and not exists(select 1 from public.product_attribute_values v where v.product_id = p.id and v.attribute_id = a.id)
      ) as attributes_complete,
      count(u.id) as available_stock
    from public.products p
    join public.categories c on c.id = p.category_id
    left join public.brands br on br.id = p.brand_id
    join public.inventory_units u on u.product_id = p.id and u.status = 'available' and u.active_transfer_id is null
    join public.locations l on l.id = u.location_id and l.is_active and l.type in ('store','warehouse')
    where p.status <> 'archived'
      and (not p_only_unpublished or not p.is_published)
      and (nullif(btrim(p_query),'') is null or concat_ws(' ', p.name, p.sku, p.barcode) ilike '%' || btrim(p_query) || '%')
    group by p.id, c.id, br.id
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.name, x.id) from (
        select
          c.*,
          array_remove(array[
            case when not c.attributes_complete then 'Majburiy atributlar to‘liq emas' end,
            case when not c.category_active then 'Kategoriya faol emas' end,
            case when not c.brand_active then 'Brend faol emas' end,
            case when c.retail_price <= 0 then 'Sotuv narxi kiritilmagan' end
          ], null) as publish_issues
        from candidates c
        order by c.name, c.id
        limit p_limit offset p_offset
      ) x
    ), '[]'::jsonb),
    'total', (select count(*) from candidates)
  ) into v_result;

  return v_result;
end;
$$;

-- 4. Permissions & Grants
grant execute on function public.delete_product_media(uuid) to authenticated, service_role;
grant execute on function public.assert_product_publishable(uuid) to authenticated, service_role;
grant execute on function public.list_inventory_catalog_candidates(text, boolean, integer, integer) to authenticated, service_role;

grant select, insert, update, delete on public.product_media to authenticated;

drop policy if exists "manager_write_product_media" on public.product_media;
create policy "manager_write_product_media" on public.product_media for all to authenticated
  using (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null))
  with check (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null));

commit;

notify pgrst, 'reload schema';
