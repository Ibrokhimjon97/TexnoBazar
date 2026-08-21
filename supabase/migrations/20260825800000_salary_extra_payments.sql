alter table public.salary_payments
  add column if not exists extra_paid numeric(18,2) not null default 0 check(extra_paid>=0),
  add column if not exists extra_note text;
