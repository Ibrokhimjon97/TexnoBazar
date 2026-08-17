-- Paginated QR label data for authenticated inventory staff.
begin;
create or replace function public.list_receipt_qr_labels(p_receipt_id uuid,p_limit integer default 100,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_branch uuid; v_items jsonb; v_total bigint;
begin
  if p_limit not between 1 and 200 or p_offset<0 then raise exception 'Sahifalash noto‘g‘ri'; end if;
  select branch_id into v_branch from public.stock_receipts where id=p_receipt_id;
  if v_branch is null then raise exception 'Partiya topilmadi' using errcode='P0002'; end if;
  if not public.can_access_branch(v_branch) then raise exception 'Ruxsat yo‘q' using errcode='42501'; end if;
  select count(*) into v_total from public.inventory_units u join public.stock_batches b on b.id=u.batch_id where b.receipt_id=p_receipt_id;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.line_no,x.unit_sequence),'[]'::jsonb) into v_items from(
    select u.id,u.qr_code,u.serial_number,u.unit_sequence,b.line_no,p.name product_name,p.sku,r.receipt_no
    from public.inventory_units u join public.stock_batches b on b.id=u.batch_id join public.products p on p.id=u.product_id join public.stock_receipts r on r.id=b.receipt_id
    where b.receipt_id=p_receipt_id order by b.line_no,u.unit_sequence limit p_limit offset p_offset)x;
  return jsonb_build_object('items',v_items,'total',v_total);
end; $$;
revoke all on function public.list_receipt_qr_labels(uuid,integer,integer) from public,anon;
grant execute on function public.list_receipt_qr_labels(uuid,integer,integer) to authenticated,service_role;
commit;
