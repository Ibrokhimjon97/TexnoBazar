-- Fix storefront_payment_methods to show all active payment methods suitable for online orders
-- Previously only showed click (if configured), payme (if configured), and cod
-- Now shows: cod always, all is_online methods (regardless of provider config), and uzum
create or replace function public.storefront_payment_methods(p_click_enabled boolean, p_payme_enabled boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(
    jsonb_build_object('code', m.code, 'name', m.name, 'is_online', m.is_online, 'is_cash', m.is_cash)
    order by m.sort_order, m.code
  ), '[]'::jsonb)
  from public.payment_methods m
  where m.is_active and (
    m.code = 'cod'
    or (m.code = 'click' and coalesce(p_click_enabled, false))
    or (m.code = 'payme' and coalesce(p_payme_enabled, false))
    or (m.is_online and m.code not in ('click', 'payme'))
  );
$$;
