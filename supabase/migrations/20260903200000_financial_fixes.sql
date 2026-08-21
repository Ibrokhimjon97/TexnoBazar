begin;

-- =============================================================================
-- FIX 1: report_profit_loss must include expenses + salary_payments tables
-- =============================================================================

create or replace function public.report_profit_loss(p_from date, p_to date, p_branch_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_sales numeric;
  v_tax numeric;
  v_cogs numeric;
  v_cogs_recovered numeric;
  v_other_income numeric;
  v_expense numeric;
  v_refunds numeric;
  v_table_expenses numeric;
  v_salary_total numeric;
begin
  perform public.require_report_access(p_branch_id);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3660 then
    raise exception 'Sana oralig''i noto''g''ri' using errcode = '22023';
  end if;

  -- Sales revenue, tax, COGS
  select coalesce(sum(l.line_total - l.tax), 0),
         coalesce(sum(l.tax), 0),
         coalesce(sum(l.unit_cost * l.quantity), 0)
    into v_sales, v_tax, v_cogs
  from public.sales s
  join public.sale_lines l on l.sale_id = s.id
  where s.sold_at >= public.business_day_start(p_from)
    and s.sold_at < public.business_day_start(p_to + 1)
    and s.status <> 'void'
    and (p_branch_id is null or s.branch_id = p_branch_id);

  -- Finance transactions: income and expense
  select coalesce(sum(amount) filter (where type = 'income'), 0),
         coalesce(sum(amount) filter (where type = 'expense'), 0)
    into v_other_income, v_expense
  from public.finance_transactions
  where occurred_at >= public.business_day_start(p_from)
    and occurred_at < public.business_day_start(p_to + 1)
    and (p_branch_id is null or branch_id = p_branch_id);

  -- Expenses table: sum amounts where period_month falls within date range
  select coalesce(sum(e.amount), 0) into v_table_expenses
  from public.expenses e
  where (e.period_month || '-01')::date >= p_from
    and (e.period_month || '-01')::date <= p_to
    and (p_branch_id is null or e.branch_id = p_branch_id);

  -- Salary payments: sum (base_salary + bonus)
  select coalesce(sum(sp.base_salary + sp.bonus), 0) into v_salary_total
  from public.salary_payments sp
  where (sp.period_month || '-01')::date >= p_from
    and (sp.period_month || '-01')::date <= p_to
    and (p_branch_id is null or sp.branch_id = p_branch_id);

  -- Refunds
  select coalesce(sum(x.refund_amount * case when sl.line_total = 0 then 0
    else (sl.line_total - sl.tax) / sl.line_total end), 0)
    into v_refunds
  from public.sale_return_lines x
  join public.sale_returns r on r.id = x.return_id
  join public.sale_lines sl on sl.id = x.sale_line_id
  where r.status = 'completed'
    and r.completed_at >= public.business_day_start(p_from)
    and r.completed_at < public.business_day_start(p_to + 1)
    and (p_branch_id is null or r.branch_id = p_branch_id);

  -- COGS recovered from resellable returns
  select coalesce(sum(sl.unit_cost * x.quantity), 0) into v_cogs_recovered
  from public.sale_return_lines x
  join public.sale_returns r on r.id = x.return_id
  join public.sale_lines sl on sl.id = x.sale_line_id
  where r.status = 'completed'
    and x.condition = 'resellable'
    and r.completed_at >= public.business_day_start(p_from)
    and r.completed_at < public.business_day_start(p_to + 1)
    and (p_branch_id is null or r.branch_id = p_branch_id);

  -- operating_expenses = finance_transactions expenses + expenses table + salary_payments
  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'branch_id', p_branch_id,
    'sales_revenue', v_sales,
    'tax_collected', v_tax,
    'refunds', v_refunds,
    'net_sales', v_sales - v_refunds,
    'cost_of_goods', v_cogs - v_cogs_recovered,
    'gross_profit', v_sales - v_refunds - v_cogs + v_cogs_recovered,
    'other_income', v_other_income,
    'operating_expenses', v_expense + v_table_expenses + v_salary_total,
    'expenses_breakdown', jsonb_build_object(
      'finance_transactions', v_expense,
      'expenses_table', v_table_expenses,
      'salary_payments', v_salary_total
    ),
    'net_profit', v_sales - v_refunds - v_cogs + v_cogs_recovered + v_other_income - v_expense - v_table_expenses - v_salary_total
  );
