-- Fix: Remove is_published filter from QR storefront resolve.
-- When a customer scans a QR code, they should see the product regardless of
-- whether it's been explicitly published in the storefront catalog.
-- The QR was printed on the physical product label — the product IS in inventory.
begin;

create or replace function public.resolve_qr_for_storefront(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'slug', p.slug,
    'name', p.name,
    'product_id', p.id,
    'variant_id', u.variant_id,
    'sku', p.sku,
    'brand_name', br.name,
    'image', coalesce(
      (select m.public_url from public.product_media m where m.variant_id = u.variant_id order by m.is_primary desc, m.sort_order limit 1),
      (select m.public_url from public.product_media m where m.product_id = p.id and m.variant_id is null order by m.is_primary desc, m.sort_order limit 1)
    ),
    'retail_price', p.retail_price,
    'status', p.status,
    'is_published', p.is_published
  )
  from public.inventory_units u
  join public.products p on p.id = u.product_id
  left join public.brands br on br.id = p.brand_id
  where (upper(u.qr_code) = upper(btrim(p_code))
    or upper(coalesce(u.serial_number, '')) = upper(btrim(p_code)))
    and p.status = 'active'
  limit 1;
$$;

-- Allow anonymous and authenticated users to resolve QR codes
revoke all on function public.resolve_qr_for_storefront(text) from public;
grant execute on function public.resolve_qr_for_storefront(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
