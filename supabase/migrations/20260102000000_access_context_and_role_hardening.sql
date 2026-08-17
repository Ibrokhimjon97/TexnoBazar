-- Task 1: authenticated access context, employee administration and RLS hardening.
begin;

create or replace function public.enforce_profile_role_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role in ('superadmin', 'admin', 'customer') and new.branch_id is not null then
    raise exception '% roli global bo‘lishi kerak', new.role using errcode = '23514';
  end if;
  if new.role in ('manager', 'seller', 'warehouse', 'accountant', 'courier') then
    if new.branch_id is null then
      raise exception '% roli filialga biriktirilishi kerak', new.role using errcode = '23514';
    end if;
    if not exists (select 1 from public.branches b where b.id = new.branch_id and b.is_active) then
      raise exception 'Xodim roli faqat faol filialga biriktiriladi' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profile_roles_scope_guard on public.profile_roles;
create trigger profile_roles_scope_guard
before insert or update of role, branch_id on public.profile_roles
for each row execute function public.enforce_profile_role_scope();

create or replace function public.prevent_assigned_branch_deactivation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.is_active and not new.is_active and exists (
    select 1 from public.profile_roles r where r.branch_id = new.id
      and r.role in ('manager','seller','warehouse','accountant','courier')
  ) then
    raise exception 'Xodim rollari biriktirilgan filialni faolsizlantirib bo‘lmaydi' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists branches_active_role_guard on public.branches;
create trigger branches_active_role_guard before update of is_active on public.branches
for each row execute function public.prevent_assigned_branch_deactivation();

do $$
begin
  if exists (
    select 1 from public.profile_roles r
    left join public.branches b on b.id = r.branch_id
    where (r.role in ('superadmin','admin','customer') and r.branch_id is not null)
       or (r.role in ('manager','seller','warehouse','accountant','courier')
           and (r.branch_id is null or not coalesce(b.is_active, false)))
  ) then
    raise exception 'Mavjud profile_roles yozuvi rol doirasiga zid';
  end if;
end;
$$;

create or replace function public.can_access_branch(p_branch uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_role(array['superadmin','admin']::public.app_role[], null)
      or public.has_role(array['manager','seller','warehouse','accountant']::public.app_role[], p_branch)
$$;
create or replace function public.get_my_access_context()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501'; end if;
  select jsonb_build_object(
    'profile', jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name,
      'phone', p.phone, 'avatar_url', p.avatar_url, 'is_active', p.is_active, 'created_at', p.created_at),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object('role', r.role, 'branch_id', r.branch_id,
        'branch_name', b.name, 'branch_code', b.code) order by r.role::text, b.name nulls first)
      from public.profile_roles r left join public.branches b on b.id = r.branch_id
      where r.profile_id = p.id
    ), '[]'::jsonb)
  ) into v_result
  from public.profiles p where p.id = auth.uid() and p.is_active;
  if v_result is null then raise exception 'Faol profil topilmadi' using errcode = '42501'; end if;
  return v_result;
end;
$$;

