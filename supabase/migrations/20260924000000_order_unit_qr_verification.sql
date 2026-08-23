begin;

-- Track which specific physical unit (by QR) was actually verified by the courier
-- before pickup, so the courier can confirm they took the exact reserved item.
alter table public.order_reserved_units
  add column if not exists courier_confirmed_at timestamptz,
  add column if not exists courier_confirmed_by uuid references public.profiles(id);

-- Manager: view current unit assignment per order line (with QR code) so they
-- can see exactly which physical item is reserved and re-scan a different one if needed.
create or replace function public.get_order_unit_assignments(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_branch uuid; v_items jsonb;
begin
  select branch_id into v_branch from public.orders where id = p_order_id;
  if v_branch is null then raise exception 'Buyurtma topilmadi' using errcode = 'P0002'; end if;
  if not public.current_user_active() or not (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    or public.has_role(array['manager']::public.app_role[], v_branch)
  ) then raise exception 'Ruxsat yoq' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.line_created), '[]'::jsonb) into v_items
  from (
    select
      ol.id as order_line_id, ol.product_id, ol.product_name, ol.sku, ol.quantity,
      ol.created_at as line_created,
      r.id as reservation_id, r.unit_id, u.qr_code, u.serial_number,
      r.courier_confirmed_at is not null as courier_confirmed
    from public.order_lines ol
    left join public.order_reserved_units r on r.order_line_id = ol.id and r.released_at is null and r.fulfilled_at is null
    left join public.inventory_units u on u.id = r.unit_id
    where ol.order_id = p_order_id
  ) q;

  return v_items;
end $$;

