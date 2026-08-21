-- Aksiya kartasiga rasm qo'shish
alter table public.cms_promotions
  add column if not exists image_url text;

-- save_cms_promotion da image_url ni saqlash
create or replace function public.save_cms_promotion(p_promotion jsonb,p_product_ids uuid[] default '{}'::uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_result public.cms_promotions%rowtype; v_count integer;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) then raise exception 'Global admin roli talab qilinadi' using errcode='42501'; end if;
  if jsonb_typeof(p_promotion)<>'object' or coalesce(cardinality(p_product_ids),0)>500 then raise exception 'Aksiya payloadi noto''g''ri' using errcode='22023'; end if;
  begin v_id=coalesce(nullif(p_promotion->>'id','')::uuid,gen_random_uuid()); exception when invalid_text_representation then raise exception 'Aksiya ID noto''g''ri' using errcode='22023'; end;
  if nullif(btrim(p_promotion->>'name'),'') is null or nullif(btrim(p_promotion->>'slug'),'') is null
    or (p_promotion->>'discount_type') not in('percent','fixed') or coalesce((p_promotion->>'discount_value')::numeric,0)<=0
    or (p_promotion->>'starts_at')::timestamptz >= (p_promotion->>'ends_at')::timestamptz
    or jsonb_typeof(coalesce(p_promotion->'rules','{}'::jsonb))<>'object' then raise exception 'Aksiya maydonlari noto''g''ri' using errcode='22023'; end if;
  select count(distinct x) into v_count from unnest(coalesce(p_product_ids,'{}'::uuid[])) x;
  if v_count<>coalesce(cardinality(p_product_ids),0) or v_count<>(select count(*) from public.products where id=any(coalesce(p_product_ids,'{}'::uuid[])) and status='active') then
    raise exception 'Aksiya mahsulotlari takrorlangan yoki faol emas' using errcode='22023';
  end if;
  insert into public.cms_promotions(id,name,slug,description,image_url,discount_type,discount_value,starts_at,ends_at,is_active,rules)
  values(v_id,btrim(p_promotion->>'name'),btrim(p_promotion->>'slug'),nullif(btrim(p_promotion->>'description'),''),
    nullif(btrim(p_promotion->>'image_url'),''),
    p_promotion->>'discount_type',(p_promotion->>'discount_value')::numeric,
    (p_promotion->>'starts_at')::timestamptz,(p_promotion->>'ends_at')::timestamptz,
    coalesce((p_promotion->>'is_active')::boolean,true),coalesce(p_promotion->'rules','{}'::jsonb))
  on conflict(id) do update set name=excluded.name,slug=excluded.slug,description=excluded.description,
    image_url=excluded.image_url,
    discount_type=excluded.discount_type,discount_value=excluded.discount_value,
    starts_at=excluded.starts_at,ends_at=excluded.ends_at,is_active=excluded.is_active,rules=excluded.rules,updated_at=now()
  returning * into v_result;
  delete from public.cms_promotion_products where promotion_id=v_id;
  insert into public.cms_promotion_products(promotion_id,product_id) select v_id,x from unnest(coalesce(p_product_ids,'{}'::uuid[])) x;
  return to_jsonb(v_result)||jsonb_build_object('product_ids',coalesce(to_jsonb(p_product_ids),'[]'::jsonb));
end $$;

commit;
