-- Migration: Allow managers to reject/cancel courier delivery when customer returns goods
-- Handles:
-- 1. Marking courier_cash_handovers as 'cancelled' with optional cancel_reason
-- 2. Voiding sales created for the order (status = 'void')
-- 3. Marking sale_payments as 'failed'
-- 4. Releasing and returning sold inventory units back to 'available' and logging inventory movements
-- 5. Marking deliveries as 'failed' with note
-- 6. Marking orders as 'returned', payment_status as 'failed'
-- 7. In-app notifications to courier that goods were returned
-- 8. Enhancing cancel_online_order to allow cancelling shipped/delivered orders when COD cash is not yet received

begin;

alter table public.courier_cash_handovers
  add column if not exists cancel_reason text;

create or replace function public.reject_courier_delivery(
  p_handover_id uuid,
  p_reason text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_h public.courier_cash_handovers%rowtype;
  v_o public.orders%rowtype;
  v_sale public.sales%rowtype;
  v_unit record;
  v_res record;
  v_note text;
  v_branch_id uuid;
  v_default_loc uuid;
begin
  select * into v_h from public.courier_cash_handovers where id = p_handover_id for update;
  if not found then
    raise exception 'Kuryer topshiruvi topilmadi' using errcode = 'P0002';
  end if;

  if v_h.status = 'cancelled' then
    return to_jsonb(v_h);
  end if;

  if v_h.status <> 'pending' then
    raise exception 'Faqat kutilayotgan (pending) topshiruvni bekor qilish mumkin. Joriy holat: %', v_h.status using errcode = 'P0001';
  end if;

  if not public.current_user_active() or not (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    or public.has_role(array['manager']::public.app_role[], v_h.branch_id)
  ) then
    raise exception 'Ruxsat yo‘q' using errcode = '42501';
  end if;

  v_note := coalesce(nullif(btrim(p_reason), ''), 'Mijoz tovardan voz kechdi / Dostavka qaytdi');
  v_branch_id := v_h.branch_id;

  -- Default active location for this branch
  select id into v_default_loc
  from public.locations
  where branch_id = v_branch_id and is_active and type in ('warehouse', 'store')
  order by case when type = 'warehouse' then 1 else 2 end
  limit 1;

  -- 1. Mark handover as cancelled
  update public.courier_cash_handovers
  set status = 'cancelled',
      received_by = auth.uid(),
      received_at = now(),
      cancel_reason = v_note
  where id = p_handover_id;

  -- 2. Fetch order
  select * into v_o from public.orders where id = v_h.order_id for update;

  -- 3. If there is a sales record created for this order, void it and restore inventory units
  select * into v_sale from public.sales where order_id = v_h.order_id for update;
  if v_sale.id is not null then
    -- A. Update sales status to 'void' so it is not counted in sales / profit
    update public.sales
    set status = 'void',
        updated_at = now()
    where id = v_sale.id;

    -- B. Update sale_payments status
    update public.sale_payments
    set status = 'failed'
    where sale_id = v_sale.id;

    -- C. Revert sold inventory units back to 'available'
    for v_unit in
      select u.id, u.product_id, u.batch_id, coalesce(u.location_id, v_default_loc) as location_id
      from public.inventory_units u
      where u.sold_sale_id = v_sale.id
      for update of u
    loop
      update public.inventory_units
      set status = 'available',
          sold_sale_id = null,
          reserved_until = null,
          location_id = v_unit.location_id,
          version = version + 1
      where id = v_unit.id;

      insert into public.inventory_movements(
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity,
        reference_type, reference_id, reason, actor_id
      )
      values (
        v_unit.id, v_unit.product_id, v_unit.batch_id, 'returned',
        v_unit.location_id, v_unit.location_id, 1,
        'courier_return', v_h.id, v_note, auth.uid()
      ) on conflict do nothing;
    end loop;
  end if;

  -- 4. Release any order reserved units that were still reserved
  for v_res in
    select r.id as res_id, r.unit_id, u.product_id, u.batch_id, coalesce(u.location_id, v_default_loc) as location_id, u.status as unit_status
    from public.order_reserved_units r
    join public.inventory_units u on u.id = r.unit_id
    where r.order_id = v_h.order_id and r.released_at is null
    for update of u
  loop
    if v_res.unit_status in ('reserved', 'sold') then
      update public.inventory_units
      set status = 'available',
          sold_sale_id = null,
          reserved_until = null,
          location_id = v_res.location_id,
          version = version + 1
      where id = v_res.unit_id;

      insert into public.inventory_movements(
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity,
        reference_type, reference_id, reason, actor_id
      )
      values (
        v_res.unit_id, v_res.product_id, v_res.batch_id, 'reservation_released',
        v_res.location_id, v_res.location_id, 1,
        'courier_return', v_h.id, v_note, auth.uid()
      ) on conflict do nothing;
    end if;

    update public.order_reserved_units
    set released_at = now(), released_by = auth.uid()
    where id = v_res.res_id;
  end loop;

  -- 5. Update delivery
  update public.deliveries
  set status = 'failed',
      recipient_note = v_note,
      updated_at = now()
  where id = v_h.delivery_id or order_id = v_h.order_id;

  -- 6. Update order status to 'returned'
  if v_o.id is not null then
    update public.orders
    set status = 'returned',
        payment_status = 'failed',
        updated_at = now()
    where id = v_o.id;

    insert into public.order_status_history(order_id, from_status, to_status, note, actor_id)
    values (v_o.id, v_o.status, 'returned', v_note, auth.uid());

    perform public.enqueue_order_notification(
      v_o.id,
      'Buyurtma qaytarildi',
      v_note,
      jsonb_build_object('status', 'returned', 'handover_id', v_h.id)
    );
  end if;

  -- 7. Notify courier in-app
  insert into public.notifications (recipient_id, channel, title, body, data, sent_at)
  values (
    v_h.courier_id, 'in_app',
    'Dostavka bekor qilindi / Tovar qabul qilindi',
    coalesce(v_o.order_no, 'Buyurtma') || ' tovari qaytarildi (bekor qilindi). Pul topshirilishi shart emas.',
    jsonb_build_object('handover_id', v_h.id, 'order_id', v_h.order_id, 'status', 'cancelled'),
    now()
  );

  select to_jsonb(h) into v_h from public.courier_cash_handovers h where h.id = p_handover_id;
  return to_jsonb(v_h);
end;
$$;

-- Enhanced cancel_online_order that handles courier delivery returns
create or replace function public.cancel_online_order(p_order_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_o public.orders%rowtype;
  v_handover_id uuid;
  v_x record;
  v_sale public.sales%rowtype;
  v_unit record;
  v_default_loc uuid;
  v_note text;
begin
  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'Buyurtma topilmadi' using errcode = 'P0002'; end if;

  if v_o.customer_user_id = auth.uid() then
    if v_o.status not in ('new', 'confirmed') then
      raise exception 'Mijoz bu bosqichda bekor qila olmaydi' using errcode = 'P0001';
    end if;
  elsif v_o.branch_id is null or not (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    or public.has_role(array['manager']::public.app_role[], v_o.branch_id)
  ) then
    raise exception 'Bekor qilish ruxsati yo‘q' using errcode = '42501';
  end if;

  if v_o.status in ('cancelled', 'returned') then
    return to_jsonb(v_o);
  end if;

  v_note := coalesce(nullif(btrim(p_reason), ''), 'Buyurtma bekor qilindi / qaytarildi');

  -- If order has a received courier cash handover, money was already accepted into branch cash!
  if exists (select 1 from public.courier_cash_handovers where order_id = p_order_id and status = 'received') then
    raise exception 'Ushbu buyurtma uchun naqd pul kassaga qabul qilingan. Uni tovar qaytarish (returns) bo‘limi orqali rasmiylashtiring' using errcode = 'P0001';
  end if;

  -- If there is a pending courier cash handover, delegate to reject_courier_delivery!
  select id into v_handover_id
  from public.courier_cash_handovers
  where order_id = p_order_id and status = 'pending'
  limit 1;

  if v_handover_id is not null then
    perform public.reject_courier_delivery(v_handover_id, p_reason);
    select * into v_o from public.orders where id = p_order_id;
    return to_jsonb(v_o);
  end if;

  -- Default location for branch
  select id into v_default_loc
  from public.locations
  where branch_id = v_o.branch_id and is_active and type in ('warehouse', 'store')
  order by case when type = 'warehouse' then 1 else 2 end
  limit 1;

  -- Void sale if one exists
  select * into v_sale from public.sales where order_id = p_order_id for update;
  if v_sale.id is not null then
    update public.sales set status = 'void', updated_at = now() where id = v_sale.id;
    update public.sale_payments set status = 'failed' where sale_id = v_sale.id;

    for v_unit in
      select u.id, u.product_id, u.batch_id, coalesce(u.location_id, v_default_loc) as location_id
      from public.inventory_units u
      where u.sold_sale_id = v_sale.id
      for update of u
    loop
      update public.inventory_units
      set status = 'available',
          sold_sale_id = null,
          reserved_until = null,
          location_id = v_unit.location_id,
          version = version + 1
      where id = v_unit.id;

      insert into public.inventory_movements(
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity,
        reference_type, reference_id, reason, actor_id
      )
      values (
        v_unit.id, v_unit.product_id, v_unit.batch_id, 'returned',
        v_unit.location_id, v_unit.location_id, 1,
        'online_order_cancel', p_order_id, v_note, auth.uid()
      ) on conflict do nothing;
    end loop;
  end if;

  -- Release order reservations
  for v_x in
    select r.*, u.product_id, u.batch_id, coalesce(u.location_id, v_default_loc) as location_id, u.status as unit_status
    from public.order_reserved_units r
    join public.inventory_units u on u.id = r.unit_id
    where r.order_id = p_order_id and r.released_at is null
    order by u.id
    for update of u
  loop
    if v_x.unit_status in ('reserved', 'sold') then
      update public.inventory_units
      set status = 'available',
          sold_sale_id = null,
          reserved_until = null,
          location_id = v_x.location_id,
          version = version + 1
      where id = v_x.unit_id;

      insert into public.inventory_movements(
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity,
        reference_type, reference_id, reason, actor_id
      )
      values (
        v_x.unit_id, v_x.product_id, v_x.batch_id, 'reservation_released',
        v_x.location_id, v_x.location_id, 1,
        'online_order', p_order_id, v_note, auth.uid()
      ) on conflict do nothing;
    end if;
    update public.order_reserved_units set released_at = now(), released_by = auth.uid() where id = v_x.id;
  end loop;

  update public.deliveries
  set status = 'cancelled',
      recipient_note = v_note,
      updated_at = now()
  where order_id = p_order_id and status not in ('cancelled');

  insert into public.order_status_history(order_id, from_status, to_status, note, actor_id)
  values (p_order_id, v_o.status, 'returned', v_note, auth.uid());

  update public.orders
  set status = 'returned',
      payment_status = 'failed',
      updated_at = now()
  where id = p_order_id
  returning * into v_o;

  perform public.enqueue_order_notification(
    p_order_id,
    'Buyurtma bekor qilindi',
    v_note,
    jsonb_build_object('status', 'returned')
  );

  return to_jsonb(v_o);
end;
$$;

grant execute on function public.reject_courier_delivery(uuid, text) to authenticated, service_role;
grant execute on function public.cancel_online_order(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
