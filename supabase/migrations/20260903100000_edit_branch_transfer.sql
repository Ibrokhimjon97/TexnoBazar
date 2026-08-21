-- Transfer tahrirlash: jo'natuvchi filial menejeri requested/approved transferni tahrirlaydi.
-- Agar approved bo'lsa, tahrirlangandan keyin requested ga qaytadi va qayta tasdiqlash kerak.
begin;

create or replace function public.edit_branch_transfer(p_transfer_id uuid,p_lines jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_t public.transfers%rowtype; v_was_approved boolean; v_item jsonb; v_uid uuid; v_price numeric(18,2);
  v_unit public.inventory_units%rowtype; v_normalized jsonb; v_hash text; v_total numeric(18,2);
  v_rate numeric; v_rate_date date; v_recipient record;
begin
  if auth.uid() is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and 500 then
    raise exception 'Transfer qatorlari noto''g''ri' using errcode='22023'; end if;

  select * into v_t from public.transfers where id=p_transfer_id for update;
  if not found then raise exception 'Transfer topilmadi' using errcode='P0002'; end if;
  perform public.require_source_manager(v_t.from_branch_id);

  if v_t.status not in('requested','approved') then
    raise exception 'Faqat so''ralgan yoki tasdiqlangan transferni tahrirlash mumkin' using errcode='P0001';
  end if;
  v_was_approved:=(v_t.status='approved');

  -- Validate lines
  begin
    select jsonb_agg(jsonb_build_object('unit_id',q.unit_id::text,'unit_price',q.unit_price) order by q.unit_id),
      sum(q.unit_price) into v_normalized,v_total
    from (select (e->>'unit_id')::uuid unit_id,(e->>'unit_price')::numeric(18,2) unit_price
      from jsonb_array_elements(p_lines)e)q;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Mahsulot identifikatori yoki narxi noto''g''ri' using errcode='22023';
  end;
  if exists(select 1 from jsonb_array_elements(p_lines)e group by (e->>'unit_id')::uuid having count(*)>1) then
    raise exception 'Mahsulot identifikatorlari takrorlanmasligi kerak' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_lines)e where (e->>'unit_price')::numeric<=0) then
    raise exception 'Har bir transfer narxi musbat bo''lishi shart' using errcode='22023'; end if;

  -- Release old units
  perform 1 from public.inventory_units u join public.transfer_lines x on x.unit_id=u.id
    where x.transfer_id=p_transfer_id order by u.id for update of u;
  update public.inventory_units set active_transfer_id=null,version=version+1
    where active_transfer_id=p_transfer_id;

  -- Delete old lines (temporarily disable immutable trigger)
  alter table public.transfer_lines disable trigger transfer_lines_immutable;
  alter table public.transfer_lines disable trigger transfer_lines_wholesale_price;
  delete from public.transfer_lines where transfer_id=p_transfer_id;

  -- Get exchange rate from transfer snapshot
  v_rate:=v_t.wholesale_exchange_rate;
  v_rate_date:=v_t.wholesale_rate_date;
  if v_rate is null or v_rate<=0 then
    select r.rate,r.rate_date into v_rate,v_rate_date from public.exchange_rates r
    where r.currency_from='USD' and r.currency_to='UZS' order by r.rate_date desc limit 1;
    if v_rate is null or v_rate<=0 then
      raise exception 'USD/UZS ulgurji kursi topilmadi' using errcode='P0002'; end if;
  end if;

  -- Lock and validate new units, insert new lines
  perform 1 from public.inventory_units u where u.id in(select (e->>'unit_id')::uuid from jsonb_array_elements(p_lines)e)
    order by u.id for update;
  for v_item in select value from jsonb_array_elements(p_lines) order by (value->>'unit_id')::uuid loop
    v_uid:=(v_item->>'unit_id')::uuid; v_price:=(v_item->>'unit_price')::numeric(18,2);
    select * into v_unit from public.inventory_units where id=v_uid;
    if not found then raise exception 'Mahsulot birligi topilmadi: %',v_uid using errcode='P0002'; end if;
    if v_unit.location_id<>v_t.from_location_id or v_unit.status<>'available'
      or (v_unit.active_transfer_id is not null and v_unit.active_transfer_id<>p_transfer_id) then
      raise exception 'Mahsulot jo''natish joyida erkin emas: %',v_uid using errcode='P0001'; end if;
    insert into public.transfer_lines(transfer_id,product_id,unit_id,quantity,unit_price)
      values(p_transfer_id,v_unit.product_id,v_uid,1,v_price);
    update public.inventory_units set active_transfer_id=p_transfer_id,version=version+1 where id=v_uid;
  end loop;

  alter table public.transfer_lines enable trigger transfer_lines_immutable;
  alter table public.transfer_lines enable trigger transfer_lines_wholesale_price;

  -- Update transfer header
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('from_location_id',v_t.from_location_id::text,
    'to_location_id',v_t.to_location_id::text,'currency','USD','notes',v_t.notes,'lines',v_normalized)::text,'UTF8'),'sha256'),'hex');

  alter table public.transfers disable trigger transfers_immutable_fields;
  update public.transfers set total_amount=v_total,request_hash=v_hash,
    status=case when v_was_approved then 'requested'::public.transfer_status else status end,
    approved_by=case when v_was_approved then null else approved_by end,
    approved_at=case when v_was_approved then null else approved_at end
    where id=p_transfer_id;
  alter table public.transfers enable trigger transfers_immutable_fields;

  -- Notify destination if it was re-requested
  if v_was_approved then
    for v_recipient in
      select distinct pr.profile_id from public.profile_roles pr
      where pr.branch_id=v_t.to_branch_id and pr.role='manager' and pr.profile_id<>auth.uid()
    loop
      insert into public.notifications(recipient_id,channel,title,body,data)
      values(v_recipient.profile_id,'in_app',
        'Transfer tahrirlandi — qayta tasdiqlash kerak',
        v_t.transfer_no||' tahrirlandi. Yangi mazmunni tekshirib tasdiqlang.',
        jsonb_build_object('type','transfer_edited','transfer_id',p_transfer_id,'transfer_no',v_t.transfer_no,
          'was_approved',true));
    end loop;
  end if;

  return public.get_branch_transfer(p_transfer_id);
end $$;

grant execute on function public.edit_branch_transfer(uuid,jsonb) to authenticated,service_role;

notify pgrst,'reload schema';
commit;
