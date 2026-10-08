-- Surface color variant info everywhere a product/batch/media row is already returned:
-- receipt detail, admin catalog editor, and product media attach/delete.
begin;

create or replace function public.get_stock_receipt(p_receipt_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb; v_branch uuid;
begin
  select branch_id into v_branch from public.stock_receipts where id=p_receipt_id;
  if v_branch is null then raise exception 'Partiya topilmadi' using errcode='P0002'; end if;
  if not public.can_access_branch(v_branch) then raise exception 'Ruxsat yo‘q' using errcode='42501'; end if;
  select to_jsonb(r) || jsonb_build_object('branch_name',br.name,'supplier_name',s.name,'location_name',l.name,
    'lines',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'line_no',b.line_no,'product_id',b.product_id,'product_name',p.name,'sku',p.sku,
      'variant_id',b.variant_id,'variant_color',v.color_name,'quantity',b.quantity,'unit_cost',b.unit_cost,
      'qr_count',(select count(*) from public.inventory_units u where u.batch_id=b.id)) order by b.line_no)
      from public.stock_batches b join public.products p on p.id=b.product_id left join public.product_variants v on v.id=b.variant_id where b.receipt_id=r.id),'[]'::jsonb))
  into v_result from public.stock_receipts r join public.branches br on br.id=r.branch_id join public.suppliers s on s.id=r.supplier_id
    join public.locations l on l.id=r.receiving_location_id where r.id=p_receipt_id;
  return v_result;
end; $$;

-- Admin catalog editor: expose the product's color variants alongside media/attributes.
create or replace function public.get_catalog_product(p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.require_catalog_admin();
  select to_jsonb(p) || jsonb_build_object(
    'category_name',c.name,'brand_name',b.name,
    'media',coalesce((select jsonb_agg(to_jsonb(m) order by m.is_primary desc,m.sort_order,m.created_at) from public.product_media m where m.product_id=p.id),'[]'::jsonb),
    'attributes',coalesce((select jsonb_agg(jsonb_build_object('attribute_id',v.attribute_id,'value',v.value)) from public.product_attribute_values v where v.product_id=p.id),'[]'::jsonb),
    'variants',coalesce((
      select jsonb_agg(to_jsonb(pv) || jsonb_build_object(
        'stock',(select count(*) from public.inventory_units u where u.variant_id=pv.id and u.status='available'),
        'media',coalesce((select jsonb_agg(to_jsonb(m) order by m.is_primary desc,m.sort_order,m.created_at) from public.product_media m where m.variant_id=pv.id),'[]'::jsonb)
      ) order by pv.sort_order,pv.created_at)
      from public.product_variants pv where pv.product_id=p.id
    ),'[]'::jsonb)
  ) into v_result from public.products p join public.categories c on c.id=p.category_id left join public.brands b on b.id=p.brand_id where p.id=p_product_id;
  if v_result is null then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if;
  return v_result;
end;
$$;

-- Attach/detach product media must accept an optional variant scope. The old
-- 7-parameter overload is dropped first so a call omitting p_variant_id can never be
-- ambiguous between two coexisting signatures.
drop function if exists public.attach_product_media(uuid,uuid,text,text,text,bigint,text);
create or replace function public.attach_product_media(p_actor_id uuid,p_product_id uuid,p_r2_key text,p_public_url text,p_mime_type text,p_bytes bigint,p_alt_text text default null,p_variant_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_primary boolean;
begin
  perform public.require_catalog_actor(p_actor_id);
  if not exists(select 1 from public.products where id=p_product_id) then raise exception 'Mahsulot topilmadi' using errcode='P0002'; end if;
  if p_variant_id is not null and not exists(select 1 from public.product_variants where id=p_variant_id and product_id=p_product_id) then
    raise exception 'Variant bu mahsulotga tegishli emas' using errcode='P0002';
  end if;
  v_primary := not exists(select 1 from public.product_media where product_id=p_product_id and variant_id is not distinct from p_variant_id);
  insert into public.product_media(product_id,variant_id,r2_key,public_url,mime_type,bytes,alt_text,sort_order,is_primary)
  values(p_product_id,p_variant_id,p_r2_key,p_public_url,p_mime_type,p_bytes,nullif(btrim(p_alt_text),''),
    coalesce((select max(sort_order)+1 from public.product_media where product_id=p_product_id and variant_id is not distinct from p_variant_id),0),v_primary)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.detach_product_media(p_actor_id uuid,p_media_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_key text; v_product uuid; v_variant uuid; v_was_primary boolean;
begin
  perform public.require_catalog_actor(p_actor_id);
  delete from public.product_media where id=p_media_id returning r2_key,product_id,variant_id,is_primary into v_key,v_product,v_variant,v_was_primary;
  if v_key is null then raise exception 'Rasm topilmadi' using errcode='P0002'; end if;
  if v_was_primary then
    update public.product_media set is_primary=true
    where id=(select id from public.product_media where product_id=v_product and variant_id is not distinct from v_variant order by sort_order,created_at limit 1);
  end if;
  return v_key;
end; $$;

revoke all on function public.attach_product_media(uuid,uuid,text,text,text,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.attach_product_media(uuid,uuid,text,text,text,bigint,text,uuid) to service_role;

notify pgrst, 'reload schema';

commit;
