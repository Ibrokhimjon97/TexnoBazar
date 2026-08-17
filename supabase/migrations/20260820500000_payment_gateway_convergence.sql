begin;

-- Converge COD metadata instead of preserving stale catalog values on conflict.
insert into public.payment_methods(code,name,is_cash,is_online,is_active,sort_order)
values('cod','Yetkazib berishda to‘lov',true,false,true,50)
on conflict(code) do update set
  name=excluded.name,
  is_cash=excluded.is_cash,
  is_online=excluded.is_online,
  is_active=excluded.is_active,
  sort_order=excluded.sort_order;

-- Retire the legacy public order surface, including inherited PUBLIC execute.
revoke all on function public.create_online_order(jsonb,jsonb,jsonb,text,text,text)
from public, anon, authenticated;

-- Deterministic least-privilege closure for high-impact SECURITY DEFINER routines.
revoke all on function
  public.finalize_online_order_sale(uuid,uuid),
  public.complete_sale_return(uuid,uuid,uuid),
  public.execute_sale_exchange(uuid,uuid,uuid,jsonb,jsonb,uuid)
from public, anon, authenticated;

grant execute on function public.finalize_online_order_sale(uuid,uuid)
to service_role;

grant execute on function
  public.complete_sale_return(uuid,uuid,uuid),
  public.execute_sale_exchange(uuid,uuid,uuid,jsonb,jsonb,uuid)
to authenticated, service_role;

commit;
