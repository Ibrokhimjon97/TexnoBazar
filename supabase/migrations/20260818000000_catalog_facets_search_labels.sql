-- Structured product content, server-side facets, advanced inventory search and price labels.
begin;

alter table public.products add column if not exists description_blocks jsonb not null default '[]'::jsonb;
alter table public.products drop constraint if exists products_description_blocks_chk;
alter table public.products add constraint products_description_blocks_chk
  check(jsonb_typeof(description_blocks)='array' and jsonb_array_length(description_blocks)<=50);

create or replace function public.validate_product_description_blocks()
returns trigger language plpgsql set search_path='' as $$
declare
  v_block jsonb;
  v_type text;
  v_row jsonb;
  v_media uuid;
begin
  if jsonb_typeof(new.description_blocks)<>'array' or jsonb_array_length(new.description_blocks)>50 then
    raise exception 'Rich tavsif bloklari noto‘g‘ri' using errcode='22023';
  end if;
  for v_block in select value from jsonb_array_elements(new.description_blocks) loop
    if jsonb_typeof(v_block)<>'object' then
      raise exception 'Tavsif bloki object bo‘lishi kerak' using errcode='22023';
    end if;
    v_type:=v_block->>'type';
    if v_type='text' then
      if jsonb_typeof(v_block->'text')<>'string' or length(v_block->>'text') not between 1 and 5000 then
        raise exception 'Text bloki noto‘g‘ri' using errcode='22023';
      end if;
    elsif v_type='heading' then
      if jsonb_typeof(v_block->'text')<>'string' or length(v_block->>'text') not between 1 and 240
        or coalesce(v_block->>'level','2')!~'^[2-4]$' then
        raise exception 'Heading bloki noto‘g‘ri' using errcode='22023';
      end if;
    elsif v_type='list' then
      if jsonb_typeof(v_block->'items')<>'array' or jsonb_array_length(v_block->'items') not between 1 and 50
        or exists(select 1 from jsonb_array_elements(v_block->'items') i where jsonb_typeof(i)<>'string' or length(i#>>'{}') not between 1 and 500) then
        raise exception 'List bloki noto‘g‘ri' using errcode='22023';
      end if;
    elsif v_type='table' then
      if jsonb_typeof(v_block->'headers')<>'array' or jsonb_typeof(v_block->'rows')<>'array'
        or jsonb_array_length(v_block->'headers') not between 1 and 20 or jsonb_array_length(v_block->'rows')>100
        or exists(select 1 from jsonb_array_elements(v_block->'headers') h where jsonb_typeof(h)<>'string' or length(h#>>'{}') not between 1 and 240) then
        raise exception 'Table bloki noto‘g‘ri' using errcode='22023';
      end if;
      if exists(select 1 from jsonb_array_elements(v_block->'rows') r where jsonb_typeof(r)<>'array' or jsonb_array_length(r)<>jsonb_array_length(v_block->'headers')) then
        raise exception 'Table qatori ustunlarga mos emas' using errcode='22023';
      end if;
      for v_row in select value from jsonb_array_elements(v_block->'rows') loop
        if exists(select 1 from jsonb_array_elements(v_row)c where jsonb_typeof(c)<>'string' or length(c#>>'{}')>1000) then
          raise exception 'Table katagi noto‘g‘ri' using errcode='22023';
        end if;
      end loop;
    elsif v_type='image' then
      if coalesce(v_block->>'media_id','')!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        or length(coalesce(v_block->>'caption',''))>240 then
        raise exception 'Image bloki noto‘g‘ri' using errcode='22023';
      end if;
      v_media:=(v_block->>'media_id')::uuid;
      if not exists(select 1 from public.product_media m where m.id=v_media and m.product_id=new.id) then
        raise exception 'Rich image shu mahsulot mediasiga tegishli emas' using errcode='23514';
      end if;
    elsif v_type in('video','link') then
      if length(coalesce(v_block->>'url',''))>2048 or coalesce(v_block->>'url','')!~'^https://'
        or (v_type='video' and coalesce(v_block->>'url','')!~'^https://(www\.)?(youtube\.com/watch\?v=|youtu\.be/|vimeo\.com/)')
        or length(coalesce(v_block->>'label',''))>240 then
        raise exception 'Link/video bloki allowlistga mos emas' using errcode='22023';
      end if;
    else
      raise exception 'Tavsif blok turi ruxsat etilmagan: %',coalesce(v_type,'null') using errcode='22023';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists products_description_blocks_guard on public.products;
create trigger products_description_blocks_guard before insert or update of description_blocks on public.products
  for each row execute function public.validate_product_description_blocks();

-- Referenced rich media cannot be detached until the product description is updated.
create or replace function public.detach_product_media(p_actor_id uuid,p_media_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare
  v_key text;
  v_product uuid;
  v_was_primary boolean;
  v_published boolean;
begin
  perform public.require_catalog_actor(p_actor_id);
  select m.r2_key,m.product_id,m.is_primary,p.is_published into v_key,v_product,v_was_primary,v_published
  from public.product_media m join public.products p on p.id=m.product_id
  where m.id=p_media_id for update of m,p;
  if v_key is null then raise exception 'Rasm topilmadi' using errcode='P0002'; end if;
  if exists(
    select 1 from public.products p cross join lateral jsonb_array_elements(p.description_blocks) block
    where p.id=v_product and block->>'type'='image' and block->>'media_id'=p_media_id::text
  ) then
    raise exception 'Rasm rich tavsifda ishlatilgan. Avval tavsif blokini o‘zgartiring' using errcode='23514';
  end if;
  if v_was_primary and v_published then
    raise exception 'Nashrdagi mahsulot asosiy rasmini o‘chirishdan oldin mahsulotni yashiring' using errcode='23514';
  end if;
  delete from public.product_media where id=p_media_id;
  if v_was_primary then
    update public.product_media set is_primary=true
    where id=(select id from public.product_media where product_id=v_product order by sort_order,created_at limit 1);
  end if;
  return v_key;
end $$;

create or replace function public.save_catalog_product(p_product jsonb,p_attributes jsonb default '[]'::jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_id uuid;
  v_status public.product_status;
  v_item jsonb;
  v_cost numeric(18,2);
  v_retail numeric(18,2);
  v_blocks jsonb;
begin
  perform public.require_catalog_admin();
  if jsonb_typeof(p_product)<>'object' or jsonb_typeof(p_attributes)<>'array' then
    raise exception 'Mahsulot formati noto‘g‘ri' using errcode='22023';
  end if;
  begin
    v_id=nullif(p_product->>'id','')::uuid;
    v_status=coalesce(nullif(p_product->>'status','')::public.product_status,'draft');
    v_cost=coalesce((p_product->>'cost_price')::numeric,0);
    v_retail=(p_product->>'retail_price')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Mahsulot identifikatori yoki narxi noto‘g‘ri' using errcode='22023';
  end;
  v_blocks=coalesce(p_product->'description_blocks','[]'::jsonb);
  if jsonb_typeof(v_blocks)<>'array' then raise exception 'Rich tavsif array bo‘lishi kerak' using errcode='22023'; end if;
  if v_id is null then
    insert into public.products(
      sku,barcode,category_id,brand_id,name,slug,description,description_blocks,seo_title,seo_description,seo_image_url,
      status,is_published,track_individual_units,cost_price,retail_price,wholesale_price,promotion_price,
      minimum_sale_price,compare_at_price,tax_rate,metadata
    ) values(
      upper(btrim(p_product->>'sku')),nullif(btrim(p_product->>'barcode'),''),(p_product->>'category_id')::uuid,
      nullif(p_product->>'brand_id','')::uuid,btrim(p_product->>'name'),lower(btrim(p_product->>'slug')),
      nullif(btrim(p_product->>'description'),''),v_blocks,nullif(btrim(p_product->>'seo_title'),''),
      nullif(btrim(p_product->>'seo_description'),''),nullif(btrim(p_product->>'seo_image_url'),''),v_status,false,
      coalesce((p_product->>'track_individual_units')::boolean,true),v_cost,v_retail,
      nullif(p_product->>'wholesale_price','')::numeric,nullif(p_product->>'promotion_price','')::numeric,
      coalesce(nullif(p_product->>'minimum_sale_price','')::numeric,least(v_cost,v_retail)),
      nullif(p_product->>'compare_at_price','')::numeric,coalesce((p_product->>'tax_rate')::numeric,0),
      coalesce(p_product->'metadata','{}'::jsonb)
    ) returning id into v_id;
  else
    update public.products set
      sku=upper(btrim(p_product->>'sku')),barcode=nullif(btrim(p_product->>'barcode'),''),
      category_id=(p_product->>'category_id')::uuid,brand_id=nullif(p_product->>'brand_id','')::uuid,
      name=btrim(p_product->>'name'),slug=lower(btrim(p_product->>'slug')),
      description=nullif(btrim(p_product->>'description'),''),
      description_blocks=case when p_product ? 'description_blocks' then v_blocks else description_blocks end,
      seo_title=nullif(btrim(p_product->>'seo_title'),''),seo_description=nullif(btrim(p_product->>'seo_description'),''),
      seo_image_url=nullif(btrim(p_product->>'seo_image_url'),''),
      status=case when status='archived' then 'draft'::public.product_status else v_status end,is_published=false,
      track_individual_units=coalesce((p_product->>'track_individual_units')::boolean,true),cost_price=v_cost,retail_price=v_retail,
      wholesale_price=case when p_product ? 'wholesale_price' then nullif(p_product->>'wholesale_price','')::numeric else wholesale_price end,
      promotion_price=case when p_product ? 'promotion_price' then nullif(p_product->>'promotion_price','')::numeric else promotion_price end,
      minimum_sale_price=case when p_product ? 'minimum_sale_price' then coalesce(nullif(p_product->>'minimum_sale_price','')::numeric,least(v_cost,v_retail)) else minimum_sale_price end,
      compare_at_price=case when p_product ? 'compare_at_price' then nullif(p_product->>'compare_at_price','')::numeric else compare_at_price end,
      tax_rate=coalesce((p_product->>'tax_rate')::numeric,0),metadata=coalesce(p_product->'metadata','{}'::jsonb)
    where id=v_id;
    if not found then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if;
  end if;
  delete from public.product_attribute_values where product_id=v_id;
  for v_item in select value from jsonb_array_elements(p_attributes) loop
    insert into public.product_attribute_values(product_id,attribute_id,value)
    values(v_id,(v_item->>'attribute_id')::uuid,v_item->'value');
  end loop;
  return v_id;
end $$;

create or replace function public.list_catalog_products(
  p_query text default null,p_status public.product_status default null,p_category_id uuid default null,
  p_brand_id uuid default null,p_limit integer default 20,p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb;v_total bigint;
begin
  perform public.require_catalog_admin();
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  select count(*) into v_total from public.products p
  where (nullif(btrim(p_query),'') is null or concat_ws(' ',p.name,p.sku,p.barcode,p.description,p.metadata::text) ilike '%'||btrim(p_query)||'%')
    and (p_status is null or p.status=p_status) and (p_category_id is null or p.category_id=p_category_id)
    and (p_brand_id is null or p.brand_id=p_brand_id);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb) into v_items from(
    select p.id,p.sku,p.barcode,p.category_id,c.name category_name,p.brand_id,b.name brand_name,p.name,p.slug,p.status,
      p.is_published,p.track_individual_units,p.cost_price,p.retail_price,p.wholesale_price,p.promotion_price,
      p.minimum_sale_price,p.compare_at_price,p.tax_rate,p.description_blocks,p.created_at,p.updated_at,
      coalesce(sum(ib.on_hand-ib.reserved),0) available_stock,
      (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order,m.id limit 1) primary_image
    from public.products p join public.categories c on c.id=p.category_id left join public.brands b on b.id=p.brand_id
    left join public.inventory_balances ib on ib.product_id=p.id
    where (nullif(btrim(p_query),'') is null or concat_ws(' ',p.name,p.sku,p.barcode,p.description,p.metadata::text) ilike '%'||btrim(p_query)||'%')
      and (p_status is null or p.status=p_status) and (p_category_id is null or p.category_id=p_category_id)
      and (p_brand_id is null or p.brand_id=p_brand_id)
    group by p.id,c.name,b.name order by p.created_at desc limit p_limit offset p_offset
  )x;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

create or replace function public.validate_storefront_catalog_filters(p_filters jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v jsonb:=coalesce(p_filters,'{}'::jsonb);v_pair record;v_min numeric;v_max numeric;
begin
  if jsonb_typeof(v)<>'object' then raise exception 'Katalog filtrlari object bo‘lishi kerak' using errcode='22023'; end if;
  if length(coalesce(v->>'query',''))>200 then raise exception 'Qidiruv matni juda uzun' using errcode='22023'; end if;
  if v ? 'category_ids' and jsonb_typeof(v->'category_ids')<>'array' then raise exception 'category_ids array bo‘lishi kerak' using errcode='22023'; end if;
  if v ? 'brand_ids' and jsonb_typeof(v->'brand_ids')<>'array' then raise exception 'brand_ids array bo‘lishi kerak' using errcode='22023'; end if;
  if coalesce(jsonb_array_length(v->'category_ids'),0)>100 or coalesce(jsonb_array_length(v->'brand_ids'),0)>100 then raise exception 'Facet qiymatlari juda ko‘p' using errcode='22023'; end if;
  if v ? 'attributes' and jsonb_typeof(v->'attributes')<>'object' then raise exception 'attributes object bo‘lishi kerak' using errcode='22023'; end if;
  for v_pair in select key,value from jsonb_each(coalesce(v->'attributes','{}'::jsonb)) loop
    if length(v_pair.key)>100 or jsonb_typeof(v_pair.value) not in('array','string')
      or (jsonb_typeof(v_pair.value)='array' and jsonb_array_length(v_pair.value)>50) then
      raise exception 'Attribute faceti noto‘g‘ri' using errcode='22023';
    end if;
  end loop;
  if v ? 'in_stock' and jsonb_typeof(v->'in_stock')<>'boolean' then raise exception 'in_stock boolean bo‘lishi kerak' using errcode='22023'; end if;
  if coalesce(v->>'sort','name') not in('name','new','cheap','expensive') then raise exception 'Saralash turi noto‘g‘ri' using errcode='22023'; end if;
  begin
    v_min=nullif(v->>'min_price','')::numeric;v_max=nullif(v->>'max_price','')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Narx filtri noto‘g‘ri' using errcode='22023';
  end;
  if coalesce(v_min,0)<0 or coalesce(v_max,0)<0 or (v_min is not null and v_max is not null and v_min>v_max) then
    raise exception 'Narx oralig‘i noto‘g‘ri' using errcode='22023';
  end if;
  return v;
end $$;

create or replace function public.storefront_catalog_faceted(p_filters jsonb default '{}'::jsonb,p_limit integer default 24,p_offset integer default 0)
returns jsonb language sql stable security definer set search_path='' as $$
with input as(
  select public.validate_storefront_catalog_filters(p_filters) f
),base as(
  select p.id,p.sku,p.barcode,p.category_id,p.brand_id,p.name,p.slug,p.description,
    p.retail_price,p.compare_at_price,p.promotion_price,
    coalesce(p.promotion_price,p.retail_price) effective_price,p.tax_rate,p.created_at,
    (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order,m.id limit 1) primary_media_url,
    (select coalesce(jsonb_agg(jsonb_build_object('code',a.code,'name',a.name,'value',v.value,'is_filterable',a.is_filterable) order by a.sort_order,a.code),'[]'::jsonb) from public.product_attribute_values v join public.attribute_definitions a on a.id=v.attribute_id where v.product_id=p.id) attributes,
    (select count(*) from public.inventory_units u join public.locations l on l.id=u.location_id where u.product_id=p.id and u.status='available' and u.active_transfer_id is null and l.is_active and l.type in('store','warehouse')) available_stock
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

create or replace function public.storefront_product_detail(p_slug text)
returns jsonb language sql stable security definer set search_path='' as $$
  select to_jsonb(x) from(
    select p.id,p.sku,p.barcode,p.category_id,p.brand_id,p.name,p.slug,p.description,p.description_blocks,
      p.seo_title,p.seo_description,p.seo_image_url,p.retail_price,p.compare_at_price,p.promotion_price,p.tax_rate,p.created_at,
      (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order,m.id limit 1) primary_media_url,
      (select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'url',m.public_url,'alt',m.alt_text) order by m.is_primary desc,m.sort_order,m.id),'[]'::jsonb) from public.product_media m where m.product_id=p.id) media,
      (select coalesce(jsonb_agg(jsonb_build_object('code',a.code,'name',a.name,'value',v.value,'is_filterable',a.is_filterable) order by a.sort_order,a.code),'[]'::jsonb) from public.product_attribute_values v join public.attribute_definitions a on a.id=v.attribute_id where v.product_id=p.id) attributes,
      (select count(*) from public.inventory_units u join public.locations l on l.id=u.location_id where u.product_id=p.id and u.status='available' and u.active_transfer_id is null and l.is_active and l.type in('store','warehouse')) available_stock
    from public.products p join public.categories c on c.id=p.category_id and c.is_active left join public.brands br on br.id=p.brand_id
    where p.slug=p_slug and p.status='active' and p.is_published and (p.brand_id is null or br.is_active)
  )x;
$$;

create or replace function public.storefront_products_by_ids(p_product_ids uuid[])
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.name,x.id),'[]'::jsonb) from(
    select p.id,p.sku,p.barcode,p.category_id,p.brand_id,p.name,p.slug,p.description,
      p.retail_price,p.compare_at_price,p.promotion_price,p.tax_rate,p.created_at,
      (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order,m.id limit 1) primary_media_url,
      (select coalesce(jsonb_agg(jsonb_build_object('code',a.code,'name',a.name,'value',v.value,'is_filterable',a.is_filterable) order by a.sort_order,a.code),'[]'::jsonb) from public.product_attribute_values v join public.attribute_definitions a on a.id=v.attribute_id where v.product_id=p.id) attributes,
      (select count(*) from public.inventory_units u join public.locations l on l.id=u.location_id where u.product_id=p.id and u.status='available' and u.active_transfer_id is null and l.is_active and l.type in('store','warehouse')) available_stock
    from public.products p join public.categories c on c.id=p.category_id and c.is_active left join public.brands br on br.id=p.brand_id
    where p.id=any(coalesce(p_product_ids,'{}'::uuid[])) and cardinality(coalesce(p_product_ids,'{}'::uuid[])) between 1 and 100
      and p.status='active' and p.is_published and (p.brand_id is null or br.is_active)
  )x;
$$;

create or replace function public.list_inventory_search_sellers()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) then
    raise exception 'Sotuvchi ma’lumotnomasi uchun admin roli talab qilinadi' using errcode='42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',p.id,'full_name',p.full_name,
      'branch_ids',coalesce((select jsonb_agg(distinct r.branch_id) from public.profile_roles r where r.profile_id=p.id and r.role='seller' and r.branch_id is not null),'[]'::jsonb)
    ) order by p.full_name,p.id)
    from public.profiles p
    where p.is_active and exists(select 1 from public.profile_roles r where r.profile_id=p.id and r.role='seller')
  ),'[]'::jsonb);
