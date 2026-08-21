-- Read-only aggregate RPCs used as AI "tools".
--
-- These are invoked by the serverless AI endpoint using the CALLING USER's JWT,
-- not the service role. That means require_report_access() inside each function
-- still enforces the same branch/role boundaries the UI has, so the assistant can
-- never surface data the asking user could not already open by hand.

-- ---------------------------------------------------------------------------
-- Reference data (used by the model to resolve names -> ids and to disambiguate)
-- ---------------------------------------------------------------------------
create or replace function public.ai_list_branches()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb;
begin
  perform public.require_ai_user();
  select coalesce(jsonb_agg(jsonb_build_object(
    'branch_id', b.id, 'name', b.name, 'code', b.code, 'is_active', b.is_active,
    'locations', coalesce((select jsonb_agg(jsonb_build_object('location_id', l.id, 'name', l.name, 'type', l.type)
      order by l.type, l.name) from public.locations l where l.branch_id = b.id and l.is_active), '[]'::jsonb),
    'can_access', public.can_access_branch(b.id)
  ) order by b.name), '[]'::jsonb) into v_items
  from public.branches b where b.is_active;
  return v_items;
end $$;

create or replace function public.ai_search_employees(p_query text default null, p_limit integer default 10)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_q text := nullif(btrim(p_query), '');
begin
  perform public.require_ai_user();
  select coalesce(jsonb_agg(jsonb_build_object(
    'employee_id', q.id, 'full_name', q.full_name, 'phone', q.phone, 'is_active', q.is_active, 'roles', q.roles
  ) order by q.full_name), '[]'::jsonb) into v_items
  from (
    select p.id, p.full_name, p.phone, p.is_active,
      coalesce((select jsonb_agg(distinct jsonb_build_object('role', r.role, 'branch_id', r.branch_id, 'branch_name', br.name))
        from public.profile_roles r left join public.branches br on br.id = r.branch_id
        where r.profile_id = p.id and r.role <> 'customer'), '[]'::jsonb) as roles
    from public.profiles p
    where exists(select 1 from public.profile_roles r where r.profile_id = p.id and r.role <> 'customer')
      and (v_q is null or p.full_name ilike '%' || v_q || '%' or coalesce(p.phone, '') ilike '%' || v_q || '%')
    order by p.full_name
    limit greatest(least(coalesce(p_limit, 10), 50), 1)
  ) q;
  return v_items;
end $$;

create or replace function public.ai_search_products(p_query text default null, p_limit integer default 10)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_q text := nullif(btrim(p_query), '');
begin
  perform public.require_ai_user();
  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', q.id, 'name', q.name, 'sku', q.sku, 'slug', q.slug,
    'status', q.status, 'is_published', q.is_published,
    'cost_price', q.cost_price, 'retail_price', q.retail_price,
    'wholesale_price', q.wholesale_price, 'minimum_sale_price', q.minimum_sale_price,
    'brand_name', q.brand_name, 'category_name', q.category_name,
    'available_units', q.available_units
  ) order by q.name), '[]'::jsonb) into v_items
  from (
    select p.id, p.name, p.sku, p.slug, p.status::text as status, p.is_published,
      p.cost_price, p.retail_price, p.wholesale_price, p.minimum_sale_price,
      br.name as brand_name, c.name as category_name,
      (select count(*) from public.inventory_units u where u.product_id = p.id and u.status = 'available') as available_units
    from public.products p
    left join public.brands br on br.id = p.brand_id
    left join public.categories c on c.id = p.category_id
    where v_q is null or p.name ilike '%' || v_q || '%' or p.sku ilike '%' || v_q || '%'
      or coalesce(p.barcode, '') ilike '%' || v_q || '%'
    order by p.name
    limit greatest(least(coalesce(p_limit, 10), 30), 1)
  ) q;
  return v_items;
end $$;

