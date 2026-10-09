-- Migration: 20260946000000_require_gps_attendance.sql
-- Strictly require GPS coordinates (latitude and longitude) for employee attendance clock_in and clock_out.

begin;

-- 1. Update clock_in function to strictly reject NULL GPS coordinates
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

  -- Require GPS coordinates
  if p_lat is null or p_lng is null then
    raise exception 'GPS lokatsiyasi majburiy! Davomatni qayd etish uchun GPS yoqilgan bo‘lishi va aniqlanishi shart.' using errcode = '22023';
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

-- 2. Update clock_out function to strictly reject NULL GPS coordinates
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

  -- Require GPS coordinates
  if p_lat is null or p_lng is null then
    raise exception 'GPS lokatsiyasi majburiy! Ishni yakunlash uchun GPS yoqilgan bo‘lishi va aniqlanishi shart.' using errcode = '22023';
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
        'time', v_time_str,
        'worked_minutes', v_worked_minutes
      ),
      now()
    );
  end loop;

  return v_record;
end;
$$;

grant execute on function public.clock_in to authenticated;
grant execute on function public.clock_out to authenticated;

commit;
