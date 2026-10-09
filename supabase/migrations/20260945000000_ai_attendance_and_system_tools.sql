-- Migration: 20260945000000_ai_attendance_and_system_tools.sql
-- Enables AI Assistant to monitor and report on employee attendance,
-- today's presence/absence, worked hours, GPS locations, online orders,
-- debts, and customer CRM.

begin;

-- ============================================================================
-- 1. AI Tool: Today Attendance Status (Bugungi davomat holati)
-- Answers: "Bugun kimlar ishga keldi?", "Kimlar kelmadi?", "Hozir kimlar ishda?"
-- ============================================================================
create or replace function public.ai_today_attendance(
  p_branch_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid;
  v_is_admin boolean;
  v_manager_branch uuid;
  v_target_branch uuid;
  v_today date;
  v_arrived jsonb;
  v_not_arrived jsonb;
  v_summary jsonb;
begin
  perform public.require_ai_user();
  v_caller_id := auth.uid();
  v_is_admin := public.has_role(array['superadmin', 'admin']::public.app_role[], null);

  if not v_is_admin then
    select r.branch_id into v_manager_branch
    from public.profile_roles r
    where r.profile_id = v_caller_id and r.role in ('manager', 'accountant')
    limit 1;
    v_target_branch := coalesce(p_branch_id, v_manager_branch);
  else
    v_target_branch := p_branch_id;
  end if;

  v_today := (now() at time zone 'Asia/Tashkent')::date;

  -- 1. Arrived employees today
  select coalesce(jsonb_agg(to_jsonb(t.*) order by t.check_in_at asc), '[]'::jsonb)
  into v_arrived
  from (
    select
      a.id as attendance_id,
      a.employee_id,
      p.full_name as employee_name,
      p.phone as employee_phone,
      p.email as employee_email,
      coalesce((
        select r.role::text from public.profile_roles r
        where r.profile_id = p.id and r.role <> 'customer'
        order by case when r.role = 'seller' then 1 when r.role = 'manager' then 2 else 3 end
        limit 1
      ), 'xodim') as role,
      b.name as branch_name,
      to_char(a.check_in_at at time zone 'Asia/Tashkent', 'HH24:MI') as check_in_time,
      case
        when a.check_out_at is not null
        then to_char(a.check_out_at at time zone 'Asia/Tashkent', 'HH24:MI')
        else null
      end as check_out_time,
      case
        when a.status = 'completed' then 'Ishni yakunlagan'
        else 'Hozir ishda (smenada)'
      end as status_label,
      a.status,
      case
        when a.check_out_at is not null then
          case
            when coalesce(a.worked_minutes, 0) < 60 then coalesce(a.worked_minutes, 0) || ' daqiqa'
            when coalesce(a.worked_minutes, 0) % 60 = 0 then (coalesce(a.worked_minutes, 0) / 60) || ' soat'
            else (coalesce(a.worked_minutes, 0) / 60) || ' soat ' || (coalesce(a.worked_minutes, 0) % 60) || ' daqiqa'
          end
        else
          round(extract(epoch from (now() - a.check_in_at)) / 60)::integer || ' daqiqa (davom etmoqda)'
      end as worked_time_text,
      a.check_in_address,
      case
        when a.check_in_lat is not null and a.check_in_lng is not null
        then 'https://www.google.com/maps?q=' || a.check_in_lat || ',' || a.check_in_lng
        else null
      end as check_in_maps_url,
      a.check_out_address,
      case
        when a.check_out_lat is not null and a.check_out_lng is not null
        then 'https://www.google.com/maps?q=' || a.check_out_lat || ',' || a.check_out_lng
        else null
      end as check_out_maps_url,
      a.check_in_at
    from public.employee_attendance a
    join public.profiles p on p.id = a.employee_id
    left join public.branches b on b.id = a.branch_id
    where a.work_date = v_today
      and (v_target_branch is null or a.branch_id = v_target_branch)
  ) t;

  -- 2. Staff who have NOT clocked in today yet
  select coalesce(jsonb_agg(to_jsonb(t.*) order by t.full_name asc), '[]'::jsonb)
  into v_not_arrived
  from (
    select distinct
      p.id as employee_id,
      p.full_name,
      p.phone,
      p.email,
      coalesce(r.role::text, 'xodim') as role,
      b.name as branch_name,
      'Kutilmoqda / Ishga kelmagan' as status_label
    from public.profiles p
    join public.profile_roles r on r.profile_id = p.id
    left join public.branches b on b.id = r.branch_id
    where p.is_active
      and r.role in ('seller', 'courier', 'manager', 'warehouse', 'accountant')
      and (v_target_branch is null or r.branch_id = v_target_branch)
      and not exists (
        select 1 from public.employee_attendance a
        where a.employee_id = p.id and a.work_date = v_today
      )
  ) t;

  -- 3. Summary metrics
  v_summary := jsonb_build_object(
    'date', v_today,
    'total_staff', jsonb_array_length(v_arrived) + jsonb_array_length(v_not_arrived),
    'arrived_count', jsonb_array_length(v_arrived),
    'not_arrived_count', jsonb_array_length(v_not_arrived),
    'currently_working_count', (select count(*) from jsonb_array_elements(v_arrived) elem where elem->>'status' = 'checked_in'),
    'completed_count', (select count(*) from jsonb_array_elements(v_arrived) elem where elem->>'status' = 'completed')
  );

  return jsonb_build_object(
    'summary', v_summary,
    'arrived_employees', v_arrived,
    'not_arrived_employees', v_not_arrived
  );
end;
$$;

-- ============================================================================
-- 2. AI Tool: Attendance Summary over Date Range (Davomat hisoboti)
-- Answers: "Shu haftada/oyda xodimlar qancha ishladi?", "Davomat hisobotini ko'rsat"
-- ============================================================================
create or replace function public.ai_attendance_summary(
  p_from date default null,
  p_to date default null,
  p_branch_id uuid default null,
  p_employee_query text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid;
  v_is_admin boolean;
  v_manager_branch uuid;
  v_target_branch uuid;
  v_from date;
  v_to date;
  v_q text := nullif(btrim(p_employee_query), '');
  v_by_employee jsonb;
  v_recent_records jsonb;
  v_total_records integer;
  v_unique_employees integer;
  v_total_minutes integer;
  v_hours_str text;
begin
  perform public.require_ai_user();
  v_caller_id := auth.uid();
  v_is_admin := public.has_role(array['superadmin', 'admin']::public.app_role[], null);

  if not v_is_admin then
    select r.branch_id into v_manager_branch
    from public.profile_roles r
    where r.profile_id = v_caller_id and r.role in ('manager', 'accountant')
    limit 1;
    v_target_branch := coalesce(p_branch_id, v_manager_branch);
  else
    v_target_branch := p_branch_id;
  end if;

  v_to := coalesce(p_to, (now() at time zone 'Asia/Tashkent')::date);
  v_from := coalesce(p_from, date_trunc('month', v_to)::date);

  -- 1. Aggregation per employee
  select coalesce(jsonb_agg(to_jsonb(t.*) order by t.total_minutes desc, t.employee_name asc), '[]'::jsonb)
  into v_by_employee
  from (
    select
      p.id as employee_id,
      p.full_name as employee_name,
      p.phone as employee_phone,
      b.name as branch_name,
      count(distinct a.work_date) as days_attended,
      count(*) filter (where a.status = 'completed') as completed_shifts,
      coalesce(sum(
        case
          when a.check_out_at is not null then coalesce(a.worked_minutes, round(extract(epoch from (a.check_out_at - a.check_in_at)) / 60)::integer)
          else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer
        end
      ), 0)::integer as total_minutes,
      case
        when coalesce(sum(
          case
            when a.check_out_at is not null then coalesce(a.worked_minutes, round(extract(epoch from (a.check_out_at - a.check_in_at)) / 60)::integer)
            else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer
          end
        ), 0)::integer < 60 then coalesce(sum(
          case
            when a.check_out_at is not null then coalesce(a.worked_minutes, round(extract(epoch from (a.check_out_at - a.check_in_at)) / 60)::integer)
            else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer
          end
        ), 0)::integer || ' daqiqa'
        else (coalesce(sum(
          case
            when a.check_out_at is not null then coalesce(a.worked_minutes, round(extract(epoch from (a.check_out_at - a.check_in_at)) / 60)::integer)
            else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer
          end
        ), 0)::integer / 60) || ' soat ' || (coalesce(sum(
          case
            when a.check_out_at is not null then coalesce(a.worked_minutes, round(extract(epoch from (a.check_out_at - a.check_in_at)) / 60)::integer)
            else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer
          end
        ), 0)::integer % 60) || ' daqiqa'
      end as total_worked_hours_str
    from public.employee_attendance a
    join public.profiles p on p.id = a.employee_id
    left join public.branches b on b.id = a.branch_id
    where a.work_date between v_from and v_to
      and (v_target_branch is null or a.branch_id = v_target_branch)
      and (v_q is null or p.full_name ilike '%' || v_q || '%' or coalesce(p.phone, '') ilike '%' || v_q || '%')
    group by p.id, p.full_name, p.phone, b.name
  ) t;

  -- 2. Recent individual records (up to 40)
  select coalesce(jsonb_agg(to_jsonb(r.*) order by r.work_date desc, r.check_in_at desc), '[]'::jsonb)
  into v_recent_records
  from (
    select
      a.id,
      a.work_date,
      case extract(isodow from a.work_date)::integer
        when 1 then 'Dushanba'
        when 2 then 'Seshanba'
        when 3 then 'Chorshanba'
        when 4 then 'Payshanba'
        when 5 then 'Juma'
        when 6 then 'Shanba'
        when 7 then 'Yakshanba'
      end as weekday_uz,
      p.full_name as employee_name,
      b.name as branch_name,
      to_char(a.check_in_at at time zone 'Asia/Tashkent', 'HH24:MI') as check_in_time,
      case
        when a.check_out_at is not null
        then to_char(a.check_out_at at time zone 'Asia/Tashkent', 'HH24:MI')
        else null
      end as check_out_time,
      case
        when a.status = 'completed' then 'Yakunlangan'
        else 'Hozir ishda'
      end as status_label,
      case
        when a.check_out_at is not null then
          case
            when coalesce(a.worked_minutes, 0) < 60 then coalesce(a.worked_minutes, 0) || ' daqiqa'
            else (coalesce(a.worked_minutes, 0) / 60) || ' soat ' || (coalesce(a.worked_minutes, 0) % 60) || ' daqiqa'
          end
        else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer || ' daqiqa (ishda)'
      end as duration_str,
      a.check_in_at
    from public.employee_attendance a
    join public.profiles p on p.id = a.employee_id
    left join public.branches b on b.id = a.branch_id
    where a.work_date between v_from and v_to
      and (v_target_branch is null or a.branch_id = v_target_branch)
      and (v_q is null or p.full_name ilike '%' || v_q || '%' or coalesce(p.phone, '') ilike '%' || v_q || '%')
    limit 40
  ) r;

  -- 3. Overall numbers
  select
    count(*),
    count(distinct a.employee_id),
    coalesce(sum(
      case
        when a.check_out_at is not null then coalesce(a.worked_minutes, round(extract(epoch from (a.check_out_at - a.check_in_at)) / 60)::integer)
        else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer
      end
    ), 0)::integer
  into v_total_records, v_unique_employees, v_total_minutes
  from public.employee_attendance a
  join public.profiles p on p.id = a.employee_id
  where a.work_date between v_from and v_to
    and (v_target_branch is null or a.branch_id = v_target_branch)
    and (v_q is null or p.full_name ilike '%' || v_q || '%' or coalesce(p.phone, '') ilike '%' || v_q || '%');

  if v_total_minutes < 60 then
    v_hours_str := v_total_minutes || ' daqiqa';
  else
    v_hours_str := (v_total_minutes / 60) || ' soat ' || (v_total_minutes % 60) || ' daqiqa';
  end if;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'summary', jsonb_build_object(
      'total_records', v_total_records,
      'unique_employees', v_unique_employees,
      'total_minutes', v_total_minutes,
      'total_worked_hours_str', v_hours_str
    ),
    'by_employee', v_by_employee,
    'recent_records', v_recent_records
  );
end;
$$;

-- ============================================================================
-- 3. AI Tool: Specific Employee Attendance Detail (Xodimning batafsil davomati)
-- Answers: "Alining shu oydagi davomatini ko'rsat", "Falondachi qachon kelgan va necha soat ishlagan?"
-- ============================================================================
create or replace function public.ai_employee_attendance_detail(
  p_employee_query text,
  p_from date default null,
  p_to date default null,
  p_period_month text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := nullif(btrim(p_employee_query), '');
  v_emp record;
  v_from date;
  v_to date;
  v_days jsonb;
  v_total_days integer;
  v_completed_days integer;
  v_total_minutes integer;
  v_hours_str text;
  v_avg_str text;
  v_is_working boolean;
begin
  perform public.require_ai_user();

  if v_q is null then
    return jsonb_build_object('error', 'Iltimos, xodim ismini yoki telefon raqamini kiriting.');
  end if;

  -- 1. Find employee
  select p.id, p.full_name, p.phone, p.email, b.name as branch_name, r.role
  into v_emp
  from public.profiles p
  left join public.profile_roles r on r.profile_id = p.id and r.role <> 'customer'
  left join public.branches b on b.id = r.branch_id
  where (p.full_name ilike '%' || v_q || '%' or coalesce(p.phone, '') ilike '%' || v_q || '%' or p.id::text = v_q)
  order by case when p.full_name ilike v_q then 1 else 2 end
  limit 1;

  if v_emp.id is null then
    return jsonb_build_object('error', 'Xodim topilmadi: "' || v_q || '". Boshqa ism yoki telefon bilan qidiring.');
  end if;

  -- 2. Resolve date range
  if p_period_month is not null and p_period_month ~ '^\d{4}-\d{2}$' then
    v_from := to_date(p_period_month || '-01', 'YYYY-MM-DD');
    v_to := (v_from + interval '1 month - 1 day')::date;
  else
    v_to := coalesce(p_to, (now() at time zone 'Asia/Tashkent')::date);
    v_from := coalesce(p_from, date_trunc('month', v_to)::date);
  end if;

  -- 3. Day by day records
  select coalesce(jsonb_agg(to_jsonb(t.*) order by t.work_date desc), '[]'::jsonb)
  into v_days
  from (
    select
      a.id,
      a.work_date,
      case extract(isodow from a.work_date)::integer
        when 1 then 'Dushanba'
        when 2 then 'Seshanba'
        when 3 then 'Chorshanba'
        when 4 then 'Payshanba'
        when 5 then 'Juma'
        when 6 then 'Shanba'
        when 7 then 'Yakshanba'
      end as weekday_uz,
      to_char(a.check_in_at at time zone 'Asia/Tashkent', 'HH24:MI') as check_in_time,
      case
        when a.check_out_at is not null
        then to_char(a.check_out_at at time zone 'Asia/Tashkent', 'HH24:MI')
        else '-'
      end as check_out_time,
      case
        when a.status = 'completed' then 'Yakunlangan'
        else 'Hozir ishda'
      end as status_label,
      a.status,
      case
        when a.check_out_at is not null then
          case
            when coalesce(a.worked_minutes, 0) < 60 then coalesce(a.worked_minutes, 0) || ' daqiqa'
            when coalesce(a.worked_minutes, 0) % 60 = 0 then (coalesce(a.worked_minutes, 0) / 60) || ' soat'
            else (coalesce(a.worked_minutes, 0) / 60) || ' soat ' || (coalesce(a.worked_minutes, 0) % 60) || ' daqiqa'
          end
        else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer || ' daqiqa (ishda)'
      end as worked_time_text,
      a.check_in_address,
      case
        when a.check_in_lat is not null and a.check_in_lng is not null
        then 'https://www.google.com/maps?q=' || a.check_in_lat || ',' || a.check_in_lng
        else null
      end as check_in_maps_url,
      a.check_out_address,
      case
        when a.check_out_lat is not null and a.check_out_lng is not null
        then 'https://www.google.com/maps?q=' || a.check_out_lat || ',' || a.check_out_lng
        else null
      end as check_out_maps_url,
      a.notes
    from public.employee_attendance a
    where a.employee_id = v_emp.id
      and a.work_date between v_from and v_to
    order by a.work_date desc
  ) t;

  -- 4. Calculate totals
  select
    count(distinct a.work_date),
    count(*) filter (where a.status = 'completed'),
    coalesce(sum(
      case
        when a.check_out_at is not null then coalesce(a.worked_minutes, round(extract(epoch from (a.check_out_at - a.check_in_at)) / 60)::integer)
        else round(extract(epoch from (now() - a.check_in_at)) / 60)::integer
      end
    ), 0)::integer
  into v_total_days, v_completed_days, v_total_minutes
  from public.employee_attendance a
  where a.employee_id = v_emp.id
    and a.work_date between v_from and v_to;

  if v_total_minutes < 60 then
    v_hours_str := v_total_minutes || ' daqiqa';
  else
    v_hours_str := (v_total_minutes / 60) || ' soat ' || (v_total_minutes % 60) || ' daqiqa';
  end if;

  if v_total_days > 0 then
    v_avg_str := ((v_total_minutes / v_total_days) / 60) || ' soat ' || ((v_total_minutes / v_total_days) % 60) || ' daqiqa';
  else
    v_avg_str := '0 soat';
  end if;

  -- 5. Is currently working right now?
  select exists (
    select 1 from public.employee_attendance
    where employee_id = v_emp.id
      and work_date = (now() at time zone 'Asia/Tashkent')::date
      and status = 'checked_in'
  ) into v_is_working;

  return jsonb_build_object(
    'employee', jsonb_build_object(
      'id', v_emp.id,
      'full_name', v_emp.full_name,
      'phone', v_emp.phone,
      'email', v_emp.email,
      'role', coalesce(v_emp.role::text, 'xodim'),
      'branch_name', v_emp.branch_name,
      'is_currently_working', v_is_working
    ),
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'summary', jsonb_build_object(
      'days_attended', v_total_days,
      'completed_shifts', v_completed_days,
      'total_minutes', v_total_minutes,
      'total_worked_hours_str', v_hours_str,
      'avg_daily_hours_str', v_avg_str
    ),
    'days', v_days
  );
end;
$$;

-- ============================================================================
-- 4. AI Tool: List / Query Online Orders (Mijozlar buyurtmalari)
-- Answers: "Yangi buyurtmalar bormi?", "Yetkazilayotgan buyurtmalar holati"
-- ============================================================================
create or replace function public.ai_list_orders(
  p_status text default null,
  p_from date default null,
  p_to date default null,
  p_branch_id uuid default null,
  p_query text default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := nullif(btrim(p_query), '');
  v_st text := nullif(btrim(p_status), '');
  v_orders jsonb;
  v_summary jsonb;
begin
  perform public.require_ai_user();

  select coalesce(jsonb_agg(to_jsonb(t.*) order by t.placed_at desc nulls last), '[]'::jsonb)
  into v_orders
  from (
    select
      o.id as order_id,
      o.order_no,
      o.status::text as status,
      o.customer_name,
      o.customer_phone,
      o.total,
      o.delivery_fee,
      o.currency,
      o.payment_status::text as payment_status,
      to_char(coalesce(o.placed_at, o.created_at) at time zone 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') as placed_at_str,
      b.name as branch_name,
      o.shipping_address,
      (select count(*) from public.order_lines ol where ol.order_id = o.id) as items_count,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'product_name', ol.product_name,
          'quantity', ol.quantity,
          'unit_price', ol.unit_price,
          'total_price', ol.total_price
        ))
        from public.order_lines ol where ol.order_id = o.id
      ), '[]'::jsonb) as lines
    from public.orders o
    left join public.branches b on b.id = o.branch_id
    where (v_st is null or o.status::text = v_st)
      and (p_branch_id is null or o.branch_id = p_branch_id)
      and (p_from is null or o.placed_at::date >= p_from)
      and (p_to is null or o.placed_at::date <= p_to)
      and (
        v_q is null
        or o.order_no ilike '%' || v_q || '%'
        or coalesce(o.customer_name, '') ilike '%' || v_q || '%'
        or coalesce(o.customer_phone, '') ilike '%' || v_q || '%'
      )
    order by coalesce(o.placed_at, o.created_at) desc
    limit greatest(least(coalesce(p_limit, 20), 50), 1)
  ) t;

  select jsonb_build_object(
    'total_matching', count(*),
    'pending_count', count(*) filter (where status::text = 'pending'),
    'delivering_count', count(*) filter (where status::text in ('delivering', 'in_transit')),
    'delivered_count', count(*) filter (where status::text = 'delivered')
  ) into v_summary
  from public.orders
  where (p_branch_id is null or branch_id = p_branch_id)
    and (p_from is null or placed_at::date >= p_from)
    and (p_to is null or placed_at::date <= p_to);

  return jsonb_build_object(
    'summary', v_summary,
    'orders', v_orders
  );
