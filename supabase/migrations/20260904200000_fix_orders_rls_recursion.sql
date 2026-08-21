-- Fix: 42P17 "infinite recursion detected in policy for relation orders".
--
-- The cycle was:
--   orders_self_read          -> subquery on deliveries  (triggers deliveries RLS)
--   deliveries_courier_read   -> subquery on orders      (triggers orders RLS)
-- ...and order_lines / order_status_history / order_reserved_units inlined the same
-- orders+deliveries pair, so reading any of them recursed too.
--
-- A policy subquery still evaluates the target table's own policies, so two policies
-- that reference each other can never resolve. The fix is to move each cross-table
-- check into a SECURITY DEFINER function: it reads the other table with the owner's
-- rights, so no policy is re-entered and the cycle is broken. The visibility rules
-- themselves are unchanged.

-- Courier assigned to this order? (reads deliveries without triggering its RLS)
create or replace function public.courier_owns_order(p_order_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.current_user_active() and exists(
    select 1 from public.deliveries d
    where d.order_id = p_order_id and d.courier_id = auth.uid()
  );
$$;

-- Staff of the order's branch? (reads orders without triggering its RLS)
create or replace function public.can_access_order_branch(p_order_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.orders o
    where o.id = p_order_id
      and o.branch_id is not null
      and public.can_access_branch(o.branch_id)
  );
$$;

-- Full "may this user read this order" rule, reusable by child tables.
create or replace function public.can_read_order(p_order_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.orders o
    where o.id = p_order_id
      and (
        o.customer_user_id = auth.uid()
        or (o.branch_id is not null and public.can_access_branch(o.branch_id))
        or public.courier_owns_order(o.id)
      )
  );
$$;

revoke all on function public.courier_owns_order(uuid) from public, anon;
revoke all on function public.can_access_order_branch(uuid) from public, anon;
revoke all on function public.can_read_order(uuid) from public, anon;
grant execute on function public.courier_owns_order(uuid) to authenticated, service_role;
grant execute on function public.can_access_order_branch(uuid) to authenticated, service_role;
grant execute on function public.can_read_order(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Rewire the five policies onto the helpers.
-- ---------------------------------------------------------------------------
drop policy if exists orders_self_read on public.orders;
create policy orders_self_read on public.orders for select to authenticated
using (
  customer_user_id = auth.uid()
  or (branch_id is not null and public.can_access_branch(branch_id))
  or public.courier_owns_order(id)
);

drop policy if exists deliveries_courier_read on public.deliveries;
create policy deliveries_courier_read on public.deliveries for select to authenticated
using (
  (courier_id = auth.uid() and public.current_user_active())
  or public.can_access_order_branch(order_id)
);

drop policy if exists order_lines_owner_read on public.order_lines;
create policy order_lines_owner_read on public.order_lines for select to authenticated
using (public.can_read_order(order_id));

drop policy if exists order_history_owner_read on public.order_status_history;
create policy order_history_owner_read on public.order_status_history for select to authenticated
using (public.can_read_order(order_id));

drop policy if exists order_reserved_units_staff_read on public.order_reserved_units;
create policy order_reserved_units_staff_read on public.order_reserved_units for select to authenticated
using (public.can_access_order_branch(order_id));
