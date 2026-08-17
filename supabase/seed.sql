-- Idempotent reference seed data only.
insert into public.payment_methods (code, name, is_cash, is_online, is_active, sort_order)
values
  ('cash', 'Naqd', true, false, true, 10),
  ('card', 'Bank kartasi / terminal', false, false, true, 20),
  ('click', 'Click', false, true, true, 30),
  ('payme', 'Payme', false, true, true, 40),
  ('uzum', 'Uzum Bank', false, true, true, 50),
  ('cod', 'Yetkazishda naqd to‘lov', true, true, true, 60),
  ('bank_transfer', 'Bank o‘tkazmasi', false, false, true, 70),
  ('installment', 'Nasiya', false, false, true, 80),
  ('other', 'Boshqa', false, false, true, 90)
on conflict (code) do update set
  name = excluded.name,
  is_cash = excluded.is_cash,
  is_online = excluded.is_online,
  is_active = excluded.is_active,
  sort_order = excluded.sort_order;

insert into public.system_settings (key, value, description, is_public)
values
  ('store.currency', '"UZS"'::jsonb, 'Default transaction currency', true),
  ('store.timezone', '"Asia/Tashkent"'::jsonb, 'Default business timezone', true),
  ('orders.default_delivery_fee', '0'::jsonb, 'Default online-order delivery fee', true),
  ('pos.reservation_minutes', '15'::jsonb, 'POS unit reservation lifetime', false),
  ('inventory.allow_negative', 'false'::jsonb, 'Whether aggregate inventory may be negative', false),
  ('storefront.orders_enabled', 'true'::jsonb, 'Whether online checkout is enabled', true)
on conflict (key) do update set
  value = excluded.value,
  description = excluded.description,
  is_public = excluded.is_public,
  updated_at = now();
