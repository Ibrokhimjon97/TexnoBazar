begin;

create or replace function public.list_my_pos_sales_filtered(
  p_branch_id uuid,
  p_date date,
  p_query text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_date date;
  v_start timestamptz;
  v_end timestamptz;
  v_query text := nullif(btrim(p_query), '');
  v_items jsonb;
  v_total bigint;
  v_kpi jsonb;
begin
  perform public.require_pos_seller(p_branch_id);
  if p_limit not between 1 and 100 or p_offset < 0 then
    raise exception 'Sahifalash noto‘g‘ri' using errcode = '22023';
  end if;

  select coalesce(b.timezone, 'Asia/Tashkent') into v_timezone
  from public.branches b
  where b.id = p_branch_id;
  if v_timezone is null then
    raise exception 'Filial topilmadi' using errcode = 'P0002';
  end if;

  v_date := coalesce(p_date, (now() at time zone v_timezone)::date);
  v_start := v_date::timestamp at time zone v_timezone;
  v_end := (v_date + 1)::timestamp at time zone v_timezone;

  select count(*) into v_total
  from public.sales s
  where s.branch_id = p_branch_id
    and s.seller_id = auth.uid()
    and s.status <> 'void'
    and s.sold_at >= v_start and s.sold_at < v_end
    and (
      v_query is null
      or s.sale_no ilike '%' || v_query || '%'
      or exists (
        select 1
        from public.sale_lines x
        join public.products p on p.id = x.product_id
        join public.inventory_units u on u.id = x.unit_id
        where x.sale_id = s.id
          and (
            p.name ilike '%' || v_query || '%'
            or p.sku ilike '%' || v_query || '%'
            or u.qr_code ilike '%' || v_query || '%'
            or coalesce(u.serial_number, '') ilike '%' || v_query || '%'
          )
      )
    );

  select coalesce(jsonb_agg(to_jsonb(q) order by q.sold_at desc, q.id), '[]'::jsonb)
  into v_items
  from (
    select
      s.id, s.sale_no, s.pending_sale_id, s.seller_id,
      seller.full_name as seller_name,
      s.manager_id, manager.full_name as manager_name,
      s.subtotal, s.discount, s.tax, s.total, s.status, s.sold_at,
      (select count(*) from public.sale_lines x where x.sale_id = s.id) as unit_count,
      (select coalesce(sum(x.line_total - x.tax - x.unit_cost), 0) from public.sale_lines x where x.sale_id = s.id) as profit
    from public.sales s
    join public.profiles seller on seller.id = s.seller_id
    left join public.profiles manager on manager.id = s.manager_id
    where s.branch_id = p_branch_id
      and s.seller_id = auth.uid()
      and s.status <> 'void'
      and s.sold_at >= v_start and s.sold_at < v_end
      and (
        v_query is null
        or s.sale_no ilike '%' || v_query || '%'
        or exists (
          select 1
          from public.sale_lines x
          join public.products p on p.id = x.product_id
          join public.inventory_units u on u.id = x.unit_id
          where x.sale_id = s.id
            and (
              p.name ilike '%' || v_query || '%'
              or p.sku ilike '%' || v_query || '%'
              or u.qr_code ilike '%' || v_query || '%'
              or coalesce(u.serial_number, '') ilike '%' || v_query || '%'
            )
        )
      )
    order by s.sold_at desc, s.id
    limit p_limit offset p_offset
  ) q;

  select jsonb_build_object(
    'count', count(*),
    'total', coalesce(sum(q.total), 0),
    'profit', coalesce(sum(q.profit), 0),
    'avg_check', coalesce(round(avg(q.total), 2), 0),
    'discount', coalesce(sum(q.discount), 0)
  )
  into v_kpi
  from (
    select
      s.total,
      s.discount,
      coalesce((select sum(x.line_total - x.tax - x.unit_cost) from public.sale_lines x where x.sale_id = s.id), 0) as profit
    from public.sales s
    where s.branch_id = p_branch_id
      and s.seller_id = auth.uid()
      and s.status <> 'void'
      and s.sold_at >= v_start and s.sold_at < v_end
      and (
        v_query is null
        or s.sale_no ilike '%' || v_query || '%'
        or exists (
          select 1
          from public.sale_lines x
          join public.products p on p.id = x.product_id
          join public.inventory_units u on u.id = x.unit_id
          where x.sale_id = s.id
            and (
              p.name ilike '%' || v_query || '%'
              or p.sku ilike '%' || v_query || '%'
              or u.qr_code ilike '%' || v_query || '%'
              or coalesce(u.serial_number, '') ilike '%' || v_query || '%'
            )
        )
      )
  ) q;

  return jsonb_build_object('items', v_items, 'total', v_total, 'today', v_kpi, 'date', v_date);
end;
$$;

create or replace function public.list_my_pos_pending_sales_by_date(
  p_branch_id uuid,
  p_date date,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_timezone text;
  v_date date;
  v_start timestamptz;
  v_end timestamptz;
  v_items jsonb;
  v_total bigint;
begin
  perform public.require_pos_seller(p_branch_id);
  perform public.release_expired_pos_sales(p_branch_id);
  if p_limit not between 1 and 100 or p_offset < 0 then
    raise exception 'Sahifalash noto‘g‘ri' using errcode = '22023';
  end if;

  select coalesce(b.timezone, 'Asia/Tashkent') into v_timezone
  from public.branches b
  where b.id = p_branch_id;
  if v_timezone is null then
    raise exception 'Filial topilmadi' using errcode = 'P0002';
  end if;

  v_date := coalesce(p_date, (now() at time zone v_timezone)::date);
  v_start := v_date::timestamp at time zone v_timezone;
  v_end := (v_date + 1)::timestamp at time zone v_timezone;

  select count(*) into v_total
  from public.pos_pending_sales s
  where s.branch_id = p_branch_id
    and s.seller_id = auth.uid()
    and s.created_at >= v_start and s.created_at < v_end;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc, q.id), '[]'::jsonb)
  into v_items
  from (
    select
      s.id, s.pending_no, s.status, s.seller_id,
      p.full_name as seller_name,
      s.store_location_id, l.name as location_name,
      (select count(*) from public.pos_pending_sale_lines x where x.pending_sale_id = s.id) as unit_count,
      s.total, s.created_at, s.expires_at
    from public.pos_pending_sales s
    join public.profiles p on p.id = s.seller_id
    join public.locations l on l.id = s.store_location_id
    where s.branch_id = p_branch_id
      and s.seller_id = auth.uid()
      and s.created_at >= v_start and s.created_at < v_end
    order by s.created_at desc, s.id
    limit p_limit offset p_offset
  ) q;

  return jsonb_build_object('items', v_items, 'total', v_total, 'date', v_date);
end;
$$;

revoke all on function public.list_my_pos_sales_filtered(uuid, date, text, integer, integer) from public, anon;
revoke all on function public.list_my_pos_pending_sales_by_date(uuid, date, integer, integer) from public, anon;
grant execute on function public.list_my_pos_sales_filtered(uuid, date, text, integer, integer) to authenticated, service_role;
grant execute on function public.list_my_pos_pending_sales_by_date(uuid, date, integer, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
