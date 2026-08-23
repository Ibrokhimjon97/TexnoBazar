begin;

-- Allow managers and admins to update product description and seo_image_url
-- without going through save_catalog_product (which force-unpublishes).
create or replace function public.update_product_text_fields(
  p_product_id uuid,
  p_description text default null,
  p_seo_image_url text default null
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Reuse the existing catalog actor check (admin or active branch manager).
  perform public.require_catalog_actor(auth.uid());

  if not exists(select 1 from public.products where id = p_product_id) then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;

  update public.products
  set
    description = coalesce(p_description, description),
    seo_image_url = coalesce(p_seo_image_url, seo_image_url),
    updated_at = now()
  where id = p_product_id;
end;
$$;

revoke all on function public.update_product_text_fields(uuid, text, text) from public, anon;
grant execute on function public.update_product_text_fields(uuid, text, text) to authenticated, service_role;

commit;