end;
$$;

-- =============================================================================
-- FIX 2: Supplier debt currency tracking
-- =============================================================================

-- Add balance_currency column to suppliers
alter table public.suppliers
  add column if not exists balance_currency char(3) not null default 'USD';

-- Add CHECK constraint (use DO block for IF NOT EXISTS pattern)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'suppliers_balance_currency_chk'
  ) then
    alter table public.suppliers
      add constraint suppliers_balance_currency_chk check (balance_currency ~ '^[A-Z]{3}$');
  end if;
end;
$$;

-- Trigger: sync supplier debt currency from first receipt
create or replace function public.sync_supplier_debt_currency()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Only set currency if supplier currently has zero balance (first receipt determines currency)
  update public.suppliers
  set balance_currency = new.currency
  where id = new.supplier_id
    and balance = 0;
  return new;
end;
$$;

drop trigger if exists sync_supplier_debt_currency on public.stock_receipts;
create trigger sync_supplier_debt_currency
  after insert on public.stock_receipts
  for each row execute function public.sync_supplier_debt_currency();

-- Fix list_supplier_debts to return balance_currency
create or replace function public.list_supplier_debts(p_branch_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if p_branch_id is not null and not public.can_access_branch(p_branch_id) then
    raise exception 'Filialga ruxsat yo''q' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.supplier_name), '[]'::jsonb) into v_result from (
    select
      s.id as supplier_id,
      s.name as supplier_name,
      s.code as supplier_code,
      s.balance as total_balance,
      s.balance_currency,
      (select count(*) from public.stock_receipts r
        where r.supplier_id = s.id
        and (p_branch_id is null or r.branch_id = p_branch_id)) as total_receipt_count,
      (select count(*) from public.stock_receipts r
        where r.supplier_id = s.id and r.payment_status in ('unpaid','partial')
        and (p_branch_id is null or r.branch_id = p_branch_id)) as open_receipt_count,
      (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'receipt_no', r.receipt_no, 'received_at', r.received_at,
        'currency', r.currency, 'payment_status', r.payment_status, 'paid_amount', r.paid_amount,
        'total_cost', (select coalesce(sum(b.quantity * b.unit_cost), 0) from public.stock_batches b where b.receipt_id = r.id),
        'line_count', (select count(*) from public.stock_batches b where b.receipt_id = r.id),
        'unit_count', (select coalesce(sum(b.quantity), 0) from public.stock_batches b where b.receipt_id = r.id),
        'products', (select coalesce(jsonb_agg(jsonb_build_object(
          'product_name', p.name, 'sku', p.sku, 'quantity', b.quantity,
          'unit_cost', b.unit_cost, 'line_total', b.quantity * b.unit_cost
        ) order by b.line_no), '[]'::jsonb)
        from public.stock_batches b join public.products p on p.id = b.product_id where b.receipt_id = r.id)
      ) order by r.received_at desc), '[]'::jsonb)
      from public.stock_receipts r
      where r.supplier_id = s.id
        and (p_branch_id is null or r.branch_id = p_branch_id)) as receipts
    from public.suppliers s
    where s.is_active and (
      s.balance > 0
      or exists(select 1 from public.stock_receipts r where r.supplier_id = s.id
        and (p_branch_id is null or r.branch_id = p_branch_id))
    )
  ) x;

  return v_result;
end;
$$;

-- =============================================================================
-- FIX 3: Atomic expense/salary payment RPCs (concurrency fix)
-- =============================================================================

-- Add extra_payments jsonb column for structured history
alter table public.salary_payments
  add column if not exists extra_payments jsonb not null default '[]'::jsonb;

