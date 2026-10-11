-- Enhance get_stock_receipt to include retail_price, wholesale_price, minimum_sale_price in lines
create or replace function public.get_stock_receipt(p_receipt_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_branch uuid;
begin
  select branch_id into v_branch from public.stock_receipts where id = p_receipt_id;
  if v_branch is null then raise exception 'Partiya topilmadi' using errcode = 'P0002'; end if;
  if not public.can_access_branch(v_branch) then raise exception 'Ruxsat yo‘q' using errcode = '42501'; end if;

  select to_jsonb(r) || jsonb_build_object(
    'branch_name', br.name,
    'supplier_name', coalesce(s.name, case when r.receipt_no like 'INV-%' then 'Inventarizatsiya' else 'Ta’minotchi ko‘rsatilmagan' end),
    'location_name', l.name,
    'lines', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', b.id, 'line_no', b.line_no, 'product_id', b.product_id,
          'product_name', p.name, 'sku', p.sku, 'variant_id', b.variant_id,
          'variant_color', v.color_name, 'quantity', b.quantity, 'unit_cost', b.unit_cost,
          'retail_price', coalesce(v.retail_price, p.retail_price),
          'wholesale_price', coalesce(v.wholesale_price, p.wholesale_price),
          'minimum_sale_price', coalesce(p.minimum_sale_price, 0),
          'qr_count', (select count(*) from public.inventory_units u where u.batch_id = b.id)
        ) order by b.line_no
      )
      from public.stock_batches b
      join public.products p on p.id = b.product_id
      left join public.product_variants v on v.id = b.variant_id
      where b.receipt_id = r.id
    ), '[]'::jsonb)
  )
  into v_result
  from public.stock_receipts r
  join public.branches br on br.id = r.branch_id
  left join public.suppliers s on s.id = r.supplier_id
  join public.locations l on l.id = r.receiving_location_id
  where r.id = p_receipt_id;

  return v_result;
end;
$$;
