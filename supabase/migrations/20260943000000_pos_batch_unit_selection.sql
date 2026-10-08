-- 20260943000000_pos_batch_unit_selection.sql
-- Allow POS sellers to fetch multiple available units for a batch QR code in one call,
-- without asking to scan each individual item repeatedly.

begin;

create or replace function public.get_pos_batch_units(
  p_branch_id uuid,
  p_code text,
  p_count integer default 1,
  p_exclude_ids uuid[] default '{}'::uuid[]
)
returns table (
  id uuid,
  qr_code text,
  serial_number text,
  location_type text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := nullif(btrim(p_code), '');
  v_product_id uuid;
  v_variant_id uuid;
  v_exclude uuid[] := coalesce(p_exclude_ids, '{}'::uuid[]);
  v_limit integer := greatest(1, least(50, coalesce(p_count, 1)));
begin
  perform public.require_pos_seller(p_branch_id);
  if v_code is null then
    raise exception 'Kod talab qilinadi' using errcode = '22023';
  end if;

  -- 1) Find the target product and variant from the scanned QR code or serial
  select u.product_id, u.variant_id into v_product_id, v_variant_id
  from public.inventory_units u
  join public.locations l on l.id = u.location_id
  where l.branch_id = p_branch_id
    and (
      upper(u.qr_code) = upper(v_code)
      or upper(coalesce(u.serial_number, '')) = upper(v_code)
    )
  limit 1;

  -- Fallback by SKU or barcode if QR not found in this branch's inventory
  if v_product_id is null then
    select p.id into v_product_id
    from public.products p
    where upper(p.sku) = upper(v_code) or upper(coalesce(p.barcode, '')) = upper(v_code)
    limit 1;
  end if;

  if v_product_id is null then
    raise exception 'Bu kod bo‘yicha mahsulot topilmadi' using errcode = 'P0002';
  end if;

  return query
  select
    u.id,
    u.qr_code,
    u.serial_number,
    l.type::text as location_type
  from public.inventory_units u
  join public.locations l on l.id = u.location_id
  join public.products p on p.id = u.product_id
  where l.branch_id = p_branch_id
    and l.is_active
    and l.type in ('store', 'warehouse')
    and u.status = 'available'
    and u.active_transfer_id is null
    and p.status = 'active'
    and u.product_id = v_product_id
    and (v_variant_id is null or u.variant_id = v_variant_id or upper(u.qr_code) = upper(v_code))
    and not (u.id = any(v_exclude))
  order by
    -- Prefer matching the exact batch QR code
    case when upper(u.qr_code) = upper(v_code) then 0 else 1 end,
    -- Store units first, then warehouse
    case when l.type = 'store' then 0 else 1 end,
    u.created_at asc,
    u.id asc
  limit v_limit;
end;
$$;

revoke all on function public.get_pos_batch_units(uuid, text, integer, uuid[]) from public, anon;
grant execute on function public.get_pos_batch_units(uuid, text, integer, uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