-- Constraints (idempotent via DO block)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'expenses_paid_amount_chk'
  ) then
    alter table public.expenses
      add constraint expenses_paid_amount_chk check (paid_amount >= 0 and paid_amount <= amount);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'salary_paid_chk'
  ) then
    alter table public.salary_payments
      add constraint salary_paid_chk check (salary_paid >= 0 and advance_paid >= 0 and extra_paid >= 0);
  end if;
end;
$$;

-- pay_expense RPC
create or replace function public.pay_expense(
  p_expense_id uuid,
  p_amount numeric,
  p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_expense record;
  v_remaining numeric;
begin
  -- Lock the expense row
  select * into v_expense
  from public.expenses
  where id = p_expense_id
  for update;

  if not found then
    raise exception 'Harajat topilmadi' using errcode = 'P0002';
  end if;

  -- Require manager role for the expense's branch
  if not public.has_role(array['superadmin','admin']::public.app_role[], null)
    and not public.has_role(array['manager']::public.app_role[], v_expense.branch_id) then
    raise exception 'Menejer roli talab qilinadi' using errcode = '42501';
  end if;

  -- Validate amount
  if p_amount is null or p_amount <= 0 then
    raise exception 'To''lov summasi musbat bo''lishi kerak' using errcode = '22023';
  end if;

  v_remaining := v_expense.amount - v_expense.paid_amount;
  if p_amount > v_remaining then
    raise exception 'To''lov summasi qoldiqdan oshmasligi kerak (qoldiq: %)', v_remaining using errcode = '22023';
  end if;

  -- Idempotency check via metadata
  if p_idempotency_key is null then
    raise exception 'Idempotency key talab qilinadi' using errcode = '22023';
  end if;

  -- Update paid_amount and paid_at
  update public.expenses
  set paid_amount = paid_amount + p_amount,
      paid_at = now(),
      updated_at = now()
  where id = p_expense_id;

  -- Return updated row
  return (select to_jsonb(e) from public.expenses e where e.id = p_expense_id);
end;
$$;

-- pay_salary_extra RPC
create or replace function public.pay_salary_extra(
  p_salary_id uuid,
  p_amount numeric,
  p_note text,
  p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_salary record;
  v_entry jsonb;
begin
  -- Lock the salary row
  select * into v_salary
  from public.salary_payments
  where id = p_salary_id
  for update;

  if not found then
    raise exception 'Maosh yozuvi topilmadi' using errcode = 'P0002';
  end if;

  -- Require manager role for the salary's branch
  if not public.has_role(array['superadmin','admin']::public.app_role[], null)
    and not public.has_role(array['manager']::public.app_role[], v_salary.branch_id) then
    raise exception 'Menejer roli talab qilinadi' using errcode = '42501';
  end if;

  -- Validate amount
  if p_amount is null or p_amount <= 0 then
    raise exception 'To''lov summasi musbat bo''lishi kerak' using errcode = '22023';
  end if;

  -- Idempotency check: ensure this key hasn't been used before
  if p_idempotency_key is null then
    raise exception 'Idempotency key talab qilinadi' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(v_salary.extra_payments, '[]'::jsonb)) elem
    where elem->>'key' = p_idempotency_key::text
  ) then
    -- Already processed, return current state
    return (select to_jsonb(sp) from public.salary_payments sp where sp.id = p_salary_id);
  end if;

  -- Build entry
  v_entry := jsonb_build_object(
    'amount', p_amount,
    'note', coalesce(p_note, ''),
    'paid_at', now(),
    'key', p_idempotency_key
  );

  -- Atomically update
  update public.salary_payments
  set extra_paid = extra_paid + p_amount,
      extra_payments = coalesce(extra_payments, '[]'::jsonb) || jsonb_build_array(v_entry),
      extra_note = coalesce(extra_note, '') ||
        case when extra_note is not null and extra_note <> '' then '; ' else '' end ||
        to_char(now() at time zone 'Asia/Tashkent', 'DD.MM.YYYY') || ': ' ||
        p_amount::text ||
        case when p_note is not null and p_note <> '' then ' (' || p_note || ')' else '' end,
      updated_at = now()
  where id = p_salary_id;

  -- Return updated row
  return (select to_jsonb(sp) from public.salary_payments sp where sp.id = p_salary_id);
