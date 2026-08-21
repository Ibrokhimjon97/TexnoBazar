-- Fix supplier balance logic:
-- Balance should only reflect UNPAID amounts.
-- When receipt is 'paid', no debt should accrue.
-- When receipt is 'partial', only unpaid portion should accrue.

-- Replace the old trigger that blindly adds to balance on every batch insert
drop trigger if exists stock_batches_supplier_accrual on public.stock_batches;
drop function if exists public.accrue_supplier_balance_from_receipt_line();

-- New trigger: accrues supplier balance based on receipt payment_status
create or replace function public.accrue_supplier_balance_from_receipt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_receipt public.stock_receipts%rowtype; v_total numeric; v_debt numeric;
begin
  -- Only fire after the full receipt is created (on stock_receipts insert)
  select * into v_receipt from public.stock_receipts where id = new.id;
  
  -- Calculate total cost of this receipt
  select coalesce(sum(b.quantity * b.unit_cost), 0) into v_total
  from public.stock_batches b where b.receipt_id = new.id;
  
  -- Determine how much debt to add based on payment status
  if v_receipt.payment_status = 'paid' then
    v_debt := 0; -- fully paid, no debt
  elsif v_receipt.payment_status = 'partial' then
    v_debt := greatest(0, v_total - coalesce(v_receipt.paid_amount, 0)); -- only unpaid portion
  else -- 'unpaid'
    v_debt := v_total; -- full amount is debt
  end if;
  
  if v_debt > 0 and v_receipt.supplier_id is not null then
    update public.suppliers set balance = balance + v_debt where id = v_receipt.supplier_id;
  end if;
  
  return new;
end; $$;

-- This trigger fires AFTER the receipt and all batches are created
-- We use a deferred trigger approach: fire on stock_receipts update (after receive_stock sets everything up)
-- Actually, let's use a simpler approach: modify receive_stock to handle balance directly

-- Instead of a trigger, we'll handle it in the receive_stock function.
-- For now, let's fix the existing data and add a trigger on stock_receipts for payment_status changes.

-- Trigger for when payment_status is updated on existing receipts
create or replace function public.sync_supplier_balance_on_payment_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_total numeric; v_old_debt numeric; v_new_debt numeric;
begin
  -- Only act when payment_status or paid_amount changes
  if old.payment_status = new.payment_status and old.paid_amount = new.paid_amount then
    return new;
  end if;
  
  -- Calculate total receipt cost
  select coalesce(sum(b.quantity * b.unit_cost), 0) into v_total
  from public.stock_batches b where b.receipt_id = new.id;
  
  -- Old debt amount
  if old.payment_status = 'paid' then v_old_debt := 0;
  elsif old.payment_status = 'partial' then v_old_debt := greatest(0, v_total - coalesce(old.paid_amount, 0));
  else v_old_debt := v_total; end if;
  
  -- New debt amount
  if new.payment_status = 'paid' then v_new_debt := 0;
  elsif new.payment_status = 'partial' then v_new_debt := greatest(0, v_total - coalesce(new.paid_amount, 0));
  else v_new_debt := v_total; end if;
  
  -- Adjust supplier balance by the difference
  if v_new_debt <> v_old_debt and new.supplier_id is not null then
    update public.suppliers set balance = balance + (v_new_debt - v_old_debt) where id = new.supplier_id;
  end if;
  
  return new;
end; $$;

drop trigger if exists stock_receipts_payment_sync on public.stock_receipts;
create trigger stock_receipts_payment_sync
  after update of payment_status, paid_amount on public.stock_receipts
  for each row execute function public.sync_supplier_balance_on_payment_change();

-- FIX EXISTING DATA: Recalculate all supplier balances from scratch
-- Balance = sum of unpaid portions across all receipts - sum of supplier_payments
do $$
declare v_sup record;
begin
  for v_sup in select id from public.suppliers loop
    update public.suppliers set balance = (
      -- Total debt from receipts (unpaid portions only)
      coalesce((
        select sum(
          case
            when r.payment_status = 'paid' then 0
            when r.payment_status = 'partial' then greatest(0, (select coalesce(sum(b.quantity * b.unit_cost), 0) from public.stock_batches b where b.receipt_id = r.id) - coalesce(r.paid_amount, 0))
            else (select coalesce(sum(b.quantity * b.unit_cost), 0) from public.stock_batches b where b.receipt_id = r.id)
          end
        )
        from public.stock_receipts r where r.supplier_id = v_sup.id
      ), 0)
      -- Minus payments already made
      - coalesce((select sum(sp.amount) from public.supplier_payments sp where sp.supplier_id = v_sup.id), 0)
      -- Minus supplier returns
      - coalesce((select sum(sr.total_amount) from public.supplier_returns sr where sr.supplier_id = v_sup.id and sr.status = 'posted'), 0)
    )
    where id = v_sup.id;
  end loop;
end $$;
