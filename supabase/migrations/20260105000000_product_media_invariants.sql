-- Product publication must keep a primary image.
begin;
create or replace function public.detach_product_media(p_actor_id uuid,p_media_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_key text; v_product uuid; v_was_primary boolean; v_published boolean;
begin
  perform public.require_catalog_actor(p_actor_id);
  select m.r2_key,m.product_id,m.is_primary,p.is_published into v_key,v_product,v_was_primary,v_published
  from public.product_media m join public.products p on p.id=m.product_id where m.id=p_media_id for update of m,p;
  if v_key is null then raise exception 'Rasm topilmadi' using errcode='P0002'; end if;
  if v_was_primary and v_published then
    raise exception 'Nashrdagi mahsulot asosiy rasmini o‘chirishdan oldin mahsulotni yashiring' using errcode='23514';
  end if;
  delete from public.product_media where id=p_media_id;
  if v_was_primary then
    update public.product_media set is_primary=true where id=(select id from public.product_media where product_id=v_product order by sort_order,created_at limit 1);
  end if;
  return v_key;
end;
$$;
revoke all on function public.detach_product_media(uuid,uuid) from public,anon,authenticated;
grant execute on function public.detach_product_media(uuid,uuid) to service_role;
commit;
