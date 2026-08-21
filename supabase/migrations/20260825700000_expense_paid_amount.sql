alter table public.expenses
  add column if not exists paid_amount numeric(18,2) not null default 0 check(paid_amount>=0);
