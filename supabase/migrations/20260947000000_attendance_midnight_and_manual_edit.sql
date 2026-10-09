-- Migration: 20260947000000_attendance_midnight_and_manual_edit.sql
-- 1. Support 'missed_checkout' status.
-- 2. Automatically close expired shifts at midnight (00:00 Tashkent time).
-- 3. Provide RPC for Admin / Manager to manually enter / edit check-in and check-out times.

begin;

-- 1. Update check constraint on status
alter table public.employee_attendance drop constraint if exists employee_attendance_status_check;
alter table public.employee_attendance add constraint employee_attendance_status_check
  check (status in ('checked_in', 'completed', 'missed_checkout'));

-- 2. Helper: Close any expired shifts from previous days
create or replace function public.close_expired_attendance_shifts()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date;
begin
  v_today := (now() at time zone 'Asia/Tashkent')::date;

  update public.employee_attendance
  set
    status = 'missed_checkout',
    worked_minutes = coalesce(worked_minutes, 0),
    notes = case
      when notes is null or notes = '' then 'Ketish qayd etilmagan (00:00 da smena yopildi)'
      when notes like '%00:00 da smena yopildi%' then notes
      else notes || ' [Ketish qayd etilmagan (00:00 da smena yopildi)]'
    end,
    updated_at = now()
  where check_out_at is null
    and work_date < v_today
    and status = 'checked_in';
end;
$$;

-- 3. Update get_my_today_attendance to auto-close previous unclosed shifts
create or replace function public.get_my_today_attendance()
returns jsonb
language plpgsql
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

  -- Auto-close past days
  perform public.close_expired_attendance_shifts();

  v_today := (now() at time zone 'Asia/Tashkent')::date;

  select to_jsonb(a.*) into v_res
  from public.employee_attendance a
  where a.employee_id = v_user_id and a.work_date = v_today;

  return v_res;
end;
$$;

-- 4. Update clock_in
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

  -- Auto-close any unclosed shifts from previous days
  perform public.close_expired_attendance_shifts();

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

-- 5. Update clock_out
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

  -- Auto-close past days
  perform public.close_expired_attendance_shifts();

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
    raise exception 'Bugun ishga kelish qayd etilmagan! Kechagi smena 00:00 da yakunlangan, uni faqat menejer yoki admin to‘g‘rilashi mumkin.' using errcode = 'P0002';
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

-- 6. Update get_attendance_list to handle missed_checkout properly
create or replace function public.get_attendance_list(
  p_branch_id uuid default null,
  p_employee_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_search text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_admin boolean;
  v_is_manager boolean;
  v_caller_id uuid;
  v_from date;
  v_to date;
  v_today date;
  v_items jsonb;
  v_summary jsonb;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501'; end if;

  -- Auto-close past days
  perform public.close_expired_attendance_shifts();

  v_is_admin := public.has_role(array['superadmin', 'admin']::public.app_role[], null);
  v_is_manager := public.has_role(array['manager']::public.app_role[], p_branch_id);

  if not (v_is_admin or v_is_manager) then
    raise exception 'Ushbu bo‘limni ko‘rish uchun menejer yoki admin roli talab qilinadi' using errcode = '42501';
  end if;

  v_today := (now() at time zone 'Asia/Tashkent')::date;
  v_from := coalesce(p_from, v_today);
  v_to := coalesce(p_to, v_today);

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
        when a.work_date < v_today then coalesce(a.worked_minutes, 0)
        else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer
      end as worked_minutes,
      case
        when a.check_out_at is null and a.work_date < v_today then 'missed_checkout'
        else a.status
      end as status,
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
        or p.full_name ilike '%' || p_search || '%'
        or p.email ilike '%' || p_search || '%'
        or p.phone ilike '%' || p_search || '%'
      )
  ) t;

  select jsonb_build_object(
    'total_records', count(*),
    'unique_employees', count(distinct a.employee_id),
    'currently_working', count(distinct case when a.status = 'checked_in' and a.work_date = v_today then a.employee_id end),
    'completed_shifts', count(distinct case when a.status = 'completed' then a.id end),
    'missed_shifts', count(distinct case when a.status = 'missed_checkout' or (a.check_out_at is null and a.work_date < v_today) then a.id end),
    'total_worked_minutes', coalesce(sum(case when a.check_out_at is not null then coalesce(a.worked_minutes, round(extract(epoch from (a.check_out_at - a.check_in_at)) / 60)::integer) else 0 end), 0)
  ) into v_summary
  from public.employee_attendance a
  join public.profiles p on p.id = a.employee_id
  where a.work_date between v_from and v_to
    and (p_branch_id is null or a.branch_id = p_branch_id)
    and (p_employee_id is null or a.employee_id = p_employee_id)
    and (
      p_search is null
      or p.full_name ilike '%' || p_search || '%'
      or p.email ilike '%' || p_search || '%'
      or p.phone ilike '%' || p_search || '%'
    );

  return jsonb_build_object(
    'items', v_items,
    'summary', v_summary,
    'from', v_from,
    'to', v_to
  );