-- ---------------------------------------------------------------------------
-- Inventory valuation: unit-level so batch-specific prices are respected.
-- Answers "omborda qancha tovar bor, tannarxi, min/ulgurji narxda qancha bo'ladi".
-- ---------------------------------------------------------------------------
create or replace function public.ai_inventory_valuation(
  p_branch_id uuid default null,
  p_location_type text default null,
  p_top_limit integer default 10
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rate numeric; v_summary jsonb; v_by_location jsonb; v_top jsonb;
begin
  perform public.require_report_access(p_branch_id);
  if p_location_type is not null and p_location_type not in ('store','warehouse') then
    raise exception 'location_type faqat store yoki warehouse bo''lishi mumkin' using errcode = '22023';
  end if;

  select rate into v_rate from public.exchange_rates
  where currency_from = 'USD' and currency_to = 'UZS' order by rate_date desc limit 1;

  with scoped as (
    select u.id, u.product_id, l.branch_id, b.name as branch_name, l.id as location_id,
      l.name as location_name, l.type::text as location_type,
      coalesce(sb.unit_cost, p.cost_price) as unit_cost,
      coalesce(sb.minimum_sale_price, p.minimum_sale_price, p.retail_price) as min_price,
      coalesce(sb.wholesale_price, p.wholesale_price, p.retail_price) as wholesale_price,
      coalesce(sb.retail_price, p.retail_price) as retail_price,
      p.name as product_name, p.sku
    from public.inventory_units u
    join public.locations l on l.id = u.location_id
    join public.branches b on b.id = l.branch_id
    join public.products p on p.id = u.product_id
    left join public.stock_batches sb on sb.id = u.batch_id
    where u.status in ('available','reserved','returned')
      and l.is_active and l.type in ('store','warehouse')
      and (p_branch_id is null or l.branch_id = p_branch_id)
      and (p_location_type is null or l.type::text = p_location_type)
  )
  select
    jsonb_build_object(
      'unit_count', count(*),
      'product_type_count', count(distinct product_id),
      'total_cost_uzs', coalesce(sum(unit_cost), 0),
      'total_at_minimum_uzs', coalesce(sum(min_price), 0),
      'total_at_wholesale_uzs', coalesce(sum(wholesale_price), 0),
      'total_at_retail_uzs', coalesce(sum(retail_price), 0),
      'profit_at_minimum_uzs', coalesce(sum(min_price) - sum(unit_cost), 0),
      'profit_at_wholesale_uzs', coalesce(sum(wholesale_price) - sum(unit_cost), 0),
      'profit_at_retail_uzs', coalesce(sum(retail_price) - sum(unit_cost), 0)
    ),
    coalesce((select jsonb_agg(jsonb_build_object(
        'branch_name', g.branch_name, 'location_name', g.location_name, 'location_type', g.location_type,
        'unit_count', g.unit_count, 'product_type_count', g.product_type_count,
        'total_cost_uzs', g.total_cost, 'total_at_minimum_uzs', g.total_min,
        'total_at_wholesale_uzs', g.total_wholesale, 'total_at_retail_uzs', g.total_retail,
        'profit_at_minimum_uzs', g.total_min - g.total_cost,
        'profit_at_wholesale_uzs', g.total_wholesale - g.total_cost)
      order by g.total_cost desc)
      from (select branch_name, location_name, location_type, count(*) as unit_count,
              count(distinct product_id) as product_type_count, sum(unit_cost) as total_cost,
              sum(min_price) as total_min, sum(wholesale_price) as total_wholesale, sum(retail_price) as total_retail
            from scoped group by branch_name, location_name, location_type) g), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
        'product_name', t.product_name, 'sku', t.sku, 'unit_count', t.unit_count,
        'total_cost_uzs', t.total_cost, 'total_at_retail_uzs', t.total_retail)
      order by t.total_cost desc)
      from (select product_name, sku, count(*) as unit_count, sum(unit_cost) as total_cost, sum(retail_price) as total_retail
            from scoped group by product_name, sku
            order by sum(unit_cost) desc
            limit greatest(least(coalesce(p_top_limit, 10), 50), 1)) t), '[]'::jsonb)
  into v_summary, v_by_location, v_top
  from scoped;

  return jsonb_build_object(
    'exchange_rate_usd_uzs', v_rate,
    'summary', v_summary,
    'by_location', v_by_location,
    'top_products_by_cost', v_top,
    'note', 'Barcha summalar UZS da. USD uchun exchange_rate_usd_uzs ga bo''ling.'
  );
