-- RPC for sellers to view their own salary history from salary_payments table
begin;

-- Allow employees to read their own salary_payments records
drop policy if exists "employee_self_salary" on public.salary_payments;
create policy "employee_self_salary" on public.salary_payments for select to authenticated
  using (employee_id = auth.uid());

create or replace function public.get_my_salary_history(p_month date default current_date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month text;
  v_items jsonb;
  v_totals jsonb;
begin
  if auth.uid() is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;

  v_month := to_char(p_month, 'YYYY-MM');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', sp.id,
    'period_month', sp.period_month,
    'base_salary', sp.base_salary,
    'bonus', sp.bonus,
    'advance_paid', sp.advance_paid,
    'salary_paid', sp.salary_paid,
    'extra_paid', coalesce(sp.extra_paid, 0),
    'extra_note', sp.extra_note,
    'note', sp.note,
    'advance_paid_at', sp.advance_paid_at,
    'salary_paid_at', sp.salary_paid_at,
    'paid_at', sp.paid_at,
    'remaining', sp.base_salary + sp.bonus - sp.salary_paid - sp.advance_paid - coalesce(sp.extra_paid, 0),
    'created_at', sp.created_at
  ) order by sp.created_at desc), '[]'::jsonb)
  into v_items
  from public.salary_payments sp
  where sp.employee_id = auth.uid()
    and sp.period_month = v_month;

  select jsonb_build_object(
    'gross', coalesce(sum((item->>'base_salary')::numeric), 0),
    'bonus', coalesce(sum((item->>'bonus')::numeric), 0),
    'advance', coalesce(sum((item->>'advance_paid')::numeric), 0),
    'salary_paid', coalesce(sum((item->>'salary_paid')::numeric), 0),
    'extra', coalesce(sum((item->>'extra_paid')::numeric), 0),
    'net', coalesce(sum((item->>'salary_paid')::numeric + (item->>'advance_paid')::numeric + (item->>'extra_paid')::numeric), 0),
    'remaining', coalesce(sum((item->>'remaining')::numeric), 0)
  )
  into v_totals
  from jsonb_array_elements(v_items) item;

  return jsonb_build_object('items', v_items, 'totals', v_totals);
end;
$$;

revoke all on function public.get_my_salary_history(date) from public, anon;
grant execute on function public.get_my_salary_history(date) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
