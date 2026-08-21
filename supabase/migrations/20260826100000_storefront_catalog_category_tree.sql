begin;

-- Keep the public filter request bounded, then expand selected categories inside
-- the trusted validator so a root category includes every active descendant
-- without sending an unbounded category_ids array from the browser.
create or replace function public.validate_storefront_catalog_filters(p_filters jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v jsonb:=coalesce(p_filters,'{}'::jsonb);
  v_pair record;
  v_min numeric;
  v_max numeric;
  v_expanded_categories jsonb;
begin
  if jsonb_typeof(v)<>'object' then raise exception 'Katalog filtrlari object bo‘lishi kerak' using errcode='22023'; end if;
  if length(coalesce(v->>'query',''))>200 then raise exception 'Qidiruv matni juda uzun' using errcode='22023'; end if;
  if v ? 'category_ids' and jsonb_typeof(v->'category_ids')<>'array' then raise exception 'category_ids array bo‘lishi kerak' using errcode='22023'; end if;
  if v ? 'brand_ids' and jsonb_typeof(v->'brand_ids')<>'array' then raise exception 'brand_ids array bo‘lishi kerak' using errcode='22023'; end if;
  if coalesce(jsonb_array_length(v->'category_ids'),0)>100 or coalesce(jsonb_array_length(v->'brand_ids'),0)>100 then raise exception 'Facet qiymatlari juda ko‘p' using errcode='22023'; end if;
  if v ? 'attributes' and jsonb_typeof(v->'attributes')<>'object' then raise exception 'attributes object bo‘lishi kerak' using errcode='22023'; end if;
  for v_pair in select key,value from jsonb_each(coalesce(v->'attributes','{}'::jsonb)) loop
    if length(v_pair.key)>100 or jsonb_typeof(v_pair.value) not in('array','string')
      or (jsonb_typeof(v_pair.value)='array' and jsonb_array_length(v_pair.value)>50) then
      raise exception 'Attribute faceti noto‘g‘ri' using errcode='22023';
    end if;
  end loop;
  if v ? 'in_stock' and jsonb_typeof(v->'in_stock')<>'boolean' then raise exception 'in_stock boolean bo‘lishi kerak' using errcode='22023'; end if;
  if coalesce(v->>'sort','name') not in('name','new','cheap','expensive') then raise exception 'Saralash turi noto‘g‘ri' using errcode='22023'; end if;
  begin
    v_min=nullif(v->>'min_price','')::numeric;
    v_max=nullif(v->>'max_price','')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Narx filtri noto‘g‘ri' using errcode='22023';
  end;
  if coalesce(v_min,0)<0 or coalesce(v_max,0)<0 or (v_min is not null and v_max is not null and v_min>v_max) then
    raise exception 'Narx oralig‘i noto‘g‘ri' using errcode='22023';
  end if;

  if coalesce(jsonb_array_length(v->'category_ids'),0)>0 then
    with recursive selected_categories(id) as(
      select c.id
      from public.categories c
      join jsonb_array_elements_text(v->'category_ids') requested(value) on c.id::text=requested.value
      where c.is_active
      union
      select child.id
      from public.categories child
      join selected_categories parent on child.parent_id=parent.id
      where child.is_active
    )
    select coalesce(jsonb_agg(id order by id),'[]'::jsonb)
    into v_expanded_categories
    from selected_categories;
    v:=jsonb_set(v,'{category_ids}',v_expanded_categories,true);
  end if;

  return v;
end $$;

revoke all on function public.validate_storefront_catalog_filters(jsonb) from public,anon,authenticated;
grant execute on function public.validate_storefront_catalog_filters(jsonb) to service_role;

commit;
