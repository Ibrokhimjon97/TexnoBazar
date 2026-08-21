begin;

-- Every visible storefront label lives in one allow-list so the admin panel can
-- edit the whole customer surface without a developer. The list is declared once
-- and reused by the admin reader, the writer and the public payload to stop drift.
create or replace function public.storefront_public_setting_keys()
returns text[] language sql immutable set search_path='' as $$
  select array[
    -- global identity and contact
    'site_name','seo_description','delivery_message','support_phone','footer_text','newsletter_text','payment_label',
    -- hero
    'hero_eyebrow','hero_title','hero_subtitle','hero_cta_label','hero_cta_url',
    'hero_secondary_label','hero_trust_items','hero_badge_title','hero_badge_text',
    -- header and navigation
    'promo_badges','search_placeholder','catalog_button_label','nav_home_label','nav_sale_label','nav_sale_url',
    'label_favorites','label_cart','label_account',
    -- section headings
    'catalog_kicker','catalog_title','featured_kicker','featured_title','featured_subtitle',
    'promotions_kicker','promotions_title','promo_banner_label','pages_kicker','pages_title',
    -- advantages strip
    'feature_1_title','feature_1_text','feature_2_title','feature_2_text',
    'feature_3_title','feature_3_text','feature_4_title','feature_4_text',
    -- footer
    'footer_badges','footer_pages_title','footer_catalog_title','newsletter_title'
  ]::text[];
$$;

create or replace function public.get_storefront_site_settings_admin()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) then
    raise exception 'Global admin roli talab qilinadi' using errcode='42501';
  end if;
  return coalesce((
    select jsonb_object_agg(s.key,s.value)
    from public.system_settings s
    where s.key=any(public.storefront_public_setting_keys())
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
    if v_key<>all(public.storefront_public_setting_keys()) then
      raise exception 'Ruxsat etilmagan sayt sozlamasi: %',v_key using errcode='22023';
    end if;
    if jsonb_typeof(v_value)<>'string' then raise exception '% matn bo‘lishi kerak',v_key using errcode='22023'; end if;
    v_text:=btrim(v_value#>>'{}');
    if length(v_text)>500 then raise exception '% qiymati juda uzun',v_key using errcode='22023'; end if;
    if v_key in('hero_cta_url','nav_sale_url') and v_text<>'' and v_text!~'^/' and v_text!~'^https://' then
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
    'settings',coalesce((select jsonb_object_agg(s.key,s.value) from public.system_settings s
      where s.key=any(public.storefront_public_setting_keys())),'{}'::jsonb));
$$;

-- Seeded defaults keep the shipped design intact until an admin edits it.
insert into public.system_settings(key,value,description,is_public) values
  ('hero_secondary_label','"Barcha mahsulotlar"'::jsonb,'Hero ikkinchi tugmasi',true),
  ('hero_trust_items','"Real ombor qoldig‘i | Rasmiy kafolat | Tezkor yetkazish"'::jsonb,'Hero ishonch belgilari',true),
  ('hero_badge_title','"Omborda mavjud"'::jsonb,'Hero rasm ustidagi belgi sarlavhasi',true),
  ('hero_badge_text','"Qoldiq real vaqtda yangilanadi"'::jsonb,'Hero rasm ustidagi belgi izohi',true),
  ('promo_badges','"100% original mahsulot | Real ombor qoldig‘i"'::jsonb,'Yuqori panel belgilari',true),
  ('search_placeholder','"Mahsulot, brend yoki SKU qidiring…"'::jsonb,'Qidiruv maydoni matni',true),
  ('catalog_button_label','"Katalog"'::jsonb,'Katalog tugmasi matni',true),
  ('nav_home_label','"Bosh sahifa"'::jsonb,'Menyudagi bosh sahifa matni',true),
  ('nav_sale_label','"Chegirmalar"'::jsonb,'Menyudagi aksiya bandi matni',true),
  ('nav_sale_url','"/catalog"'::jsonb,'Menyudagi aksiya bandi havolasi',true),
  ('label_favorites','"Saralangan"'::jsonb,'Saralanganlar tugmasi matni',true),
  ('label_cart','"Savatcha"'::jsonb,'Savatcha tugmasi matni',true),
  ('label_account','"Kabinet"'::jsonb,'Kabinet tugmasi matni',true),
  ('catalog_kicker','"KATEGORIYALAR"'::jsonb,'Kategoriya bo‘limi yuqori yozuvi',true),
  ('featured_kicker','"TANLANGAN MAHSULOTLAR"'::jsonb,'Mahsulot bo‘limi yuqori yozuvi',true),
  ('featured_subtitle','"Ombordagi haqiqiy qoldiqqa ega yangi mahsulotlar"'::jsonb,'Mahsulot bo‘limi izohi',true),
  ('promotions_kicker','"MAXSUS TAKLIFLAR"'::jsonb,'Aksiya bo‘limi yuqori yozuvi',true),
  ('promotions_title','"Foydali chegirmalar"'::jsonb,'Aksiya bo‘limi sarlavhasi',true),
  ('promo_banner_label','"MAXSUS TAKLIF"'::jsonb,'Promo banner yorlig‘i',true),
  ('pages_kicker','"YORDAM MARKAZI"'::jsonb,'Ma’lumot bo‘limi yuqori yozuvi',true),
  ('pages_title','"Kerakli ma’lumotlar"'::jsonb,'Ma’lumot bo‘limi sarlavhasi',true),
  ('feature_1_title','"Tezkor yetkazib berish"'::jsonb,'Afzallik 1 sarlavhasi',true),
  ('feature_1_text','"Buyurtmangiz ko‘rsatilgan manzilga yetkaziladi"'::jsonb,'Afzallik 1 izohi',true),
  ('feature_2_title','"Rasmiy kafolat"'::jsonb,'Afzallik 2 sarlavhasi',true),
  ('feature_2_text','"Barcha mahsulotlar rasmiy kafolat bilan sotiladi"'::jsonb,'Afzallik 2 izohi',true),
  ('feature_3_title','"Qulay to‘lov"'::jsonb,'Afzallik 3 sarlavhasi',true),
  ('feature_3_text','"Naqd yoki onlayn to‘lov usulini tanlang"'::jsonb,'Afzallik 3 izohi',true),
  ('feature_4_title','"Real ombor qoldig‘i"'::jsonb,'Afzallik 4 sarlavhasi',true),
  ('feature_4_text','"Saytdagi miqdor ombor bilan bir xil"'::jsonb,'Afzallik 4 izohi',true),
  ('footer_badges','"Respublika bo‘ylab yetkazish | Rasmiy kafolat | Qulay to‘lov"'::jsonb,'Footer belgilari',true),
  ('footer_pages_title','"Ma’lumotlar"'::jsonb,'Footer ma’lumot ustuni sarlavhasi',true),
  ('footer_catalog_title','"Katalog"'::jsonb,'Footer katalog ustuni sarlavhasi',true),
  ('newsletter_title','"Yangiliklardan xabardor bo‘ling"'::jsonb,'Obuna bloki sarlavhasi',true)
on conflict(key) do nothing;

revoke all on function public.storefront_public_setting_keys() from public,anon,authenticated;
grant execute on function public.storefront_public_setting_keys() to service_role;

commit;
