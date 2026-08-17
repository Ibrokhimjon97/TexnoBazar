-- Task 2: master-data read access and complete audit coverage.
begin;

-- The admin RLS policy already limits suppliers to global superadmin/admin,
-- but authenticated users also need a table-level SELECT grant.
grant select on public.suppliers to authenticated;

-- Catalog dictionaries are mutable master records and must be audited too.
drop trigger if exists categories_audit on public.categories;
create trigger categories_audit
after insert or update or delete on public.categories
for each row execute function public.audit_row_change();

drop trigger if exists brands_audit on public.brands;
create trigger brands_audit
after insert or update or delete on public.brands
for each row execute function public.audit_row_change();

drop trigger if exists attribute_definitions_audit on public.attribute_definitions;
create trigger attribute_definitions_audit
after insert or update or delete on public.attribute_definitions
for each row execute function public.audit_row_change();

commit;
