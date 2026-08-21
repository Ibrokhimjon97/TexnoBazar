-- Katalog mega-menusi uchun ixtiyoriy chuqurlikdagi kategoriya daraxti.
-- Avvalgi storefront_references() faqat bitta darajali children qaytargan;
-- endi har bir kategoriya o'z ichki shoxlarini rekursiv oladi.

create or replace function public.storefront_category_branch(p_parent uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',c.id,'name',c.name,'slug',c.slug,'description',c.description,
    'seo_title',c.seo_title,'seo_description',c.seo_description,'seo_image_url',c.seo_image_url,
    'parent_id',c.parent_id,'sort_order',c.sort_order,'updated_at',c.updated_at,
    'children',public.storefront_category_branch(c.id)
  ) order by c.sort_order,c.name,c.id),'[]'::jsonb)
  from public.categories c
  where c.is_active and c.parent_id is not distinct from p_parent;
$$;

create or replace function public.storefront_references()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'categories',public.storefront_category_branch(null),
    'brands',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'logo_url',b.logo_url) order by b.name,b.id)
      from public.brands b where b.is_active),'[]'::jsonb)
  );
$$;

revoke all on function public.storefront_category_branch(uuid) from public, anon, authenticated;
grant execute on function public.storefront_category_branch(uuid) to service_role;
grant execute on function public.storefront_references() to anon, authenticated, service_role;

commit;
