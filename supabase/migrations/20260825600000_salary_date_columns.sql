alter table public.salary_payments
  add column if not exists advance_paid_at date,
  add column if not exists salary_paid_at date;
