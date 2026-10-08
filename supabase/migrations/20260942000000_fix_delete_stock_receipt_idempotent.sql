-- Make delete_stock_receipt idempotent and handle receipts without suppliers
create or replace function public.delete_stock_receipt(p_receipt_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.stock_receipts%rowtype;
  v_batch_ids uuid[];
  v_unit_ids uuid[];
  v_repair_ids uuid[];
  v_total numeric(18,2);
  v_debt numeric(18,2);
begin
  select * into v_r from public.stock_receipts where id = p_receipt_id for update;
  if not found then
    -- Idempotent: already deleted or not found
    return;
  end if;

  perform public.require_inventory_operator(v_r.branch_id);

  select coalesce(sum(quantity * unit_cost), 0) into v_total
  from public.stock_batches where receipt_id = p_receipt_id;
  v_debt := case v_r.payment_status
    when 'paid' then 0
    when 'partial' then greatest(0, v_total - coalesce(v_r.paid_amount, 0))
    else v_total
  end;

  select array_agg(id) into v_batch_ids from public.stock_batches where receipt_id = p_receipt_id;
  if v_batch_ids is null then v_batch_ids := '{}'::uuid[]; end if;
  select array_agg(id) into v_unit_ids from public.inventory_units where batch_id = any(v_batch_ids);
  if v_unit_ids is null then v_unit_ids := '{}'::uuid[]; end if;

  if exists(select 1 from public.sale_lines where unit_id = any(v_unit_ids)) then
    raise exception 'Bu partiya birliklaridan sotilganlari bor — o''chirish mumkin emas' using errcode = 'P0001';
  end if;

  select array_agg(id) into v_repair_ids from public.repair_orders where unit_id = any(v_unit_ids);
  if v_repair_ids is not null then
    alter table public.repair_events disable trigger repair_events_immutable;
    alter table public.repair_cost_entries disable trigger repair_cost_entries_immutable;
    delete from public.repair_events where repair_id = any(v_repair_ids);
    delete from public.repair_cost_entries where repair_id = any(v_repair_ids);
    alter table public.repair_events enable trigger repair_events_immutable;
    alter table public.repair_cost_entries enable trigger repair_cost_entries_immutable;
    delete from public.repair_orders where id = any(v_repair_ids);
  end if;

  alter table public.inventory_movements disable trigger inventory_movements_immutable;
  delete from public.inventory_movements where unit_id = any(v_unit_ids);
  alter table public.inventory_movements enable trigger inventory_movements_immutable;

  delete from public.inventory_count_lines where unit_id = any(v_unit_ids);
  delete from public.transfer_lines where unit_id = any(v_unit_ids);
  delete from public.writeoff_lines where unit_id = any(v_unit_ids);
  delete from public.inventory_units where id = any(v_unit_ids);
  delete from public.stock_batches where id = any(v_batch_ids);
  delete from public.stock_receipts where id = p_receipt_id;
  if v_debt > 0 and v_r.supplier_id is not null then
    update public.suppliers set balance = balance - v_debt where id = v_r.supplier_id;
  end if;
end;
$$;

revoke all on function public.delete_stock_receipt(uuid) from public, anon;
grant execute on function public.delete_stock_receipt(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
