-- Partiyalarni tahrirlash va o'chirish imkoniyati.
-- Tahrirlash: ta'minotchi, sana, to'lov holati, invoice, izoh.
-- O'chirish: faqat hech bir birlik sotilmagan/rezervlangan/transferga jo'natilmagan bo'lsa.
begin;

create or replace function public.update_stock_receipt(p_receipt_id uuid, p_updates jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.stock_receipts%rowtype;
begin
  select * into v_r from public.stock_receipts where id=p_receipt_id for update;
  if not found then raise exception 'Partiya topilmadi' using errcode='P0002'; end if;
  perform public.require_inventory_operator(v_r.branch_id);
  if jsonb_typeof(p_updates)<>'object' then raise exception 'Yangilanish obyekti talab qilinadi' using errcode='22023'; end if;

  update public.stock_receipts set
    supplier_id=coalesce((nullif(p_updates->>'supplier_id',''))::uuid, supplier_id),
    invoice_number=case when p_updates ? 'invoice_number' then nullif(btrim(p_updates->>'invoice_number'),'') else invoice_number end,
    payment_status=case when p_updates ? 'payment_status' and (p_updates->>'payment_status') in ('unpaid','partial','paid') then p_updates->>'payment_status' else payment_status end,
    received_at=coalesce((nullif(p_updates->>'received_at',''))::timestamptz, received_at),
    notes=case when p_updates ? 'notes' then nullif(btrim(p_updates->>'notes'),'') else notes end,
    updated_at=now()
  where id=p_receipt_id returning * into v_r;

  -- Ta'minotchi o'zgarganda batch qatorlarini ham yangilaymiz
  if p_updates ? 'supplier_id' and nullif(p_updates->>'supplier_id','') is not null then
    update public.stock_batches set supplier_id=(p_updates->>'supplier_id')::uuid where receipt_id=p_receipt_id;
  end if;
  if p_updates ? 'received_at' and nullif(p_updates->>'received_at','') is not null then
    update public.stock_batches set received_at=(p_updates->>'received_at')::timestamptz where receipt_id=p_receipt_id;
  end if;

  return to_jsonb(v_r);
end $$;

create or replace function public.delete_stock_receipt(p_receipt_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_r public.stock_receipts%rowtype; v_batch_ids uuid[]; v_unit_ids uuid[]; v_repair_ids uuid[];
begin
  select * into v_r from public.stock_receipts where id=p_receipt_id for update;
  if not found then raise exception 'Partiya topilmadi' using errcode='P0002'; end if;
  perform public.require_inventory_operator(v_r.branch_id);
  select array_agg(id) into v_batch_ids from public.stock_batches where receipt_id=p_receipt_id;
  if v_batch_ids is null then v_batch_ids:='{}'::uuid[]; end if;
  select array_agg(id) into v_unit_ids from public.inventory_units where batch_id=any(v_batch_ids);
  if v_unit_ids is null then v_unit_ids:='{}'::uuid[]; end if;

  -- Sotilgan birliklar bo'lsa — o'chirish mumkin emas (pul oqimi buziladi)
  if exists(select 1 from public.sale_lines where unit_id=any(v_unit_ids)) then
    raise exception 'Bu partiya birliklaridan sotilganlari bor — o''chirish mumkin emas' using errcode='P0001';
  end if;

  -- Repair orders va ularga bog'liq jadvallar
  select array_agg(id) into v_repair_ids from public.repair_orders where unit_id=any(v_unit_ids);
  if v_repair_ids is not null then
    alter table public.repair_events disable trigger repair_events_immutable;
    alter table public.repair_cost_entries disable trigger repair_cost_entries_immutable;
    delete from public.repair_events where repair_id=any(v_repair_ids);
    delete from public.repair_cost_entries where repair_id=any(v_repair_ids);
    alter table public.repair_events enable trigger repair_events_immutable;
    alter table public.repair_cost_entries enable trigger repair_cost_entries_immutable;
    delete from public.repair_orders where id=any(v_repair_ids);
  end if;

  -- Inventory movements (immutable trigger)
  alter table public.inventory_movements disable trigger inventory_movements_immutable;
  delete from public.inventory_movements where unit_id=any(v_unit_ids);
  alter table public.inventory_movements enable trigger inventory_movements_immutable;

  delete from public.inventory_count_lines where unit_id=any(v_unit_ids);
  delete from public.transfer_lines where unit_id=any(v_unit_ids);
  delete from public.writeoff_lines where unit_id=any(v_unit_ids);
  delete from public.inventory_units where id=any(v_unit_ids);
  delete from public.stock_batches where id=any(v_batch_ids);
  delete from public.stock_receipts where id=p_receipt_id;
end $$;

grant execute on function public.update_stock_receipt(uuid,jsonb) to authenticated;
grant execute on function public.delete_stock_receipt(uuid) to authenticated;
grant execute on all functions in schema public to service_role;

commit;