end $$;

-- ---------------------------------------------------------------------------
-- Seller performance: "Ilhomjon bugun qanday savdo qildi", "top 5 xodim"
-- ---------------------------------------------------------------------------
create or replace function public.ai_seller_performance(
  p_from date default current_date,
  p_to date default current_date,
  p_branch_id uuid default null,
  p_employee_query text default null,
  p_limit integer default 5
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rate numeric; v_items jsonb; v_totals jsonb; v_q text := nullif(btrim(p_employee_query), '');
begin
  perform public.require_report_access(p_branch_id);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Sana oralig''i noto''g''ri' using errcode = '22023';
  end if;

  select rate into v_rate from public.exchange_rates
  where currency_from = 'USD' and currency_to = 'UZS' order by rate_date desc limit 1;

  with lines as (
    select s.seller_id, pr.full_name, s.branch_id, b.name as branch_name, s.id as sale_id,
      sl.unit_cost, sl.line_total, sl.tax, sl.discount
    from public.sales s
    join public.sale_lines sl on sl.sale_id = s.id
    join public.profiles pr on pr.id = s.seller_id
    join public.branches b on b.id = s.branch_id
    where s.status <> 'void'
      and s.sold_at >= public.business_day_start(p_from)
      and s.sold_at < public.business_day_start(p_to + 1)
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and (v_q is null or pr.full_name ilike '%' || v_q || '%')
  ), agg as (
    select seller_id, full_name, branch_name,
      count(distinct sale_id) as sale_count,
      count(*) as unit_count,
      sum(unit_cost) as total_cost,
      sum(line_total - tax) as revenue_net,
      sum(discount) as total_discount,
      sum(line_total - tax - unit_cost) as profit
    from lines group by seller_id, full_name, branch_name
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
      'employee_id', a.seller_id, 'full_name', a.full_name, 'branch_name', a.branch_name,
      'sale_count', a.sale_count, 'unit_count', a.unit_count,
      'total_cost_uzs', a.total_cost, 'revenue_net_uzs', a.revenue_net,
      'total_discount_uzs', a.total_discount, 'profit_uzs', a.profit)
      order by a.revenue_net desc)
      from (select * from agg order by revenue_net desc limit greatest(least(coalesce(p_limit, 5), 50), 1)) a), '[]'::jsonb),
    jsonb_build_object(
      'seller_count', (select count(*) from agg),
      'sale_count', coalesce((select sum(sale_count) from agg), 0),
      'unit_count', coalesce((select sum(unit_count) from agg), 0),
      'total_cost_uzs', coalesce((select sum(total_cost) from agg), 0),
      'revenue_net_uzs', coalesce((select sum(revenue_net) from agg), 0),
      'profit_uzs', coalesce((select sum(profit) from agg), 0))
  into v_items, v_totals;

  return jsonb_build_object('from', p_from, 'to', p_to, 'exchange_rate_usd_uzs', v_rate,
    'sellers', v_items, 'totals', v_totals,
    'note', 'revenue_net = soliqsiz tushum. profit = line_total - tax - unit_cost. Summalar UZS.');
end $$;

