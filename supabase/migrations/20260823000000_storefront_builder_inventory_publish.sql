begin;

-- Guided storefront settings are intentionally allow-listed. Internal and secret
-- system_settings keys can never be read or changed through the site builder.
create or replace function public.get_storefront_site_settings_admin()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) then
    raise exception 'Global admin roli talab qilinadi' using errcode='42501';
  end if;
  return coalesce((
    select jsonb_object_agg(s.key,s.value)
    from public.system_settings s
    where s.key=any(array[
      'site_name','seo_description','delivery_message','support_phone','footer_text','newsletter_text','payment_label',
      'hero_eyebrow','hero_title','hero_subtitle','hero_cta_label','hero_cta_url','catalog_title','featured_title'
    ])
  ),'{}'::jsonb);
end $$;

create or replace function public.save_storefront_site_settings(p_settings jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_key text;v_value jsonb;v_text text;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) then
    raise exception 'Global admin roli talab qilinadi' using errcode='42501';
  end if;
  if jsonb_typeof(p_settings)<>'object' then
    raise exception 'Sayt sozlamalari object bo‘lishi kerak' using errcode='22023';
  end if;
  for v_key,v_value in select key,value from jsonb_each(p_settings) loop
    if v_key<>all(array[
      'site_name','seo_description','delivery_message','support_phone','footer_text','newsletter_text','payment_label',
      'hero_eyebrow','hero_title','hero_subtitle','hero_cta_label','hero_cta_url','catalog_title','featured_title'
    ]) then raise exception 'Ruxsat etilmagan sayt sozlamasi: %',v_key using errcode='22023'; end if;
    if jsonb_typeof(v_value)<>'string' then raise exception '% matn bo‘lishi kerak',v_key using errcode='22023'; end if;
    v_text:=btrim(v_value#>>'{}');
    if length(v_text)>500 then raise exception '% qiymati juda uzun',v_key using errcode='22023'; end if;
    if v_key in('hero_cta_url') and v_text<>'' and v_text!~'^/' and v_text!~'^https://' then
      raise exception 'Havola / ichki yo‘l yoki https:// manzil bo‘lishi kerak' using errcode='22023';
    end if;
    insert into public.system_settings(key,value,description,is_public,updated_by)
    values(v_key,to_jsonb(v_text),case v_key
      when 'site_name' then 'Storefront nomi'
      when 'seo_description' then 'Storefront SEO tavsifi'
      else 'Storefront site builder sozlamasi' end,true,auth.uid())
    on conflict(key) do update set value=excluded.value,description=excluded.description,is_public=true,updated_by=auth.uid(),updated_at=now();
  end loop;
  return public.get_storefront_site_settings_admin();
end $$;

-- Public references travel through a sanitized RPC so storefront never needs
-- direct table grants (and therefore does not produce categories/brands 401s).
create or replace function public.storefront_references()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'categories',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'slug',c.slug,'description',c.description,
      'seo_title',c.seo_title,'seo_description',c.seo_description,'seo_image_url',c.seo_image_url,'updated_at',c.updated_at)
      order by c.sort_order,c.name,c.id) from public.categories c where c.is_active),'[]'::jsonb),
    'brands',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'name',b.name) order by b.name,b.id)
      from public.brands b where b.is_active),'[]'::jsonb)
  );
$$;

