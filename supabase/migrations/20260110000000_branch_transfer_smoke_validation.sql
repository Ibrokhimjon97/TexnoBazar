-- Filial transferlari uchun tranzaksion smoke; ichki sentinel barcha fixturelarni rollback qiladi.
do $smoke$
declare
  v_actor uuid; v_role_id uuid; v_from_branch uuid; v_to_branch uuid; v_from_location uuid; v_to_location uuid;
  v_supplier uuid; v_category uuid; v_product uuid; v_receipt jsonb; v_receipt_id uuid; v_u1 uuid; v_u2 uuid;
  v_transfer jsonb; v_replay jsonb; v_transfer_id uuid; v_debt_id uuid; v_payment jsonb; v_payment_replay jsonb;
  v_receipt_key uuid:=gen_random_uuid(); v_transfer_key uuid:=gen_random_uuid(); v_payment_key uuid:=gen_random_uuid();
  v_failed boolean; v_source_before numeric; v_paid numeric; v_remaining numeric; v_debt_status public.debt_status;
begin
  begin
    select p.id,r.id into v_actor,v_role_id from public.profiles p join public.profile_roles r on r.profile_id=p.id
      where p.is_active and r.role='superadmin' and r.branch_id is null order by p.created_at limit 1;
    if v_actor is null then raise exception 'Transfer smoke: faol global superadmin topilmadi'; end if;
    perform set_config('request.jwt.claim.sub',v_actor::text,true);
    select id into v_from_branch from public.branches where code='MAIN' and is_active;
    select id into v_from_location from public.locations where branch_id=v_from_branch and is_active
      and type in('warehouse','store') order by (type='warehouse') desc,created_at limit 1;
    if v_from_branch is null or v_from_location is null then raise exception 'Transfer smoke: MAIN topologiya topilmadi'; end if;
    insert into public.branches(code,name) values('SMOKE-TR-BR','Smoke transfer filial') returning id into v_to_branch;
    insert into public.locations(branch_id,code,name,type) values(v_to_branch,'SMOKE-TR-WH','Smoke transfer ombor','warehouse') returning id into v_to_location;
    insert into public.suppliers(code,name) values('SMOKE-TR-SUP','Smoke transfer supplier') returning id into v_supplier;
    insert into public.categories(name,slug) values('Smoke transfer category','smoke-transfer-category') returning id into v_category;
    insert into public.products(sku,category_id,name,slug,status,retail_price,cost_price)
      values('SMOKE-TR-P1',v_category,'Smoke transfer product','smoke-transfer-product','draft',150,100) returning id into v_product;
    v_receipt=public.receive_stock(jsonb_build_object('receipt_no','SMOKE-TR-RECEIPT','branch_id',v_from_branch,
      'supplier_id',v_supplier,'receiving_location_id',v_from_location,'currency','UZS','payment_status','unpaid'),
      jsonb_build_array(jsonb_build_object('product_id',v_product,'quantity',2,'unit_cost',100,
        'serial_numbers',jsonb_build_array('SMOKE-TR-S1','SMOKE-TR-S2'))),v_receipt_key);
    v_receipt_id=(v_receipt->>'id')::uuid;
    select u.id into v_u1 from public.inventory_units u join public.stock_batches b on b.id=u.batch_id where b.receipt_id=v_receipt_id and u.unit_sequence=1;
    select u.id into v_u2 from public.inventory_units u join public.stock_batches b on b.id=u.batch_id where b.receipt_id=v_receipt_id and u.unit_sequence=2;
    if v_u1 is null or v_u2 is null then raise exception 'Transfer smoke: receive_stock ikki dona yaratmadi'; end if;
    select on_hand into v_source_before from public.inventory_balances where location_id=v_from_location and product_id=v_product;

    update public.profile_roles set role='manager',branch_id=v_from_branch where id=v_role_id;
    v_transfer=public.create_branch_transfer(jsonb_build_object('from_location_id',v_from_location,'to_location_id',v_to_location,
      'currency','UZS','notes','Smoke transfer'),jsonb_build_array(jsonb_build_object('unit_id',v_u1,'unit_price',120),
      jsonb_build_object('unit_id',v_u2,'unit_price',130)),v_transfer_key);
    v_transfer_id=(v_transfer->>'id')::uuid;
    if v_transfer->>'status'<>'requested' or (v_transfer->>'total_amount')::numeric<>250
      or (select count(*) from public.inventory_units where id in(v_u1,v_u2) and active_transfer_id=v_transfer_id)<>2 then
      raise exception 'Transfer smoke: requested yaratish noto‘g‘ri'; end if;
    v_replay=public.create_branch_transfer(jsonb_build_object('notes','Smoke transfer','currency','UZS','to_location_id',v_to_location,
      'from_location_id',v_from_location),jsonb_build_array(jsonb_build_object('unit_price',130,'unit_id',v_u2),
      jsonb_build_object('unit_price',120,'unit_id',v_u1)),v_transfer_key);
    if v_replay->>'id'<>v_transfer_id::text then raise exception 'Transfer smoke: create replay idempotent emas'; end if;
    v_failed=false;
    begin perform public.create_branch_transfer(jsonb_build_object('from_location_id',v_from_location,'to_location_id',v_to_location,
      'currency','UZS','notes','Zid'),jsonb_build_array(jsonb_build_object('unit_id',v_u1,'unit_price',120),
      jsonb_build_object('unit_id',v_u2,'unit_price',130)),v_transfer_key);
    exception when invalid_parameter_value then v_failed=true; end;
    if not v_failed then raise exception 'Transfer smoke: zid create replay rad etilmadi'; end if;

    perform public.approve_branch_transfer(v_transfer_id); perform public.approve_branch_transfer(v_transfer_id);
    perform public.ship_branch_transfer(v_transfer_id);
    if (select status from public.transfers where id=v_transfer_id)<>'in_transit'
      or (select count(*) from public.inventory_units where id in(v_u1,v_u2) and status='in_transit'
        and location_id=v_from_location and active_transfer_id=v_transfer_id)<>2
      or (select count(*) from public.inventory_movements where reference_type='branch_transfer' and reference_id=v_transfer_id
        and movement_type='transfer_out')<>2
      or coalesce((select on_hand from public.inventory_balances where location_id=v_from_location and product_id=v_product),0)<>v_source_before-2 then
      raise exception 'Transfer smoke: ship hayot sikli yoki source balans noto‘g‘ri'; end if;
    v_failed=false; begin perform public.receive_branch_transfer(v_transfer_id); exception when insufficient_privilege then v_failed=true; end;
    if not v_failed then raise exception 'Transfer smoke: source qabul qila oldi'; end if;

    update public.profile_roles set branch_id=v_to_branch where id=v_role_id;
    v_failed=false; begin perform public.ship_branch_transfer(v_transfer_id); exception when insufficient_privilege then v_failed=true; end;
    if not v_failed then raise exception 'Transfer smoke: destination jo‘nata oldi'; end if;
    perform public.receive_branch_transfer(v_transfer_id); perform public.receive_branch_transfer(v_transfer_id);
    if (select status from public.transfers where id=v_transfer_id)<>'received'
      or (select count(*) from public.inventory_units where id in(v_u1,v_u2) and status='available'
        and location_id=v_to_location and active_transfer_id is null)<>2
      or (select count(*) from public.inventory_movements where reference_type='branch_transfer' and reference_id=v_transfer_id
        and movement_type='transfer_in')<>2
      or coalesce((select on_hand from public.inventory_balances where location_id=v_to_location and product_id=v_product),0)<>2
      or (select count(*) from public.branch_debts where transfer_id=v_transfer_id)<>1 then
      raise exception 'Transfer smoke: receive/retry/balans/qarz noto‘g‘ri'; end if;
    select id into v_debt_id from public.branch_debts where transfer_id=v_transfer_id;
    if (select amount from public.branch_debts where id=v_debt_id)<>250 then raise exception 'Transfer smoke: qarz summasi noto‘g‘ri'; end if;
    v_failed=false; begin perform public.record_branch_debt_payment(v_debt_id,100,'UZS','bank','DENIED',null,gen_random_uuid());
      exception when insufficient_privilege then v_failed=true; end;
    if not v_failed then raise exception 'Transfer smoke: debtor to‘lov kirita oldi'; end if;

    update public.profile_roles set branch_id=v_from_branch where id=v_role_id;
    v_payment=public.record_branch_debt_payment(v_debt_id,100,'UZS','bank','SMOKE-PAY-1','Qisman',v_payment_key);
    v_payment_replay=public.record_branch_debt_payment(v_debt_id,100,'UZS','bank','SMOKE-PAY-1','Qisman',v_payment_key);
    if v_payment_replay->>'id'<>v_debt_id::text or jsonb_array_length(v_payment_replay->'payments')<>1 then
      raise exception 'Transfer smoke: payment replay to‘liq qarzni qaytarmadi'; end if;
    v_failed=false; begin perform public.record_branch_debt_payment(v_debt_id,101,'UZS','bank','SMOKE-PAY-1','Qisman',v_payment_key);
      exception when invalid_parameter_value then v_failed=true; end;
    if not v_failed then raise exception 'Transfer smoke: zid payment replay rad etilmadi'; end if;
    v_failed=false; begin perform public.record_branch_debt_payment(v_debt_id,151,'UZS','cash','OVERPAY',null,gen_random_uuid());
      exception when invalid_parameter_value then v_failed=true; end;
    if not v_failed then raise exception 'Transfer smoke: ortiqcha to‘lov rad etilmadi'; end if;
    perform public.record_branch_debt_payment(v_debt_id,150,'UZS','cash','SMOKE-PAY-2','Yakuniy',gen_random_uuid());
    select paid_amount,remaining_amount,status into v_paid,v_remaining,v_debt_status from public.branch_debts where id=v_debt_id;
    if v_paid<>250 or v_remaining<>0 or v_debt_status<>'paid' or (select count(*) from public.debt_payments where debt_id=v_debt_id)<>2 then
      raise exception 'Transfer smoke: yakuniy to‘lov noto‘g‘ri'; end if;
    if (public.list_branch_transfers(v_from_branch,'outgoing','received',null,30,0)->>'total')::bigint<>1
      or (public.list_branch_debts(v_from_branch,'creditor','paid',50,0)->>'total')::bigint<>1
      or jsonb_array_length(public.get_branch_debt_summary(v_from_branch)->'creditor')<>1
      or jsonb_array_length(public.get_branch_debt(v_debt_id)->'payments')<>2 then raise exception 'Transfer smoke: list/detail noto‘g‘ri'; end if;
    if has_function_privilege('authenticated','public.move_units(uuid,public.transfer_status)','EXECUTE')
      or has_table_privilege('authenticated','public.debt_payments','INSERT') then raise exception 'Transfer smoke: grant/revoke noto‘g‘ri'; end if;
    raise exception 'BRANCH_TRANSFER_SMOKE_OK_ROLLBACK';
  exception when others then
    if sqlerrm<>'BRANCH_TRANSFER_SMOKE_OK_ROLLBACK' then raise; end if;
  end;
end;
$smoke$;