-- RPC to fully delete a product and all its dependent records.
-- Only superadmin/admin can invoke this.
create or replace function public.delete_product_cascade(p_product_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Check permission
  if not public.has_role(array['superadmin','admin']::public.app_role[], null) then
    raise exception 'Mahsulotni ochirish uchun admin roli talab qilinadi' using errcode = '42501';
  end if;

  -- Check product exists
  if not exists(select 1 from public.products where id = p_product_id) then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;

  -- Delete dependent records in correct order
  delete from public.product_attribute_values where product_id = p_product_id;
  delete from public.product_media where product_id = p_product_id;
  delete from public.inventory_movements where product_id = p_product_id;
  delete from public.sale_lines where product_id = p_product_id;
  delete from public.transfer_lines where product_id = p_product_id;
  delete from public.order_lines where product_id = p_product_id;
  delete from public.inventory_units where product_id = p_product_id;
  delete from public.stock_batches where product_id = p_product_id;
  delete from public.cms_promotion_products where product_id = p_product_id;
  delete from public.product_price_history where product_id = p_product_id;
  delete from public.customer_favorites where product_id = p_product_id;
  delete from public.customer_cart_items where product_id = p_product_id;

  -- Finally delete the product itself
  delete from public.products where id = p_product_id;
end $$;

revoke all on function public.delete_product_cascade(uuid) from public, anon;
grant execute on function public.delete_product_cascade(uuid) to authenticated, service_role;
