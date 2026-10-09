-- Migration: Allow deleting stock receipt with sold units using password '9707'
drop function if exists public.delete_stock_receipt(uuid);
drop function if exists public.delete_stock_receipt(uuid, text);

create or replace function public.delete_stock_receipt(
  p_receipt_id uuid,
  p_password text default null
)
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
  v_has_sold boolean := false;
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

  -- Sotilgan birliklar bormi?
  v_has_sold := exists(select 1 from public.sale_lines where unit_id = any(v_unit_ids));

  if v_has_sold then
    if p_password is null or btrim(p_password) = '' then
      raise exception 'Bu partiya birliklaridan sotilganlari bor — o''chirish mumkin emas' using errcode = 'P0001';
    elsif btrim(p_password) <> '9707' then
      raise exception 'Parol noto''g''ri kiritildi!' using errcode = 'P0001';
    end if;
  end if;

  -- 1. Bog'liq sotuvlar, qaytarishlar va rezervlarni tozalash
  begin alter table public.sale_lines disable trigger sale_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.sale_return_lines disable trigger sale_return_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.pos_pending_sale_lines disable trigger pos_pending_sale_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.supplier_return_lines disable trigger supplier_return_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.order_reserved_units disable trigger order_reserved_units_guard; exception when undefined_table or undefined_object then null; end;

  delete from public.sale_return_lines where unit_id = any(v_unit_ids);
  delete from public.supplier_return_lines where unit_id = any(v_unit_ids);
  delete from public.sale_lines where unit_id = any(v_unit_ids);
  delete from public.pos_pending_sale_lines where unit_id = any(v_unit_ids);
  delete from public.order_reserved_units where unit_id = any(v_unit_ids);

  begin alter table public.sale_lines enable trigger sale_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.sale_return_lines enable trigger sale_return_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.pos_pending_sale_lines enable trigger pos_pending_sale_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.supplier_return_lines enable trigger supplier_return_lines_immutable; exception when undefined_table or undefined_object then null; end;
  begin alter table public.order_reserved_units enable trigger order_reserved_units_guard; exception when undefined_table or undefined_object then null; end;

  -- 2. Ta'mirlash buyurtmalari
  select array_agg(id) into v_repair_ids from public.repair_orders where unit_id = any(v_unit_ids);
  if v_repair_ids is not null then
    begin alter table public.repair_events disable trigger repair_events_immutable; exception when undefined_table or undefined_object then null; end;
    begin alter table public.repair_cost_entries disable trigger repair_cost_entries_immutable; exception when undefined_table or undefined_object then null; end;
    delete from public.repair_events where repair_id = any(v_repair_ids);
    delete from public.repair_cost_entries where repair_id = any(v_repair_ids);
    begin alter table public.repair_events enable trigger repair_events_immutable; exception when undefined_table or undefined_object then null; end;
    begin alter table public.repair_cost_entries enable trigger repair_cost_entries_immutable; exception when undefined_table or undefined_object then null; end;
    delete from public.repair_orders where id = any(v_repair_ids);
  end if;

  -- 3. Harakatlar tarixi
  begin alter table public.inventory_movements disable trigger inventory_movements_immutable; exception when undefined_table or undefined_object then null; end;
  delete from public.inventory_movements where unit_id = any(v_unit_ids);
  begin alter table public.inventory_movements enable trigger inventory_movements_immutable; exception when undefined_table or undefined_object then null; end;

  -- 4. Boshqa satrlar va birliklarni tozalash
  delete from public.inventory_count_lines where unit_id = any(v_unit_ids);
  delete from public.transfer_lines where unit_id = any(v_unit_ids);
  delete from public.writeoff_lines where unit_id = any(v_unit_ids);

  -- Units holatini xavfsiz tozalab o'chiramiz
  update public.inventory_units
  set status = 'available', sold_sale_id = null, active_transfer_id = null
  where id = any(v_unit_ids);

  delete from public.inventory_units where id = any(v_unit_ids);
  delete from public.stock_batches where id = any(v_batch_ids);
  delete from public.stock_receipts where id = p_receipt_id;

  if v_debt > 0 and v_r.supplier_id is not null then
    update public.suppliers set balance = balance - v_debt where id = v_r.supplier_id;
  end if;
end;
$$;

revoke all on function public.delete_stock_receipt(uuid, text) from public, anon;
grant execute on function public.delete_stock_receipt(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
