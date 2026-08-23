-- Allow any authenticated user to insert new suppliers (from receipt modal)
-- Suppliers are not sensitive data — any staff member may need to add one.
-- The existing admin_all policy already covers superadmin/admin for all operations.

create policy suppliers_staff_insert on public.suppliers
  for insert to authenticated
  with check (true);

-- Grant INSERT on suppliers to authenticated (SELECT was already granted)
grant insert on public.suppliers to authenticated;
