-- Migration: Ensure set_primary_product_media properly synchronizes products.seo_image_url,
-- keep delete_product_media in sync, prevent new uploads from overwriting primary media,
-- and support video_url in update_product_text_fields.

begin;

-- 1. set_primary_product_media
create or replace function public.set_primary_product_media(p_product_id uuid, p_media_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_var_id uuid;
begin
  perform public.require_catalog_admin();
  if not exists(select 1 from public.product_media where id = p_media_id and product_id = p_product_id) then
    raise exception 'Rasm topilmadi' using errcode = 'P0002';
  end if;
  
  select variant_id into v_var_id from public.product_media where id = p_media_id;
  
  -- Reset existing primary flag for the same product and variant scope
  update public.product_media
  set is_primary = false
  where product_id = p_product_id
    and variant_id is not distinct from v_var_id
    and is_primary = true;
    
  -- Set the selected media as primary
  update public.product_media
  set is_primary = true
  where id = p_media_id
  returning public_url into v_url;
  
  -- If this is a main product image (variant_id is null), update products.seo_image_url
  if v_var_id is null and v_url is not null and btrim(v_url) <> '' then
    update public.products
    set seo_image_url = v_url, updated_at = now()
    where id = p_product_id;
  end if;
end; $$;

grant execute on function public.set_primary_product_media(uuid, uuid) to authenticated, service_role;

-- 2. delete_product_media
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
  v_new_primary_url text;
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
    ) returning public_url into v_new_primary_url;

    if v_variant is null then
      update public.products
      set seo_image_url = v_new_primary_url, updated_at = now()
      where id = v_product;
    end if;
  end if;

  return jsonb_build_object('success', true, 'deleted', true, 'key', v_key);
end;
$$;

grant execute on function public.delete_product_media(uuid) to authenticated, service_role;

-- 3. attach_product_media: ensure subsequent uploads don't override primary image
create or replace function public.attach_product_media(
  p_actor_id uuid,
  p_product_id uuid,
  p_r2_key text,
  p_public_url text,
  p_mime_type text,
  p_bytes bigint,
  p_alt_text text default null,
  p_variant_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_primary boolean;
begin
  perform public.require_catalog_actor(p_actor_id);
  if not exists(select 1 from public.products where id=p_product_id) then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if;
  if p_variant_id is not null and not exists(select 1 from public.product_variants where id=p_variant_id and product_id=p_product_id) then
    raise exception 'Variant bu mahsulotga tegishli emas' using errcode='P0002';
  end if;
  
  v_primary := not exists(select 1 from public.product_media where product_id=p_product_id and variant_id is not distinct from p_variant_id and is_primary = true);
  
  insert into public.product_media(product_id,variant_id,r2_key,public_url,mime_type,bytes,alt_text,sort_order,is_primary)
  values(p_product_id,p_variant_id,p_r2_key,p_public_url,p_mime_type,p_bytes,nullif(btrim(p_alt_text),''),
    coalesce((select max(sort_order)+1 from public.product_media where product_id=p_product_id and variant_id is not distinct from p_variant_id),0),v_primary)
  returning id into v_id;

  -- Set seo_image_url as canonical product thumbnail ONLY if null or if this is the very first primary media of the product
  if p_variant_id is null and (v_primary or (select seo_image_url from public.products where id=p_product_id) is null) then
    update public.products set seo_image_url = p_public_url, updated_at = now() where id = p_product_id;
  end if;

  return v_id;
end;
$$;

grant execute on function public.attach_product_media(uuid,uuid,text,text,text,bigint,text,uuid) to authenticated, service_role;

-- 4. update_product_text_fields to support video_url and reload schema cache
create or replace function public.update_product_text_fields(
  p_product_id uuid,
  p_description text default null,
  p_seo_image_url text default null,
  p_video_url text default null
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_catalog_admin();

  if not exists(select 1 from public.products where id = p_product_id) then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;

  update public.products
  set
    description = coalesce(p_description, description),
    seo_image_url = coalesce(p_seo_image_url, seo_image_url),
    video_url = coalesce(p_video_url, video_url),
    updated_at = now()
  where id = p_product_id;
end;
$$;

grant execute on function public.update_product_text_fields(uuid, text, text, text) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
