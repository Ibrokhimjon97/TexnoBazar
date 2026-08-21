-- Menejer roliga products jadvaliga INSERT/UPDATE/DELETE ruxsati.
begin;

drop policy if exists "manager_write_products" on public.products;
create policy "manager_write_products" on public.products for all to authenticated
  using (public.is_any_manager())
  with check (public.is_any_manager());

-- products jadvaliga to'liq SELECT ruxsati (oldin faqat ba'zi ustunlar uchun edi)
grant select on public.products to authenticated;

-- brands va categories ga ham menejer ruxsati
drop policy if exists "manager_write_brands" on public.brands;
create policy "manager_write_brands" on public.brands for all to authenticated
  using (public.is_any_manager())
  with check (public.is_any_manager());

drop policy if exists "manager_write_categories" on public.categories;
create policy "manager_write_categories" on public.categories for all to authenticated
  using (public.is_any_manager())
  with check (public.is_any_manager());

commit;
