-- Transfer tasdiqlash faqat QABUL QILUVCHI filial menejeri tomonidan amalga oshiriladi.
-- Jo'natuvchi emas, qabul qiluvchi filial menejeri so'rovni tasdiqlaydi.
-- Transfer yaratilganda qabul qiluvchi filial menejeriga bildirishnoma yuboriladi.
begin;

-- Tasdiqlash ruxsatini destination branch manageriga o'zgartirish
create or replace function public.approve_branch_transfer(p_transfer_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_t public.transfers%rowtype;
begin
  select * into v_t from public.transfers where id=p_transfer_id for update;
  if not found then raise exception 'Transfer topilmadi' using errcode='P0002'; end if;
  -- Qabul qiluvchi filial menejeri yoki global admin tasdiqlaydi
  if not(public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager']::public.app_role[],v_t.to_branch_id)) then
    raise exception 'Qabul qiluvchi filial menejeri yoki global administrator roli talab qilinadi' using errcode='42501';
  end if;
  if v_t.status='approved' then return public.get_branch_transfer(p_transfer_id); end if;
  if v_t.status<>'requested' then raise exception 'Faqat so''ralgan transfer tasdiqlanadi' using errcode='P0001'; end if;
  update public.transfers set status='approved',approved_by=auth.uid(),approved_at=now() where id=p_transfer_id;
  return public.get_branch_transfer(p_transfer_id);
end $$;

-- get_branch_transfer dagi can_approve ni to_branch ga o'zgartirish
create or replace function public.get_branch_transfer(p_transfer_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_t public.transfers%rowtype; v_result jsonb; v_can_settlement boolean;
begin
  select * into v_t from public.transfers where id=p_transfer_id;
  if not found then raise exception 'Transfer topilmadi' using errcode='P0002'; end if;
  perform public.require_transfer_access(v_t.from_branch_id,v_t.to_branch_id);
  v_can_settlement=public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['manager','accountant']::public.app_role[],v_t.from_branch_id)
    or public.has_role(array['manager','accountant']::public.app_role[],v_t.to_branch_id);
  select to_jsonb(t)||jsonb_build_object('from_branch_name',fb.name,'to_branch_name',tb.name,
    'from_location_name',fl.name,'to_location_name',tl.name,
    'can_approve',t.status='requested' and (public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager']::public.app_role[],t.to_branch_id)),
    'can_ship',t.status='approved' and (public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager','warehouse']::public.app_role[],t.from_branch_id)),
    'can_receive',t.status='in_transit' and (public.has_role(array['superadmin','admin']::public.app_role[],null)
      or public.has_role(array['manager','warehouse']::public.app_role[],t.to_branch_id)),
    'can_record_payment',v_can_settlement and t.status<>'cancelled'
      and coalesce((select sum(dp.amount) from public.debt_payments dp where dp.transfer_id=t.id),0)<t.total_amount
      and (public.has_role(array['superadmin','admin']::public.app_role[],null)
        or public.has_role(array['manager','accountant']::public.app_role[],t.from_branch_id)),
    'paid_amount',case when v_can_settlement then
      coalesce((select sum(dp.amount) from public.debt_payments dp where dp.transfer_id=t.id),0) else null end,
    'remaining_amount',case when v_can_settlement then
      t.total_amount-coalesce((select sum(dp.amount) from public.debt_payments dp where dp.transfer_id=t.id),0) else null end,
    'debt',case when v_can_settlement then (select jsonb_build_object('id',d.id,'status',d.status,'amount',d.amount,
      'paid_amount',d.paid_amount,'remaining_amount',d.remaining_amount,'created_at',d.created_at)
      from public.branch_debts d where d.transfer_id=t.id) else null end,
    'payments',case when v_can_settlement then coalesce((select jsonb_agg(jsonb_build_object(
      'id',dp.id,'amount',dp.amount,'currency',dp.currency,'paid_at',dp.paid_at,'method',dp.method,
      'reference',dp.reference,'notes',dp.notes) order by dp.paid_at desc,dp.id)
      from public.debt_payments dp where dp.transfer_id=t.id),'[]'::jsonb) else '[]'::jsonb end,
    'lines',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'unit_id',x.unit_id,'qr_code',u.qr_code,
      'serial_number',u.serial_number,'product_id',p.id,'product_name',p.name,'sku',p.sku,
      'image',(select m.public_url from public.product_media m where m.product_id=p.id order by m.is_primary desc,m.sort_order limit 1),
      'quantity',x.quantity,'unit_price',x.unit_price,'line_amount',x.line_amount) order by u.id)
      from public.transfer_lines x join public.inventory_units u on u.id=x.unit_id join public.products p on p.id=x.product_id
      where x.transfer_id=t.id),'[]'::jsonb))
  into v_result from public.transfers t join public.branches fb on fb.id=t.from_branch_id
    join public.branches tb on tb.id=t.to_branch_id join public.locations fl on fl.id=t.from_location_id
    join public.locations tl on tl.id=t.to_location_id where t.id=p_transfer_id;
  return v_result;
