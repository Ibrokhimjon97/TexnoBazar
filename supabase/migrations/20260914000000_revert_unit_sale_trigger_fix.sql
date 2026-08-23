begin;

-- The live database still carries legacy immutability triggers on sale rows, so
-- the revert RPC must suspend every user trigger on the two tables it rewrites
-- instead of naming one trigger. Behaviour is otherwise unchanged.
create or replace function public.manager_revert_unit_sale(
  p_unit_id uuid,
  p_location_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_u public.inventory_units%rowtype;
  v_sale public.sales%rowtype;
  v_line public.sale_lines%rowtype;
  v_location public.locations%rowtype;
  v_subtotal numeric(18,2) := 0;
  v_discount numeric(18,2) := 0;
  v_tax numeric(18,2) := 0;
  v_total numeric(18,2) := 0;
  v_old_total numeric(18,2);
  v_remaining integer := 0;
  v_payment record;
  v_allocated numeric(18,2) := 0;
  v_new_amount numeric(18,2);
  v_last_payment uuid;
  v_from_location uuid;
begin
  select * into v_u from public.inventory_units where id = p_unit_id for update;
  if not found then raise exception 'Mahsulot birligi topilmadi' using errcode = 'P0002'; end if;
  if v_u.status <> 'sold' or v_u.sold_sale_id is null then
    raise exception 'Bu birlik sotilgan holatda emas (holat: %)', v_u.status::text using errcode = 'P0001';
  end if;

  select * into v_sale from public.sales where id = v_u.sold_sale_id for update;
  if not found then raise exception 'Sotuv topilmadi' using errcode = 'P0002'; end if;
  perform public.require_pos_manager(v_sale.branch_id);
  if v_sale.status = 'void' then
    raise exception 'Sotuv allaqachon bekor qilingan' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.sale_return_lines rl where rl.unit_id = p_unit_id) then
    raise exception 'Bu birlik rasmiy qaytarish jarayonidan o‘tgan; Qaytarish bo‘limidan davom eting' using errcode = 'P0001';
  end if;

  select * into v_location from public.locations
    where id = p_location_id and branch_id = v_sale.branch_id and is_active and type in ('store','warehouse');
  if not found then
    raise exception 'Qaytarish joylashuvi filialga mos emas' using errcode = '22023';
  end if;

  select * into v_line from public.sale_lines where sale_id = v_sale.id and unit_id = p_unit_id;
  if not found then raise exception 'Sotuv qatori topilmadi' using errcode = 'P0002'; end if;

  v_from_location := v_u.location_id;
  v_old_total := v_sale.total;

  -- Sale rows are immutable by design; only this audited RPC may rewrite them.
  alter table public.sale_lines disable trigger user;
  alter table public.sale_payments disable trigger user;

  delete from public.sale_lines where id = v_line.id;

  select count(*), coalesce(sum(unit_price),0), coalesce(sum(discount),0), coalesce(sum(tax),0), coalesce(sum(line_total),0)
    into v_remaining, v_subtotal, v_discount, v_tax, v_total
  from public.sale_lines where sale_id = v_sale.id;

  if v_remaining = 0 then
    delete from public.sale_payments where sale_id = v_sale.id;
    update public.sales set status = 'void', subtotal = 0, discount = 0, tax = 0, total = 0 where id = v_sale.id;
  else
    if coalesce(v_old_total,0) > 0 then
      for v_payment in select id, amount from public.sale_payments where sale_id = v_sale.id order by paid_at, id loop
        v_new_amount := round(v_payment.amount * v_total / v_old_total, 2);
        update public.sale_payments set amount = v_new_amount where id = v_payment.id;
        v_allocated := v_allocated + v_new_amount;
        v_last_payment := v_payment.id;
      end loop;
      if v_last_payment is not null and v_allocated <> v_total then
        update public.sale_payments set amount = amount + (v_total - v_allocated) where id = v_last_payment;
      end if;
      delete from public.sale_payments where sale_id = v_sale.id and amount <= 0;
    end if;
    update public.sales set subtotal = v_subtotal, discount = v_discount, tax = v_tax, total = v_total where id = v_sale.id;
  end if;

  alter table public.sale_payments enable trigger user;
  alter table public.sale_lines enable trigger user;

  update public.inventory_units
    set status = 'available', sold_sale_id = null, reserved_until = null,
        location_id = p_location_id, version = version + 1
    where id = p_unit_id;

  insert into public.inventory_movements(unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
    quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata)
  values(v_u.id, v_u.product_id, v_u.batch_id, 'returned', v_from_location, p_location_id, 1, v_line.unit_cost,
    'sale_revert', v_sale.id, nullif(btrim(p_reason), ''), auth.uid(),
    jsonb_build_object('sale_no', v_sale.sale_no, 'reverted_amount', v_line.line_total));

  insert into public.audit_log(actor_id, action, entity_table, entity_id, old_data, new_data)
  values(auth.uid(), 'sale_unit_revert', 'sales', v_sale.id::text,
    jsonb_build_object('total', v_old_total, 'unit_id', p_unit_id, 'line_total', v_line.line_total),
    jsonb_build_object('total', case when v_remaining = 0 then 0 else v_total end, 'remaining_lines', v_remaining,
      'location_id', p_location_id, 'reason', nullif(btrim(p_reason), '')));

  return jsonb_build_object(
    'unit_id', v_u.id,
    'qr_code', v_u.qr_code,
    'sale_id', v_sale.id,
    'sale_no', v_sale.sale_no,
    'sale_status', case when v_remaining = 0 then 'void' else v_sale.status::text end,
    'reverted_amount', v_line.line_total,
    'remaining_lines', v_remaining,
    'new_sale_total', case when v_remaining = 0 then 0 else v_total end,
    'location_id', p_location_id,
    'location_name', v_location.name,
    'location_type', v_location.type
  );
end;
$$;

revoke all on function public.manager_revert_unit_sale(uuid, uuid, text) from public, anon;
grant execute on function public.manager_revert_unit_sale(uuid, uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
