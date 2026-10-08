-- Notify the seller when their POS pending sale is confirmed or rejected by a manager.
-- Rebuilds release_pos_reservation (rejection path) and manager_confirm_sale (confirmation path)
-- with the exact same logic as their latest versions, adding a notifications insert for the seller.

begin;

create or replace function public.release_pos_reservation(p_pending_id uuid,p_status public.pending_sale_status,
  p_reason text,p_actor uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_s public.pos_pending_sales%rowtype; v_x record;
begin
  if p_status not in('expired','rejected') then raise exception 'Yakuniy bekor qilish holati noto‘g‘ri' using errcode='22023'; end if;
  select * into v_s from public.pos_pending_sales where id=p_pending_id for update;
  if not found then raise exception 'POS so‘rovi topilmadi' using errcode='P0002'; end if;
  if v_s.status=p_status then return; end if;
  if v_s.status<>'pending' then raise exception 'Yakunlangan POS so‘rovini bekor qilib bo‘lmaydi' using errcode='P0001'; end if;
  perform 1 from public.inventory_units u join public.pos_pending_sale_lines x on x.unit_id=u.id
    where x.pending_sale_id=p_pending_id order by u.id for update of u;
  for v_x in select x.*,u.batch_id,u.location_id from public.pos_pending_sale_lines x
    join public.inventory_units u on u.id=x.unit_id where x.pending_sale_id=p_pending_id order by u.id loop
    if exists(select 1 from public.inventory_units where id=v_x.unit_id and status='reserved' and sold_sale_id is null) then
      update public.inventory_units set status='available',reserved_until=null,version=version+1 where id=v_x.unit_id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,
        quantity,reference_type,reference_id,reason,actor_id)
      values(v_x.unit_id,v_x.product_id,v_x.batch_id,'reservation_released',v_x.location_id,v_x.location_id,
        1,'pos_pending_sale',p_pending_id,nullif(btrim(p_reason),''),p_actor) on conflict do nothing;
    end if;
  end loop;
  update public.pos_pending_sales set status=p_status,
    rejected_by=case when p_status='rejected' then p_actor end,
    rejected_at=case when p_status='rejected' then now() end,
    rejection_reason=case when p_status='rejected' then coalesce(nullif(btrim(p_reason),''),'Menejer tomonidan rad etildi') end
  where id=p_pending_id;

  -- Notify the seller when a manager explicitly rejects their pending sale.
  if p_status='rejected' then
    insert into public.notifications(recipient_id,channel,title,body,data,sent_at)
    values(v_s.seller_id,'in_app','Kassa so‘rovi rad etildi',
      v_s.pending_no||' raqamli so‘rov rad etildi'||case when nullif(btrim(p_reason),'') is not null then ': '||btrim(p_reason) else '' end,
      jsonb_build_object('type','pos_sale_rejected','pending_sale_id',v_s.id,'pending_no',v_s.pending_no,'reason',nullif(btrim(p_reason),'')),
      now());
  end if;
end $$;

