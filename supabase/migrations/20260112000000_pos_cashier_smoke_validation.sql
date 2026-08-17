-- POS cashier lifecycle transactional smoke; sentinel rolls every fixture back.
do $smoke$
declare
  v_actor uuid; v_role uuid; v_branch uuid; v_store uuid; v_warehouse uuid; v_supplier uuid; v_category uuid; v_product uuid;
  v_receipt jsonb; v_receipt_id uuid; v_units uuid[]; v_pending jsonb; v_replay jsonb; v_pending_id uuid;
  v_sale uuid; v_sale_retry uuid; v_reject jsonb; v_reject_id uuid; v_expire_id uuid;
  v_key uuid:=gen_random_uuid(); v_failed boolean; v_on_hand numeric; v_reserved numeric; v_receipt_key uuid:=gen_random_uuid();
begin
  begin
    select p.id,r.id into v_actor,v_role from public.profiles p join public.profile_roles r on r.profile_id=p.id
      where p.is_active and r.role='superadmin' and r.branch_id is null order by p.created_at limit 1;
    if v_actor is null then raise exception 'POS smoke: faol global superadmin topilmadi'; end if;
    perform set_config('request.jwt.claim.sub',v_actor::text,true);
    insert into public.branches(code,name,phone,address,currency) values('SMOKE-POS-BR','Smoke POS filial','+998000000000',
      '{"line1":"Smoke address"}'::jsonb,'UZS') returning id into v_branch;
    insert into public.locations(branch_id,code,name,type) values(v_branch,'SMOKE-POS-STORE','Smoke POS do‘kon','store') returning id into v_store;
    insert into public.locations(branch_id,code,name,type) values(v_branch,'SMOKE-POS-WH','Smoke POS ombor','warehouse') returning id into v_warehouse;
    insert into public.suppliers(code,name) values('SMOKE-POS-SUP','Smoke POS supplier') returning id into v_supplier;
    insert into public.categories(name,slug) values('Smoke POS category','smoke-pos-category') returning id into v_category;
    insert into public.products(sku,barcode,category_id,name,slug,status,retail_price,cost_price,minimum_sale_price,tax_rate)
      values('SMOKE-POS-P1','SMOKE-POS-BAR',v_category,'Smoke POS product','smoke-pos-product','active',150,100,100,10) returning id into v_product;
    v_receipt=public.receive_stock(jsonb_build_object('receipt_no','SMOKE-POS-RECEIPT','branch_id',v_branch,
      'supplier_id',v_supplier,'receiving_location_id',v_store,'currency','UZS','payment_status','unpaid'),
      jsonb_build_array(jsonb_build_object('product_id',v_product,'quantity',4,'unit_cost',100,
        'serial_numbers',jsonb_build_array('SMOKE-POS-S1','SMOKE-POS-S2','SMOKE-POS-S3','SMOKE-POS-S4'))),v_receipt_key);
    v_receipt_id=(v_receipt->>'id')::uuid;
    select array_agg(u.id order by u.unit_sequence) into v_units from public.inventory_units u join public.stock_batches b on b.id=u.batch_id
      where b.receipt_id=v_receipt_id;
    if cardinality(v_units)<>4 then raise exception 'POS smoke: receive_stock to‘rtta birlik yaratmadi'; end if;
    select on_hand,reserved into v_on_hand,v_reserved from public.inventory_balances where location_id=v_store and product_id=v_product;
    if v_on_hand<>4 or v_reserved<>0 then raise exception 'POS smoke: boshlang‘ich balans noto‘g‘ri'; end if;

    update public.profile_roles set role='seller',branch_id=v_branch where id=v_role;
    if public.find_pos_unit(v_branch,'SMOKE-POS-S1')->>'unit_cost'<>'100.00'
      or public.find_pos_unit(v_branch,'SMOKE-POS-S1')->>'tax_rate'<>'10.00'
      or ((public.list_pos_units(v_branch,'Smoke POS',30,0)->'items'->0->>'tax_rate')::numeric)<>10
      or (public.list_pos_units(v_branch,'Smoke POS',30,0)->>'total')::integer<>4
      or jsonb_array_length(public.get_pos_references(v_branch)->'payment_methods')<8 then
      raise exception 'POS smoke: seller reference/find/list yoki tannarx ko‘rinishi noto‘g‘ri'; end if;
    v_failed=false; begin perform public.create_pos_pending_sale(v_branch,
      jsonb_build_array(jsonb_build_object('unit_id',v_units[1],'unit_price',100,'discount',1)),
      jsonb_build_array(jsonb_build_object('method_code','cash','amount',108.90)),gen_random_uuid(),'Minimum net');
      exception when invalid_parameter_value then v_failed=true; end;
    if not v_failed then raise exception 'POS smoke: chegirmadan keyingi minimum narx chetlab o‘tildi'; end if;
    v_pending=public.create_pos_pending_sale(v_branch,
      jsonb_build_array(jsonb_build_object('unit_id',v_units[1],'unit_price',140,'discount',10),
        jsonb_build_object('unit_id',v_units[2],'unit_price',150,'discount',0)),
      jsonb_build_array(jsonb_build_object('method_code','cash','amount',143),
        jsonb_build_object('method_code','card','amount',165,'external_reference','SMOKE-CARD')),v_key,'Smoke sale');
    v_pending_id=(v_pending->>'id')::uuid;
    if (v_pending->>'subtotal')::numeric<>290 or (v_pending->>'discount')::numeric<>10
      or (v_pending->>'tax')::numeric<>28 or (v_pending->>'total')::numeric<>308 then
      raise exception 'POS smoke: pending summalari noto‘g‘ri'; end if;
    v_replay=public.create_pos_pending_sale(v_branch,
      jsonb_build_array(jsonb_build_object('discount',0,'unit_price',150,'unit_id',v_units[2]),
        jsonb_build_object('discount',10,'unit_price',140,'unit_id',v_units[1])),
      jsonb_build_array(jsonb_build_object('method_code','card','amount',165,'external_reference','SMOKE-CARD'),
        jsonb_build_object('method_code','cash','amount',143)),v_key,'Smoke sale');
    if v_replay->>'id'<>v_pending_id::text then raise exception 'POS smoke: idempotent retry bir xil so‘rovni qaytarmadi'; end if;
    v_failed=false; begin perform public.create_pos_pending_sale(v_branch,
      jsonb_build_array(jsonb_build_object('unit_id',v_units[1],'unit_price',141,'discount',10)),
      jsonb_build_array(jsonb_build_object('method_code','cash','amount',131)),v_key,'Smoke sale');
      exception when invalid_parameter_value then v_failed=true; end;
    if not v_failed then raise exception 'POS smoke: zid idempotent retry rad etilmadi'; end if;
    select on_hand,reserved into v_on_hand,v_reserved from public.inventory_balances where location_id=v_store and product_id=v_product;
    if v_on_hand<>4 or v_reserved<>2 or (select count(*) from public.inventory_movements where reference_type='pos_pending_sale'
      and reference_id=v_pending_id and movement_type='reserved')<>2 then raise exception 'POS smoke: rezerv yoki balans noto‘g‘ri'; end if;
    v_failed=false; begin perform public.create_pos_pending_sale(v_branch,
      jsonb_build_array(jsonb_build_object('unit_id',v_units[1],'unit_price',140,'discount',0)),
      jsonb_build_array(jsonb_build_object('method_code','cash','amount',140)),gen_random_uuid(),null);
      exception when raise_exception then v_failed=true; end;
    if not v_failed then raise exception 'POS smoke: band birlik qayta rezervlandi'; end if;
    v_failed=false; begin perform public.manager_confirm_sale(v_pending_id,null); exception when insufficient_privilege then v_failed=true; end;
    if not v_failed then raise exception 'POS smoke: seller sotuvni tasdiqladi'; end if;

    update public.profile_roles set role='manager' where id=v_role;
    if public.get_pos_pending_sale(v_pending_id)->>'id'<>v_pending_id::text
      or (public.list_pos_pending_sales(v_branch,'pending',null,30,0)->>'total')::integer<>1 then
      raise exception 'POS smoke: manager detail/list noto‘g‘ri'; end if;
    v_failed=false; begin perform public.manager_confirm_sale(v_pending_id,
      jsonb_build_array(jsonb_build_object('method_code','cash','amount',307)));
      exception when invalid_parameter_value then v_failed=true; end;
    if not v_failed then raise exception 'POS smoke: noto‘g‘ri to‘lov summasi qabul qilindi'; end if;
    v_sale=public.manager_confirm_sale(v_pending_id,null); v_sale_retry=public.manager_confirm_sale(v_pending_id,null);
    if v_sale<>v_sale_retry or (select count(*) from public.sales where pending_sale_id=v_pending_id)<>1
      or (select count(*) from public.sale_lines where sale_id=v_sale)<>2
      or (select count(*) from public.sale_payments where sale_id=v_sale)<>2
      or (select sum(line_total) from public.sale_lines where sale_id=v_sale)<>(select total from public.sales where id=v_sale)
      or (select sum(discount) from public.sale_lines where sale_id=v_sale)<>(select discount from public.sales where id=v_sale)
      or (select sum(tax) from public.sale_lines where sale_id=v_sale)<>(select tax from public.sales where id=v_sale) then
      raise exception 'POS smoke: confirm/retry/sotuv summalari noto‘g‘ri'; end if;
    if (select count(*) from public.inventory_units where id in(v_units[1],v_units[2]) and status='sold'
      and sold_sale_id=v_sale and reserved_until is null)<>2
      or (select count(*) from public.inventory_movements where reference_type='sale' and reference_id=v_sale and movement_type='sold')<>2 then
      raise exception 'POS smoke: SOLD lifecycle noto‘g‘ri'; end if;
    select on_hand,reserved into v_on_hand,v_reserved from public.inventory_balances where location_id=v_store and product_id=v_product;
    if v_on_hand<>2 or v_reserved<>0 then raise exception 'POS smoke: confirm balansi noto‘g‘ri'; end if;
    if public.get_sale_receipt(v_sale)->>'id'<>v_sale::text
      or (public.list_my_pos_sales(v_branch,20,0)->>'total')::integer<>1
      or jsonb_array_length(public.list_pos_pending_sales(v_branch,null,null,30,0)->'items')<1 then
      raise exception 'POS smoke: receipt/KPI/list noto‘g‘ri'; end if;

    update public.profile_roles set role='seller' where id=v_role;
    v_reject=public.create_pos_pending_sale(v_branch,jsonb_build_array(jsonb_build_object('unit_id',v_units[3],
      'unit_price',150,'discount',0)),jsonb_build_array(jsonb_build_object('method_code','cash','amount',165)),gen_random_uuid(),'Reject');
    v_reject_id=(v_reject->>'id')::uuid;
    update public.profile_roles set role='manager' where id=v_role;
    perform public.reject_pos_pending_sale(v_reject_id,'Smoke rad etish');
    if (select status from public.pos_pending_sales where id=v_reject_id)<>'rejected'
      or (select status from public.inventory_units where id=v_units[3])<>'available'
      or (select count(*) from public.inventory_movements where reference_type='pos_pending_sale' and reference_id=v_reject_id
        and movement_type='reservation_released')<>1 then raise exception 'POS smoke: reject lifecycle noto‘g‘ri'; end if;

    update public.profile_roles set role='seller' where id=v_role;
    v_replay=public.create_pos_pending_sale(v_branch,jsonb_build_array(jsonb_build_object('unit_id',v_units[4],
      'unit_price',150,'discount',0)),jsonb_build_array(jsonb_build_object('method_code','cash','amount',165)),gen_random_uuid(),'Expire');
    v_expire_id=(v_replay->>'id')::uuid;
    update public.pos_pending_sales set expires_at=now()-interval '1 second' where id=v_expire_id;
    update public.profile_roles set role='manager' where id=v_role;
    v_sale=public.manager_confirm_sale(v_expire_id,null);
    if v_sale is not null
      or (select status from public.pos_pending_sales where id=v_expire_id)<>'expired'
      or (select status from public.inventory_units where id=v_units[4])<>'available'
      or (select count(*) from public.inventory_movements where reference_type='pos_pending_sale' and reference_id=v_expire_id
        and movement_type='reservation_released')<>1 then raise exception 'POS smoke: confirm expiry release persist bo‘lmadi'; end if;

    v_failed=false; begin update public.inventory_units set status='sold',sold_sale_id=v_sale where id=v_units[3];
      exception when insufficient_privilege then v_failed=true; end;
    if not v_failed then raise exception 'POS smoke: direct SOLD guard ishlamadi'; end if;
    if to_regprocedure('public.create_pos_pending_sale(uuid,uuid,jsonb,numeric,text)') is not null
      or has_table_privilege('authenticated','public.pos_pending_sales','INSERT')
      or has_table_privilege('authenticated','public.pos_pending_sale_lines','INSERT')
      or has_table_privilege('authenticated','public.pos_pending_sale_payments','INSERT')
      or has_table_privilege('authenticated','public.sales','INSERT')
      or has_table_privilege('authenticated','public.sale_lines','INSERT')
      or has_table_privilege('authenticated','public.sale_payments','INSERT') then
      raise exception 'POS smoke: eski overload yoki direct INSERT huquqi ochiq'; end if;
    raise exception 'POS_CASHIER_SMOKE_OK_ROLLBACK';
  exception when others then
    if sqlerrm<>'POS_CASHIER_SMOKE_OK_ROLLBACK' then raise; end if;
  end;
end;
$smoke$;
