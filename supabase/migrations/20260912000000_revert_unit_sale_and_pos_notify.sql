begin;

-- 1) Manager may cancel the sale of a single scanned unit: the unit returns to a
--    store/warehouse balance of its own branch and the money leaves the sale
--    totals, so the item counts as never sold. Units that already went through
--    the formal return workflow are refused here to avoid double accounting.
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

  -- Remove the sale line (immutability is intentional; only this RPC bypasses it).
  alter table public.sale_lines disable trigger sale_lines_immutable;
  delete from public.sale_lines where id = v_line.id;
  alter table public.sale_lines enable trigger sale_lines_immutable;

  select count(*), coalesce(sum(unit_price),0), coalesce(sum(discount),0), coalesce(sum(tax),0), coalesce(sum(line_total),0)
    into v_remaining, v_subtotal, v_discount, v_tax, v_total
  from public.sale_lines where sale_id = v_sale.id;

  -- Money follows the remaining lines; a fully reverted sale becomes void.
  alter table public.sale_payments disable trigger sale_payments_refund_guard;
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
  alter table public.sale_payments enable trigger sale_payments_refund_guard;

  update public.inventory_units
    set status = 'available', sold_sale_id = null, reserved_until = null,
        location_id = p_location_id, version = version + 1
    where id = p_unit_id;

  insert into public.inventory_movements(unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
    quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata)
  values(v_u.id, v_u.product_id, v_u.batch_id, 'returned', v_from_location, p_location_id, 1, v_line.unit_cost,
    'sale_revert', v_sale.id, nullif(btrim(p_reason), ''), auth.uid(),
    jsonb_build_object('sale_no', v_sale.sale_no, 'reverted_amount', v_line.line_total));

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

-- 2) A queued POS sale must reach the branch managers immediately.
create or replace function public.notify_pos_pending_sale()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_recipient uuid; v_seller text; v_units integer; v_branch text;
begin
  if new.status <> 'pending' then return new; end if;
  select full_name into v_seller from public.profiles where id = new.seller_id;
  select name into v_branch from public.branches where id = new.branch_id;
  select count(*) into v_units from public.pos_pending_sale_lines where pending_sale_id = new.id;
  for v_recipient in
    select distinct r.profile_id from public.profile_roles r
    join public.profiles p on p.id = r.profile_id and p.is_active
    where r.role = 'manager' and r.branch_id = new.branch_id and r.profile_id is distinct from new.seller_id
  loop
    insert into public.notifications(recipient_id, channel, title, body, data, sent_at)
    values(v_recipient, 'in_app',
      'Kassaga yangi savdo so‘rovi',
      coalesce(v_seller, 'Sotuvchi') || ' ' || coalesce(v_units, 0)::text || ' dona mahsulotni tasdiqlashga yubordi · '
        || to_char(new.total, 'FM999G999G999G990D00') || ' · ' || coalesce(v_branch, ''),
      jsonb_build_object('type', 'pos_pending_sale', 'pending_sale_id', new.id, 'pending_no', new.pending_no,
        'branch_id', new.branch_id, 'total', new.total, 'unit_count', v_units),
      now());
  end loop;
  return new;
end;
$$;

drop trigger if exists pos_pending_sales_notify on public.pos_pending_sales;
create trigger pos_pending_sales_notify
after insert on public.pos_pending_sales
for each row execute function public.notify_pos_pending_sale();

revoke all on function public.notify_pos_pending_sale() from public, anon, authenticated;
grant execute on function public.notify_pos_pending_sale() to service_role;

notify pgrst, 'reload schema';
commit;
