-- Transactional smoke validation. The nested block intentionally rolls back all fixtures.
do $smoke$
declare v_actor uuid; v_branch uuid; v_wh uuid; v_store uuid; v_supplier uuid; v_category uuid; v_p1 uuid; v_p2 uuid;
  v_receipt jsonb; v_receipt_again jsonb; v_receipt_id uuid; v_qr text; v_passport jsonb; v_request uuid:=gen_random_uuid(); v_balance numeric;
begin
  begin
    select p.id into v_actor from public.profiles p join public.profile_roles r on r.profile_id=p.id
      where p.is_active and r.role='superadmin' and r.branch_id is null limit 1;
    if v_actor is null then raise exception 'Inventory smoke: global superadmin topilmadi'; end if;
    perform set_config('request.jwt.claim.sub',v_actor::text,true);
    select id into v_branch from public.branches where code='MAIN';
    select id into v_wh from public.locations where branch_id=v_branch and type='warehouse' and is_active order by created_at limit 1;
    select id into v_store from public.locations where branch_id=v_branch and type='store' and is_active order by created_at limit 1;
    if v_branch is null or v_wh is null or v_store is null then raise exception 'Inventory smoke: MAIN topologiya topilmadi'; end if;
    insert into public.suppliers(code,name) values('SMOKE-INV-SUP','Smoke inventory supplier') returning id into v_supplier;
    insert into public.categories(name,slug) values('Smoke inventory category','smoke-inventory-category') returning id into v_category;
    insert into public.products(sku,category_id,name,slug,status,retail_price,cost_price)
      values('SMOKE-INV-P1',v_category,'Smoke product one','smoke-inventory-product-one','draft',120,100) returning id into v_p1;
    insert into public.products(sku,category_id,name,slug,status,retail_price,cost_price)
      values('SMOKE-INV-P2',v_category,'Smoke product two','smoke-inventory-product-two','draft',240,200) returning id into v_p2;
    v_receipt:=public.receive_stock(jsonb_build_object('receipt_no','SMOKE-RECEIPT','branch_id',v_branch,'supplier_id',v_supplier,'receiving_location_id',v_wh,'currency','UZS','payment_status','unpaid','received_at',now()),
      jsonb_build_array(jsonb_build_object('product_id',v_p1,'quantity',2,'unit_cost',100,'serial_numbers',jsonb_build_array('SMOKE-S1','SMOKE-S2')),
                        jsonb_build_object('product_id',v_p2,'quantity',1,'unit_cost',200,'serial_numbers','[]'::jsonb)),v_request);
    v_receipt_id:=(v_receipt->>'id')::uuid;
    if jsonb_array_length(v_receipt->'lines')<>2 then raise exception 'Inventory smoke: receipt lines'; end if;
    if (select count(*) from public.inventory_units u join public.stock_batches b on b.id=u.batch_id where b.receipt_id=v_receipt_id)<>3 then raise exception 'Inventory smoke: QR count'; end if;
    if (select count(distinct qr_code) from public.inventory_units u join public.stock_batches b on b.id=u.batch_id where b.receipt_id=v_receipt_id)<>3 then raise exception 'Inventory smoke: QR unique'; end if;
    select qr_code into v_qr from public.inventory_units u join public.stock_batches b on b.id=u.batch_id where b.receipt_id=v_receipt_id and u.product_id=v_p1 order by unit_sequence limit 1;
    v_passport:=public.get_inventory_unit_passport(v_qr); if v_passport->>'qr_code'<>v_qr then raise exception 'Inventory smoke: passport'; end if;
    select on_hand into v_balance from public.inventory_balances where location_id=v_wh and product_id=v_p1; if v_balance<>2 then raise exception 'Inventory smoke: warehouse balance'; end if;
    perform public.place_inventory_units(v_store,jsonb_build_array(v_qr),gen_random_uuid());
    select on_hand into v_balance from public.inventory_balances where location_id=v_store and product_id=v_p1; if v_balance<>1 then raise exception 'Inventory smoke: placement target'; end if;
    select on_hand into v_balance from public.inventory_balances where location_id=v_wh and product_id=v_p1; if v_balance<>1 then raise exception 'Inventory smoke: placement source'; end if;
    v_receipt_again:=public.receive_stock(jsonb_build_object('receipt_no','IGNORED-IDEMPOTENT','branch_id',v_branch,'supplier_id',v_supplier,'receiving_location_id',v_wh),jsonb_build_array(jsonb_build_object('product_id',v_p1,'quantity',1,'unit_cost',100)),v_request);
    if v_receipt_again->>'id'<>v_receipt_id::text then raise exception 'Inventory smoke: idempotency'; end if;
    raise exception 'INVENTORY_SMOKE_OK_ROLLBACK';
  exception when others then
    if sqlerrm<>'INVENTORY_SMOKE_OK_ROLLBACK' then raise; end if;
  end;
end;
$smoke$;