-- ---------------------------------------------------------------------------
-- Product performance: best/worst sellers, and stock that never moved.
-- ---------------------------------------------------------------------------
create or replace function public.ai_product_performance(
  p_from date default current_date,
  p_to date default current_date,
  p_branch_id uuid default null,
  p_order text default 'best',
  p_limit integer default 10
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_stale jsonb;
begin
  perform public.require_report_access(p_branch_id);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Sana oralig''i noto''g''ri' using errcode = '22023';
  end if;
  if p_order not in ('best','worst') then
    raise exception 'order faqat best yoki worst bo''lishi mumkin' using errcode = '22023';
  end if;

  with sold as (
    select p.id, p.sku, p.name,
      count(*) as sold_units,
      sum(sl.line_total - sl.tax) as revenue_net,
      sum(sl.line_total - sl.tax - sl.unit_cost) as profit,
      max(s.sold_at) as last_sold_at
    from public.sale_lines sl
    join public.sales s on s.id = sl.sale_id and s.status <> 'void'
    join public.products p on p.id = sl.product_id
    where s.sold_at >= public.business_day_start(p_from)
      and s.sold_at < public.business_day_start(p_to + 1)
      and (p_branch_id is null or s.branch_id = p_branch_id)
    group by p.id, p.sku, p.name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', q.id, 'name', q.name, 'sku', q.sku, 'sold_units', q.sold_units,
    'revenue_net_uzs', q.revenue_net, 'profit_uzs', q.profit, 'last_sold_at', q.last_sold_at)
    order by case when p_order = 'best' then q.sold_units end desc nulls last,
             case when p_order = 'worst' then q.sold_units end asc nulls last), '[]'::jsonb)
  into v_items
  from (
    select * from sold
    order by case when p_order = 'best' then sold_units end desc,
             case when p_order = 'worst' then sold_units end asc
    limit greatest(least(coalesce(p_limit, 10), 50), 1)
  ) q;

  -- Products sitting in stock with zero sales in the window: the real "dead stock".
  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', q.id, 'name', q.name, 'sku', q.sku, 'stock_units', q.stock_units,
    'stock_cost_uzs', q.stock_cost) order by q.stock_cost desc), '[]'::jsonb)
  into v_stale
  from (
    select p.id, p.name, p.sku,
      count(u.id) as stock_units,
      sum(coalesce(sb.unit_cost, p.cost_price)) as stock_cost
    from public.products p
    join public.inventory_units u on u.product_id = p.id and u.status = 'available'
    join public.locations l on l.id = u.location_id and l.is_active and l.type in ('store','warehouse')
    left join public.stock_batches sb on sb.id = u.batch_id
    where (p_branch_id is null or l.branch_id = p_branch_id)
      and not exists(
        select 1 from public.sale_lines sl join public.sales s on s.id = sl.sale_id
        where sl.product_id = p.id and s.status <> 'void'
          and s.sold_at >= public.business_day_start(p_from)
          and s.sold_at < public.business_day_start(p_to + 1)
          and (p_branch_id is null or s.branch_id = p_branch_id))
    group by p.id, p.name, p.sku
    order by sum(coalesce(sb.unit_cost, p.cost_price)) desc
    limit greatest(least(coalesce(p_limit, 10), 50), 1)
  ) q;

  return jsonb_build_object('from', p_from, 'to', p_to, 'order', p_order,
    'products', v_items, 'unsold_stock', v_stale,
    'note', 'unsold_stock = shu oraliqda hech sotilmagan, lekin qoldiqda turgan tovarlar.');
end $$;

