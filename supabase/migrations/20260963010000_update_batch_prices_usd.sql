-- Migration: update_batch_prices with USD price support
-- =============================================================================

create or replace function public.update_batch_prices(
  p_batch_id uuid,
  p_unit_cost numeric,
  p_retail_price numeric,
  p_wholesale_price numeric default null,
  p_minimum_sale_price numeric default null,
  p_unit_cost_usd numeric default null,
  p_retail_price_usd numeric default null,
  p_wholesale_price_usd numeric default null,
  p_minimum_sale_price_usd numeric default null
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

  -- Step 2: Update batch unit_cost and batch-level prices including USD fields
  update public.stock_batches
  set unit_cost = p_unit_cost,
      retail_price = p_retail_price,
      wholesale_price = coalesce(p_wholesale_price, wholesale_price),
      minimum_sale_price = coalesce(p_minimum_sale_price, minimum_sale_price),
      unit_cost_usd = coalesce(p_unit_cost_usd, unit_cost_usd),
      retail_price_usd = coalesce(p_retail_price_usd, retail_price_usd),
      wholesale_price_usd = coalesce(p_wholesale_price_usd, wholesale_price_usd),
      minimum_sale_price_usd = coalesce(p_minimum_sale_price_usd, minimum_sale_price_usd)
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

  return jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'product_id', v_batch.product_id,
    'old_total', v_old_total, 'new_total', v_new_total, 'debt_adjustment', v_new_debt - v_old_debt);
end;
$$;

revoke all on function public.update_batch_prices(uuid,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric) from public, anon;
grant execute on function public.update_batch_prices(uuid,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric) to authenticated, service_role;
