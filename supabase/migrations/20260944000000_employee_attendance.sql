-- Migration: 20260944000000_employee_attendance.sql
-- Employee attendance tracking with GPS location, daily clock-in / clock-out,
-- worked hours computation, manager/admin notifications, and reporting RPCs.

begin;

create table if not exists public.employee_attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  work_date date not null default (now() at time zone 'Asia/Tashkent')::date,
  check_in_at timestamptz not null default now(),
  check_in_lat numeric(10, 7),
  check_in_lng numeric(10, 7),
  check_in_accuracy numeric(8, 2),
  check_in_address text,
  check_out_at timestamptz,
  check_out_lat numeric(10, 7),
  check_out_lng numeric(10, 7),
  check_out_accuracy numeric(8, 2),
  check_out_address text,
  worked_minutes integer,
  status text not null default 'checked_in' check (status in ('checked_in', 'completed')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_employee_work_date unique (employee_id, work_date)
);

create index if not exists idx_attendance_employee_date on public.employee_attendance(employee_id, work_date desc);
create index if not exists idx_attendance_branch_date on public.employee_attendance(branch_id, work_date desc);
create index if not exists idx_attendance_work_date on public.employee_attendance(work_date desc);

-- Enable RLS
alter table public.employee_attendance enable row level security;

-- Policies
drop policy if exists attendance_select_policy on public.employee_attendance;
create policy attendance_select_policy on public.employee_attendance
  for select to authenticated
  using (
    employee_id = auth.uid()
    or public.has_role(array['superadmin', 'admin']::public.app_role[], null)
    or (branch_id is not null and public.has_role(array['manager']::public.app_role[], branch_id))
  );

-- RPC: clock_in
create or replace function public.clock_in(
  p_branch_id uuid default null,
  p_lat numeric default null,
  p_lng numeric default null,
  p_accuracy numeric default null,
  p_address text default null
)
returns public.employee_attendance
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_name text;
  v_branch_id uuid;
  v_branch_name text;
  v_today date;
  v_record public.employee_attendance;
  v_rec record;
  v_time_str text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;

  select coalesce(p.full_name, p.email, 'Xodim')
  into v_user_name
  from public.profiles p
  where p.id = v_user_id;

  v_today := (now() at time zone 'Asia/Tashkent')::date;

  -- Check if already clocked in today
  if exists (select 1 from public.employee_attendance where employee_id = v_user_id and work_date = v_today) then
    raise exception 'Siz bugun allaqachon ishga kelganingizni qayd etgansiz!' using errcode = '23505';
  end if;

  -- Determine branch
  v_branch_id := p_branch_id;
  if v_branch_id is null then
    select r.branch_id into v_branch_id
    from public.profile_roles r
    where r.profile_id = v_user_id and r.branch_id is not null
    limit 1;
  end if;

  if v_branch_id is not null then
    select b.name into v_branch_name from public.branches b where b.id = v_branch_id;
  end if;

  insert into public.employee_attendance (
    employee_id,
    branch_id,
    work_date,
    check_in_at,
    check_in_lat,
    check_in_lng,
    check_in_accuracy,
    check_in_address,
    status
  ) values (
    v_user_id,
    v_branch_id,
    v_today,
    now(),
    p_lat,
    p_lng,
    p_accuracy,
    p_address,
    'checked_in'
  )
  returning * into v_record;

  v_time_str := to_char(now() at time zone 'Asia/Tashkent', 'HH24:MI');

  -- Notify managers and superadmins
  for v_rec in (
    select distinct r.profile_id
    from public.profile_roles r
    where r.profile_id <> v_user_id
      and (
        r.role in ('superadmin', 'admin')
        or (v_branch_id is not null and r.role = 'manager' and r.branch_id = v_branch_id)
      )
  ) loop
    insert into public.notifications (
      recipient_id,
      channel,
      title,
      body,
      data,
      sent_at
    ) values (
      v_rec.profile_id,
      'in_app',
      'Xodim ishga keldi: ' || v_user_name,
      v_user_name || ' (' || coalesce(v_branch_name, 'Filial') || ') soat ' || v_time_str || ' da ishga keldi.',
      jsonb_build_object(
        'type', 'attendance_clock_in',
        'attendance_id', v_record.id,
        'employee_id', v_user_id,
        'employee_name', v_user_name,
        'branch_id', v_branch_id,
        'branch_name', v_branch_name,
        'lat', p_lat,
        'lng', p_lng,
        'time', v_time_str
      ),
      now()
    );
  end loop;

  return v_record;
