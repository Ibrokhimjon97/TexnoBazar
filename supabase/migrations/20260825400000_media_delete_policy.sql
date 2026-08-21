-- Allow admin to delete product media records
create policy "superadmin_delete_product_media" on public.product_media
  for delete to authenticated
  using (public.has_role(array['superadmin','admin']::public.app_role[], null));

grant delete on public.product_media to authenticated;