-- ---------------------------------------------------------------------------
-- Combined expense report: finance_transactions + expenses + salary_payments.
-- report_expense_breakdown only covers finance_transactions, which is why the
-- manually entered tax/salary rows were invisible in it.
-- ---------------------------------------------------------------------------
create or replace function public.ai_expense_report(
  p_from date default (date_trunc('month', current_date))::date,
  p_to date default current_date,
  p_branch_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rate numeric; v_categories jsonb; v_salaries jsonb; v_total numeric := 0;
begin
  perform public.require_report_access(p_branch_id);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Sana oralig''i noto''g''ri' using errcode = '22023';
  end if;

  select rate into v_rate from public.exchange_rates
  where currency_from = 'USD' and currency_to = 'UZS' order by rate_date desc limit 1;

  with combined as (
    select 'finance' as source, t.category, t.amount
    from public.finance_transactions t
    where t.type = 'expense'
      and t.occurred_at >= public.business_day_start(p_from)
      and t.occurred_at < public.business_day_start(p_to + 1)
      and (p_branch_id is null or t.branch_id = p_branch_id)
    union all
    select 'manual', e.category, e.amount
    from public.expenses e
    where (e.period_month || '-01')::date >= date_trunc('month', p_from)::date
      and (e.period_month || '-01')::date <= p_to
      and (p_branch_id is null or e.branch_id = p_branch_id)
    union all
    select 'salary', 'salary', (sp.base_salary + sp.bonus)
    from public.salary_payments sp
    where (sp.period_month || '-01')::date >= date_trunc('month', p_from)::date
      and (sp.period_month || '-01')::date <= p_to
      and (p_branch_id is null or sp.branch_id = p_branch_id)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'source', g.source, 'category', g.category, 'amount_uzs', g.amount, 'entry_count', g.cnt)
    order by g.amount desc), '[]'::jsonb),
    coalesce(sum(g.amount), 0)
  into v_categories, v_total
  from (select source, category, sum(amount) as amount, count(*) as cnt from combined group by source, category) g;

  select coalesce(jsonb_agg(jsonb_build_object(
    'employee_name', q.full_name, 'period_month', q.period_month,
    'base_salary_uzs', q.base_salary, 'bonus_uzs', q.bonus,
    'advance_paid_uzs', q.advance_paid, 'salary_paid_uzs', q.salary_paid,
    'extra_paid_uzs', q.extra_paid, 'remaining_uzs', q.remaining)
    order by q.full_name), '[]'::jsonb)
  into v_salaries
  from (
    select pr.full_name, sp.period_month, sp.base_salary, sp.bonus, sp.advance_paid,
      sp.salary_paid, coalesce(sp.extra_paid, 0) as extra_paid,
      (sp.base_salary + sp.bonus - sp.salary_paid - sp.advance_paid - coalesce(sp.extra_paid, 0)) as remaining
    from public.salary_payments sp
    join public.profiles pr on pr.id = sp.employee_id
    where (sp.period_month || '-01')::date >= date_trunc('month', p_from)::date
      and (sp.period_month || '-01')::date <= p_to
      and (p_branch_id is null or sp.branch_id = p_branch_id)
  ) q;

  return jsonb_build_object('from', p_from, 'to', p_to, 'exchange_rate_usd_uzs', v_rate,
    'total_expense_uzs', v_total, 'categories', v_categories, 'salary_detail', v_salaries,
    'note', 'source: finance=kassa tranzaksiyalari, manual=qo''lda kiritilgan xarajatlar, salary=maosh.');
end $$;

-- ---------------------------------------------------------------------------
-- Employee salary detail (admin view of a specific person).
-- ---------------------------------------------------------------------------
create or replace function public.ai_employee_salary(
  p_employee_query text,
  p_period_month text default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_q text := nullif(btrim(p_employee_query), '');
begin
  -- Salary data is global admin territory (matches the admin_all_salary RLS policy).
  perform public.require_report_access(null);
  if v_q is null then
    raise exception 'Xodim ismi talab qilinadi' using errcode = '22023';
  end if;
  if p_period_month is not null and p_period_month !~ '^\d{4}-\d{2}$' then
    raise exception 'period_month YYYY-MM formatida bo''lishi kerak' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'employee_name', q.full_name, 'branch_name', q.branch_name, 'period_month', q.period_month,
    'base_salary_uzs', q.base_salary, 'bonus_uzs', q.bonus,
    'advance_paid_uzs', q.advance_paid, 'advance_paid_at', q.advance_paid_at,
    'salary_paid_uzs', q.salary_paid, 'salary_paid_at', q.salary_paid_at,
    'extra_paid_uzs', q.extra_paid, 'extra_note', q.extra_note,
    'remaining_uzs', q.remaining, 'note', q.note)
    order by q.period_month desc), '[]'::jsonb)
  into v_items
  from (
    select pr.full_name, br.name as branch_name, sp.period_month, sp.base_salary, sp.bonus,
      sp.advance_paid, sp.advance_paid_at, sp.salary_paid, sp.salary_paid_at,
      coalesce(sp.extra_paid, 0) as extra_paid, sp.extra_note, sp.note,
      (sp.base_salary + sp.bonus - sp.salary_paid - sp.advance_paid - coalesce(sp.extra_paid, 0)) as remaining
    from public.salary_payments sp
    join public.profiles pr on pr.id = sp.employee_id
    left join public.branches br on br.id = sp.branch_id
    where pr.full_name ilike '%' || v_q || '%'
      and (p_period_month is null or sp.period_month = p_period_month)
    order by sp.period_month desc
    limit 24
  ) q;

  return jsonb_build_object('employee_query', v_q, 'period_month', p_period_month, 'records', v_items,
    'note', 'remaining = base_salary + bonus - salary_paid - advance_paid - extra_paid (UZS).');