end;
$$;

-- RPC: clock_out
create or replace function public.clock_out(
  p_lat numeric default null,
  p_lng numeric default null,
  p_accuracy numeric default null,
  p_address text default null
)
returns public.employee_attendance
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_name text;
  v_branch_id uuid;
  v_branch_name text;
  v_today date;
  v_record public.employee_attendance;
  v_worked_minutes integer;
  v_hours integer;
  v_mins integer;
  v_duration_str text;
  v_rec record;
  v_time_str text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;

  select coalesce(p.full_name, p.email, 'Xodim')
  into v_user_name
  from public.profiles p
  where p.id = v_user_id;

  v_today := (now() at time zone 'Asia/Tashkent')::date;

  select * into v_record
  from public.employee_attendance
  where employee_id = v_user_id and work_date = v_today
  for update;

  if not found then
    raise exception 'Bugun ishga kelish qayd etilmagan!' using errcode = 'P0002';
  end if;

  if v_record.check_out_at is not null then
    raise exception 'Siz bugun ishni allaqachon yakunlagansiz!' using errcode = '23505';
  end if;

  v_worked_minutes := greatest(0, round(extract(epoch from (now() - v_record.check_in_at)) / 60)::integer);
  v_hours := v_worked_minutes / 60;
  v_mins := v_worked_minutes % 60;
  v_duration_str := v_hours || ' soat ' || v_mins || ' daqiqa';
  v_time_str := to_char(now() at time zone 'Asia/Tashkent', 'HH24:MI');

  update public.employee_attendance
  set
    check_out_at = now(),
    check_out_lat = p_lat,
    check_out_lng = p_lng,
    check_out_accuracy = p_accuracy,
    check_out_address = p_address,
    worked_minutes = v_worked_minutes,
    status = 'completed',
    updated_at = now()
  where id = v_record.id
  returning * into v_record;

  v_branch_id := v_record.branch_id;
  if v_branch_id is not null then
    select b.name into v_branch_name from public.branches b where b.id = v_branch_id;
  end if;

  -- Notify managers and superadmins
  for v_rec in (
    select distinct r.profile_id
    from public.profile_roles r
    where r.profile_id <> v_user_id
      and (
        r.role in ('superadmin', 'admin')
        or (v_branch_id is not null and r.role = 'manager' and r.branch_id = v_branch_id)
      )
  ) loop
    insert into public.notifications (
      recipient_id,
      channel,
      title,
      body,
      data,
      sent_at
    ) values (
      v_rec.profile_id,
      'in_app',
      'Xodim ishni yakunladi: ' || v_user_name,
      v_user_name || ' (' || coalesce(v_branch_name, 'Filial') || ') soat ' || v_time_str || ' da ishni yakunladi. Ishlangan vaqt: ' || v_duration_str || '.',
      jsonb_build_object(
        'type', 'attendance_clock_out',
        'attendance_id', v_record.id,
        'employee_id', v_user_id,
        'employee_name', v_user_name,
        'branch_id', v_branch_id,
        'branch_name', v_branch_name,
        'lat', p_lat,
        'lng', p_lng,
        'worked_minutes', v_worked_minutes,
        'time', v_time_str
      ),
      now()
    );
  end loop;

  return v_record;
end;
$$;

-- RPC: get_my_today_attendance
create or replace function public.get_my_today_attendance()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_today date;
  v_res jsonb;
