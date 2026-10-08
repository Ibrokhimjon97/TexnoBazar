begin;

-- 1. Ommaviy mahsulotlarni kaskad usulida o'chirish funksiyasi
create or replace function public.delete_products_cascade(p_product_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_count integer := 0;
  v_errors text[] := array[]::text[];
begin
  if not (public.has_role(array['superadmin','admin']::public.app_role[], null) or public.is_any_manager()) then
    raise exception 'Mahsulotlarni o''chirish uchun admin yoki menejer roli talab qilinadi' using errcode = '42501';
  end if;

  if p_product_ids is null or array_length(p_product_ids, 1) is null then
    return jsonb_build_object('success', true, 'deleted_count', 0, 'errors', array[]::text[]);
  end if;

  foreach v_id in array p_product_ids loop
    begin
      perform public.delete_product_cascade(v_id);
      v_count := v_count + 1;
    exception when others then
      v_errors := array_append(v_errors, coalesce(SQLERRM, 'Noma''lum xatolik'));
    end;
  end loop;

  return jsonb_build_object(
    'success', true,
    'deleted_count', v_count,
    'errors', v_errors
  );
end $$;

grant execute on function public.delete_products_cascade(uuid[]) to authenticated, service_role;

-- 2. Butun kategoriya (va uning subkategoriyalari)dagi barcha mahsulotlarni o'chirish
create or replace function public.delete_category_products_cascade(
  p_category_id uuid,
  p_include_children boolean default true
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
  v_result jsonb;
begin
  if not (public.has_role(array['superadmin','admin']::public.app_role[], null) or public.is_any_manager()) then
    raise exception 'Kategoriyadagi mahsulotlarni o''chirish uchun admin yoki menejer roli talab qilinadi' using errcode = '42501';
  end if;

  if p_category_id is null then
    raise exception 'Kategoriya ID ko''rsatilmadi';
  end if;

  if p_include_children then
    with recursive cat_tree as (
      select id from public.categories where id = p_category_id
      union all
      select c.id from public.categories c inner join cat_tree ct on c.parent_id = ct.id
    )
    select coalesce(array_agg(id), array[]::uuid[]) into v_ids
    from public.products
    where category_id in (select id from cat_tree);
  else
    select coalesce(array_agg(id), array[]::uuid[]) into v_ids
    from public.products
    where category_id = p_category_id;
  end if;

  if array_length(v_ids, 1) is null or array_length(v_ids, 1) = 0 then
    return jsonb_build_object('success', true, 'deleted_count', 0, 'product_count', 0, 'errors', array[]::text[]);
  end if;

  v_result := public.delete_products_cascade(v_ids);
  return v_result || jsonb_build_object('product_count', array_length(v_ids, 1));
end $$;

grant execute on function public.delete_category_products_cascade(uuid, boolean) to authenticated, service_role;

commit;
