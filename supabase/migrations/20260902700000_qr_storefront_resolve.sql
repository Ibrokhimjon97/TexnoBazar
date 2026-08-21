-- Resolve QR code to product slug for customer storefront redirect.
-- Returns slug only if product is published; returns null otherwise.
begin;

create or replace function public.resolve_qr_for_storefront(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('slug', p.slug, 'name', p.name)
  from public.inventory_units u
  join public.products p on p.id = u.product_id
  where (upper(u.qr_code) = upper(btrim(p_code))
    or upper(coalesce(u.serial_number, '')) = upper(btrim(p_code)))
    and p.status = 'active'
    and p.is_published
  limit 1;
$$;

-- Allow anonymous and authenticated users to resolve QR codes
revoke all on function public.resolve_qr_for_storefront(text) from public;
grant execute on function public.resolve_qr_for_storefront(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