end $$;

-- ---------------------------------------------------------------------------
-- Inter-branch transfers and the debt they created.
-- ---------------------------------------------------------------------------
create or replace function public.ai_transfer_summary(
  p_branch_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_only_unpaid boolean default false
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_transfers jsonb; v_debts jsonb; v_rate numeric;
begin
  perform public.require_report_access(p_branch_id);

  select rate into v_rate from public.exchange_rates
  where currency_from = 'USD' and currency_to = 'UZS' order by rate_date desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'transfer_no', q.transfer_no, 'status', q.status,
    'from_branch', q.from_branch, 'to_branch', q.to_branch,
    'currency', q.currency, 'total_amount', q.total_amount,
    'unit_count', q.unit_count, 'product_type_count', q.product_type_count,
    'total_cost_uzs', q.total_cost,
    'requested_at', q.requested_at, 'received_at', q.received_at,
    'exchange_rate', q.wholesale_exchange_rate)
    order by q.requested_at desc nulls last), '[]'::jsonb)
  into v_transfers
  from (
    select t.transfer_no, t.status::text as status,
      fb.name as from_branch, tb.name as to_branch,
      t.currency, t.total_amount, t.requested_at, t.received_at, t.wholesale_exchange_rate,
      count(x.id) as unit_count,
      count(distinct x.product_id) as product_type_count,
      sum(coalesce(sb.unit_cost, p.cost_price)) as total_cost
    from public.transfers t
    left join public.locations fl on fl.id = t.from_location_id
    left join public.locations tl on tl.id = t.to_location_id
    left join public.branches fb on fb.id = fl.branch_id
    left join public.branches tb on tb.id = tl.branch_id
    left join public.transfer_lines x on x.transfer_id = t.id
    left join public.inventory_units u on u.id = x.unit_id
    left join public.stock_batches sb on sb.id = u.batch_id
    left join public.products p on p.id = x.product_id
    where (p_branch_id is null or fl.branch_id = p_branch_id or tl.branch_id = p_branch_id)
      and (p_from is null or t.requested_at >= public.business_day_start(p_from))
      and (p_to is null or t.requested_at < public.business_day_start(p_to + 1))
    group by t.id, t.transfer_no, t.status, fb.name, tb.name, t.currency, t.total_amount,
      t.requested_at, t.received_at, t.wholesale_exchange_rate
    order by t.requested_at desc nulls last
    limit 50
  ) q;

  select coalesce(jsonb_agg(jsonb_build_object(
    'transfer_no', d.transfer_no, 'debtor_branch', d.debtor_branch, 'creditor_branch', d.creditor_branch,
    'currency', d.currency, 'amount', d.amount, 'paid_amount', d.paid_amount,
    'remaining_amount', d.remaining_amount, 'status', d.status,
    'created_at', d.created_at, 'due_at', d.due_at)
    order by d.remaining_amount desc), '[]'::jsonb)
  into v_debts
  from (
    select t.transfer_no, db.name as debtor_branch, cb.name as creditor_branch,
      bd.currency, bd.amount, bd.paid_amount, bd.remaining_amount, bd.status::text as status,
      bd.created_at, bd.due_at
    from public.branch_debts bd
    join public.branches db on db.id = bd.debtor_branch_id
    join public.branches cb on cb.id = bd.creditor_branch_id
    left join public.transfers t on t.id = bd.transfer_id
    where bd.status <> 'void'
      and (p_branch_id is null or bd.debtor_branch_id = p_branch_id or bd.creditor_branch_id = p_branch_id)
      and (not coalesce(p_only_unpaid, false) or bd.status in ('open','partially_paid'))
    order by bd.remaining_amount desc
    limit 50
  ) d;

  return jsonb_build_object('exchange_rate_usd_uzs', v_rate,
    'transfers', v_transfers, 'debts', v_debts,
    'note', 'total_amount transfer valyutasida (odatda USD), total_cost_uzs tannarx UZS da.');