begin
  v_user_id := auth.uid();
  if v_user_id is null then return null; end if;
  v_today := (now() at time zone 'Asia/Tashkent')::date;

  select to_jsonb(a.*) into v_res
  from public.employee_attendance a
  where a.employee_id = v_user_id and a.work_date = v_today;

  return v_res;
end;
$$;

-- RPC: get_my_attendance_history
create or replace function public.get_my_attendance_history(
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_from date;
  v_to date;
  v_items jsonb;
  v_summary jsonb;
begin
  v_user_id := auth.uid();
  if v_user_id is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501'; end if;

  v_from := coalesce(p_from, (now() at time zone 'Asia/Tashkent')::date - interval '30 days');
  v_to := coalesce(p_to, (now() at time zone 'Asia/Tashkent')::date);

  select coalesce(jsonb_agg(to_jsonb(t.*) order by t.work_date desc), '[]'::jsonb)
  into v_items
  from (
    select
      a.id,
      a.work_date,
      a.check_in_at,
      a.check_in_lat,
      a.check_in_lng,
      a.check_out_at,
      a.check_out_lat,
      a.check_out_lng,
      case
        when a.check_out_at is not null then coalesce(a.worked_minutes, round(extract(epoch from (a.check_out_at - a.check_in_at)) / 60)::integer)
        else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer
      end as worked_minutes,
      a.status,
      b.name as branch_name
    from public.employee_attendance a
    left join public.branches b on b.id = a.branch_id
    where a.employee_id = v_user_id
      and a.work_date between v_from and v_to
    order by a.work_date desc
  ) t;

  select jsonb_build_object(
    'total_days', count(distinct a.work_date),
    'completed_days', count(distinct case when a.status = 'completed' then a.work_date end),
    'total_worked_minutes', coalesce(sum(case when a.check_out_at is not null then coalesce(a.worked_minutes, round(extract(epoch from (a.check_out_at - a.check_in_at)) / 60)::integer) else 0 end), 0)
  ) into v_summary
  from public.employee_attendance a
  where a.employee_id = v_user_id
    and a.work_date between v_from and v_to;

  return jsonb_build_object(
    'items', v_items,
    'summary', v_summary,
    'from', v_from,
    'to', v_to
  );
end;
$$;

-- RPC: get_attendance_list (for Admin and Manager)
create or replace function public.get_attendance_list(
  p_branch_id uuid default null,
  p_employee_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_is_admin boolean;
  v_is_manager boolean;
  v_caller_id uuid;
  v_from date;
  v_to date;
  v_items jsonb;
  v_summary jsonb;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501'; end if;

  v_is_admin := public.has_role(array['superadmin', 'admin']::public.app_role[], null);
  v_is_manager := public.has_role(array['manager']::public.app_role[], p_branch_id);

  if not (v_is_admin or v_is_manager) then
    raise exception 'Ushbu bo‘limni ko‘rish uchun menejer yoki admin roli talab qilinadi' using errcode = '42501';
  end if;

  v_from := coalesce(p_from, (now() at time zone 'Asia/Tashkent')::date);
  v_to := coalesce(p_to, (now() at time zone 'Asia/Tashkent')::date);

  select coalesce(jsonb_agg(to_jsonb(t.*) order by t.work_date desc, t.check_in_at desc), '[]'::jsonb)
  into v_items
  from (
    select
      a.id,
      a.work_date,
      a.check_in_at,
      a.check_in_lat,
      a.check_in_lng,
      a.check_in_accuracy,
      a.check_in_address,
      a.check_out_at,
      a.check_out_lat,
      a.check_out_lng,
      a.check_out_accuracy,
      a.check_out_address,
      case
        when a.check_out_at is not null then coalesce(a.worked_minutes, round(extract(epoch from (a.check_out_at - a.check_in_at)) / 60)::integer)
        else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer
      end as worked_minutes,
      a.status,
      a.notes,
      a.employee_id,
      p.full_name as employee_name,
      p.email as employee_email,
      p.phone as employee_phone,
      p.avatar_url as employee_avatar,
      a.branch_id,
      b.name as branch_name,
      b.code as branch_code,
      coalesce((
        select r.role from public.profile_roles r
        where r.profile_id = p.id
        order by case when r.role = 'seller' then 1 when r.role = 'manager' then 2 else 3 end
        limit 1
      )::text, 'xodim') as employee_role
    from public.employee_attendance a
    join public.profiles p on p.id = a.employee_id
    left join public.branches b on b.id = a.branch_id
    where a.work_date between v_from and v_to
      and (p_branch_id is null or a.branch_id = p_branch_id)
      and (p_employee_id is null or a.employee_id = p_employee_id)
      and (
        p_search is null
        or btrim(p_search) = ''
        or p.full_name ilike '%' || btrim(p_search) || '%'
        or p.email ilike '%' || btrim(p_search) || '%'
        or p.phone ilike '%' || btrim(p_search) || '%'
      )
      and (
        v_is_admin
        or exists (
          select 1 from public.profile_roles pr
          where pr.profile_id = v_caller_id
            and pr.role = 'manager'
            and (pr.branch_id is null or pr.branch_id = a.branch_id)
        )
      )
    order by a.work_date desc, a.check_in_at desc
  ) t;

  select jsonb_build_object(
    'total_records', count(*),
    'unique_employees', count(distinct a.employee_id),
    'currently_working', count(*) filter (where a.status = 'checked_in'),
    'completed_shifts', count(*) filter (where a.status = 'completed'),
    'total_worked_minutes', coalesce(sum(case when a.check_out_at is not null then coalesce(a.worked_minutes, round(extract(epoch from (a.check_out_at - a.check_in_at)) / 60)::integer) else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer end), 0)
  ) into v_summary
  from public.employee_attendance a
  join public.profiles p on p.id = a.employee_id
  where a.work_date between v_from and v_to
    and (p_branch_id is null or a.branch_id = p_branch_id)
    and (p_employee_id is null or a.employee_id = p_employee_id)
    and (
      p_search is null
      or btrim(p_search) = ''
      or p.full_name ilike '%' || btrim(p_search) || '%'
      or p.email ilike '%' || btrim(p_search) || '%'
      or p.phone ilike '%' || btrim(p_search) || '%'
    )
    and (
      v_is_admin
      or exists (
        select 1 from public.profile_roles pr
        where pr.profile_id = v_caller_id
          and pr.role = 'manager'
          and (pr.branch_id is null or pr.branch_id = a.branch_id)
      )
    );

  return jsonb_build_object(
    'items', v_items,
    'summary', v_summary,
    'from', v_from,
    'to', v_to
  );
end;
$$;

-- RPC: list_branch_employees
create or replace function public.list_branch_employees(p_branch_id uuid default null)
returns table(id uuid, full_name text, email extensions.citext, phone text, avatar_url text, role public.app_role)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid;
  v_branch uuid;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501'; end if;

  if public.has_role(array['superadmin', 'admin']::public.app_role[], null) then
    v_branch := p_branch_id;
  elsif public.has_role(array['manager']::public.app_role[], p_branch_id) then
    v_branch := p_branch_id;
  else
    raise exception 'Ruxsat berilmadi' using errcode = '42501';
  end if;

  return query
  select distinct p.id, p.full_name, p.email, p.phone, p.avatar_url, r.role
  from public.profiles p
  join public.profile_roles r on r.profile_id = p.id
  where (v_branch is null or r.branch_id = v_branch)
    and r.role in ('seller', 'courier', 'manager', 'warehouse', 'accountant')
    and p.is_active
  order by p.full_name, p.id;
end;
$$;

-- Permissions
grant select on public.employee_attendance to authenticated;
grant execute on function public.clock_in(uuid, numeric, numeric, numeric, text) to authenticated;
grant execute on function public.clock_out(numeric, numeric, numeric, text) to authenticated;
grant execute on function public.get_my_today_attendance() to authenticated;
grant execute on function public.get_my_attendance_history(date, date) to authenticated;
grant execute on function public.get_attendance_list(uuid, uuid, date, date, text) to authenticated;
grant execute on function public.list_branch_employees(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