end;
$$;

-- ============================================================================
-- 5. AI Tool: Search Customers (Mijozlar bazasi)
-- Answers: "Mijozlar haqida ma'lumot", "Falondachi degan mijoz bormi?"
-- ============================================================================
create or replace function public.ai_search_customers(
  p_query text default null,
  p_limit integer default 15
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := nullif(btrim(p_query), '');
  v_customers jsonb;
begin
  perform public.require_ai_user();

  select coalesce(jsonb_agg(to_jsonb(t.*) order by t.full_name asc), '[]'::jsonb)
  into v_customers
  from (
    select
      c.id,
      c.full_name,
      c.phone,
      c.email,
      c.loyalty_points,
      c.is_active,
      (select count(*) from public.orders o where o.customer_id = c.id) as total_orders,
      coalesce((select sum(o.total) from public.orders o where o.customer_id = c.id and o.status::text <> 'cancelled'), 0) as total_spent,
      to_char(c.created_at at time zone 'Asia/Tashkent', 'YYYY-MM-DD') as registered_date
    from public.customers c
    where v_q is null
      or c.full_name ilike '%' || v_q || '%'
      or coalesce(c.phone, '') ilike '%' || v_q || '%'
      or coalesce(c.email, '') ilike '%' || v_q || '%'
    order by c.created_at desc
    limit greatest(least(coalesce(p_limit, 15), 50), 1)
  ) t;

  return v_customers;
end;
$$;

-- ============================================================================
-- 6. AI Tool: Debts Report (Qarzlar va nasiyalar hisoboti)
-- Answers: "Qarzdorliklar qanday?", "Filiallar o'rtasida qanday qarzlar bor?"
-- ============================================================================
create or replace function public.ai_debt_report(
  p_branch_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  v_summary jsonb;
begin
  perform public.require_ai_user();

  select coalesce(jsonb_agg(to_jsonb(t.*) order by t.created_at desc), '[]'::jsonb)
  into v_items
  from (
    select
      d.id as debt_id,
      b1.name as debtor_branch,
      b2.name as creditor_branch,
      d.amount,
      d.paid_amount,
      d.remaining_amount,
      d.status::text as status,
      d.currency,
      to_char(d.created_at at time zone 'Asia/Tashkent', 'YYYY-MM-DD') as created_date,
      to_char(d.due_at at time zone 'Asia/Tashkent', 'YYYY-MM-DD') as due_date,
      d.notes
    from public.branch_debts d
    left join public.branches b1 on b1.id = d.debtor_branch_id
    left join public.branches b2 on b2.id = d.creditor_branch_id
    where (p_branch_id is null or d.debtor_branch_id = p_branch_id or d.creditor_branch_id = p_branch_id)
    order by d.created_at desc
    limit 40
  ) t;

  select jsonb_build_object(
    'total_debts_count', count(*),
    'unpaid_count', count(*) filter (where status::text <> 'paid'),
    'total_remaining_amount', coalesce(sum(remaining_amount), 0)
  ) into v_summary
  from public.branch_debts
  where (p_branch_id is null or debtor_branch_id = p_branch_id or creditor_branch_id = p_branch_id);

  return jsonb_build_object(
    'summary', v_summary,
    'debts', v_items
  );
end;
$$;

-- Permissions
grant execute on function public.ai_today_attendance(uuid) to authenticated;
grant execute on function public.ai_attendance_summary(date, date, uuid, text) to authenticated;
grant execute on function public.ai_employee_attendance_detail(text, date, date, text) to authenticated;
grant execute on function public.ai_list_orders(text, date, date, uuid, text, integer) to authenticated;
grant execute on function public.ai_search_customers(text, integer) to authenticated;
grant execute on function public.ai_debt_report(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
