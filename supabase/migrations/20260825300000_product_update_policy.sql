create policy "superadmin_update_products" on public.products
  for update to authenticated
  using (public.has_role(array['superadmin','admin']::public.app_role[], null))
  with check (public.has_role(array['superadmin','admin']::public.app_role[], null));

grant update on public.products to authenticated;