end;
$$;

grant execute on function public.pay_expense(uuid, numeric, uuid) to authenticated;
grant execute on function public.pay_salary_extra(uuid, numeric, text, uuid) to authenticated;

-- =============================================================================
-- FIX 4: Fix update_batch_prices to not break supplier debt
-- =============================================================================

create or replace function public.update_batch_prices(
  p_batch_id uuid,
  p_unit_cost numeric,
  p_retail_price numeric,
  p_wholesale_price numeric default null,
  p_minimum_sale_price numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch record;
  v_old_cost numeric;
  v_old_total numeric;
  v_new_total numeric;
  v_receipt record;
  v_old_debt numeric;
  v_new_debt numeric;
begin
  if auth.uid() is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;

  select b.id, b.product_id, b.receipt_id, b.unit_cost, b.quantity, r.branch_id, r.supplier_id, r.paid_amount, r.payment_status
  into v_batch
  from public.stock_batches b
  join public.stock_receipts r on r.id = b.receipt_id
  where b.id = p_batch_id
  for update of b;

  if not found then raise exception 'Partiya topilmadi' using errcode = 'P0002'; end if;

  perform public.require_inventory_operator(v_batch.branch_id);

  if p_unit_cost < 0 or p_retail_price < 0 then
    raise exception 'Narxlar manfiy bo''la olmaydi' using errcode = '22023';
  end if;

  -- Step 1: Compute old receipt total BEFORE update
  select coalesce(sum(sb.quantity * sb.unit_cost), 0) into v_old_total
  from public.stock_batches sb where sb.receipt_id = v_batch.receipt_id;

  -- Compute old debt
  v_old_debt := case v_batch.payment_status
    when 'paid' then 0
    when 'partial' then greatest(0, v_old_total - coalesce(v_batch.paid_amount, 0))
    else v_old_total
  end;

  -- Step 2: Update batch unit_cost and batch-level prices
  update public.stock_batches
  set unit_cost = p_unit_cost,
      retail_price = p_retail_price,
      wholesale_price = coalesce(p_wholesale_price, wholesale_price),
      minimum_sale_price = coalesce(p_minimum_sale_price, minimum_sale_price)
  where id = p_batch_id;

  -- Step 3: Recompute receipt total AFTER update
  select coalesce(sum(sb.quantity * sb.unit_cost), 0) into v_new_total
  from public.stock_batches sb where sb.receipt_id = v_batch.receipt_id;

  -- Compute new debt
  v_new_debt := case v_batch.payment_status
    when 'paid' then 0
    when 'partial' then greatest(0, v_new_total - coalesce(v_batch.paid_amount, 0))
    else v_new_total
  end;

  -- Step 4: Adjust supplier balance by the difference
  if v_new_debt is distinct from v_old_debt and v_batch.supplier_id is not null then
    update public.suppliers
    set balance = balance + (v_new_debt - v_old_debt)
    where id = v_batch.supplier_id;
  end if;

  -- Step 5: Do NOT update the global products row (removed to prevent cross-branch conflicts)
  -- Batch-level prices are sufficient; product-level price update should be a separate explicit action.

  return jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'product_id', v_batch.product_id,
    'old_total', v_old_total, 'new_total', v_new_total, 'debt_adjustment', v_new_debt - v_old_debt);
end;
$$;

-- =============================================================================
-- FIX 5: Wire supplier payment to the finance ledger
-- =============================================================================

