begin;

-- Product media is managed by global catalog administrators and active branch managers.
create or replace function public.require_catalog_actor(p_actor_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.profiles p
    join public.profile_roles r on r.profile_id = p.id
    left join public.branches b on b.id = r.branch_id
    where p.id = p_actor_id
      and p.is_active
      and (
        (r.role in ('superadmin','admin') and r.branch_id is null)
        or (r.role = 'manager' and r.branch_id is not null and b.is_active)
      )
  ) then
    raise exception 'Faol katalog administratori yoki filial menejeri roli talab qilinadi'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.require_catalog_actor(uuid) from public, anon, authenticated;
grant execute on function public.require_catalog_actor(uuid) to service_role;

commit;
