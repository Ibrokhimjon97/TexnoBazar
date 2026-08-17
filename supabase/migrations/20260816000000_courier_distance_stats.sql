begin;

-- Courier route lifecycle boundaries make GPS distance reproducible after a
-- delivery has finished. Existing rows are backfilled conservatively.
alter table public.deliveries
  add column if not exists in_transit_at timestamptz,
  add column if not exists completed_at timestamptz;

update public.deliveries
set in_transit_at=coalesce(in_transit_at,picked_up_at,assigned_at,created_at),
    completed_at=coalesce(completed_at,delivered_at,case when status='failed' then updated_at end)
where status in('in_transit','delivered','failed')
  and (in_transit_at is null or (status in('delivered','failed') and completed_at is null));

create or replace function public.stamp_delivery_route_times()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' then
    if new.status='in_transit' then new.in_transit_at=coalesce(new.in_transit_at,now()); end if;
    if new.status in('delivered','failed') then
      new.in_transit_at=coalesce(new.in_transit_at,new.picked_up_at,new.assigned_at,now());
      new.completed_at=coalesce(new.completed_at,now());
    end if;
    return new;
  end if;

  if new.assigned_at is distinct from old.assigned_at and new.status='assigned' then
    new.in_transit_at=null;
    new.completed_at=null;
  elsif new.status='in_transit' and old.status is distinct from new.status then
    new.in_transit_at=coalesce(new.in_transit_at,now());
    new.completed_at=null;
  elsif new.status in('delivered','failed') and old.status is distinct from new.status then
    new.in_transit_at=coalesce(new.in_transit_at,new.picked_up_at,new.assigned_at,now());
    new.completed_at=coalesce(new.completed_at,now());
  end if;
  return new;
end $$;

drop trigger if exists deliveries_route_times on public.deliveries;
create trigger deliveries_route_times before insert or update of status,assigned_at on public.deliveries
  for each row execute function public.stamp_delivery_route_times();