end $$;

-- ---------------------------------------------------------------------------
-- Write tools. Deliberately narrow: only visibility and description, both of
-- which are reversible and low blast-radius. Anything financial stays manual.
-- ---------------------------------------------------------------------------
create or replace function public.ai_set_product_visibility(p_product_id uuid, p_publish boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_name text; v_slug text; v_now boolean;
begin
  if auth.uid() is null or not public.has_role(array['superadmin','admin']::public.app_role[], null) then
    raise exception 'Saytda ko''rinishni o''zgartirish uchun admin roli talab qilinadi' using errcode = '42501';
  end if;
  select name, slug into v_name, v_slug from public.products where id = p_product_id;
  if v_name is null then raise exception 'Mahsulot topilmadi' using errcode = 'P0002'; end if;

  update public.products
  set is_published = coalesce(p_publish, false), updated_at = now()
  where id = p_product_id
  returning is_published into v_now;

  return jsonb_build_object('product_id', p_product_id, 'name', v_name, 'slug', v_slug, 'is_published', v_now);
end $$;

create or replace function public.ai_update_product_description(
  p_product_id uuid,
  p_description text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_name text; v_published boolean;
begin
  if auth.uid() is null or not public.has_role(array['superadmin','admin']::public.app_role[], null) then
    raise exception 'Tavsifni o''zgartirish uchun admin roli talab qilinadi' using errcode = '42501';
  end if;
  if p_description is null or length(btrim(p_description)) < 2 then
    raise exception 'Tavsif juda qisqa' using errcode = '22023';
  end if;
  if length(p_description) > 20000 then
    raise exception 'Tavsif juda uzun' using errcode = '22023';
  end if;

  -- Direct update (not save_catalog_product) precisely because save_catalog_product
  -- force-unpublishes the product; editing a description must not pull it off the site.
  update public.products
  set description = btrim(p_description), updated_at = now()
  where id = p_product_id
  returning name, is_published into v_name, v_published;

  if v_name is null then raise exception 'Mahsulot topilmadi' using errcode = 'P0002'; end if;
  return jsonb_build_object('product_id', p_product_id, 'name', v_name,
    'is_published', v_published, 'description_length', length(btrim(p_description)));
end $$;

grant execute on function public.ai_list_branches() to authenticated;
grant execute on function public.ai_search_employees(text, integer) to authenticated;
grant execute on function public.ai_search_products(text, integer) to authenticated;
grant execute on function public.ai_inventory_valuation(uuid, text, integer) to authenticated;
grant execute on function public.ai_seller_performance(date, date, uuid, text, integer) to authenticated;
grant execute on function public.ai_product_performance(date, date, uuid, text, integer) to authenticated;
grant execute on function public.ai_expense_report(date, date, uuid) to authenticated;
grant execute on function public.ai_employee_salary(text, text) to authenticated;
grant execute on function public.ai_transfer_summary(uuid, date, date, boolean) to authenticated;
grant execute on function public.ai_set_product_visibility(uuid, boolean) to authenticated;
grant execute on function public.ai_update_product_description(uuid, text) to authenticated;
