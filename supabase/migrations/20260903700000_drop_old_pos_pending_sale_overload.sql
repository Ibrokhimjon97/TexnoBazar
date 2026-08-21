-- create or replace with an extra trailing param creates an overload rather than
-- replacing the function (Postgres treats differing argument lists as distinct
-- functions). Drop the old 5-arg signature so PostgREST has a single unambiguous
-- create_pos_pending_sale to route RPC calls to.
drop function if exists public.create_pos_pending_sale(uuid, jsonb, jsonb, uuid, text);