-- Products received into a store/warehouse are already catalog products. This
-- read model exposes those exact rows and their publication readiness; it never
-- creates a second product or synthetic stock record.
create or replace function public.list_inventory_catalog_candidates(
  p_query text default null,p_only_unpublished boolean default true,p_limit integer default 50,p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform public.require_catalog_admin();
  if p_limit not between 1 and 100 or p_offset<0 or length(coalesce(p_query,''))>200 then
    raise exception 'Qidiruv yoki sahifalash noto‘g‘ri' using errcode='22023';
  end if;
  with candidates as materialized(
    select p.id,p.name,p.sku,p.slug,p.status,p.is_published,p.retail_price,p.category_id,c.name category_name,c.is_active category_active,
      p.brand_id,br.name brand_name,coalesce(br.is_active,true) brand_active,count(u.id) available_stock,
      (select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order,m.id limit 1) primary_image,
      exists(select 1 from public.product_media m where m.product_id=p.id and m.is_primary) has_primary_media,
      not exists(select 1 from public.attribute_definitions a where a.is_required and (a.category_id is null or a.category_id=p.category_id)
        and not exists(select 1 from public.product_attribute_values v where v.product_id=p.id and v.attribute_id=a.id)) attributes_complete
    from public.products p join public.categories c on c.id=p.category_id left join public.brands br on br.id=p.brand_id
    join public.inventory_units u on u.product_id=p.id and u.status='available' and u.active_transfer_id is null
    join public.locations l on l.id=u.location_id and l.is_active and l.type in('store','warehouse')
    where p.status<>'archived' and (not p_only_unpublished or not p.is_published)
      and (nullif(btrim(p_query),'') is null or concat_ws(' ',p.name,p.sku,p.barcode) ilike '%'||btrim(p_query)||'%')
    group by p.id,c.id,br.id
  )
  select jsonb_build_object(
    'items',coalesce((select jsonb_agg(to_jsonb(x) order by x.name,x.id) from(
      select c.*,array_remove(array[
        case when not c.has_primary_media then 'Asosiy rasm yo‘q' end,
        case when not c.attributes_complete then 'Majburiy atributlar to‘liq emas' end,
        case when not c.category_active then 'Kategoriya faol emas' end,
        case when not c.brand_active then 'Brend faol emas' end,
        case when c.retail_price<=0 then 'Sotuv narxi kiritilmagan' end
      ],null) publish_issues
      from candidates c order by c.name,c.id limit p_limit offset p_offset
    )x),'[]'::jsonb),
    'total',(select count(*) from candidates)
  ) into v_result;
  return v_result;
end $$;

create or replace function public.bulk_publish_inventory_products(p_product_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid;v_product public.products%rowtype;v_results jsonb:='[]'::jsonb;v_success integer:=0;v_failure integer:=0;
begin
  perform public.require_catalog_admin();
  if cardinality(coalesce(p_product_ids,'{}'::uuid[])) not between 1 and 100
    or cardinality(p_product_ids)<>(select count(distinct x) from unnest(p_product_ids)x) then
    raise exception '1–100 ta takrorlanmagan mahsulot tanlang' using errcode='22023';
  end if;
  foreach v_id in array p_product_ids loop
    begin
      select * into v_product from public.products where id=v_id for update;
      if not found then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if;
      if v_product.status='archived' then raise exception 'Arxiv mahsulot nashr qilinmaydi' using errcode='23514'; end if;
      if v_product.retail_price<=0 then raise exception 'Sotuv narxini kiriting' using errcode='23514'; end if;
      if not exists(select 1 from public.categories where id=v_product.category_id and is_active) then raise exception 'Kategoriyani faollashtiring' using errcode='23514'; end if;
      if v_product.brand_id is not null and not exists(select 1 from public.brands where id=v_product.brand_id and is_active) then raise exception 'Brendni faollashtiring' using errcode='23514'; end if;
      if not exists(select 1 from public.inventory_units u join public.locations l on l.id=u.location_id
        where u.product_id=v_id and u.status='available' and u.active_transfer_id is null and l.is_active and l.type in('store','warehouse')) then
        raise exception 'Storefront uchun real mavjud qoldiq yo‘q' using errcode='23514';
      end if;
      perform public.assert_product_publishable(v_id);
      update public.products set status='active',is_published=true,updated_at=now() where id=v_id;
      v_success:=v_success+1;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('id',v_id,'ok',true));
    exception when others then
      v_failure:=v_failure+1;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('id',v_id,'ok',false,'error',sqlerrm));
    end;
  end loop;
  return jsonb_build_object('published_count',v_success,'failed_count',v_failure,'results',v_results);
end $$;

-- Storefront CMS is exposed only through this sanitized SECURITY DEFINER read
-- model. Even rows marked public cannot leak arbitrary system settings.
create or replace function public.storefront_cms_payload()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'banners',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'title',b.title,'image_url',b.image_url,
      'target_url',b.target_url,'placement',b.placement,'sort_order',b.sort_order,'starts_at',b.starts_at,'ends_at',b.ends_at)
      order by b.placement,b.sort_order,b.id) from public.cms_banners b where b.is_active and (b.starts_at is null or b.starts_at<=now()) and (b.ends_at is null or b.ends_at>now())),'[]'::jsonb),
    'home_blocks',coalesce((select jsonb_agg(to_jsonb(h) order by h.sort_order,h.id) from public.cms_home_blocks h where h.is_active and (h.starts_at is null or h.starts_at<=now()) and (h.ends_at is null or h.ends_at>now())),'[]'::jsonb),
    'menu_items',coalesce((select jsonb_agg(to_jsonb(m) order by m.location,m.sort_order,m.id) from public.cms_menu_items m where m.is_active),'[]'::jsonb),
    'promotions',coalesce((select jsonb_agg((to_jsonb(p)-'rules')||jsonb_build_object('product_ids',(select coalesce(jsonb_agg(x.product_id),'[]'::jsonb) from public.cms_promotion_products x where x.promotion_id=p.id)) order by p.starts_at,p.id) from public.cms_promotions p where p.is_active and p.starts_at<=now() and p.ends_at>now()),'[]'::jsonb),
    'pages',coalesce((select jsonb_agg(to_jsonb(p)-'created_by'-'updated_by' order by p.slug) from public.cms_pages p where p.is_published and p.published_at<=now()),'[]'::jsonb),
    'settings',coalesce((select jsonb_object_agg(s.key,s.value) from public.system_settings s where s.key=any(array[
      'site_name','seo_description','delivery_message','support_phone','footer_text','newsletter_text','payment_label',
      'hero_eyebrow','hero_title','hero_subtitle','hero_cta_label','hero_cta_url','catalog_title','featured_title'
    ])),'{}'::jsonb));
