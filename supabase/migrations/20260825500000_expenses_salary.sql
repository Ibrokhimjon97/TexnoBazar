begin;

create table if not exists public.expenses(
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references public.branches(id) on delete restrict,
  category text not null check(category in('tax','rent','electricity','water','gas','llc','sole_trader','salary','transport','other')),
  title text not null check(length(btrim(title)) between 2 and 300),
  amount numeric(18,2) not null check(amount>0),
  currency char(3) not null default 'UZS',
  period_month text not null check(period_month ~ '^\d{4}-\d{2}$'),
  paid_at timestamptz,
  note text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists expenses_period_idx on public.expenses(period_month desc, category);
alter table public.expenses enable row level security;
create policy "admin_all_expenses" on public.expenses for all to authenticated
  using (public.has_role(array['superadmin','admin']::public.app_role[], null))
  with check (public.has_role(array['superadmin','admin']::public.app_role[], null));
grant all on public.expenses to authenticated, service_role;

create table if not exists public.salary_payments(
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete restrict,
  branch_id uuid references public.branches(id) on delete restrict,
  period_month text not null check(period_month ~ '^\d{4}-\d{2}$'),
  base_salary numeric(18,2) not null default 0 check(base_salary>=0),
  bonus numeric(18,2) not null default 0 check(bonus>=0),
  advance_paid numeric(18,2) not null default 0 check(advance_paid>=0),
  salary_paid numeric(18,2) not null default 0 check(salary_paid>=0),
  note text,
  paid_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists salary_payments_employee_idx on public.salary_payments(employee_id, period_month desc);
alter table public.salary_payments enable row level security;
create policy "admin_all_salary" on public.salary_payments for all to authenticated
  using (public.has_role(array['superadmin','admin']::public.app_role[], null))
  with check (public.has_role(array['superadmin','admin']::public.app_role[], null));
grant all on public.salary_payments to authenticated, service_role;

commit;
