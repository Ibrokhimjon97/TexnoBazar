create or replace function public.storefront_references()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'categories',coalesce((select jsonb_agg(jsonb_build_object(
      'id',c.id,'name',c.name,'slug',c.slug,'description',c.description,
      'seo_title',c.seo_title,'seo_description',c.seo_description,'seo_image_url',c.seo_image_url,
      'parent_id',c.parent_id,'updated_at',c.updated_at,
      'children',coalesce((select jsonb_agg(jsonb_build_object(
        'id',sc.id,'name',sc.name,'slug',sc.slug,'description',sc.description,
        'seo_image_url',sc.seo_image_url,'parent_id',sc.parent_id
      ) order by sc.sort_order,sc.name,sc.id) from public.categories sc where sc.parent_id=c.id and sc.is_active),'[]'::jsonb)
    ) order by c.sort_order,c.name,c.id) from public.categories c where c.is_active and c.parent_id is null),'[]'::jsonb),
    'brands',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'logo_url',b.logo_url) order by b.name,b.id)
      from public.brands b where b.is_active),'[]'::jsonb)
  );
$$;