end $$;

-- Transfer yaratilganda qabul qiluvchi filial menejerlariga bildirishnoma yuborish
create or replace function public.notify_transfer_requested()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_recipient record; v_from_name text; v_to_name text;
begin
  if new.status='requested' then
    select name into v_from_name from public.branches where id=new.from_branch_id;
    select name into v_to_name from public.branches where id=new.to_branch_id;
    for v_recipient in
      select distinct pr.profile_id from public.profile_roles pr
      where pr.branch_id=new.to_branch_id and pr.role='manager'
        and pr.profile_id<>coalesce(new.created_by,new.requested_by)
    loop
      insert into public.notifications(recipient_id,channel,title,body,data)
      values(v_recipient.profile_id,'in_app',
        'Yangi transfer so''rovi',
        v_from_name||' filialidan '||new.transfer_no||' raqamli transfer so''rovi keldi. Tasdiqlash kutilmoqda.',
        jsonb_build_object('type','transfer_requested','transfer_id',new.id,'transfer_no',new.transfer_no,
          'from_branch',v_from_name,'to_branch',v_to_name,'amount',new.total_amount,'currency',btrim(new.currency::text)));
    end loop;
  end if;
  return new;
end $$;

drop trigger if exists transfers_notify_requested on public.transfers;
create trigger transfers_notify_requested after insert on public.transfers
for each row execute function public.notify_transfer_requested();

-- Transfer holati o'zgarganda ham bildirishnoma (approve, ship, receive)
create or replace function public.notify_transfer_status_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_recipient_id uuid; v_from_name text; v_to_name text; v_title text; v_body text;
begin
  if old.status=new.status then return new; end if;
  select name into v_from_name from public.branches where id=new.from_branch_id;
  select name into v_to_name from public.branches where id=new.to_branch_id;
  if new.status='approved' then
    v_title:='Transfer tasdiqlandi';
    v_body:=new.transfer_no||' tasdiqlandi. Jo''natishga tayyor.';
    v_recipient_id:=new.created_by;
  elsif new.status='in_transit' then
    v_title:='Transfer yo''lga chiqarildi';
    v_body:=new.transfer_no||' '||v_from_name||' dan jo''natildi. Qabul qilishni kuting.';
    for v_recipient_id in select distinct pr.profile_id from public.profile_roles pr
      where pr.branch_id=new.to_branch_id and pr.role in('manager','warehouse') loop
      insert into public.notifications(recipient_id,channel,title,body,data)
      values(v_recipient_id,'in_app',v_title,v_body,
        jsonb_build_object('type','transfer_shipped','transfer_id',new.id,'transfer_no',new.transfer_no));
    end loop;
    v_recipient_id:=null;
  elsif new.status='received' then
    v_title:='Transfer qabul qilindi';
    v_body:=new.transfer_no||' '||v_to_name||' tomonidan qabul qilindi. Qarz yaratildi.';
    v_recipient_id:=new.created_by;
  end if;
  if v_recipient_id is not null and v_recipient_id is distinct from auth.uid() then
    insert into public.notifications(recipient_id,channel,title,body,data)
    values(v_recipient_id,'in_app',v_title,v_body,
      jsonb_build_object('type','transfer_'||new.status,'transfer_id',new.id,'transfer_no',new.transfer_no));
  end if;
  return new;
end $$;

drop trigger if exists transfers_notify_status_change on public.transfers;
create trigger transfers_notify_status_change after update of status on public.transfers
for each row execute function public.notify_transfer_status_change();

notify pgrst,'reload schema';
commit;
