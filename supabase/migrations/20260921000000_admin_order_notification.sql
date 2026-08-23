begin;

-- Notify all global superadmins and admins when a new online order is placed.
create or replace function public.notify_admins_new_order()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_admin record; v_title text; v_body text;
begin
  if new.status = 'new' and (TG_OP = 'INSERT' or old.status is distinct from 'new') then
    v_title := 'Yangi buyurtma: ' || new.order_no;
    v_body := coalesce(new.customer_name, 'Mijoz') || ' — '
      || to_char(new.total, 'FM999,999,999') || ' so''m';

    for v_admin in
      select distinct pr.profile_id
      from public.profile_roles pr
      join public.profiles p on p.id = pr.profile_id and p.is_active
      where pr.role in ('superadmin', 'admin') and pr.branch_id is null
    loop
      insert into public.notifications(recipient_id, channel, title, body, data, sent_at)
      values (v_admin.profile_id, 'in_app', v_title, v_body,
        jsonb_build_object('order_id', new.id, 'order_no', new.order_no, 'total', new.total), now());
    end loop;
  end if;
  return new;
end $$;

drop trigger if exists trg_notify_admins_new_order on public.orders;
create trigger trg_notify_admins_new_order
  after insert or update of status on public.orders
  for each row execute function public.notify_admins_new_order();

-- Notify branch managers when an order is assigned to their branch.
create or replace function public.notify_branch_managers_order_assigned()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_mgr record; v_title text; v_body text;
begin
  -- Only fire when branch_id changes from null to a value (assignment)
  if new.branch_id is not null and (old.branch_id is null or old.branch_id is distinct from new.branch_id) then
    v_title := 'Yangi buyurtma biriktirildi: ' || new.order_no;
    v_body := coalesce(new.customer_name, 'Mijoz') || ' — '
      || to_char(new.total, 'FM999,999,999') || ' so''m';

    for v_mgr in
      select distinct pr.profile_id
      from public.profile_roles pr
      join public.profiles p on p.id = pr.profile_id and p.is_active
      where pr.branch_id = new.branch_id and pr.role in ('manager', 'admin')
    loop
      insert into public.notifications(recipient_id, channel, title, body, data, sent_at)
      values (v_mgr.profile_id, 'in_app', v_title, v_body,
        jsonb_build_object('order_id', new.id, 'order_no', new.order_no, 'total', new.total, 'branch_id', new.branch_id), now());
    end loop;
  end if;
  return new;
end $$;

drop trigger if exists trg_notify_branch_managers_order_assigned on public.orders;
create trigger trg_notify_branch_managers_order_assigned
  after update of branch_id on public.orders
  for each row execute function public.notify_branch_managers_order_assigned();

-- RPC: Get product stock availability per branch for order assignment
create or replace function public.get_order_branch_stock(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.require_ai_user(); -- admin/manager only

  select coalesce(jsonb_agg(to_jsonb(q) order by q.branch_name), '[]'::jsonb) into v_result
  from (
    select
      b.id as branch_id,
      b.name as branch_name,
      b.code as branch_code,
      jsonb_agg(jsonb_build_object(
        'product_id', sub.product_id,
        'product_name', sub.product_name,
        'needed', sub.needed,
        'available', sub.available
      ) order by sub.product_name) as products,
      min(sub.available) as min_available,
      bool_and(sub.available >= sub.needed) as can_fulfill
    from public.branches b
    cross join lateral (
      select
        ol.product_id,
        ol.product_name,
        ol.quantity::integer as needed,
        coalesce((
          select count(*)::integer
          from public.inventory_units u
          join public.locations l on l.id = u.location_id
          where u.product_id = ol.product_id
            and l.branch_id = b.id
            and l.is_active
            and l.type in ('store', 'warehouse')
            and u.status = 'available'
            and u.active_transfer_id is null
        ), 0) as available
      from public.order_lines ol
      where ol.order_id = p_order_id
    ) sub
    where b.is_active
    group by b.id, b.name, b.code
  ) q;

  return v_result;
end $$;

grant execute on function public.get_order_branch_stock(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;

