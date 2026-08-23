begin;

-- Fix delete_product_cascade: add missing dependent table cleanups
create or replace function public.delete_product_cascade(p_product_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[], null) then
    raise exception 'Mahsulotni ochirish uchun admin roli talab qilinadi' using errcode = '42501';
  end if;
  if not exists(select 1 from public.products where id = p_product_id) then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;

  -- Reviews (has ON DELETE CASCADE but explicit is safer)
  begin delete from public.product_reviews where product_id = p_product_id; exception when undefined_table then null; end;

  -- Order reserved units
  begin delete from public.order_reserved_units where order_line_id in (select id from public.order_lines where product_id = p_product_id); exception when undefined_table then null; end;

  delete from public.product_attribute_values where product_id = p_product_id;
  delete from public.product_media where product_id = p_product_id;
  delete from public.inventory_movements where product_id = p_product_id;

  -- Order lines referencing this product
  delete from public.order_lines where product_id = p_product_id;

  update public.inventory_units set sold_sale_id = null, active_transfer_id = null where product_id = p_product_id;
  delete from public.sale_lines where product_id = p_product_id;
  delete from public.transfer_lines where unit_id in (select id from public.inventory_units where product_id = p_product_id);
  delete from public.inventory_units where product_id = p_product_id;
  delete from public.stock_batches where product_id = p_product_id;
  -- product_price_history has immutable trigger; disable only the user trigger by name
  begin
    alter table public.product_price_history disable trigger product_price_history_immutable;
    delete from public.product_price_history where product_id = p_product_id;
    alter table public.product_price_history enable trigger product_price_history_immutable;
  exception when undefined_table then null; end;
  begin delete from public.cms_promotion_products where product_id = p_product_id; exception when undefined_table then null; end;
  begin delete from public.customer_favorites where product_id = p_product_id; exception when undefined_table then null; end;
  begin delete from public.customer_cart_items where product_id = p_product_id; exception when undefined_table then null; end;
  delete from public.products where id = p_product_id;
end $$;

-- Ensure logos bucket exists (idempotent)
insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

commit;
