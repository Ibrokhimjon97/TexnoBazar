-- Migration: Fix storefront primary media resolution, relax product_media constraints, and backfill product_media from products.seo_image_url
begin;

-- 1. Relax overly strict constraints on public.product_media
alter table public.product_media drop constraint if exists product_media_key_chk;
alter table public.product_media add constraint product_media_key_chk check (length(btrim(r2_key)) >= 1);

alter table public.product_media drop constraint if exists product_media_bytes_chk;
alter table public.product_media add constraint product_media_bytes_chk check (bytes is null or bytes >= 1);

alter table public.product_media drop constraint if exists product_media_mime_chk;
alter table public.product_media add constraint product_media_mime_chk check (mime_type is null or mime_type ilike 'image/%');

-- 2. Backfill product_media for existing products having seo_image_url but no product_media
insert into public.product_media (product_id, r2_key, public_url, mime_type, bytes, is_primary, sort_order)
select p.id,
       'products/' || p.id || '/primary.webp',
       p.seo_image_url,
       'image/webp',
       1024,
       true,
       0
from public.products p
where p.seo_image_url is not null
  and not exists (select 1 from public.product_media m where m.product_id = p.id);

-- 3. Trigger on products: automatically create/sync product_media when seo_image_url is set/updated
create or replace function public.trg_sync_product_seo_image_fn()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.seo_image_url is not null and (tg_op = 'INSERT' or old.seo_image_url is distinct from new.seo_image_url) then
    if not exists (select 1 from public.product_media where product_id = new.id and variant_id is null) then
      insert into public.product_media (product_id, r2_key, public_url, mime_type, bytes, is_primary, sort_order)
      values (new.id, 'products/' || new.id || '/primary.webp', new.seo_image_url, 'image/webp', 1024, true, 0);
    else
      update public.product_media
      set public_url = new.seo_image_url
      where product_id = new.id and variant_id is null and is_primary = true and (public_url is null or public_url = '' or public_url <> new.seo_image_url);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_product_seo_image on public.products;
create trigger trg_sync_product_seo_image
after insert or update of seo_image_url on public.products
for each row execute function public.trg_sync_product_seo_image_fn();

