-- Allow superadmin/admin to delete products via direct PostgREST call.
create policy "superadmin_delete_products" on public.products
  for delete to authenticated
  using (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
  );

-- Also grant DELETE privilege on products to authenticated (table privilege)
grant delete on public.products to authenticated;
