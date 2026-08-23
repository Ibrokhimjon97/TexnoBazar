begin;

-- Add avatar_url to list_employees return set
drop function if exists public.list_employees();

create or replace function public.list_employees()
returns table(employee_id uuid, email extensions.citext, full_name text, phone text,
  avatar_url text, is_active boolean, roles jsonb, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_role(array['superadmin']::public.app_role[], null) then
    raise exception 'Global superadmin roli talab qilinadi' using errcode = '42501';
  end if;
  return query select p.id, p.email, p.full_name, p.phone, p.avatar_url, p.is_active,
    coalesce((select jsonb_agg(jsonb_build_object('role', r.role, 'branch_id', r.branch_id,
      'branch_name', b.name, 'branch_code', b.code) order by r.role::text, b.name nulls first)
      from public.profile_roles r left join public.branches b on b.id = r.branch_id
      where r.profile_id = p.id), '[]'::jsonb), p.created_at
    from public.profiles p
    where exists (select 1 from public.profile_roles r where r.profile_id = p.id and r.role <> 'customer')
    order by p.created_at desc;
end;
$$;

revoke all on function public.list_employees() from public, anon;
grant execute on function public.list_employees() to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
