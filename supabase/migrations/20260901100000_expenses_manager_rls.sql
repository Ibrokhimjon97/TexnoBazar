-- Menejer roliga expenses va salary_payments jadvallari uchun RLS ruxsati.
-- Menejer faqat o'z filialiga tegishli yozuvlarni ko'radi va yozadi.
begin;

-- expenses: menejer o'z filialining harajatlarini ko'radi va yozadi
drop policy if exists "manager_branch_expenses" on public.expenses;
create policy "manager_branch_expenses" on public.expenses for all to authenticated
  using (
    branch_id is not null
    and public.has_role(array['manager']::public.app_role[], branch_id)
  )
  with check (
    branch_id is not null
    and public.has_role(array['manager']::public.app_role[], branch_id)
  );

-- salary_payments: menejer o'z filialining maoshlarini ko'radi va yozadi
drop policy if exists "manager_branch_salary" on public.salary_payments;
create policy "manager_branch_salary" on public.salary_payments for all to authenticated
  using (
    branch_id is not null
    and public.has_role(array['manager']::public.app_role[], branch_id)
  )
  with check (
    branch_id is not null
    and public.has_role(array['manager']::public.app_role[], branch_id)
  );

commit;
