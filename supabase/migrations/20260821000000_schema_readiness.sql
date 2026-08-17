-- Public, non-secret application/schema compatibility probe.
begin;

create or replace function public.app_schema_readiness()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with required_functions(signature, migration) as (
    values
      ('public.get_my_access_context()', '20260102000000'),
      ('public.get_pos_references(uuid)', '20260111000000'),
      ('public.storefront_cms_payload()', '20260113000000'),
      ('public.get_management_dashboard(date,date,uuid)', '20260113000000'),
      ('public.get_manager_workspace_references(uuid)', '20260113000000'),
      ('public.list_courier_deliveries(public.delivery_status,integer,integer)', '20260113000000'),
      ('public.storefront_catalog_faceted(jsonb,integer,integer)', '20260818000000'),
      ('public.report_seller_performance(date,date,uuid)', '20260819000000'),
      ('public.create_online_order_v2(jsonb,jsonb,jsonb,text,text,text,text)', '20260820000000'),
      ('public.storefront_payment_methods(boolean,boolean)', '20260820000000'),
      ('public.list_provider_refunds(uuid)', '20260820000000'),
      ('public.payment_runtime_hardening_version()', '20260822000000')
  ), required_columns(relation_name, column_name, migration) as (
    values
      ('orders', 'checkout_token_hash', '20260820000000'),
      ('products', 'description_blocks', '20260818000000'),
      ('payment_transactions', 'state', '20260820000000'),
      ('payment_refund_transactions', 'state', '20260820000000')
  ), missing as (
    select 'function'::text object_type, f.signature object_name, f.migration
    from required_functions f
    where pg_catalog.to_regprocedure(f.signature) is null
    union all
    select 'column', format('public.%I.%I', c.relation_name, c.column_name), c.migration
    from required_columns c
    where not exists (
      select 1 from information_schema.columns i
      where i.table_schema = 'public' and i.table_name = c.relation_name and i.column_name = c.column_name
    )
  )
  select jsonb_build_object(
    'ok', not exists(select 1 from missing),
    'schema_version', '20260822000000',
    'missing', coalesce((select jsonb_agg(to_jsonb(m) order by m.migration, m.object_type, m.object_name) from missing m), '[]'::jsonb)
  );
$$;

revoke all on function public.app_schema_readiness() from public;
grant execute on function public.app_schema_readiness() to anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