-- 4. Overload attach_product_media so calls using p_storage_path / p_file_size succeed seamlessly
create or replace function public.attach_product_media(
  p_actor_id uuid,
  p_product_id uuid,
  p_storage_path text,
  p_public_url text,
  p_file_size bigint,
  p_mime_type text,
  p_alt_text text default null,
  p_variant_id uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
begin
  return public.attach_product_media(
    p_actor_id := p_actor_id,
    p_product_id := p_product_id,
    p_r2_key := p_storage_path,
    p_public_url := p_public_url,
    p_mime_type := p_mime_type,
    p_bytes := greatest(coalesce(p_file_size, 1024), 1),
    p_alt_text := p_alt_text,
    p_variant_id := p_variant_id
  );
end;
$$;

grant execute on function public.attach_product_media(uuid,uuid,text,text,bigint,text,text,uuid) to authenticated, service_role;

-- 5. Update storefront_product_detail to coalesce primary_media_url with seo_image_url
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
      coalesce(
        (select m.public_url from public.product_media m where m.product_id=p.id and m.variant_id is null order by m.is_primary desc, m.sort_order, m.id limit 1),
        p.seo_image_url
      ) primary_media_url,
      coalesce(
        nullif((select jsonb_agg(jsonb_build_object('id', m.id, 'url', m.public_url, 'alt', m.alt_text) order by m.is_primary desc, m.sort_order, m.id) from public.product_media m where m.product_id=p.id and m.variant_id is null), '[]'::jsonb),
        case when p.seo_image_url is not null then jsonb_build_array(jsonb_build_object('id', p.id, 'url', p.seo_image_url, 'alt', p.name)) else '[]'::jsonb end
      ) media,
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

-- 6. Update storefront_catalog to coalesce primary_media_url with seo_image_url
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
      coalesce(
        (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc, m.sort_order, m.id limit 1),
        p.seo_image_url
      ) primary_media_url,
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

-- 7. Update storefront_catalog_faceted to coalesce primary_media_url with seo_image_url
create or replace function public.storefront_catalog_faceted(p_filters jsonb default '{}'::jsonb,p_limit integer default 24,p_offset integer default 0)
returns jsonb language sql stable security definer set search_path='' as $$
with input as(
  select public.validate_storefront_catalog_filters(p_filters) f
),base as(
  select p.id,p.sku,p.barcode,p.category_id,p.brand_id,p.name,p.slug,p.description,
    p.retail_price,p.compare_at_price,p.promotion_price,
    coalesce(p.promotion_price,p.retail_price) effective_price,p.tax_rate,p.created_at,
    coalesce(
      (select m.public_url from public.product_media m where m.product_id=p.id and m.variant_id is null order by m.is_primary desc,m.sort_order,m.id limit 1),
      p.seo_image_url
    ) primary_media_url,
    (select coalesce(jsonb_agg(jsonb_build_object('code',a.code,'name',a.name,'value',v.value,'is_filterable',a.is_filterable) order by a.sort_order,a.code),'[]'::jsonb) from public.product_attribute_values v join public.attribute_definitions a on a.id=v.attribute_id where v.product_id=p.id) attributes,
    (select count(*) from public.inventory_units u join public.locations l on l.id=u.location_id where u.product_id=p.id and u.status='available' and u.active_transfer_id is null and l.is_active and l.type in('store','warehouse')) available_stock,
    (select round(avg(r.rating),1) from public.product_reviews r where r.product_id=p.id and r.is_visible) avg_rating,
    (select count(*) from public.product_reviews r where r.product_id=p.id and r.is_visible) review_count,
    (select coalesce(jsonb_agg(jsonb_build_object(
        'id',pv.id,'color_name',pv.color_name,'color_hex',pv.color_hex,
        'price',coalesce(pv.promotion_price,pv.retail_price,p.promotion_price,p.retail_price),
        'stock',(select count(*) from public.inventory_units u where u.variant_id=pv.id and u.status='available' and u.active_transfer_id is null),
        'image',(select m.public_url from public.product_media m where m.variant_id=pv.id order by m.is_primary desc,m.sort_order,m.id limit 1)
      ) order by pv.sort_order,pv.created_at),'[]'::jsonb)
      from public.product_variants pv where pv.product_id=p.id and pv.is_active) variants
  from public.products p join public.categories c on c.id=p.category_id and c.is_active
  left join public.brands br on br.id=p.brand_id
  where p.status='active' and p.is_published and (p.brand_id is null or br.is_active)
),searched as(
  select b.* from base b cross join input i where
    (nullif(btrim(i.f->>'query'),'') is null or concat_ws(' ',b.name,b.sku,b.barcode,b.description,b.attributes::text) ilike '%'||btrim(i.f->>'query')||'%')
    and (coalesce((i.f->>'in_stock')::boolean,false)=false or b.available_stock>0)
),priced as(
  select s.* from searched s cross join input i where
    (nullif(i.f->>'min_price','') is null or s.effective_price>=(i.f->>'min_price')::numeric)
    and (nullif(i.f->>'max_price','') is null or s.effective_price<=(i.f->>'max_price')::numeric)
),category_scope as(
  select s.* from priced s cross join input i where coalesce(jsonb_array_length(i.f->'category_ids'),0)=0
    or s.category_id::text in(select jsonb_array_elements_text(i.f->'category_ids'))
),brand_scope as(
  select s.* from priced s cross join input i where coalesce(jsonb_array_length(i.f->'brand_ids'),0)=0
    or s.brand_id::text in(select jsonb_array_elements_text(i.f->'brand_ids'))
),selected_dimensions as(
  select s.* from category_scope s cross join input i where coalesce(jsonb_array_length(i.f->'brand_ids'),0)=0
    or s.brand_id::text in(select jsonb_array_elements_text(i.f->'brand_ids'))
),filtered as(
  select s.* from selected_dimensions s cross join input i where not exists(
    select 1 from jsonb_each(coalesce(i.f->'attributes','{}'::jsonb)) wanted_filter where not exists(
      select 1 from public.product_attribute_values pav join public.attribute_definitions ad on ad.id=pav.attribute_id
      where pav.product_id=s.id and ad.code=wanted_filter.key and exists(
        select 1 from jsonb_array_elements(case when jsonb_typeof(wanted_filter.value)='array' then wanted_filter.value else jsonb_build_array(wanted_filter.value) end) wanted
        where pav.value=wanted.value or (jsonb_typeof(pav.value)='array' and pav.value @> jsonb_build_array(wanted.value))
      )
    )
  )
),category_facet_source as(
  select s.* from brand_scope s cross join input i where not exists(
    select 1 from jsonb_each(coalesce(i.f->'attributes','{}'::jsonb)) wf where not exists(
      select 1 from public.product_attribute_values pav join public.attribute_definitions ad on ad.id=pav.attribute_id
      where pav.product_id=s.id and ad.code=wf.key and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(wf.value)='array' then wf.value else jsonb_build_array(wf.value) end) w where pav.value=w.value or (jsonb_typeof(pav.value)='array' and pav.value @> jsonb_build_array(w.value)))
    )
  )
),brand_facet_source as(
  select s.* from category_scope s cross join input i where not exists(
    select 1 from jsonb_each(coalesce(i.f->'attributes','{}'::jsonb)) wf where not exists(
      select 1 from public.product_attribute_values pav join public.attribute_definitions ad on ad.id=pav.attribute_id
      where pav.product_id=s.id and ad.code=wf.key and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(wf.value)='array' then wf.value else jsonb_build_array(wf.value) end) w where pav.value=w.value or (jsonb_typeof(pav.value)='array' and pav.value @> jsonb_build_array(w.value)))
    )
  )
),price_dimensions as(
  select s.* from searched s cross join input i where
    (coalesce(jsonb_array_length(i.f->'category_ids'),0)=0 or s.category_id::text in(select jsonb_array_elements_text(i.f->'category_ids')))
    and (coalesce(jsonb_array_length(i.f->'brand_ids'),0)=0 or s.brand_id::text in(select jsonb_array_elements_text(i.f->'brand_ids')))
),price_facet_source as(
  select s.* from price_dimensions s cross join input i where not exists(
    select 1 from jsonb_each(coalesce(i.f->'attributes','{}'::jsonb)) wf where not exists(
      select 1 from public.product_attribute_values pav join public.attribute_definitions ad on ad.id=pav.attribute_id
      where pav.product_id=s.id and ad.code=wf.key and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(wf.value)='array' then wf.value else jsonb_build_array(wf.value) end) w where pav.value=w.value or (jsonb_typeof(pav.value)='array' and pav.value @> jsonb_build_array(w.value)))
    )
  )
),ordered as(
  select s.* from filtered s cross join input i order by
    case when i.f->>'sort'='cheap' then effective_price end asc,
    case when i.f->>'sort'='expensive' then effective_price end desc,
    case when i.f->>'sort'='new' then created_at end desc,name,id
)
select jsonb_build_object(
  'items',coalesce((select jsonb_agg(to_jsonb(x)) from(select * from ordered limit greatest(1,least(p_limit,100)) offset greatest(p_offset,0))x),'[]'::jsonb),
  'total',(select count(*) from filtered),
  'facets',jsonb_build_object(
    'categories',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from(select c.id,c.name,count(*) count from category_facet_source f join public.categories c on c.id=f.category_id group by c.id,c.name)x),'[]'::jsonb),
    'brands',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from(select br.id,br.name,count(*) count from brand_facet_source f join public.brands br on br.id=f.brand_id group by br.id,br.name)x),'[]'::jsonb),
    'attributes',coalesce((select jsonb_object_agg(code,values) from(
      select code,jsonb_agg(jsonb_build_object('value',value_json,'count',match_count) order by value_text) values from(
        select candidate.code,candidate.value_json,candidate.value_text,(
          select count(distinct candidate_product.id)
          from selected_dimensions candidate_product cross join input i
          where exists(
            select 1 from public.product_attribute_values cpv join public.attribute_definitions cad on cad.id=cpv.attribute_id
            where cpv.product_id=candidate_product.id and cad.code=candidate.code
              and (cpv.value=candidate.value_json or (jsonb_typeof(cpv.value)='array' and cpv.value @> jsonb_build_array(candidate.value_json)))
          ) and not exists(
            select 1 from jsonb_each(coalesce(i.f->'attributes','{}'::jsonb)) selected_filter
            where selected_filter.key<>candidate.code and not exists(
              select 1 from public.product_attribute_values pav join public.attribute_definitions ad on ad.id=pav.attribute_id
              where pav.product_id=candidate_product.id and ad.code=selected_filter.key and exists(
                select 1 from jsonb_array_elements(case when jsonb_typeof(selected_filter.value)='array' then selected_filter.value else jsonb_build_array(selected_filter.value) end) wanted
                where pav.value=wanted.value or (jsonb_typeof(pav.value)='array' and pav.value @> jsonb_build_array(wanted.value))
              )
            )
          )
        ) match_count
        from(
          select distinct a.code,val.value value_json,val.value#>>'{}' value_text
          from selected_dimensions f join public.product_attribute_values pav on pav.product_id=f.id
          join public.attribute_definitions a on a.id=pav.attribute_id and a.is_filterable
          cross join lateral jsonb_array_elements(case when jsonb_typeof(pav.value)='array' then pav.value else jsonb_build_array(pav.value) end) val
        )candidate
      )scored where match_count>0 group by code
    )grouped),'{}'::jsonb),
    'price',coalesce((select jsonb_build_object('min',min(effective_price),'max',max(effective_price)) from price_facet_source),'{}'::jsonb)
  )
);
$$;