create or replace function public.list_employees()
returns table(employee_id uuid, email extensions.citext, full_name text, phone text,
  is_active boolean, roles jsonb, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_role(array['superadmin']::public.app_role[], null) then
    raise exception 'Global superadmin roli talab qilinadi' using errcode = '42501';
  end if;
  return query select p.id, p.email, p.full_name, p.phone, p.is_active,
    coalesce((select jsonb_agg(jsonb_build_object('role', r.role, 'branch_id', r.branch_id,
      'branch_name', b.name, 'branch_code', b.code) order by r.role::text, b.name nulls first)
      from public.profile_roles r left join public.branches b on b.id = r.branch_id
      where r.profile_id = p.id), '[]'::jsonb), p.created_at
    from public.profiles p
    where exists (select 1 from public.profile_roles r where r.profile_id = p.id and r.role <> 'customer')
    order by p.created_at desc;
end;
$$;

create or replace function public.list_active_branches()
returns table(id uuid, code text, name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_role(array['superadmin']::public.app_role[], null) then
    raise exception 'Global superadmin roli talab qilinadi' using errcode = '42501';
  end if;
  return query select b.id, b.code, b.name from public.branches b where b.is_active order by b.name;
end;
$$;

create or replace function public.set_employee_active(p_employee_id uuid, p_is_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role(array['superadmin']::public.app_role[], null) then
    raise exception 'Global superadmin roli talab qilinadi' using errcode = '42501';
  end if;
  if p_employee_id = auth.uid() and not p_is_active then
    raise exception 'O‘zingizni faolsizlantira olmaysiz' using errcode = '22023';
  end if;
  update public.profiles p set is_active = p_is_active where p.id = p_employee_id
    and exists (select 1 from public.profile_roles r where r.profile_id = p.id and r.role <> 'customer');
  if not found then raise exception 'Xodim topilmadi' using errcode = 'P0002'; end if;
end;
$$;

-- Couriers only see their assigned delivery/order chain. Other internal roles remain branch-scoped.
drop policy if exists orders_self_read on public.orders;
create policy orders_self_read on public.orders for select to authenticated using(
  customer_user_id = auth.uid()
  or (branch_id is not null and public.can_access_branch(branch_id))
  or exists(select 1 from public.deliveries d where d.order_id = orders.id and d.courier_id = auth.uid()
    and public.current_user_active())
);
drop policy if exists order_lines_owner_read on public.order_lines;
create policy order_lines_owner_read on public.order_lines for select to authenticated using(
  exists(select 1 from public.orders o where o.id = order_id and (
    o.customer_user_id = auth.uid() or (o.branch_id is not null and public.can_access_branch(o.branch_id))
    or exists(select 1 from public.deliveries d where d.order_id = o.id and d.courier_id = auth.uid() and public.current_user_active())
  ))
);
drop policy if exists order_history_owner_read on public.order_status_history;
create policy order_history_owner_read on public.order_status_history for select to authenticated using(
  exists(select 1 from public.orders o where o.id = order_id and (
    o.customer_user_id = auth.uid() or (o.branch_id is not null and public.can_access_branch(o.branch_id))
    or exists(select 1 from public.deliveries d where d.order_id = o.id and d.courier_id = auth.uid() and public.current_user_active())
  ))
);
drop policy if exists deliveries_courier_read on public.deliveries;
create policy deliveries_courier_read on public.deliveries for select to authenticated using(
  (courier_id = auth.uid() and public.current_user_active())
  or exists(select 1 from public.orders o where o.id = order_id and o.branch_id is not null
    and public.can_access_branch(o.branch_id))
);

drop policy if exists pending_sales_staff_read on public.pos_pending_sales;
create policy pending_sales_staff_read on public.pos_pending_sales for select to authenticated using(
  public.has_role(array['superadmin','admin','manager']::public.app_role[], branch_id)
  or (seller_id = auth.uid() and public.has_role(array['seller']::public.app_role[], branch_id))
);
drop policy if exists sales_staff_read on public.sales;
create policy sales_staff_read on public.sales for select to authenticated using(
  public.has_role(array['superadmin','admin','manager','accountant']::public.app_role[], branch_id)
  or (seller_id = auth.uid() and public.has_role(array['seller']::public.app_role[], branch_id))
);

-- Explicit callable allow-list. Direct profile/role administration remains unavailable to clients.
revoke all on function public.enforce_profile_role_scope() from public, anon, authenticated;
revoke all on function public.prevent_assigned_branch_deactivation() from public, anon, authenticated;
revoke all on function public.get_my_access_context() from public, anon;
revoke all on function public.list_employees() from public, anon;
revoke all on function public.list_active_branches() from public, anon;
revoke all on function public.set_employee_active(uuid, boolean) from public, anon;
grant execute on function public.get_my_access_context(), public.list_employees(),
  public.list_active_branches(), public.set_employee_active(uuid, boolean) to authenticated;
grant execute on function public.enforce_profile_role_scope(), public.prevent_assigned_branch_deactivation(), public.get_my_access_context(),
  public.list_employees(), public.list_active_branches(), public.set_employee_active(uuid, boolean) to service_role;
revoke all on public.profile_roles from anon, authenticated;
alter table public.profile_roles enable row level security;

-- Minimal operational topology, only on a completely empty installation.
do $$ declare v_branch_id uuid;
begin
  if not exists (select 1 from public.branches) then
    insert into public.branches(code,name) values('MAIN','Asosiy filial') returning id into v_branch_id;
    insert into public.locations(branch_id,code,name,type) values
      (v_branch_id,'MAIN-STORE','Asosiy do‘kon','store'),
      (v_branch_id,'MAIN-WH','Asosiy ombor','warehouse');
  end if;
end;
$$;

commit;