-- Completed attempts are immutable facts. Reassigning the reusable deliveries
-- row must never erase the previous courier's outcome or route window.
create table if not exists public.delivery_attempts(
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  courier_id uuid not null references public.profiles(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  status public.delivery_status not null check(status in('delivered','failed')),
  assigned_at timestamptz not null,
  in_transit_at timestamptz not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(delivery_id,courier_id,assigned_at)
);
create index if not exists delivery_attempts_courier_time_idx
  on public.delivery_attempts(courier_id,completed_at,branch_id);
create index if not exists delivery_attempts_delivery_window_idx
  on public.delivery_attempts(delivery_id,courier_id,in_transit_at,completed_at);

insert into public.delivery_attempts(delivery_id,order_id,courier_id,branch_id,status,assigned_at,in_transit_at,completed_at)
select d.id,d.order_id,d.courier_id,o.branch_id,d.status,
  coalesce(d.assigned_at,d.created_at),coalesce(d.in_transit_at,d.picked_up_at,d.assigned_at,d.created_at),
  coalesce(d.completed_at,d.delivered_at,d.updated_at)
from public.deliveries d join public.orders o on o.id=d.order_id
where d.courier_id is not null and o.branch_id is not null and d.status in('delivered','failed')
on conflict(delivery_id,courier_id,assigned_at) do nothing;

create or replace function public.capture_delivery_attempt()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_branch uuid;
begin
  if new.status in('delivered','failed') and old.status is distinct from new.status and new.courier_id is not null then
    select o.branch_id into v_branch from public.orders o where o.id=new.order_id;
    if v_branch is null then raise exception 'Yetkazib berish filiali topilmadi' using errcode='23514'; end if;
    insert into public.delivery_attempts(delivery_id,order_id,courier_id,branch_id,status,assigned_at,in_transit_at,completed_at)
    values(new.id,new.order_id,new.courier_id,v_branch,new.status,coalesce(new.assigned_at,new.created_at),
      coalesce(new.in_transit_at,new.picked_up_at,new.assigned_at,new.created_at),coalesce(new.completed_at,new.delivered_at,now()))
    on conflict(delivery_id,courier_id,assigned_at) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists deliveries_capture_attempt on public.deliveries;
create trigger deliveries_capture_attempt after update of status on public.deliveries
  for each row execute function public.capture_delivery_attempt();

create index if not exists courier_tracking_route_order_idx
  on public.courier_tracking(delivery_id,courier_id,recorded_at,id);
create index if not exists courier_tracking_courier_time_idx
  on public.courier_tracking(courier_id,recorded_at,id);

-- Only an active courier assigned to the order's branch may append a point,
-- and only while the delivery is actually on the road.
create or replace function public.insert_courier_tracking(p_delivery_id uuid,p_latitude numeric,p_longitude numeric,p_accuracy_m numeric default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare v_id bigint;
begin
  if not public.current_user_active() or not exists(
    select 1
    from public.deliveries d
    join public.orders o on o.id=d.order_id
    join public.profile_roles r on r.profile_id=auth.uid() and r.role='courier' and r.branch_id=o.branch_id
    where d.id=p_delivery_id and d.courier_id=auth.uid() and d.status='in_transit'
  ) then
    raise exception 'Yo‘ldagi faol yetkazib berish topilmadi' using errcode='42501';
  end if;
  if p_latitude not between -90 and 90 or p_longitude not between -180 and 180
    or (p_accuracy_m is not null and p_accuracy_m not between 0 and 1000) then
    raise exception 'Koordinata yoki GPS aniqligi noto‘g‘ri' using errcode='22023';
  end if;
  insert into public.courier_tracking(delivery_id,courier_id,latitude,longitude,accuracy_m)
  values(p_delivery_id,auth.uid(),p_latitude,p_longitude,p_accuracy_m)
  returning id into v_id;
  return v_id;
end $$;

-- Internal, non-client helper. A segment is accepted only when both GPS
-- points are accurate, close in time, outside their jitter radius and below
-- a realistic road-speed/jump threshold.
create or replace function public.courier_performance_rows(
  p_from date,
  p_to date,
  p_branch_id uuid default null,
  p_courier_id uuid default null
)
returns table(
  courier_id uuid,
  full_name text,
  branch_id uuid,
  branch_name text,
  assigned bigint,
  delivered bigint,
  failed bigint,
  active bigint,
  delivery_rate numeric,
  distance_m numeric,
  accepted_segments bigint,
  rejected_segments bigint
)
language sql stable security definer set search_path='' as $$
with fact_couriers as (
  -- Keep currently active couriers visible even when they have no activity.
  select r.profile_id courier_id,r.branch_id
  from public.profile_roles r
  join public.profiles p on p.id=r.profile_id
  join public.branches b on b.id=r.branch_id
  where r.role='courier' and r.branch_id is not null and p.is_active and b.is_active
  union
  -- Historical facts remain visible after a courier or branch is deactivated.
  select a.courier_id,a.branch_id from public.delivery_attempts a
  where a.assigned_at>=public.business_day_start(p_from) and a.assigned_at<public.business_day_start(p_to+1)
  union
  select d.courier_id,o.branch_id from public.deliveries d join public.orders o on o.id=d.order_id
  where d.courier_id is not null and o.branch_id is not null
    and coalesce(d.assigned_at,d.created_at)>=public.business_day_start(p_from)
    and coalesce(d.assigned_at,d.created_at)<public.business_day_start(p_to+1)
  union
  select ct.courier_id,o.branch_id from public.courier_tracking ct
  join public.deliveries d on d.id=ct.delivery_id join public.orders o on o.id=d.order_id
  where o.branch_id is not null and ct.recorded_at>=public.business_day_start(p_from)
    and ct.recorded_at<public.business_day_start(p_to+1)
),
scoped_couriers as (
  select fc.courier_id,p.full_name,fc.branch_id,b.name branch_name
  from fact_couriers fc
  join public.profiles p on p.id=fc.courier_id
  join public.branches b on b.id=fc.branch_id
  where (p_branch_id is null or fc.branch_id=p_branch_id)
    and (p_courier_id is null or fc.courier_id=p_courier_id)
),
delivery_facts as (
  select a.courier_id,a.branch_id,a.status,a.assigned_at
  from public.delivery_attempts a
  union all
  select d.courier_id,o.branch_id,d.status,coalesce(d.assigned_at,d.created_at)
  from public.deliveries d join public.orders o on o.id=d.order_id
  where d.courier_id is not null and o.branch_id is not null
    and d.status in('assigned','picked_up','in_transit')
),
delivery_stats as (
  select f.courier_id,f.branch_id,
    count(*) assigned,
    count(*) filter(where f.status='delivered') delivered,
    count(*) filter(where f.status='failed') failed,
    count(*) filter(where f.status in('assigned','picked_up','in_transit')) active
  from delivery_facts f
  join scoped_couriers sc on sc.courier_id=f.courier_id and sc.branch_id=f.branch_id
  where f.assigned_at>=public.business_day_start(p_from)
    and f.assigned_at<public.business_day_start(p_to+1)
  group by f.courier_id,f.branch_id
),
route_windows as (
  select 'attempt:'||a.id::text route_key,a.delivery_id,a.courier_id,a.branch_id,a.in_transit_at route_start,a.completed_at route_end
  from public.delivery_attempts a
  union all
  select 'current:'||d.id::text||':'||extract(epoch from coalesce(d.assigned_at,d.created_at))::text,
    d.id,d.courier_id,o.branch_id,d.in_transit_at,'infinity'::timestamptz
  from public.deliveries d join public.orders o on o.id=d.order_id
  where d.courier_id is not null and o.branch_id is not null and d.status='in_transit' and d.in_transit_at is not null
),
route_points as (
  select rw.route_key,ct.id,ct.delivery_id,ct.courier_id,rw.branch_id,ct.latitude,ct.longitude,ct.accuracy_m,ct.recorded_at
  from public.courier_tracking ct
  join route_windows rw on rw.delivery_id=ct.delivery_id and rw.courier_id=ct.courier_id
    and ct.recorded_at>=rw.route_start and ct.recorded_at<=rw.route_end
  join scoped_couriers sc on sc.courier_id=ct.courier_id and sc.branch_id=rw.branch_id
  where ct.recorded_at>=public.business_day_start(p_from)
    and ct.recorded_at<public.business_day_start(p_to+1)
),
ordered_points as (
  select rp.*,
    lag(rp.id) over(partition by rp.route_key order by rp.recorded_at,rp.id) prev_id,
    lag(rp.latitude) over(partition by rp.route_key order by rp.recorded_at,rp.id) prev_latitude,
    lag(rp.longitude) over(partition by rp.route_key order by rp.recorded_at,rp.id) prev_longitude,
    lag(rp.accuracy_m) over(partition by rp.route_key order by rp.recorded_at,rp.id) prev_accuracy_m,
    lag(rp.recorded_at) over(partition by rp.route_key order by rp.recorded_at,rp.id) prev_recorded_at
  from route_points rp
),
segments as (
  select op.*,
    extract(epoch from op.recorded_at-op.prev_recorded_at) elapsed_seconds,
    case when op.prev_id is null then null else
      2.0*6371000.0*asin(sqrt(least(1.0,
        power(sin(radians((op.latitude-op.prev_latitude)::double precision)/2.0),2)
        +cos(radians(op.prev_latitude::double precision))*cos(radians(op.latitude::double precision))
        *power(sin(radians((op.longitude-op.prev_longitude)::double precision)/2.0),2)
      )))
    end distance_m
  from ordered_points op
),
evaluated_segments as (
  select s.*,
    (s.prev_id is not null
      and s.accuracy_m is not null and s.prev_accuracy_m is not null
      and s.accuracy_m<=100 and s.prev_accuracy_m<=100
      and s.elapsed_seconds>0 and s.elapsed_seconds<=300
      and s.distance_m>greatest(s.accuracy_m,s.prev_accuracy_m)::double precision
      and s.distance_m<=5000
      and s.distance_m/s.elapsed_seconds<=45) accepted
  from segments s
),
distance_stats as (
  select es.courier_id,es.branch_id,
    coalesce(sum(es.distance_m) filter(where es.accepted),0) distance_m,
    count(*) filter(where es.prev_id is not null and es.accepted) accepted_segments,
    count(*) filter(where es.prev_id is not null and not es.accepted) rejected_segments
  from evaluated_segments es
  group by es.courier_id,es.branch_id
)
select sc.courier_id,sc.full_name,sc.branch_id,sc.branch_name,
  coalesce(ds.assigned,0)::bigint,
  coalesce(ds.delivered,0)::bigint,
  coalesce(ds.failed,0)::bigint,
  coalesce(ds.active,0)::bigint,
  case when coalesce(ds.delivered,0)+coalesce(ds.failed,0)=0 then 0
    else round(100.0*ds.delivered/(ds.delivered+ds.failed),2) end,
  round(coalesce(gps.distance_m,0)::numeric,2),
  coalesce(gps.accepted_segments,0)::bigint,
  coalesce(gps.rejected_segments,0)::bigint
from scoped_couriers sc
left join delivery_stats ds on ds.courier_id=sc.courier_id and ds.branch_id=sc.branch_id
left join distance_stats gps on gps.courier_id=sc.courier_id and gps.branch_id=sc.branch_id
order by sc.branch_name,sc.full_name,sc.courier_id;
$$;

-- Courier self-service keeps the existing JSON contract and adds distance.
create or replace function public.get_courier_stats(
  p_from date default (now() at time zone 'Asia/Tashkent')::date,
  p_to date default (now() at time zone 'Asia/Tashkent')::date
)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if auth.uid() is null or not public.current_user_active()
    or not exists(select 1 from public.profile_roles where profile_id=auth.uid() and role='courier') then
    raise exception 'Faol kuryer roli talab qilinadi' using errcode='42501';
  end if;
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>366 then
    raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023';
  end if;
  select jsonb_build_object(
    'assigned',x.assigned,'delivered',x.delivered,'failed',x.failed,'active',x.active,
    'delivery_rate',case when x.delivered+x.failed=0 then 0 else round(100.0*x.delivered/(x.delivered+x.failed),2) end,
    'distance_m',x.distance_m,'accepted_segments',x.accepted_segments,'rejected_segments',x.rejected_segments
  ) into v_result
  from (
    select coalesce(sum(r.assigned),0) assigned,coalesce(sum(r.delivered),0) delivered,
      coalesce(sum(r.failed),0) failed,coalesce(sum(r.active),0) active,
      round(coalesce(sum(r.distance_m),0),2) distance_m,
      coalesce(sum(r.accepted_segments),0) accepted_segments,
      coalesce(sum(r.rejected_segments),0) rejected_segments
    from public.courier_performance_rows(p_from,p_to,null,auth.uid()) r
  ) x;
  return v_result;
end $$;

-- Managers see only their branch; global administrators may aggregate all
-- branches or select one branch/courier.
create or replace function public.list_courier_performance(
  p_from date,
  p_to date,
  p_branch_id uuid default null,
  p_courier_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if auth.uid() is null or not public.current_user_active() then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode='42501';
  end if;
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>366 then
    raise exception 'Sana oralig‘i noto‘g‘ri' using errcode='22023';
  end if;
  if p_branch_id is null then
    if not public.has_role(array['superadmin','admin']::public.app_role[],null) then
      raise exception 'Global kuryer hisoboti uchun admin roli talab qilinadi' using errcode='42501';
    end if;
  elsif not(public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager']::public.app_role[],p_branch_id)) then
    raise exception 'Filial kuryer hisoboti uchun menejer roli talab qilinadi' using errcode='42501';
  end if;

  select jsonb_build_object(
    'summary',jsonb_build_object(
      'assigned',coalesce(sum(r.assigned),0),'delivered',coalesce(sum(r.delivered),0),
      'failed',coalesce(sum(r.failed),0),'active',coalesce(sum(r.active),0),
      'delivery_rate',case when coalesce(sum(r.delivered+r.failed),0)=0 then 0
        else round(100.0*sum(r.delivered)/sum(r.delivered+r.failed),2) end,
      'distance_m',round(coalesce(sum(r.distance_m),0),2),
      'accepted_segments',coalesce(sum(r.accepted_segments),0),
      'rejected_segments',coalesce(sum(r.rejected_segments),0)
    ),
    'couriers',coalesce(jsonb_agg(to_jsonb(r) order by r.branch_name,r.full_name,r.courier_id),'[]'::jsonb)
  ) into v_result
  from public.courier_performance_rows(p_from,p_to,p_branch_id,p_courier_id) r;
  return v_result;
end $$;

alter table public.delivery_attempts enable row level security;
drop policy if exists courier_tracking_insert_own on public.courier_tracking;
revoke insert,update,delete on public.courier_tracking from authenticated;
revoke all on public.delivery_attempts from public,anon,authenticated;
grant all on public.delivery_attempts to service_role;

revoke all on function public.stamp_delivery_route_times() from public,anon,authenticated;
revoke all on function public.capture_delivery_attempt() from public,anon,authenticated;
revoke all on function public.courier_performance_rows(date,date,uuid,uuid) from public,anon,authenticated;
revoke all on function public.get_courier_stats(date,date) from public,anon,authenticated;
revoke all on function public.list_courier_performance(date,date,uuid,uuid) from public,anon,authenticated;
revoke all on function public.insert_courier_tracking(uuid,numeric,numeric,numeric) from public,anon,authenticated;

grant execute on function public.get_courier_stats(date,date),
  public.list_courier_performance(date,date,uuid,uuid),
  public.insert_courier_tracking(uuid,numeric,numeric,numeric) to authenticated;
grant execute on function public.stamp_delivery_route_times(),public.capture_delivery_attempt(),
  public.courier_performance_rows(date,date,uuid,uuid) to service_role;
grant execute on function public.get_courier_stats(date,date),
  public.list_courier_performance(date,date,uuid,uuid),
  public.insert_courier_tracking(uuid,numeric,numeric,numeric) to service_role;

commit;