$$;

-- Existing mismatched children become visible roots; all future writes enforce the
-- same-location, one-level hierarchy used by every storefront renderer.
update public.cms_menu_items child set parent_id=null
where child.parent_id is not null and not exists(
  select 1 from public.cms_menu_items parent
  where parent.id=child.parent_id and parent.parent_id is null and parent.location=child.location
);
create or replace function public.enforce_cms_menu_parent()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_location text;v_parent_id uuid;
begin
  -- CMS menu writes are rare; one transaction-scoped lock makes parent and
  -- child checks atomic across concurrent inserts/reassignments/root edits.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.cms_menu_items.hierarchy',0));
  if tg_op='UPDATE' and exists(select 1 from public.cms_menu_items child where child.parent_id=new.id)
    and (new.parent_id is not null or new.location is distinct from old.location) then
    raise exception 'Ichki bandlari bor asosiy menyuni avval ichki bandlardan bo‘shating' using errcode='23514';
  end if;
  if new.parent_id is null then return new; end if;
  select parent.location,parent.parent_id into v_location,v_parent_id
  from public.cms_menu_items parent where parent.id=new.parent_id;
  if not found or v_parent_id is not null or v_location<>new.location then
    raise exception 'Yuqori menyu bandi shu joylashuvdagi asosiy band bo‘lishi kerak' using errcode='23514';
  end if;
  return new;
end $$;
drop trigger if exists cms_menu_items_parent_guard on public.cms_menu_items;
create trigger cms_menu_items_parent_guard before insert or update of parent_id,location on public.cms_menu_items
for each row execute function public.enforce_cms_menu_parent();

-- Public clients use storefront_cms_payload(); direct table reads remain admin-only.
drop policy if exists cms_pages_public_read on public.cms_pages;
drop policy if exists cms_banners_public_read on public.cms_banners;
drop policy if exists cms_promotions_public_read on public.cms_promotions;
drop policy if exists cms_promotion_products_public_read on public.cms_promotion_products;
drop policy if exists cms_home_blocks_public_read on public.cms_home_blocks;
drop policy if exists cms_menu_items_public_read on public.cms_menu_items;
drop policy if exists public_settings_user_read on public.system_settings;
revoke select on public.cms_pages,public.cms_banners,public.cms_promotions,public.cms_promotion_products,
  public.cms_home_blocks,public.cms_menu_items,public.system_settings from anon;

insert into public.system_settings(key,value,description,is_public)
values
  ('site_name','"Texnobazar"'::jsonb,'Storefront nomi',true),
  ('hero_eyebrow','"YANGI AVLOD TEXNIKALARI"'::jsonb,'Hero yuqori yozuvi',true),
  ('hero_title','"Texnologiya — endi yanada yaqin"'::jsonb,'Hero sarlavhasi',true),
  ('hero_subtitle','"Smartfon, maishiy texnika va aksessuarlarni real ombor qoldig‘i bilan tanlang."'::jsonb,'Hero izohi',true),
  ('hero_cta_label','"Katalogni ko‘rish"'::jsonb,'Hero tugmasi',true),
  ('hero_cta_url','"/catalog"'::jsonb,'Hero havolasi',true),
  ('catalog_title','"Ommabop kategoriyalar"'::jsonb,'Kategoriya bo‘limi sarlavhasi',true),
  ('featured_title','"Siz uchun tanladik"'::jsonb,'Mahsulot bo‘limi sarlavhasi',true)
on conflict(key) do nothing;

revoke all on function public.get_storefront_site_settings_admin(),public.save_storefront_site_settings(jsonb),public.storefront_references(),
  public.list_inventory_catalog_candidates(text,boolean,integer,integer),public.bulk_publish_inventory_products(uuid[]),
  public.enforce_cms_menu_parent()
from public,anon,authenticated;
grant execute on function public.get_storefront_site_settings_admin(),public.save_storefront_site_settings(jsonb),
  public.list_inventory_catalog_candidates(text,boolean,integer,integer),public.bulk_publish_inventory_products(uuid[])
to authenticated,service_role;
grant execute on function public.storefront_references() to anon,authenticated,service_role;

commit;
