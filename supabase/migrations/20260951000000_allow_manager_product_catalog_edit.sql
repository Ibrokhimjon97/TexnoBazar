-- Migration: Allow managers to fully view, edit and manage product catalog, media, and variants.

begin;

-- 1. Update require_catalog_admin to allow both superadmin/admin and manager
create or replace function public.require_catalog_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not (
    public.is_any_manager() or 
    public.has_role(array['superadmin','admin']::public.app_role[], null)
  ) then
    raise exception 'Katalog administratori yoki menejeri roli talab qilinadi' using errcode = '42501';
  end if;
end;
$$;

-- 2. Update require_catalog_actor to allow manager actors
create or replace function public.require_catalog_actor(p_actor_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists(
    select 1 from public.profiles p join public.profile_roles r on r.profile_id=p.id
    where p.id=p_actor_id and p.is_active and (
      (r.role in ('superadmin','admin') and r.branch_id is null)
      or r.role = 'manager'
    )
  ) then
    raise exception 'Katalog administratori yoki menejeri roli talab qilinadi' using errcode='42501';
  end if;
end;
$$;

-- 3. Robust get_catalog_product with LEFT JOIN so products without category still load cleanly
create or replace function public.get_catalog_product(p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.require_catalog_admin();
  select to_jsonb(p) || jsonb_build_object(
    'category_name',c.name,'brand_name',b.name,
    'media',coalesce((select jsonb_agg(to_jsonb(m) order by m.is_primary desc,m.sort_order,m.created_at) from public.product_media m where m.product_id=p.id),'[]'::jsonb),
    'attributes',coalesce((select jsonb_agg(jsonb_build_object('attribute_id',v.attribute_id,'value',v.value)) from public.product_attribute_values v where v.product_id=p.id),'[]'::jsonb),
    'variants',coalesce((
      select jsonb_agg(to_jsonb(pv) || jsonb_build_object(
        'stock',(select count(*) from public.inventory_units u where u.variant_id=pv.id and u.status='available'),
        'media',coalesce((select jsonb_agg(to_jsonb(m) order by m.is_primary desc,m.sort_order,m.created_at) from public.product_media m where m.variant_id=pv.id),'[]'::jsonb)
      ) order by pv.sort_order,pv.created_at)
      from public.product_variants pv where pv.product_id=p.id
    ),'[]'::jsonb)
  ) into v_result 
  from public.products p 
  left join public.categories c on c.id=p.category_id 
  left join public.brands b on b.id=p.brand_id 
  where p.id=p_product_id;

  if v_result is null then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if;
  return v_result;
end;
$$;

-- 4. Ensure RLS policies and table permissions on products, product_media, product_attribute_values
grant select, insert, update, delete on public.products to authenticated;
grant select, insert, update, delete on public.product_media to authenticated;
grant select, insert, update, delete on public.product_attribute_values to authenticated;

drop policy if exists "manager_write_product_media" on public.product_media;
create policy "manager_write_product_media" on public.product_media for all to authenticated
  using (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null))
  with check (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null));

drop policy if exists "manager_write_product_attributes" on public.product_attribute_values;
create policy "manager_write_product_attributes" on public.product_attribute_values for all to authenticated
  using (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null))
  with check (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null));

-- 5. Grant logos storage to managers as well
drop policy if exists "admin_upload_logos" on storage.objects;
create policy "admin_upload_logos" on storage.objects for insert to authenticated
  with check (bucket_id = 'logos' and (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null)));

drop policy if exists "admin_delete_logos" on storage.objects;
create policy "admin_delete_logos" on storage.objects for delete to authenticated
  using (bucket_id = 'logos' and (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null)));

-- 6. Grant executions
grant execute on function public.require_catalog_admin() to authenticated, service_role;
grant execute on function public.require_catalog_actor(uuid) to authenticated, service_role;
grant execute on function public.get_catalog_product(uuid) to authenticated, service_role;
grant execute on function public.save_catalog_product(jsonb,jsonb) to authenticated, service_role;
grant execute on function public.set_primary_product_media(uuid,uuid) to authenticated, service_role;
grant execute on function public.attach_product_media(uuid,uuid,text,text,text,bigint,text,uuid) to authenticated, service_role;
grant execute on function public.detach_product_media(uuid,uuid) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