end;
$$;

-- 7. Update get_my_attendance_history
create or replace function public.get_my_attendance_history(
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_from date;
  v_to date;
  v_today date;
  v_items jsonb;
  v_summary jsonb;
begin
  v_user_id := auth.uid();
  if v_user_id is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501'; end if;

  -- Auto-close past days
  perform public.close_expired_attendance_shifts();

  v_today := (now() at time zone 'Asia/Tashkent')::date;
  v_from := coalesce(p_from, v_today - interval '30 days');
  v_to := coalesce(p_to, v_today);

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
        when a.work_date < v_today then coalesce(a.worked_minutes, 0)
        else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer
      end as worked_minutes,
      case
        when a.check_out_at is null and a.work_date < v_today then 'missed_checkout'
        else a.status
      end as status,
      a.notes,
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
    'missed_days', count(distinct case when a.status = 'missed_checkout' or (a.check_out_at is null and a.work_date < v_today) then a.work_date end),
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

-- 8. RPC: admin_manual_set_attendance (Admin or Manager manually entering departure or arrival time)
create or replace function public.admin_manual_set_attendance(
  p_attendance_id uuid,
  p_check_in_time text default null,
  p_check_out_time text default null,
  p_notes text default null
)
returns public.employee_attendance
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid;
  v_caller_name text;
  v_record public.employee_attendance;
  v_check_in timestamptz;
  v_check_out timestamptz;
  v_worked_minutes integer;
  v_is_admin boolean;
  v_is_manager boolean;
  v_note_text text;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501'; end if;

  select * into v_record
  from public.employee_attendance
  where id = p_attendance_id
  for update;

  if not found then
    raise exception 'Davomat yozuvi topilmadi!' using errcode = 'P0002';
  end if;

  v_is_admin := public.has_role(array['superadmin', 'admin']::public.app_role[], null);
  v_is_manager := (v_record.branch_id is not null and public.has_role(array['manager']::public.app_role[], v_record.branch_id));

  if not (v_is_admin or v_is_manager) then
    raise exception 'Ushbu amalni bajarish uchun ruxsat yo‘q!' using errcode = '42501';
  end if;

  select coalesce(p.full_name, p.email, 'Admin/Menejer')
  into v_caller_name
  from public.profiles p
  where p.id = v_caller_id;

  v_check_in := v_record.check_in_at;
  v_check_out := v_record.check_out_at;

  -- If check-in time string provided (format: 'HH24:MI' or 'HH24:MI:SS')
  if p_check_in_time is not null and trim(p_check_in_time) <> '' then
    v_check_in := (v_record.work_date::text || ' ' || trim(p_check_in_time))::timestamp at time zone 'Asia/Tashkent';
  end if;

  -- If check-out time string provided (format: 'HH24:MI' or 'HH24:MI:SS')
  if p_check_out_time is not null and trim(p_check_out_time) <> '' then
    v_check_out := (v_record.work_date::text || ' ' || trim(p_check_out_time))::timestamp at time zone 'Asia/Tashkent';
  end if;

  if v_check_out is not null and v_check_out < v_check_in then
    raise exception 'Ketish vaqti kelish vaqtidan oldin bo‘lishi mumkin emas!' using errcode = '22023';
  end if;

  if v_check_out is not null then
    v_worked_minutes := greatest(0, round(extract(epoch from (v_check_out - v_check_in)) / 60)::integer);
  else
    v_worked_minutes := null;
  end if;

  v_note_text := coalesce(v_record.notes, '');
  if p_notes is not null and trim(p_notes) <> '' then
    if v_note_text <> '' then v_note_text := v_note_text || ' | '; end if;
    v_note_text := v_note_text || trim(p_notes);
  end if;
  if v_note_text <> '' then v_note_text := v_note_text || ' '; end if;
  v_note_text := v_note_text || '[' || v_caller_name || ' tomonidan qo‘lda kiritildi: ' || to_char(now() at time zone 'Asia/Tashkent', 'DD.MM.YYYY HH24:MI') || ']';

  update public.employee_attendance
  set
    check_in_at = v_check_in,
    check_out_at = v_check_out,
    worked_minutes = v_worked_minutes,
    status = case when v_check_out is not null then 'completed' else v_record.status end,
    notes = v_note_text,
    updated_at = now()
  where id = v_record.id
  returning * into v_record;

  return v_record;
end;
$$;

grant execute on function public.close_expired_attendance_shifts to authenticated;
grant execute on function public.admin_manual_set_attendance to authenticated;

commit;
