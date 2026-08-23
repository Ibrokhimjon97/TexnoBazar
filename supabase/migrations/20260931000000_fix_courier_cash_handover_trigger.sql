-- Fix: auto_create_courier_cash_handover used NEW.branch_id but deliveries table
-- has no branch_id column. branch_id should come from the related order (v_order).

begin;

create or replace function public.auto_create_courier_cash_handover()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_order  public.orders%rowtype;
  v_method public.payment_methods%rowtype;
begin
  if new.status = 'delivered' and (old.status is distinct from 'delivered') then
    select o.* into v_order from public.orders o where o.id = new.order_id;
    if v_order.id is null then return new; end if;

    select pm.* into v_method from public.payment_methods pm where pm.id = v_order.payment_method_id;
    -- Only COD (cash on delivery) orders need courier cash handover
    if v_method.code = 'cod' then
      insert into public.courier_cash_handovers (delivery_id, order_id, branch_id, courier_id, amount, currency)
      values (new.id, new.order_id, v_order.branch_id, new.courier_id, v_order.total, 'UZS')
      on conflict (delivery_id) do nothing;
    end if;
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';

commit;