end $$;

create or replace function public.validate_inventory_search_filters(p_filters jsonb)
returns jsonb language plpgsql stable set search_path='' as $$
declare v jsonb:=coalesce(p_filters,'{}'::jsonb);v_key text;v_min numeric;v_max numeric;v_from timestamptz;v_to timestamptz;
begin
  if jsonb_typeof(v)<>'object' then raise exception 'Inventar qidiruv filtrlari object bo‘lishi kerak' using errcode='22023'; end if;
  foreach v_key in array array['branch_ids','location_ids','statuses','seller_ids'] loop
    if v ? v_key and jsonb_typeof(v->v_key)<>'array' then raise exception '% array bo‘lishi kerak',v_key using errcode='22023'; end if;
    if coalesce(jsonb_array_length(v->v_key),0)>100 then raise exception '% qiymatlari juda ko‘p',v_key using errcode='22023'; end if;
  end loop;
  if exists(select 1 from jsonb_each_text(v) item where length(item.value)>500) then raise exception 'Qidiruv filtri juda uzun' using errcode='22023'; end if;
  begin
    v_min=nullif(v->>'min_price','')::numeric;v_max=nullif(v->>'max_price','')::numeric;
    v_from=nullif(v->>'from','')::timestamptz;v_to=nullif(v->>'to','')::timestamptz;
  exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
    raise exception 'Narx yoki sana filtri noto‘g‘ri' using errcode='22023';
  end;
  if coalesce(v_min,0)<0 or coalesce(v_max,0)<0 or (v_min is not null and v_max is not null and v_min>v_max)
    or (v_from is not null and v_to is not null and v_from>=v_to) then
    raise exception 'Qidiruv oralig‘i noto‘g‘ri' using errcode='22023';
  end if;
  return v;
