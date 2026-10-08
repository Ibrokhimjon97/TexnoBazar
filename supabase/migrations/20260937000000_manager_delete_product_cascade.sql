begin;

-- delete_product_cascade funksiyasini to'liq kaskad va immutable triggerlarni chetlab o'tuvchi holatga keltirish
create or replace function public.delete_product_cascade(p_product_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (public.has_role(array['superadmin','admin']::public.app_role[], null) or public.is_any_manager()) then
    raise exception 'Mahsulotni ochirish uchun admin yoki menejer roli talab qilinadi' using errcode = '42501';
  end if;
  if not exists(select 1 from public.products where id = p_product_id) then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;

  -- 1. Immutable triggerlarni vaqtincha o'chirish
  begin alter table public.transfer_lines disable trigger transfer_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.order_reserved_units disable trigger order_reserved_units_guard; exception when undefined_table or undefined_object then null; end;
  begin alter table public.sale_lines disable trigger sale_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.pos_pending_sale_lines disable trigger pos_pending_sale_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.sale_return_lines disable trigger sale_return_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.supplier_return_lines disable trigger supplier_return_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.product_price_history disable trigger product_price_history_immutable; exception when undefined_table or undefined_object then null; end;

  -- 2. Bog'liq yordamchi jadvallarni tozalash
  begin delete from public.product_reviews where product_id = p_product_id; exception when undefined_table then null; end;
  begin delete from public.customer_favorites where product_id = p_product_id; exception when undefined_table then null; end;
  begin delete from public.customer_cart_items where product_id = p_product_id; exception when undefined_table then null; end;
  begin delete from public.cms_promotion_products where product_id = p_product_id; exception when undefined_table then null; end;
  begin delete from public.product_variants where product_id = p_product_id; exception when undefined_table then null; end;
  begin delete from public.product_attribute_values where product_id = p_product_id; exception when undefined_table then null; end;
  begin delete from public.product_media where product_id = p_product_id; exception when undefined_table then null; end;

  -- 3. Buyurtma va rezervlar
  begin delete from public.order_reserved_units where order_line_id in (select id from public.order_lines where product_id = p_product_id); exception when undefined_table then null; end;
  begin delete from public.order_reserved_units where unit_id in (select id from public.inventory_units where product_id = p_product_id); exception when undefined_table then null; end;
  begin delete from public.order_lines where product_id = p_product_id; exception when undefined_table then null; end;

  -- 4. POS, sotuv va qaytarish jadvallari
  begin delete from public.pos_pending_sale_lines where product_id = p_product_id or unit_id in (select id from public.inventory_units where product_id = p_product_id); exception when undefined_table then null; end;
  begin delete from public.sale_return_lines where unit_id in (select id from public.inventory_units where product_id = p_product_id); exception when undefined_table then null; end;
  begin delete from public.supplier_return_lines where product_id = p_product_id or unit_id in (select id from public.inventory_units where product_id = p_product_id); exception when undefined_table then null; end;
  begin delete from public.repair_orders where unit_id in (select id from public.inventory_units where product_id = p_product_id); exception when undefined_table then null; end;
  begin delete from public.writeoff_lines where product_id = p_product_id or unit_id in (select id from public.inventory_units where product_id = p_product_id); exception when undefined_table then null; end;
  begin delete from public.inventory_count_lines where product_id = p_product_id or unit_id in (select id from public.inventory_units where product_id = p_product_id); exception when undefined_table then null; end;

  -- 5. Ombordagi harakatlar va o'tkazmalar
  begin delete from public.inventory_movements where product_id = p_product_id or unit_id in (select id from public.inventory_units where product_id = p_product_id); exception when undefined_table then null; end;
  begin delete from public.transfer_lines where product_id = p_product_id or unit_id in (select id from public.inventory_units where product_id = p_product_id); exception when undefined_table then null; end;

  -- 6. Inventory units va sotuv satrlari:
  -- Muhim: inventory_units check constraintini buzmaslik uchun status='available' va sold_sale_id=null qilib yangilaymiz
  begin
    update public.inventory_units
    set status = 'available', sold_sale_id = null, active_transfer_id = null
    where product_id = p_product_id;
  exception when undefined_table then null; end;

  begin delete from public.sale_lines where product_id = p_product_id or unit_id in (select id from public.inventory_units where product_id = p_product_id); exception when undefined_table then null; end;
  begin delete from public.inventory_units where product_id = p_product_id; exception when undefined_table then null; end;
  begin delete from public.stock_batches where product_id = p_product_id; exception when undefined_table then null; end;
  begin delete from public.product_price_history where product_id = p_product_id; exception when undefined_table then null; end;

  -- 7. Mahsulotning o'zini o'chirish
  delete from public.products where id = p_product_id;

  -- 8. Triggerlarni qayta yoqish
  begin alter table public.transfer_lines enable trigger transfer_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.order_reserved_units enable trigger order_reserved_units_guard; exception when undefined_table or undefined_object then null; end;
  begin alter table public.sale_lines enable trigger sale_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.pos_pending_sale_lines enable trigger pos_pending_sale_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.sale_return_lines enable trigger sale_return_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.supplier_return_lines enable trigger supplier_return_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.product_price_history enable trigger product_price_history_immutable; exception when undefined_table or undefined_object then null; end;

exception when others then
  -- Xato yuz bersa ham triggerlar yoqilgan holatda qolishi uchun:
  begin alter table public.transfer_lines enable trigger transfer_lines_immutable; exception when others then null; end;
  begin alter table public.order_reserved_units enable trigger order_reserved_units_guard; exception when others then null; end;
  begin alter table public.sale_lines enable trigger sale_lines_immutable; exception when others then null; end;
  begin alter table public.pos_pending_sale_lines enable trigger pos_pending_sale_lines_immutable; exception when others then null; end;
  begin alter table public.sale_return_lines enable trigger sale_return_lines_immutable; exception when others then null; end;
  begin alter table public.supplier_return_lines enable trigger supplier_return_lines_immutable; exception when others then null; end;
  begin alter table public.product_price_history enable trigger product_price_history_immutable; exception when others then null; end;
  raise;
end $$;

grant execute on function public.delete_product_cascade(uuid) to authenticated, service_role;

commit;
