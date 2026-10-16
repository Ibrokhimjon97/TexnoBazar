-- Migration: Support variant cost_price and USD pricing in save_product_variants

CREATE OR REPLACE FUNCTION public.save_product_variants(p_product_id uuid, p_variants jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_item jsonb;
  v_id uuid;
  v_seen uuid[] := '{}';
  v_keep uuid[] := '{}';
  v_sort integer := 0;
  v_referenced boolean;
  v_rate numeric;
  v_cost_uzs numeric;
  v_cost_usd numeric;
  v_ret_uzs numeric;
  v_ret_usd numeric;
  v_whl_uzs numeric;
  v_whl_usd numeric;
  v_min_uzs numeric;
  v_min_usd numeric;
begin
  if not (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null)) then
    raise exception 'Mahsulot variantlarini saqlash uchun admin yoki menejer roli talab qilinadi' using errcode = '42501';
  end if;
  if not exists(select 1 from public.products where id = p_product_id) then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_variants) is distinct from 'array' then
    raise exception 'Variantlar ro‘yxati massiv bo‘lishi kerak' using errcode = '22023';
  end if;
  if jsonb_array_length(p_variants) > 30 then
    raise exception 'Bir mahsulotda 30 tadan ortiq rang variant bo‘lishi mumkin emas' using errcode = '22023';
  end if;

  v_rate := coalesce(public.get_effective_exchange_rate('USD', 'UZS'), 12800);

  for v_item in select value from jsonb_array_elements(p_variants) loop
    if nullif(btrim(v_item->>'color_name'), '') is null then
      raise exception 'Rang nomi talab qilinadi' using errcode = '22023';
    end if;

    v_cost_uzs := nullif(v_item->>'cost_price', '')::numeric;
    v_cost_usd := nullif(v_item->>'cost_price_usd', '')::numeric;
    if v_cost_uzs is not null and v_cost_usd is null and v_rate > 0 then
      v_cost_usd := round(v_cost_uzs / v_rate, 2);
    elsif v_cost_usd is not null and v_cost_uzs is null and v_rate > 0 then
      v_cost_uzs := round(v_cost_usd * v_rate);
    end if;

    v_ret_uzs := nullif(v_item->>'retail_price', '')::numeric;
    v_ret_usd := nullif(v_item->>'retail_price_usd', '')::numeric;
    if v_ret_uzs is not null and v_ret_usd is null and v_rate > 0 then
      v_ret_usd := round(v_ret_uzs / v_rate, 2);
    elsif v_ret_usd is not null and v_ret_uzs is null and v_rate > 0 then
      v_ret_uzs := round(v_ret_usd * v_rate);
    end if;

    v_whl_uzs := nullif(v_item->>'wholesale_price', '')::numeric;
    v_whl_usd := nullif(v_item->>'wholesale_price_usd', '')::numeric;
    if v_whl_uzs is not null and v_whl_usd is null and v_rate > 0 then
      v_whl_usd := round(v_whl_uzs / v_rate, 2);
    elsif v_whl_usd is not null and v_whl_uzs is null and v_rate > 0 then
      v_whl_uzs := round(v_whl_usd * v_rate);
    end if;

    v_min_uzs := nullif(v_item->>'minimum_sale_price', '')::numeric;
    v_min_usd := nullif(v_item->>'minimum_sale_price_usd', '')::numeric;
    if v_min_uzs is not null and v_min_usd is null and v_rate > 0 then
      v_min_usd := round(v_min_uzs / v_rate, 2);
    elsif v_min_usd is not null and v_min_uzs is null and v_rate > 0 then
      v_min_uzs := round(v_min_usd * v_rate);
    end if;

    v_id := nullif(v_item->>'id', '')::uuid;
    if v_id is null then
      insert into public.product_variants(
        product_id, color_name, color_hex,
        retail_price, retail_price_usd,
        wholesale_price, wholesale_price_usd,
        promotion_price,
        minimum_sale_price, minimum_sale_price_usd,
        compare_at_price,
        cost_price, cost_price_usd,
        sort_order, is_active
      ) values (
        p_product_id,
        btrim(v_item->>'color_name'),
        nullif(btrim(v_item->>'color_hex'), ''),
        v_ret_uzs, v_ret_usd,
        v_whl_uzs, v_whl_usd,
        nullif(v_item->>'promotion_price', '')::numeric,
        v_min_uzs, v_min_usd,
        nullif(v_item->>'compare_at_price', '')::numeric,
        v_cost_uzs, v_cost_usd,
        v_sort,
        coalesce((v_item->>'is_active')::boolean, true)
      ) returning id into v_id;
    else
      update public.product_variants set
        color_name = btrim(v_item->>'color_name'),
        color_hex = nullif(btrim(v_item->>'color_hex'), ''),
        retail_price = v_ret_uzs,
        retail_price_usd = v_ret_usd,
        wholesale_price = v_whl_uzs,
        wholesale_price_usd = v_whl_usd,
        promotion_price = nullif(v_item->>'promotion_price', '')::numeric,
        minimum_sale_price = v_min_uzs,
        minimum_sale_price_usd = v_min_usd,
        compare_at_price = nullif(v_item->>'compare_at_price', '')::numeric,
        cost_price = v_cost_uzs,
        cost_price_usd = v_cost_usd,
        sort_order = v_sort,
        is_active = coalesce((v_item->>'is_active')::boolean, true)
      where id = v_id and product_id = p_product_id;
      if not found then raise exception 'Variant topilmadi' using errcode = 'P0002'; end if;
    end if;
    v_keep := array_append(v_keep, v_id);
    v_sort := v_sort + 1;
  end loop;

  -- Deactivate (never hard-delete) variants that were dropped from the payload but are
  -- still referenced by stock/media/orders; otherwise remove them entirely.
  for v_id in select id from public.product_variants where product_id = p_product_id and not (id = any(v_keep)) loop
    select exists(
      select 1 from public.inventory_units where variant_id = v_id
      union all select 1 from public.stock_batches where variant_id = v_id
      union all select 1 from public.order_lines where variant_id = v_id
    ) into v_referenced;
    if v_referenced then
      update public.product_variants set is_active = false where id = v_id;
    else
      delete from public.product_media where variant_id = v_id;
      delete from public.product_variants where id = v_id;
    end if;
  end loop;

  return coalesce((
    select jsonb_agg(to_jsonb(v) order by v.sort_order, v.created_at) from public.product_variants v where v.product_id = p_product_id
  ), '[]'::jsonb);
end;
$function$;

GRANT EXECUTE ON FUNCTION public.save_product_variants(uuid, jsonb) TO authenticated, service_role;
