-- Migration: 20260963340000_resolve_qr_include_variant_color.sql
-- Description: Update resolve_qr_for_storefront to include color_name and variant_color so scanned units always open with the exact color preselected.

CREATE OR REPLACE FUNCTION public.resolve_qr_for_storefront(p_code text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'slug', p.slug,
    'name', p.name,
    'product_id', p.id,
    'variant_id', u.variant_id,
    'color_name', coalesce(pv.color_name, 'Standart'),
    'variant_color', pv.color_name,
    'sku', p.sku,
    'brand_name', br.name,
    'image', coalesce(
      (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = u.variant_id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
      (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
      p.seo_image_url
    ),
    'retail_price', coalesce(sb.retail_price, p.retail_price),
    'retail_price_usd', coalesce(sb.retail_price_usd, p.retail_price_usd),
    'batch_id', u.batch_id,
    'status', p.status,
    'is_published', p.is_published
  )
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  LEFT JOIN public.product_variants pv ON pv.id = u.variant_id
  LEFT JOIN public.stock_batches sb ON sb.id = u.batch_id
  LEFT JOIN public.brands br ON br.id = p.brand_id
  WHERE (upper(u.qr_code) = upper(btrim(p_code))
    OR upper(coalesce(u.serial_number, '')) = upper(btrim(p_code)))
    AND p.status = 'active'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_qr_for_storefront(text) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_qr_for_storefront(text) TO anon, authenticated, service_role;
