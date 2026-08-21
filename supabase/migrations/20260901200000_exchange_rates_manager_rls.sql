-- exchange_rates jadvali uchun menejer roli RLS tuzatish.
-- profile_roles ga to'g'ridan-to'g'ri SELECT ruxsati yo'q, shuning uchun
-- SECURITY DEFINER yordamchi funksiya orqali tekshiramiz.
begin;

drop policy if exists exchange_rates_write on public.exchange_rates;
drop policy if exists exchange_rates_admin on public.exchange_rates;

create or replace function public.is_any_manager()
returns boolean language sql stable security definer set search_path='' as $$
  select public.current_user_active() and exists(
    select 1 from public.profile_roles r where r.profile_id = auth.uid() and r.role = 'manager'
  )
$$;

drop policy if exists exchange_rates_write on public.exchange_rates;
create policy exchange_rates_write on public.exchange_rates for all to authenticated
  using (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    or public.is_any_manager()
  )
  with check (
    public.has_role(array['superadmin','admin']::public.app_role[], null)
    or public.is_any_manager()
  );

grant execute on function public.is_any_manager() to authenticated, service_role;

commit;
