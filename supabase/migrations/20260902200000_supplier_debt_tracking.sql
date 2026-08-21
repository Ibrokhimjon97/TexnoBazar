-- Supplier debt tracking: add paid_amount to stock_receipts and create supplier debt view

-- Add paid_amount column to track partial payments on receipts
alter table public.stock_receipts
  add column if not exists paid_amount numeric(18,2) not null default 0 check (paid_amount >= 0);

-- Change default currency to USD
alter table public.stock_receipts alter column currency set default 'USD';

-- Create a view for supplier debt summary (per supplier)
create or replace view public.supplier_debt_summary as
select
  s.id as supplier_id,
  s.name as supplier_name,
  s.code as supplier_code,
  s.balance as total_balance,
  count(r.id) filter (where r.payment_status in ('unpaid','partial')) as open_receipt_count,
  coalesce(sum(
    case when r.payment_status in ('unpaid','partial')
    then (select coalesce(sum(b.quantity * b.unit_cost), 0) from public.stock_batches b where b.receipt_id = r.id) - r.paid_amount
    else 0 end
  ), 0) as total_remaining,
  coalesce(sum(
    case when r.payment_status in ('unpaid','partial')
    then (select coalesce(sum(b.quantity * b.unit_cost), 0) from public.stock_batches b where b.receipt_id = r.id)
    else 0 end
  ), 0) as total_receipt_amount,
  r.currency
from public.suppliers s
left join public.stock_receipts r on r.supplier_id = s.id
where s.is_active
group by s.id, s.name, s.code, s.balance, r.currency
having s.balance > 0 or count(r.id) filter (where r.payment_status in ('unpaid','partial')) > 0;

-- RPC to list supplier debts for a branch
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
end; $$;

-- RPC to update receipt paid_amount (superadmin only)
create or replace function public.update_receipt_payment(p_receipt_id uuid, p_paid_amount numeric, p_payment_status text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_receipt public.stock_receipts%rowtype; v_total numeric;
begin
  -- Only superadmin/admin can update payment amounts
  if not public.has_role(array['superadmin','admin']::public.app_role[], null) then
    raise exception 'Faqat superadmin to''lov miqdorini o''zgartira oladi' using errcode = '42501';
  end if;

  select * into v_receipt from public.stock_receipts where id = p_receipt_id for update;
  if not found then raise exception 'Partiya topilmadi' using errcode = 'P0002'; end if;

  select coalesce(sum(b.quantity * b.unit_cost), 0) into v_total
  from public.stock_batches b where b.receipt_id = p_receipt_id;

  if p_paid_amount < 0 or p_paid_amount > v_total then
    raise exception 'To''langan summa 0 dan kichik yoki jami summadan katta bo''la olmaydi' using errcode = '22023';
  end if;

  -- Auto-determine payment status if not provided
  if p_payment_status is null then
    if p_paid_amount = 0 then p_payment_status := 'unpaid';
    elsif p_paid_amount >= v_total then p_payment_status := 'paid';
    else p_payment_status := 'partial';
    end if;
  end if;

  update public.stock_receipts
  set paid_amount = p_paid_amount, payment_status = p_payment_status
  where id = p_receipt_id;

  -- Update supplier balance: balance should reflect remaining debt
  -- balance = total receipts cost - total payments
  -- This is already handled by the trigger, so we don't change it here

  return jsonb_build_object('id', p_receipt_id, 'paid_amount', p_paid_amount, 'payment_status', p_payment_status, 'total_cost', v_total);
end; $$;

-- Grant permissions
grant execute on function public.list_supplier_debts(uuid) to authenticated;
grant execute on function public.update_receipt_payment(uuid, numeric, text) to authenticated;
