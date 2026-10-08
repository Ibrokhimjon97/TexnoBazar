-- Cart items must be keyed by (product, variant) so a customer can hold "2 white" and
-- "1 black" of the same product simultaneously. The old 2-arg overload is dropped so
-- calls without p_variant_id are never ambiguous against the new 3-arg signature.
begin;

drop function if exists public.set_customer_cart_item(uuid,integer);

create or replace function public.set_customer_cart_item(p_product_id uuid,p_quantity integer,p_variant_id uuid default null)
returns integer language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.current_user_active() then raise exception 'Faol autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  if p_variant_id is not null and not exists(select 1 from public.product_variants where id=p_variant_id and product_id=p_product_id and is_active) then
    raise exception 'Rang varianti topilmadi' using errcode='P0002';
  end if;
  if coalesce(p_quantity,0)<=0 then
    delete from public.customer_cart_items where user_id=auth.uid() and product_id=p_product_id and variant_id is not distinct from p_variant_id;
    return 0;
  end if;
  if p_quantity>100 then raise exception 'Savat miqdori 100 dan oshmasligi kerak' using errcode='22023'; end if;
  if not exists(select 1 from public.products where id=p_product_id and status='active' and is_published) then
    raise exception 'Ochiq mahsulot topilmadi' using errcode='P0002'; end if;
  insert into public.customer_cart_items(user_id,product_id,variant_id,quantity) values(auth.uid(),p_product_id,p_variant_id,p_quantity)
  on conflict(user_id,product_id,variant_id) do update set quantity=excluded.quantity;
  return p_quantity;
end $$;

create or replace function public.get_customer_account()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  return jsonb_build_object(
    'profile',(select jsonb_build_object('id',p.id,'email',p.email,'full_name',p.full_name,'phone',p.phone,'avatar_url',p.avatar_url)
      from public.profiles p where p.id=auth.uid()),
    'customer',(select to_jsonb(c)-'auth_user_id' from public.customers c where c.auth_user_id=auth.uid()),
    'addresses',coalesce((select jsonb_agg(to_jsonb(a)-'user_id' order by a.is_default desc,a.created_at,a.id)
      from public.customer_addresses a where a.user_id=auth.uid()),'[]'::jsonb),
    'favorites',coalesce((select jsonb_agg(f.product_id order by f.created_at desc) from public.customer_favorites f where f.user_id=auth.uid()),'[]'::jsonb),
    'cart',coalesce((select jsonb_agg(jsonb_build_object('product_id',c.product_id,'variant_id',c.variant_id,'quantity',c.quantity,'updated_at',c.updated_at)
      order by c.updated_at desc) from public.customer_cart_items c where c.user_id=auth.uid()),'[]'::jsonb));
end $$;

revoke all on function public.set_customer_cart_item(uuid,integer,uuid) from public,anon;
grant execute on function public.set_customer_cart_item(uuid,integer,uuid) to authenticated,service_role;

notify pgrst, 'reload schema';

commit;
