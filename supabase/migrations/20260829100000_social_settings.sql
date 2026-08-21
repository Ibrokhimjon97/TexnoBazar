-- Ijtimoiy tarmoq havolalarini storefront sozlamalariga qo'shish
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
    'footer_badges','footer_pages_title','footer_catalog_title','newsletter_title',
    -- social media
    'social_telegram','social_instagram','social_facebook','social_youtube','social_tiktok',
    -- contact
    'company_address','work_hours'
  ]::text[];
$$;

commit;
