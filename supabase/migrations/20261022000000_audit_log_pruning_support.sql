-- Migration: 20261022000000_audit_log_pruning_support.sql
-- Enables safe, authorized pruning and statistics for public.audit_log
begin;

create or replace function public.guard_audit_log_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_setting('texnobazar.audit_cleanup', true) = 'allowed' then
    return old;
  end if;
  raise exception 'audit_log is immutable' using errcode = '55000';
end; $$;

drop trigger if exists audit_log_immutable on public.audit_log;
create trigger audit_log_immutable before update or delete on public.audit_log
for each row execute function public.guard_audit_log_mutation();

create or replace function public.prune_old_audit_logs(p_days integer default 14)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_deleted_count bigint;
  v_remaining_count bigint;
  v_cutoff timestamptz;
begin
  if not public.has_role(array['superadmin']::public.app_role[], null) then
    raise exception 'Eski audit yozuvlarini tozalash faqat superadmin uchun ruxsat etilgan' using errcode = '42501';
  end if;

  if p_days < 3 then
    raise exception 'Kamida 3 kunlik audit yozuvlari saqlanishi kerak' using errcode = '22023';
  end if;

  v_cutoff := now() - (p_days || ' days')::interval;

  perform set_config('texnobazar.audit_cleanup', 'allowed', true);

  delete from public.audit_log where created_at < v_cutoff;
  get diagnostics v_deleted_count = row_count;

  select count(*) into v_remaining_count from public.audit_log;

  return jsonb_build_object(
    'success', true,
    'deleted_count', v_deleted_count,
    'remaining_count', v_remaining_count,
    'cutoff', v_cutoff
  );
end; $$;

create or replace function public.get_audit_stats()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_total_rows bigint;
  v_older_7d bigint;
  v_older_14d bigint;
  v_older_30d bigint;
  v_audit_size text;
  v_db_size text;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[], null) then
    raise exception 'Ruxsat berilmagan' using errcode = '42501';
  end if;

  select count(*) into v_total_rows from public.audit_log;
  select count(*) into v_older_7d from public.audit_log where created_at < now() - interval '7 days';
  select count(*) into v_older_14d from public.audit_log where created_at < now() - interval '14 days';
  select count(*) into v_older_30d from public.audit_log where created_at < now() - interval '30 days';

  select pg_size_pretty(pg_total_relation_size('public.audit_log')) into v_audit_size;
  select pg_size_pretty(pg_database_size(current_database())) into v_db_size;

  return jsonb_build_object(
    'total_rows', v_total_rows,
    'older_7d', v_older_7d,
    'older_14d', v_older_14d,
    'older_30d', v_older_30d,
    'audit_size', v_audit_size,
    'db_size', v_db_size
  );
end; $$;

grant execute on function public.prune_old_audit_logs(integer) to authenticated;
grant execute on function public.get_audit_stats() to authenticated;

commit;
