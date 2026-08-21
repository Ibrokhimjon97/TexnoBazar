-- Add retail price and cost price totals to list_stock_receipts response
create or replace function public.list_stock_receipts(p_branch_id uuid default null,p_query text default null,p_limit integer default 20,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_total bigint;
begin
  if p_limit not between 1 and 100 or p_offset<0 then raise exception 'Sahifalash noto''g''ri'; end if;
  select count(*) into v_total from public.stock_receipts r where public.can_access_branch(r.branch_id)
    and (p_branch_id is null or r.branch_id=p_branch_id) and (p_query is null or r.receipt_no ilike '%'||btrim(p_query)||'%' or coalesce(r.invoice_number,'') ilike '%'||btrim(p_query)||'%');
  select coalesce(jsonb_agg(to_jsonb(x) order by x.received_at desc),'[]'::jsonb) into v_items from (
    select r.id,r.receipt_no,r.branch_id,br.name branch_name,r.supplier_id,s.name supplier_name,r.receiving_location_id,l.name location_name,
      r.invoice_number,r.currency,r.payment_status,r.received_at,r.created_at,
      count(b.id) line_count,
      coalesce(sum(b.quantity),0) unit_count,
      coalesce(sum(b.quantity * case when b.unit_cost > 0 then b.unit_cost else coalesce(p.cost_price,0) end),0) total_cost,
      coalesce(sum(b.quantity*p.retail_price),0) total_retail
    from public.stock_receipts r
    join public.branches br on br.id=r.branch_id
    join public.suppliers s on s.id=r.supplier_id
    join public.locations l on l.id=r.receiving_location_id
    left join public.stock_batches b on b.receipt_id=r.id
    left join public.products p on p.id=b.product_id
    where public.can_access_branch(r.branch_id) and (p_branch_id is null or r.branch_id=p_branch_id)
      and (p_query is null or r.receipt_no ilike '%'||btrim(p_query)||'%' or coalesce(r.invoice_number,'') ilike '%'||btrim(p_query)||'%')
    group by r.id,br.name,s.name,l.name order by r.received_at desc limit p_limit offset p_offset) x;
  return jsonb_build_object('items',v_items,'total',v_total);
end; $$;