end $$;

create or replace function public.search_inventory_units(p_filters jsonb default '{}'::jsonb,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb;v_total bigint;v_filters jsonb;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) then
    raise exception 'Advanced inventar qidiruvi uchun admin roli talab qilinadi' using errcode='42501';
  end if;
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  v_filters:=public.validate_inventory_search_filters(p_filters);
  with found as materialized(
    select u.id,u.qr_code,u.serial_number,u.status,u.created_at,p.id product_id,p.name product_name,p.sku,
      p.retail_price,p.wholesale_price,p.promotion_price,b.id batch_id,b.reference batch_reference,b.received_at,
      l.id location_id,l.name location_name,l.branch_id,br.name branch_name,s.seller_id,s.sold_at,
      (select coalesce(jsonb_object_agg(a.code,v.value),'{}'::jsonb) from public.product_attribute_values v join public.attribute_definitions a on a.id=v.attribute_id where v.product_id=p.id) attributes
    from public.inventory_units u join public.products p on p.id=u.product_id left join public.stock_batches b on b.id=u.batch_id
    join public.locations l on l.id=u.location_id left join public.branches br on br.id=l.branch_id left join public.sales s on s.id=u.sold_sale_id
    where l.branch_id is not null and public.can_access_branch(l.branch_id)
      and (nullif(btrim(v_filters->>'query'),'') is null or concat_ws(' ',p.name,p.sku,p.barcode,u.qr_code,u.serial_number,b.reference,p.metadata::text) ilike '%'||btrim(v_filters->>'query')||'%')
      and (nullif(v_filters->>'qr','') is null or u.qr_code ilike '%'||btrim(v_filters->>'qr')||'%')
      and (nullif(v_filters->>'serial','') is null or coalesce(u.serial_number,'') ilike '%'||btrim(v_filters->>'serial')||'%')
      and (nullif(v_filters->>'batch','') is null or coalesce(b.reference,'') ilike '%'||btrim(v_filters->>'batch')||'%')
      and (nullif(v_filters->>'sku','') is null or p.sku ilike '%'||btrim(v_filters->>'sku')||'%')
      and (nullif(v_filters->>'model','') is null or exists(select 1 from public.product_attribute_values v join public.attribute_definitions a on a.id=v.attribute_id where v.product_id=p.id and a.code='model' and v.value#>>'{}' ilike '%'||btrim(v_filters->>'model')||'%'))
      and (nullif(v_filters->>'color','') is null or exists(select 1 from public.product_attribute_values v join public.attribute_definitions a on a.id=v.attribute_id where v.product_id=p.id and a.code='color' and v.value#>>'{}' ilike '%'||btrim(v_filters->>'color')||'%'))
      and (nullif(v_filters->>'size','') is null or exists(select 1 from public.product_attribute_values v join public.attribute_definitions a on a.id=v.attribute_id where v.product_id=p.id and a.code='size' and v.value#>>'{}' ilike '%'||btrim(v_filters->>'size')||'%'))
      and (nullif(v_filters->>'min_price','') is null or coalesce(p.promotion_price,p.retail_price)>=(v_filters->>'min_price')::numeric)
      and (nullif(v_filters->>'max_price','') is null or coalesce(p.promotion_price,p.retail_price)<=(v_filters->>'max_price')::numeric)
      and (coalesce(jsonb_array_length(v_filters->'branch_ids'),0)=0 or l.branch_id::text in(select jsonb_array_elements_text(v_filters->'branch_ids')))
      and (coalesce(jsonb_array_length(v_filters->'location_ids'),0)=0 or l.id::text in(select jsonb_array_elements_text(v_filters->'location_ids')))
      and (coalesce(jsonb_array_length(v_filters->'statuses'),0)=0 or u.status::text in(select jsonb_array_elements_text(v_filters->'statuses')))
      and (coalesce(jsonb_array_length(v_filters->'seller_ids'),0)=0 or s.seller_id::text in(select jsonb_array_elements_text(v_filters->'seller_ids')))
      and (nullif(v_filters->>'from','') is null or s.sold_at>=(v_filters->>'from')::timestamptz)
      and (nullif(v_filters->>'to','') is null or s.sold_at<(v_filters->>'to')::timestamptz)
  )
  select (select count(*) from found),coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id) from(
      select * from found order by created_at desc,id limit p_limit offset p_offset
    )x
  ),'[]'::jsonb) into v_total,v_items;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

create or replace function public.list_receipt_qr_labels(p_receipt_id uuid,p_limit integer default 100,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_branch uuid;v_items jsonb;v_total bigint;
begin
  if p_limit not between 1 and 200 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  select branch_id into v_branch from public.stock_receipts where id=p_receipt_id;
  if v_branch is null then raise exception 'Partiya topilmadi' using errcode='P0002'; end if;
  if not public.can_access_branch(v_branch) then raise exception 'Ruxsat yo‘q' using errcode='42501'; end if;
  select count(*) into v_total from public.inventory_units u join public.stock_batches b on b.id=u.batch_id where b.receipt_id=p_receipt_id;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.line_no,x.unit_sequence),'[]'::jsonb) into v_items from(
    select u.id,u.qr_code,u.serial_number,u.unit_sequence,b.line_no,p.name product_name,p.sku,r.receipt_no,
      p.retail_price,p.wholesale_price,p.promotion_price,p.minimum_sale_price,p.compare_at_price,
      coalesce(p.promotion_price,p.retail_price) effective_price,btrim(br.currency::text) currency,
      jsonb_build_object('title',p.name,'sku',p.sku,'price',coalesce(p.promotion_price,p.retail_price),
        'old_price',case when p.promotion_price is not null then p.retail_price else p.compare_at_price end,
        'currency',btrim(br.currency::text),'qr',u.qr_code) price_label
    from public.inventory_units u join public.stock_batches b on b.id=u.batch_id join public.products p on p.id=u.product_id
    join public.stock_receipts r on r.id=b.receipt_id join public.branches br on br.id=r.branch_id
    where b.receipt_id=p_receipt_id order by b.line_no,u.unit_sequence limit p_limit offset p_offset
  )x;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

revoke all on function public.validate_product_description_blocks(),public.validate_storefront_catalog_filters(jsonb),
  public.validate_inventory_search_filters(jsonb),public.storefront_catalog_faceted(jsonb,integer,integer),
  public.storefront_product_detail(text),public.storefront_products_by_ids(uuid[]),public.list_inventory_search_sellers(),
  public.search_inventory_units(jsonb,integer,integer),public.save_catalog_product(jsonb,jsonb),
  public.list_catalog_products(text,public.product_status,uuid,uuid,integer,integer),
  public.list_receipt_qr_labels(uuid,integer,integer),public.detach_product_media(uuid,uuid)
from public,anon,authenticated;
grant execute on function public.storefront_catalog_faceted(jsonb,integer,integer),public.storefront_product_detail(text),
  public.storefront_products_by_ids(uuid[]) to anon,authenticated,service_role;
grant execute on function public.search_inventory_units(jsonb,integer,integer),public.list_inventory_search_sellers(),public.save_catalog_product(jsonb,jsonb),
  public.list_catalog_products(text,public.product_status,uuid,uuid,integer,integer),
  public.list_receipt_qr_labels(uuid,integer,integer) to authenticated,service_role;
grant execute on function public.validate_product_description_blocks(),public.validate_storefront_catalog_filters(jsonb),
  public.validate_inventory_search_filters(jsonb),public.detach_product_media(uuid,uuid) to service_role;

commit;
