begin;

-- Add product slug to order_lines in list_manager_orders and list_admin_orders
create or replace function public.list_manager_orders(p_branch_id uuid,p_status text default null,p_query text default null,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_items jsonb; v_total bigint;
begin
  if p_branch_id is null or not public.current_user_active() or not(
    public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager']::public.app_role[],p_branch_id)) then
    raise exception 'Filial menejeri roli talab qilinadi' using errcode='42501';
  end if;
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto''g''ri' using errcode='22023'; end if;
  if nullif(p_status,'') is not null and not exists(select 1 from unnest(enum_range(null::public.order_status)) x where x::text=p_status) then
    raise exception 'Buyurtma statusi noto''g''ri' using errcode='22023';
  end if;
  select count(*) into v_total from public.orders o where (o.branch_id=p_branch_id or (o.branch_id is null and o.status='new'))
    and (nullif(p_status,'') is null or o.status::text=p_status)
    and (nullif(btrim(p_query),'') is null or o.order_no ilike '%'||btrim(p_query)||'%' or o.customer_name ilike '%'||btrim(p_query)||'%' or o.customer_phone ilike '%'||btrim(p_query)||'%');
  select coalesce(jsonb_agg(to_jsonb(q) order by q.placed_at desc,q.id),'[]'::jsonb) into v_items from(
    select o.id,o.order_no,o.branch_id,o.status,o.customer_name,o.customer_phone,o.shipping_address,o.notes,
      o.subtotal,o.discount,o.delivery_fee,o.total,o.payment_status,o.placed_at,
      coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'product_id',l.product_id,'product_name',l.product_name,
        'sku',l.sku,'slug',p.slug,'quantity',l.quantity,'unit_price',l.unit_price,'discount',l.discount,'line_total',l.line_total) order by l.id)
        from public.order_lines l join public.products p on p.id=l.product_id where l.order_id=o.id),'[]'::jsonb) order_lines,
      (select jsonb_build_object('id',d.id,'courier_id',d.courier_id,'status',d.status,'tracking_code',d.tracking_code,
        'assigned_at',d.assigned_at,'picked_up_at',d.picked_up_at,'delivered_at',d.delivered_at)
        from public.deliveries d where d.order_id=o.id) delivery
    from public.orders o where (o.branch_id=p_branch_id or (o.branch_id is null and o.status='new'))
      and (nullif(p_status,'') is null or o.status::text=p_status)
      and (nullif(btrim(p_query),'') is null or o.order_no ilike '%'||btrim(p_query)||'%' or o.customer_name ilike '%'||btrim(p_query)||'%' or o.customer_phone ilike '%'||btrim(p_query)||'%')
    order by o.placed_at desc,o.id limit p_limit offset p_offset
  )q;
  return jsonb_build_object('items',v_items,'total',v_total);
end $$;

notify pgrst, 'reload schema';
commit;
