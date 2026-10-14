-- Fix get_inventory_unit_passport:
-- sale_lines uses line_total (not total_price) and discount (not discount_amount)
CREATE OR REPLACE FUNCTION public.get_inventory_unit_passport(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
  v_branch uuid;
  v_found boolean;
BEGIN
  SELECT l.branch_id, true INTO v_branch, v_found
  FROM public.inventory_units u
  JOIN public.locations l ON l.id = u.location_id
  WHERE upper(u.qr_code) = upper(btrim(p_code))
     OR upper(coalesce(u.serial_number, '')) = upper(btrim(p_code))
  LIMIT 1;

  IF NOT coalesce(v_found, false) THEN
    RAISE EXCEPTION 'QR yoki seriya bo''yicha mahsulot topilmadi' USING errcode = 'P0002';
  END IF;

  IF NOT (
    (v_branch IS NOT NULL AND public.can_access_branch(v_branch))
    OR public.has_role(ARRAY['superadmin', 'admin']::public.app_role[], NULL)
    OR EXISTS (
      SELECT 1 FROM public.inventory_units u
      JOIN public.sale_lines sl ON sl.unit_id = u.id
      JOIN public.sales s ON s.id = sl.sale_id
      WHERE (upper(u.qr_code) = upper(btrim(p_code)) OR upper(coalesce(u.serial_number, '')) = upper(btrim(p_code)))
        AND public.can_access_branch(s.branch_id)
    )
  ) THEN
    RAISE EXCEPTION 'Bu mahsulot uchun ruxsat yo''q' USING errcode = '42501';
  END IF;

  SELECT jsonb_build_object(
    'id', u.id,
    'qr_code', u.qr_code,
    'serial_number', u.serial_number,
    'status', u.status,
    'version', u.version,
    'sold_sale_id', u.sold_sale_id,
    'variant_id', u.variant_id,
    'variant_color', v.color_name,
    'variant_color_hex', v.color_hex,
    'cost_price_usd', coalesce(b.unit_cost_usd, p.cost_price_usd),
    'can_revert_sale', u.status = 'sold' AND u.sold_sale_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.sales s2
        WHERE s2.id = u.sold_sale_id AND s2.status <> 'void'
          AND (
            public.has_role(ARRAY['superadmin', 'admin']::public.app_role[], NULL)
            OR public.has_role(ARRAY['manager']::public.app_role[], s2.branch_id)
          )
      )
      AND NOT EXISTS (SELECT 1 FROM public.sale_return_lines rl WHERE rl.unit_id = u.id),
    'product', jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'sku', p.sku,
      'barcode', p.barcode,
      'brand_name', br.name,
      'slug', p.slug,
      'is_published', p.is_published,
      'status', p.status,
      'retail_price', p.retail_price,
      'retail_price_usd', p.retail_price_usd,
      'cost_price', p.cost_price,
      'cost_price_usd', p.cost_price_usd,
      'wholesale_price', p.wholesale_price,
      'wholesale_price_usd', p.wholesale_price_usd,
      'minimum_sale_price', p.minimum_sale_price,
      'minimum_sale_price_usd', p.minimum_sale_price_usd,
      'image', coalesce(
        (SELECT m.public_url FROM public.product_media m WHERE m.variant_id = u.variant_id ORDER BY m.is_primary DESC, m.sort_order LIMIT 1),
        (SELECT m.public_url FROM public.product_media m WHERE m.product_id = p.id AND m.variant_id IS NULL ORDER BY m.is_primary DESC, m.sort_order LIMIT 1)
      )
    ),
    'batch', jsonb_build_object(
      'id', b.id,
      'receipt_id', r.id,
      'receipt_no', r.receipt_no,
      'received_at', r.received_at,
      'supplier_name', s.name,
      'unit_cost', b.unit_cost,
      'unit_cost_usd', coalesce(b.unit_cost_usd, p.cost_price_usd),
      'retail_price', coalesce(v.retail_price, b.retail_price),
      'wholesale_price', coalesce(v.wholesale_price, b.wholesale_price),
      'minimum_sale_price', coalesce(v.minimum_sale_price, b.minimum_sale_price)
    ),
    'latest_batch_prices', (
      SELECT jsonb_build_object(
        'retail_price', lb.retail_price,
        'wholesale_price', lb.wholesale_price,
        'minimum_sale_price', lb.minimum_sale_price,
        'unit_cost', lb.unit_cost,
        'unit_cost_usd', lb.unit_cost_usd,
        'received_at', lr.received_at
      )
      FROM public.stock_batches lb
      JOIN public.stock_receipts lr ON lr.id = lb.receipt_id
      WHERE lb.product_id = p.id AND lb.retail_price IS NOT NULL
      ORDER BY lr.received_at DESC LIMIT 1
    ),
    'location', jsonb_build_object(
      'id', l.id,
      'name', l.name,
      'type', l.type,
      'branch_id', l.branch_id,
      'branch_name', branch.name
    ),
    'sale', (
      SELECT jsonb_build_object(
        'sale_id', sale.id,
        'sale_no', sale.sale_no,
        'sold_at', sale.sold_at,
        'status', sale.status,
        'branch_id', sale.branch_id,
        'branch_name', sb.name,
        'receipt_lines', (
          SELECT jsonb_agg(jsonb_build_object(
            'unit_price', sl.unit_price,
            'quantity', sl.quantity,
            'total_price', sl.line_total,
            'line_total', sl.line_total,
            'discount_amount', sl.discount,
            'discount', sl.discount
          ))
          FROM public.sale_lines sl
          WHERE sl.sale_id = sale.id AND sl.unit_id = u.id
        )
      )
      FROM public.sales sale
      JOIN public.branches sb ON sb.id = sale.branch_id
      WHERE sale.id = u.sold_sale_id
      LIMIT 1
    ),
    'stamps', jsonb_build_object(
      'was_sold', exists(select 1 from public.inventory_movements m where m.unit_id=u.id and m.movement_type='sold'),
      'was_returned', exists(select 1 from public.inventory_movements m where m.unit_id=u.id and m.movement_type='returned'),
      'sold_count', (select count(*) from public.inventory_movements m where m.unit_id=u.id and m.movement_type='sold'),
      'returned_count', (select count(*) from public.inventory_movements m where m.unit_id=u.id and m.movement_type='returned')
    ),
    'movements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'type', m.movement_type,
        'label', public.movement_type_label(m.movement_type::text),
        'occurred_at', m.occurred_at,
        'from_location', fl.name,
        'to_location', tl.name,
        'reason', m.reason,
        'actor_name', a.full_name,
        'reference_type', m.reference_type,
        'reference_id', m.reference_id,
        'unit_cost', m.unit_cost,
        'metadata', m.metadata
      ) order by m.occurred_at desc, m.id desc)
      from public.inventory_movements m
      left join public.locations fl on fl.id = m.from_location_id
      left join public.locations tl on tl.id = m.to_location_id
      left join public.profiles a on a.id = m.actor_id
      where m.unit_id = u.id
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM public.inventory_units u
  JOIN public.products p ON p.id = u.product_id
  LEFT JOIN public.product_variants v ON v.id = u.variant_id
  LEFT JOIN public.brands br ON br.id = p.brand_id
  LEFT JOIN public.stock_batches b ON b.id = u.batch_id
  LEFT JOIN public.stock_receipts r ON r.id = b.receipt_id
  LEFT JOIN public.suppliers s ON s.id = r.supplier_id
  JOIN public.locations l ON l.id = u.location_id
  JOIN public.branches branch ON branch.id = l.branch_id
  WHERE upper(u.qr_code) = upper(btrim(p_code))
     OR upper(coalesce(u.serial_number, '')) = upper(btrim(p_code))
  LIMIT 1;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_inventory_unit_passport(text) TO authenticated, service_role;