create or replace function public.manager_confirm_sale(p_pending_sale_id uuid,p_payments jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_s public.pos_pending_sales%rowtype; v_sale uuid; v_x record; v_item jsonb; v_method public.payment_methods%rowtype;
  v_paid numeric(18,2):=0; v_count integer:=0;
begin
  select * into v_s from public.pos_pending_sales where id=p_pending_sale_id for update;
  if not found then raise exception 'POS so‘rovi topilmadi' using errcode='P0002'; end if;
  perform public.require_pos_manager(v_s.branch_id);
  if v_s.status='confirmed' then
    select id into v_sale from public.sales where pending_sale_id=v_s.id;
    if v_sale is null then raise exception 'Tasdiqlangan POS so‘rovi uchun sotuv topilmadi' using errcode='P0001'; end if;
    return v_sale;
  end if;
  if v_s.status<>'pending' then raise exception 'Faqat kutilayotgan POS so‘rovi tasdiqlanadi' using errcode='P0001'; end if;
  if v_s.expires_at<=now() then
    perform public.release_pos_reservation(v_s.id,'expired','Rezerv muddati tugadi',auth.uid());
    return null;
  end if;
  perform 1 from public.inventory_units u join public.pos_pending_sale_lines x on x.unit_id=u.id
    where x.pending_sale_id=v_s.id order by u.id for update of u;
  if exists(select 1 from public.inventory_units u
    join public.pos_pending_sale_lines x on x.unit_id=u.id
    join public.locations l on l.id=u.location_id
    where x.pending_sale_id=v_s.id and (u.status<>'reserved' or u.reserved_until<=now() or u.sold_sale_id is not null
      or u.active_transfer_id is not null or l.branch_id<>v_s.branch_id or not l.is_active
      or l.type not in ('store','warehouse'))) then
    raise exception 'Rezervdagi mahsulot holati buzilgan' using errcode='P0001'; end if;
  if p_payments is null then
    select count(*),coalesce(sum(amount),0) into v_count,v_paid from public.pos_pending_sale_payments where pending_sale_id=v_s.id;
  else
    if jsonb_typeof(p_payments)<>'array' or jsonb_array_length(p_payments) not between 1 and 10 then
      raise exception 'To‘lovlar ro‘yxati noto‘g‘ri' using errcode='22023'; end if;
    for v_item in select value from jsonb_array_elements(p_payments) loop
      select * into v_method from public.payment_methods where code=lower(btrim(v_item->>'method_code')) and is_active and code<>'cod';
      if not found or (v_item->>'amount') is null or (v_item->>'amount')::numeric<=0 then
        raise exception 'POS to‘lov usuli yoki summasi noto‘g‘ri' using errcode='22023'; end if;
      v_paid=v_paid+(v_item->>'amount')::numeric(18,2); v_count=v_count+1;
    end loop;
  end if;
  if v_count not between 1 and 10 or v_paid<>v_s.total then raise exception 'To‘lovlar jami sotuv summasiga teng emas' using errcode='22023'; end if;
  v_sale=gen_random_uuid();
  insert into public.sales(id,sale_no,branch_id,seller_id,manager_id,customer_id,pending_sale_id,status,subtotal,discount,tax,total)
  values(v_sale,'SAL-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_sale::text,1,8)),v_s.branch_id,
    v_s.seller_id,auth.uid(),v_s.customer_id,v_s.id,'completed',v_s.subtotal,v_s.discount,v_s.tax,v_s.total);
  perform set_config('texnobazar.manager_confirm_sale','allowed',true);
  for v_x in select x.*,u.batch_id,u.location_id,coalesce(sb.unit_cost,p.cost_price) unit_cost
    from public.pos_pending_sale_lines x join public.inventory_units u on u.id=x.unit_id
    join public.products p on p.id=x.product_id left join public.stock_batches sb on sb.id=u.batch_id
    where x.pending_sale_id=v_s.id order by u.id loop
    insert into public.sale_lines(sale_id,product_id,unit_id,quantity,unit_cost,unit_price,discount,tax,line_total)
      values(v_sale,v_x.product_id,v_x.unit_id,1,v_x.unit_cost,v_x.unit_price,v_x.discount,v_x.tax,v_x.line_total);
    update public.inventory_units set status='sold',sold_sale_id=v_sale,reserved_until=null,version=version+1 where id=v_x.unit_id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,quantity,unit_cost,
      reference_type,reference_id,actor_id) values(v_x.unit_id,v_x.product_id,v_x.batch_id,'sold',v_x.location_id,1,
      v_x.unit_cost,'sale',v_sale,auth.uid());
  end loop;
  perform set_config('texnobazar.manager_confirm_sale','',true);
  if p_payments is null then
    insert into public.sale_payments(sale_id,payment_method_id,amount,status,external_reference,received_by)
      select v_sale,payment_method_id,amount,'paid',external_reference,auth.uid() from public.pos_pending_sale_payments
      where pending_sale_id=v_s.id order by sort_order;
  else
    for v_item in select value from jsonb_array_elements(p_payments) loop
      select * into v_method from public.payment_methods where code=lower(btrim(v_item->>'method_code'));
      insert into public.sale_payments(sale_id,payment_method_id,amount,status,external_reference,received_by)
      values(v_sale,v_method.id,(v_item->>'amount')::numeric(18,2),'paid',nullif(btrim(v_item->>'external_reference'),''),auth.uid());
    end loop;
  end if;
  update public.pos_pending_sales set status='confirmed',confirmed_by=auth.uid(),confirmed_at=now() where id=v_s.id;

  -- Notify the seller that their pending sale was confirmed and money accepted.
  insert into public.notifications(recipient_id,channel,title,body,data,sent_at)
  values(v_s.seller_id,'in_app','Kassa so‘rovi tasdiqlandi',
    v_s.pending_no||' raqamli so‘rov uchun pul qabul qilindi va sotuv yakunlandi',
    jsonb_build_object('type','pos_sale_confirmed','pending_sale_id',v_s.id,'pending_no',v_s.pending_no,'sale_id',v_sale),
    now());

  return v_sale;
exception when unique_violation then
  select id into v_sale from public.sales where pending_sale_id=p_pending_sale_id;
  if v_sale is not null then return v_sale; end if; raise;
end $$;

notify pgrst, 'reload schema';

commit;
