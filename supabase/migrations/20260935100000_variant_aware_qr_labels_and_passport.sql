-- Show the unit's color variant next to the product name everywhere a QR code is
-- printed or scanned: the printed price-label payload and the unit passport (used by
-- the manager QR scanner and superadmin unit lookups).
begin;

create or replace function public.list_receipt_qr_labels(p_receipt_id uuid,p_limit integer default 100,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_branch uuid;v_items jsonb;v_total bigint;
begin
  if p_limit not between 1 and 200 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri' using errcode='22023'; end if;
  select branch_id into v_branch from public.stock_receipts where id=p_receipt_id;
  if v_branch is null then raise exception 'Partiya topilmadi' using errcode='P0002'; end if;
  if not public.can_access_branch(v_branch) then raise exception 'Ruxsat yo‘q' using errcode='42501'; end if;
  select count(*) into v_total from public.inventory_units u join public.stock_batches b on b.id=u.batch_id where b.receipt_id=p_receipt_id;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.line_no,x.unit_sequence),'[]'::jsonb) into v_items from(
    select u.id,u.qr_code,u.serial_number,u.unit_sequence,b.line_no,p.name product_name,p.sku,r.receipt_no,
      v.color_name variant_color,
      p.retail_price,p.wholesale_price,p.promotion_price,p.minimum_sale_price,p.compare_at_price,
      coalesce(v.promotion_price,v.retail_price,p.promotion_price,p.retail_price) effective_price,btrim(br.currency::text) currency,
      jsonb_build_object('title',p.name,'sku',p.sku,
        'price',coalesce(v.promotion_price,v.retail_price,p.promotion_price,p.retail_price),
        'old_price',case when coalesce(v.promotion_price,p.promotion_price) is not null then coalesce(v.retail_price,p.retail_price) else p.compare_at_price end,
        'currency',btrim(br.currency::text),'qr',u.qr_code,'color',v.color_name) price_label
    from public.inventory_units u join public.stock_batches b on b.id=u.batch_id join public.products p on p.id=u.product_id
    left join public.product_variants v on v.id=u.variant_id
    join public.stock_receipts r on r.id=b.receipt_id join public.branches br on br.id=r.branch_id
    where b.receipt_id=p_receipt_id order by b.line_no,u.unit_sequence limit p_limit offset p_offset
  )x;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