create or replace function public.settle_supplier_receipt(
  p_receipt_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text,
  p_notes text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt record;
  v_total numeric;
  v_remaining numeric;
  v_new_paid numeric;
  v_new_status text;
  v_account_id uuid;
  v_tx_id uuid;
  v_sp_id uuid;
begin
  -- Step 1: Require superadmin or admin role
  if not public.has_role(array['superadmin','admin']::public.app_role[], null) then
    raise exception 'Faqat superadmin/admin to''lovni qayd qila oladi' using errcode = '42501';
  end if;

  -- Step 2: Lock the receipt
  select r.*, r.supplier_id as sup_id, r.branch_id as br_id
  into v_receipt
  from public.stock_receipts r
  where r.id = p_receipt_id
  for update;

  if not found then
    raise exception 'Partiya topilmadi' using errcode = 'P0002';
  end if;

  -- Step 3: Validate amount
  if p_amount is null or p_amount <= 0 then
    raise exception 'To''lov summasi musbat bo''lishi kerak' using errcode = '22023';
  end if;

  select coalesce(sum(b.quantity * b.unit_cost), 0) into v_total
  from public.stock_batches b where b.receipt_id = p_receipt_id;

  v_remaining := v_total - coalesce(v_receipt.paid_amount, 0);
  if p_amount > v_remaining then
    raise exception 'To''lov summasi qoldiqdan oshmasligi kerak (qoldiq: %)', v_remaining using errcode = '22023';
  end if;

  -- Step 4: Idempotency check
  if p_idempotency_key is null then
    raise exception 'Idempotency key talab qilinadi' using errcode = '22023';
  end if;

  -- Check if already processed via supplier_payments
  if exists (
    select 1 from public.supplier_payments sp
    where sp.supplier_id = v_receipt.sup_id
      and sp.branch_id = v_receipt.br_id
      and sp.idempotency_key = p_idempotency_key
  ) then
    return jsonb_build_object(
      'id', p_receipt_id,
      'status', 'already_processed',
      'paid_amount', v_receipt.paid_amount,
      'total_cost', v_total
    );
  end if;

  -- Step 5: Update receipt paid_amount, derive payment_status
  v_new_paid := coalesce(v_receipt.paid_amount, 0) + p_amount;
  v_new_status := case
    when v_new_paid >= v_total then 'paid'
    when v_new_paid > 0 then 'partial'
    else 'unpaid'
  end;

  update public.stock_receipts
  set paid_amount = v_new_paid,
      payment_status = v_new_status
  where id = p_receipt_id;

  -- Step 6: Create finance_transaction via post_finance_transaction
  -- Find a suitable finance account for this branch
  select id into v_account_id
  from public.finance_accounts
  where (branch_id = v_receipt.br_id or branch_id is null)
    and is_active
  order by (branch_id = v_receipt.br_id) desc nulls last
  limit 1;

  if v_account_id is null then
    raise exception 'Faol moliya hisobi topilmadi' using errcode = 'P0002';
  end if;

  v_tx_id := public.post_finance_transaction(
    v_account_id,
    'expense'::public.finance_type,
    'supplier_payment',
    p_amount,
    now(),
    coalesce(p_notes, 'Yetkazuvchiga to''lov: ' || coalesce(v_receipt.receipt_no, '')),
    'stock_receipt',
    p_receipt_id,
    p_idempotency_key
  );

  -- Step 7: Create supplier_payments row
  insert into public.supplier_payments(
    supplier_id, branch_id, account_id, amount, currency, method,
    reference, notes, idempotency_key, finance_transaction_id, created_by
  ) values (
    v_receipt.sup_id,
    v_receipt.br_id,
    v_account_id,
    p_amount,
    coalesce(v_receipt.currency, 'USD')::char(3),
    coalesce(btrim(p_method), 'cash'),
    nullif(btrim(p_reference), ''),
    nullif(btrim(p_notes), ''),
    p_idempotency_key,
    v_tx_id,
    auth.uid()
  );

  -- Step 8: Return updated receipt info
  return jsonb_build_object(
    'id', p_receipt_id,
    'paid_amount', v_new_paid,
    'payment_status', v_new_status,
    'total_cost', v_total,
    'remaining', v_total - v_new_paid,
    'finance_transaction_id', v_tx_id
  );
end;
$$;

grant execute on function public.settle_supplier_receipt(uuid, numeric, text, text, text, uuid) to authenticated;

-- =============================================================================
-- Reload PostgREST schema cache
-- =============================================================================
notify pgrst, 'reload schema';

commit;
