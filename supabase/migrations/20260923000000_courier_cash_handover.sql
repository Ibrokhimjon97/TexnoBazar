begin;

-- Tracks cash collected by couriers from COD orders that must be handed to the branch cashier.
create table if not exists public.courier_cash_handovers (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  courier_id uuid not null references public.profiles(id) on delete restrict,
  amount numeric(18,2) not null check (amount > 0),
  currency char(3) not null default 'UZS',
  status text not null default 'pending' check (status in ('pending','received','cancelled')),
  received_by uuid references public.profiles(id),
  received_at timestamptz,
  finance_transaction_id uuid references public.finance_transactions(id),
  created_at timestamptz not null default now(),
  unique(delivery_id)
);
create index if not exists courier_cash_handovers_courier_status_idx on public.courier_cash_handovers(courier_id, status);
create index if not exists courier_cash_handovers_branch_status_idx on public.courier_cash_handovers(branch_id, status);

-- Auto-create handover record when delivery is marked as delivered (COD orders only)
create or replace function public.auto_create_courier_cash_handover()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_order public.orders%rowtype; v_method public.payment_methods%rowtype;
begin
  if new.status = 'delivered' and (old.status is distinct from 'delivered') then
    select o.* into v_order from public.orders o where o.id = new.order_id;
    if v_order.id is null then return new; end if;
    
    select pm.* into v_method from public.payment_methods pm where pm.id = v_order.payment_method_id;
    -- Only COD (cash on delivery) orders need courier cash handover
    if v_method.code = 'cod' then
      insert into public.courier_cash_handovers (delivery_id, order_id, branch_id, courier_id, amount, currency)
      values (new.id, new.order_id, coalesce(v_order.branch_id, new.branch_id), new.courier_id, v_order.total, 'UZS')
      on conflict (delivery_id) do nothing;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_auto_courier_cash_handover on public.deliveries;
create trigger trg_auto_courier_cash_handover
  after update of status on public.deliveries
  for each row execute function public.auto_create_courier_cash_handover();

-- Courier: list own pending cash to hand over
create or replace function public.list_courier_pending_cash()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_total numeric;
begin
  if auth.uid() is null then raise exception 'Auth' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc), '[]'::jsonb),
         coalesce(sum(q.amount), 0)
  into v_items, v_total
  from (
    select h.id, h.order_id, h.amount, h.currency, h.status, h.created_at,
      o.order_no, o.customer_name, o.customer_phone
    from public.courier_cash_handovers h
    join public.orders o on o.id = h.order_id
    where h.courier_id = auth.uid() and h.status = 'pending'
  ) q;

  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

-- Manager: list pending courier cash for branch
create or replace function public.list_branch_courier_cash(p_branch_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_total numeric;
begin
  if not public.current_user_active() or not (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    or public.has_role(array['manager']::public.app_role[], p_branch_id)
  ) then raise exception 'Ruxsat yoq' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc), '[]'::jsonb),
         coalesce(sum(q.amount), 0)
  into v_items, v_total
  from (
    select h.id, h.order_id, h.delivery_id, h.courier_id, h.amount, h.currency, h.status, h.created_at,
      o.order_no, o.customer_name, o.customer_phone,
      p.full_name as courier_name, p.phone as courier_phone
    from public.courier_cash_handovers h
    join public.orders o on o.id = h.order_id
    join public.profiles p on p.id = h.courier_id
    where h.branch_id = p_branch_id and h.status = 'pending'
  ) q;

  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

-- Manager: accept courier cash handover
create or replace function public.accept_courier_cash(p_handover_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_h public.courier_cash_handovers%rowtype; v_account_id uuid; v_tx_id uuid;
begin
  select * into v_h from public.courier_cash_handovers where id = p_handover_id for update;
  if not found then raise exception 'Topilmadi' using errcode = 'P0002'; end if;
  if v_h.status <> 'pending' then return to_jsonb(v_h); end if;
  
  if not public.current_user_active() or not (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    or public.has_role(array['manager']::public.app_role[], v_h.branch_id)
  ) then raise exception 'Ruxsat yoq' using errcode = '42501'; end if;

  -- Record income in finance
  select id into v_account_id from public.finance_accounts where branch_id = v_h.branch_id and is_active limit 1;
  if v_account_id is null then
    insert into public.finance_accounts (branch_id, code, name, currency)
    values (v_h.branch_id, 'CASH-' || left(v_h.branch_id::text, 8), 'Kassa', 'UZS')
    returning id into v_account_id;
  end if;

  insert into public.finance_transactions (account_id, branch_id, type, category, amount, description, reference_type, reference_id, created_by)
  values (v_account_id, v_h.branch_id, 'income', 'courier_cash', v_h.amount,
    'Kuryer pul topshirishi: ' || (select order_no from public.orders where id = v_h.order_id),
    'courier_cash_handover', v_h.id, auth.uid())
  returning id into v_tx_id;

  update public.courier_cash_handovers
  set status = 'received', received_by = auth.uid(), received_at = now(), finance_transaction_id = v_tx_id
  where id = p_handover_id;

  -- Notify courier
  insert into public.notifications (recipient_id, channel, title, body, data, sent_at)
  values (v_h.courier_id, 'in_app',
    'Pul qabul qilindi',
    to_char(v_h.amount, 'FM999,999,999') || ' so''m kassaga topshirildi',
    jsonb_build_object('handover_id', v_h.id, 'order_id', v_h.order_id, 'amount', v_h.amount),
    now());

  select to_jsonb(h) into v_h from public.courier_cash_handovers h where h.id = p_handover_id;
  return to_jsonb(v_h);
end $$;

grant execute on function public.list_courier_pending_cash() to authenticated, service_role;
grant execute on function public.list_branch_courier_cash(uuid) to authenticated, service_role;
grant execute on function public.accept_courier_cash(uuid) to authenticated, service_role;

alter table public.courier_cash_handovers enable row level security;
drop policy if exists courier_own_read on public.courier_cash_handovers;
create policy courier_own_read on public.courier_cash_handovers for select to authenticated
  using (courier_id = auth.uid() or public.has_role(array['superadmin','admin','manager']::public.app_role[], branch_id));

notify pgrst, 'reload schema';
commit;