-- Unit passport: surface the unit's variant (if any) so scan/lookup UIs can show it
-- next to the product name.
create or replace function public.get_inventory_unit_passport(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb; v_branch uuid; v_found boolean;
begin
  select l.branch_id, true into v_branch, v_found from public.inventory_units u
    join public.locations l on l.id = u.location_id
    where upper(u.qr_code) = upper(btrim(p_code)) or upper(coalesce(u.serial_number,'')) = upper(btrim(p_code)) limit 1;
  if not coalesce(v_found, false) then raise exception 'QR yoki seriya bo''yicha mahsulot topilmadi' using errcode = 'P0002'; end if;
  if not (
    (v_branch is not null and public.can_access_branch(v_branch))
    or public.has_role(array['superadmin','admin']::public.app_role[], null)
    or exists(select 1 from public.inventory_units u join public.sale_lines sl on sl.unit_id = u.id
      join public.sales s on s.id = sl.sale_id
      where (upper(u.qr_code) = upper(btrim(p_code)) or upper(coalesce(u.serial_number,'')) = upper(btrim(p_code)))
        and public.can_access_branch(s.branch_id))
  ) then raise exception 'Bu mahsulot uchun ruxsat yo''q' using errcode = '42501'; end if;

  select jsonb_build_object(
    'id', u.id, 'qr_code', u.qr_code, 'serial_number', u.serial_number, 'status', u.status, 'version', u.version,
    'sold_sale_id', u.sold_sale_id,
    'variant_id', u.variant_id, 'variant_color', v.color_name, 'variant_color_hex', v.color_hex,
    'can_revert_sale', u.status = 'sold' and u.sold_sale_id is not null
      and exists(select 1 from public.sales s2 where s2.id = u.sold_sale_id and s2.status <> 'void'
        and (public.has_role(array['superadmin','admin']::public.app_role[], null)
          or public.has_role(array['manager']::public.app_role[], s2.branch_id)))
      and not exists(select 1 from public.sale_return_lines rl where rl.unit_id = u.id),
    'product', jsonb_build_object(
      'id', p.id, 'name', p.name, 'sku', p.sku, 'barcode', p.barcode, 'brand_name', br.name,
      'slug', p.slug, 'is_published', p.is_published, 'status', p.status,
      'retail_price', p.retail_price, 'cost_price', p.cost_price,
      'wholesale_price', p.wholesale_price, 'minimum_sale_price', p.minimum_sale_price,
      'image', coalesce(
        (select m.public_url from public.product_media m where m.variant_id = u.variant_id order by m.is_primary desc, m.sort_order limit 1),
        (select m.public_url from public.product_media m where m.product_id = p.id and m.variant_id is null order by m.is_primary desc, m.sort_order limit 1))),
    'batch', jsonb_build_object(
      'id', b.id, 'receipt_id', r.id, 'receipt_no', r.receipt_no, 'received_at', r.received_at,
      'supplier_name', s.name, 'unit_cost', b.unit_cost,
      'retail_price', coalesce(v.retail_price,b.retail_price), 'wholesale_price', coalesce(v.wholesale_price,b.wholesale_price),
      'minimum_sale_price', coalesce(v.minimum_sale_price,b.minimum_sale_price)),
    'latest_batch_prices', (
      select jsonb_build_object(
        'retail_price', lb.retail_price, 'wholesale_price', lb.wholesale_price,
        'minimum_sale_price', lb.minimum_sale_price, 'unit_cost', lb.unit_cost, 'received_at', lr.received_at)
      from public.stock_batches lb
      join public.stock_receipts lr on lr.id = lb.receipt_id
      where lb.product_id = p.id and lb.retail_price is not null
      order by lr.received_at desc limit 1),
    'location', jsonb_build_object('id', l.id, 'name', l.name, 'type', l.type, 'branch_id', l.branch_id, 'branch_name', branch.name),
    'sale', (
      select jsonb_build_object(
        'sale_id', sale.id, 'sale_no', sale.sale_no, 'sold_at', sale.sold_at, 'status', sale.status,
        'branch_id', sale.branch_id, 'branch_name', sb.name,
        'seller_name', seller.full_name, 'manager_name', mgr.full_name,
        'customer_name', cust.full_name, 'customer_phone', cust.phone,
        'unit_price', sl.unit_price, 'discount', sl.discount, 'tax', sl.tax, 'line_total', sl.line_total,
        'sale_total', sale.total,
        'payments', coalesce((select jsonb_agg(jsonb_build_object('method_name', pm.name, 'amount', sp.amount)
          order by sp.paid_at, sp.id)
          from public.sale_payments sp join public.payment_methods pm on pm.id = sp.payment_method_id
          where sp.sale_id = sale.id), '[]'::jsonb))
      from public.sales sale
      join public.branches sb on sb.id = sale.branch_id
      left join public.profiles seller on seller.id = sale.seller_id
      left join public.profiles mgr on mgr.id = sale.manager_id
      left join public.customers cust on cust.id = sale.customer_id
      left join public.sale_lines sl on sl.sale_id = sale.id and sl.unit_id = u.id
      where sale.id = u.sold_sale_id),
    'stamps', jsonb_build_object(
      'was_sold', exists(select 1 from public.inventory_movements m where m.unit_id = u.id and m.movement_type = 'sold'),
      'was_returned', exists(select 1 from public.inventory_movements m where m.unit_id = u.id and m.movement_type = 'returned'),
      'sold_count', (select count(*) from public.inventory_movements m where m.unit_id = u.id and m.movement_type = 'sold'),
      'returned_count', (select count(*) from public.inventory_movements m where m.unit_id = u.id and m.movement_type = 'returned')),
    'movements', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'type', m.movement_type,
        'label', public.movement_type_label(m.movement_type::text), 'occurred_at', m.occurred_at,
        'from_location', fl.name, 'to_location', tl.name, 'reason', m.reason, 'actor_name', a.full_name,
        'reference_type', m.reference_type, 'reference_id', m.reference_id, 'unit_cost', m.unit_cost, 'metadata', m.metadata)
      order by m.occurred_at desc, m.id desc)
      from public.inventory_movements m
      left join public.locations fl on fl.id = m.from_location_id
      left join public.locations tl on tl.id = m.to_location_id
      left join public.profiles a on a.id = m.actor_id
      where m.unit_id = u.id), '[]'::jsonb))
  into v_result
  from public.inventory_units u
  join public.products p on p.id = u.product_id
  left join public.brands br on br.id = p.brand_id
  left join public.product_variants v on v.id = u.variant_id
  left join public.stock_batches b on b.id = u.batch_id
  left join public.stock_receipts r on r.id = b.receipt_id
  left join public.suppliers s on s.id = b.supplier_id
  join public.locations l on l.id = u.location_id
  left join public.branches branch on branch.id = l.branch_id
  where upper(u.qr_code) = upper(btrim(p_code)) or upper(coalesce(u.serial_number,'')) = upper(btrim(p_code)) limit 1;
  return v_result;
end; $$;

notify pgrst, 'reload schema';
commit;
