-- Branch fulfillment stock preview must count only units matching the order line's
-- exact color variant, otherwise a branch could look "fully stocked" while only
-- holding the wrong color.
begin;

create or replace function public.get_order_branch_stock(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.require_ai_user(); -- admin/manager only

  select coalesce(jsonb_agg(to_jsonb(q) order by q.branch_name), '[]'::jsonb) into v_result
  from (
    select
      b.id as branch_id,
      b.name as branch_name,
      b.code as branch_code,
      jsonb_agg(jsonb_build_object(
        'product_id', sub.product_id,
        'product_name', sub.product_name,
        'variant_color', sub.variant_color,
        'needed', sub.needed,
        'available', sub.available
      ) order by sub.product_name) as products,
      min(sub.available) as min_available,
      bool_and(sub.available >= sub.needed) as can_fulfill
    from public.branches b
    cross join lateral (
      select
        ol.product_id,
        ol.product_name,
        ol.variant_color,
        ol.quantity::integer as needed,
        coalesce((
          select count(*)::integer
          from public.inventory_units u
          join public.locations l on l.id = u.location_id
          where u.product_id = ol.product_id
            and u.variant_id is not distinct from ol.variant_id
            and l.branch_id = b.id
            and l.is_active
            and l.type in ('store', 'warehouse')
            and u.status = 'available'
            and u.active_transfer_id is null
        ), 0) as available
      from public.order_lines ol
      where ol.order_id = p_order_id
    ) sub
    where b.is_active
    group by b.id, b.name, b.code
  ) q;

  return v_result;
end $$;

notify pgrst, 'reload schema';

commit;