-- Manager: swap the auto-assigned unit for a specific one identified by QR code.
-- Validates the new unit belongs to the same product and is available in the order's branch.
create or replace function public.manager_reassign_order_unit(p_order_line_id uuid, p_qr_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_line public.order_lines%rowtype;
  v_order public.orders%rowtype;
  v_old_reservation public.order_reserved_units%rowtype;
  v_new_unit record;
  v_code text := nullif(btrim(p_qr_code), '');
begin
  if v_code is null then raise exception 'QR kod talab qilinadi' using errcode = '22023'; end if;

  select * into v_line from public.order_lines where id = p_order_line_id;
  if v_line.id is null then raise exception 'Buyurtma qatori topilmadi' using errcode = 'P0002'; end if;

  select * into v_order from public.orders where id = v_line.order_id for update;
  if v_order.branch_id is null or not (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    or public.has_role(array['manager']::public.app_role[], v_order.branch_id)
  ) then raise exception 'Filial menejeri roli talab qilinadi' using errcode = '42501'; end if;

  if v_order.status not in ('new','confirmed','processing','ready') then
    raise exception 'Buyurtma holati mahsulot almashtirishga mos emas' using errcode = 'P0001';
  end if;

  -- Find the new unit by QR/serial, must be available in this branch and match the product.
  select u.id, u.product_id, u.status, u.location_id, l.branch_id
  into v_new_unit
  from public.inventory_units u
  join public.locations l on l.id = u.location_id
  where (upper(u.qr_code) = upper(v_code) or upper(coalesce(u.serial_number,'')) = upper(v_code))
  limit 1;

  if v_new_unit.id is null then
    raise exception 'Bu QR/seriya bo''yicha birlik topilmadi' using errcode = 'P0002';
  end if;
  if v_new_unit.branch_id <> v_order.branch_id then
    raise exception 'Bu birlik boshqa filialga tegishli' using errcode = 'P0001';
  end if;
  if v_new_unit.product_id <> v_line.product_id then
    raise exception 'Bu QR "%" mahsulotiga tegishli emas', v_line.product_name using errcode = 'P0001';
  end if;
  if v_new_unit.status <> 'available' then
    raise exception 'Bu birlik hozir mavjud (available) holatda emas' using errcode = 'P0001';
  end if;

  -- Release the old reservation (if any) and free its unit back to available.
  select * into v_old_reservation from public.order_reserved_units
  where order_line_id = p_order_line_id and released_at is null and fulfilled_at is null
  for update;

  if v_old_reservation.id is not null then
    if v_old_reservation.unit_id = v_new_unit.id then
      -- Same unit re-scanned; nothing to change.
      return jsonb_build_object('order_line_id', p_order_line_id, 'unit_id', v_new_unit.id, 'unchanged', true);
    end if;
    update public.inventory_units set status = 'available', reserved_until = null, version = version + 1
    where id = v_old_reservation.unit_id;
    update public.order_reserved_units set released_at = now(), released_by = auth.uid()
    where id = v_old_reservation.id;
    insert into public.inventory_movements(unit_id, product_id, movement_type, from_location_id, to_location_id, quantity, reference_type, reference_id, reason, actor_id)
    select v_old_reservation.unit_id, v_line.product_id, 'reservation_released', location_id, location_id, 1, 'online_order', v_order.id, 'Menejer boshqa birlik bilan almashtirdi', auth.uid()
    from public.inventory_units where id = v_old_reservation.unit_id
    on conflict do nothing;
  end if;

  -- Reserve the new unit for this order line.
  insert into public.order_reserved_units(order_id, order_line_id, unit_id, reserved_by)
  values (v_order.id, p_order_line_id, v_new_unit.id, auth.uid());
  update public.inventory_units set status = 'reserved', reserved_until = null, version = version + 1
  where id = v_new_unit.id;
  insert into public.inventory_movements(unit_id, product_id, movement_type, from_location_id, to_location_id, quantity, reference_type, reference_id, actor_id)
  values (v_new_unit.id, v_line.product_id, 'reserved', v_new_unit.location_id, v_new_unit.location_id, 1, 'online_order', v_order.id, auth.uid())
  on conflict do nothing;

  return jsonb_build_object('order_line_id', p_order_line_id, 'unit_id', v_new_unit.id, 'unchanged', false);
end $$;

-- Courier: scan a QR code to verify it matches the reserved unit for this order.
-- Marks the reservation as courier_confirmed when it matches.
create or replace function public.courier_verify_order_unit(p_order_id uuid, p_qr_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_delivery public.deliveries%rowtype;
  v_code text := nullif(btrim(p_qr_code), '');
  v_match record;
  v_all_confirmed boolean;
  v_total integer;
  v_confirmed integer;
begin
  if v_code is null then raise exception 'QR kod talab qilinadi' using errcode = '22023'; end if;

  select * into v_delivery from public.deliveries where order_id = p_order_id;
  if v_delivery.id is null or v_delivery.courier_id <> auth.uid() then
    raise exception 'Sizga biriktirilgan yetkazish topilmadi' using errcode = '42501';
  end if;

  select r.id as reservation_id, r.unit_id, u.qr_code, ol.product_name, r.courier_confirmed_at
  into v_match
  from public.order_reserved_units r
  join public.inventory_units u on u.id = r.unit_id
  join public.order_lines ol on ol.id = r.order_line_id
  where r.order_id = p_order_id and r.released_at is null and r.fulfilled_at is null
    and upper(u.qr_code) = upper(v_code)
  limit 1;

  if v_match.reservation_id is null then
    return jsonb_build_object('matched', false, 'message', 'Bu QR kod ushbu buyurtmadagi mahsulotlarga mos kelmadi.');
  end if;

  update public.order_reserved_units
  set courier_confirmed_at = now(), courier_confirmed_by = auth.uid()
  where id = v_match.reservation_id;

  select count(*), count(*) filter (where courier_confirmed_at is not null)
  into v_total, v_confirmed
  from public.order_reserved_units
  where order_id = p_order_id and released_at is null and fulfilled_at is null;

  v_all_confirmed := v_total > 0 and v_total = v_confirmed;

  return jsonb_build_object(
    'matched', true,
    'product_name', v_match.product_name,
    'qr_code', v_match.qr_code,
    'confirmed_count', v_confirmed,
    'total_count', v_total,
    'all_confirmed', v_all_confirmed
  );
end $$;

-- Courier: get verification progress for the order (how many scanned vs total)
create or replace function public.get_courier_order_verification(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_delivery public.deliveries%rowtype; v_items jsonb;
begin
  select * into v_delivery from public.deliveries where order_id = p_order_id;
  if v_delivery.id is null or v_delivery.courier_id <> auth.uid() then
    raise exception 'Sizga biriktirilgan yetkazish topilmadi' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_items
  from (
    select ol.product_name, ol.sku, r.courier_confirmed_at is not null as confirmed
    from public.order_lines ol
    join public.order_reserved_units r on r.order_line_id = ol.id and r.released_at is null and r.fulfilled_at is null
    where ol.order_id = p_order_id
  ) q;

  return jsonb_build_object('items', v_items,
    'all_confirmed', not exists (
      select 1 from public.order_lines ol
      join public.order_reserved_units r on r.order_line_id = ol.id and r.released_at is null and r.fulfilled_at is null
      where ol.order_id = p_order_id and r.courier_confirmed_at is null
    ));
end $$;

-- Require courier verification before allowing pickup transition.
create or replace function public.courier_update_delivery_status(p_delivery_id uuid,p_status public.delivery_status,p_note text default null,p_proof_id uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_d public.deliveries%rowtype; v_o public.orders%rowtype; v_p public.delivery_proofs%rowtype; v_order_status public.order_status; v_sale uuid; v_order_id uuid;
  v_unverified integer;
begin
  select order_id into v_order_id from public.deliveries where id=p_delivery_id;
  if not found then raise exception 'Yetkazib berish topilmadi' using errcode='P0002'; end if;
  select * into v_o from public.orders where id=v_order_id for update;
  select * into v_d from public.deliveries where id=p_delivery_id for update;
  if not found or v_d.order_id<>v_order_id or v_d.courier_id<>auth.uid() or not public.current_user_active() or not exists(select 1 from public.profile_roles r where r.profile_id=auth.uid() and r.role='courier' and r.branch_id=v_o.branch_id) then raise exception 'Faol biriktirilgan kuryer talab qilinadi' using errcode='42501'; end if;
  if v_d.status=p_status then return; end if;
  if not((v_d.status='assigned' and p_status='picked_up') or (v_d.status='picked_up' and p_status='in_transit') or (v_d.status='in_transit' and p_status in('delivered','failed'))) then raise exception 'Yetkazib berish status o''tishi noto''g''ri' using errcode='P0001'; end if;

  -- New guard: before picking up, every reserved unit for this order must have been
  -- QR-scanned and confirmed by this courier (see courier_verify_order_unit).
  if p_status='picked_up' then
    select count(*) into v_unverified
    from public.order_reserved_units r
    where r.order_id=v_order_id and r.released_at is null and r.fulfilled_at is null and r.courier_confirmed_at is null;
    if v_unverified > 0 then
      raise exception 'Avval barcha mahsulotlarni QR skaner orqali tasdiqlang (% ta tasdiqlanmagan)', v_unverified using errcode='P0001';
    end if;
  end if;

  if p_status='delivered' then
    if p_proof_id is null then
      select * into v_p from public.delivery_proofs where delivery_id=p_delivery_id and courier_id=auth.uid() and status='verified' order by created_at desc limit 1;
    else
      select * into v_p from public.delivery_proofs where id=p_proof_id and delivery_id=p_delivery_id and courier_id=auth.uid() and status='verified' for update;
      if not found then raise exception 'Tasdiqlangan yetkazish isboti topilmadi' using errcode='P0002'; end if;
    end if;
  end if;
  if p_status='failed' and nullif(btrim(p_note),'') is null then raise exception 'Muvaffaqiyatsizlik sababi talab qilinadi' using errcode='22023'; end if;
  update public.deliveries set status=p_status,picked_up_at=case when p_status='picked_up' then now() else picked_up_at end,
    delivered_at=case when p_status='delivered' then now() else delivered_at end,
    proof_url=case when p_status='delivered' then v_p.public_url else proof_url end,recipient_note=coalesce(nullif(btrim(p_note),''),recipient_note)
  where id=p_delivery_id;
  v_order_status=case when p_status in('picked_up','in_transit') then 'shipped'::public.order_status when p_status='delivered' then 'delivered'::public.order_status else 'processing'::public.order_status end;
  if p_status='delivered' then
    v_sale=public.finalize_online_order_sale(v_d.order_id,auth.uid());
    if v_p.id is not null then update public.delivery_proofs set status='consumed',consumed_at=now() where id=v_p.id; end if;
  end if;
  update public.orders set status=v_order_status where id=v_d.order_id;
  insert into public.order_status_history(order_id,from_status,to_status,note,actor_id) values(v_d.order_id,v_o.status,v_order_status,nullif(btrim(p_note),''),auth.uid());
  perform public.enqueue_order_notification(v_d.order_id,case when p_status='delivered' then 'Buyurtma yetkazildi' when p_status='failed' then 'Yetkazib berish amalga oshmadi' else 'Yetkazib berish yangilandi' end,
    coalesce(nullif(btrim(p_note),''),'Yetkazib berish holati: '||p_status::text),jsonb_build_object('delivery_status',p_status,'proof_url',v_p.public_url,'proof_id',p_proof_id,'sale_id',v_sale));
end $$;

grant execute on function public.get_order_unit_assignments(uuid) to authenticated, service_role;
grant execute on function public.manager_reassign_order_unit(uuid, text) to authenticated, service_role;
grant execute on function public.courier_verify_order_unit(uuid, text) to authenticated, service_role;
grant execute on function public.get_courier_order_verification(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