-- 8. Update storefront_products_by_ids to coalesce primary_media_url with seo_image_url
create or replace function public.storefront_products_by_ids(p_product_ids uuid[])
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.name,x.id),'[]'::jsonb) from(
    select p.id,p.sku,p.barcode,p.category_id,p.brand_id,p.name,p.slug,p.description,
      p.retail_price,p.compare_at_price,p.promotion_price,p.tax_rate,p.created_at,
      coalesce(
        (select m.public_url from public.product_media m where m.product_id=p.id and m.variant_id is null order by m.is_primary desc,m.sort_order,m.id limit 1),
        p.seo_image_url
      ) primary_media_url,
      (select coalesce(jsonb_agg(jsonb_build_object('code',a.code,'name',a.name,'value',v.value,'is_filterable',a.is_filterable) order by a.sort_order,a.code),'[]'::jsonb) from public.product_attribute_values v join public.attribute_definitions a on a.id=v.attribute_id where v.product_id=p.id) attributes,
      (select count(*) from public.inventory_units u join public.locations l on l.id=u.location_id where u.product_id=p.id and u.status='available' and u.active_transfer_id is null and l.is_active and l.type in('store','warehouse')) available_stock,
      (select round(avg(r.rating),1) from public.product_reviews r where r.product_id=p.id and r.is_visible) avg_rating,
      (select count(*) from public.product_reviews r where r.product_id=p.id and r.is_visible) review_count,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id',pv.id,'color_name',pv.color_name,'color_hex',pv.color_hex,
          'price',coalesce(pv.promotion_price,pv.retail_price,p.promotion_price,p.retail_price),
          'stock',(select count(*) from public.inventory_units u where u.variant_id=pv.id and u.status='available' and u.active_transfer_id is null),
          'image',(select m.public_url from public.product_media m where m.variant_id=pv.id order by m.is_primary desc,m.sort_order,m.id limit 1)
        ) order by pv.sort_order,pv.created_at),'[]'::jsonb)
        from public.product_variants pv where pv.product_id=p.id and pv.is_active) variants
    from public.products p join public.categories c on c.id=p.category_id and c.is_active left join public.brands br on br.id=p.brand_id
    where p.id=any(coalesce(p_product_ids,'{}'::uuid[])) and cardinality(coalesce(p_product_ids,'{}'::uuid[])) between 1 and 100
      and p.status='active' and p.is_published and (p.brand_id is null or br.is_active)
  )x;
$$;

commit;

notify pgrst, 'reload schema';
