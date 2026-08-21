-- QR kodlarni qisqa formatga o'tkazish: 2 harf + 4 raqam (masalan: AB1234)
-- Jami 6,760,000 noyob kombinatsiya. Takrorlanish holati uchun retry bor.
-- Faqat YANGI partiyalar uchun ishlaydi — mavjud QR kodlar o'zgarmaydi.
begin;

create or replace function public.generate_short_qr()
returns text language plpgsql set search_path='' as $$
declare
  v_letters text:='ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_qr text;
  v_attempt integer:=0;
begin
  loop
    v_qr:=substr(v_letters,(floor(random()*24)+1)::int,1)
      ||substr(v_letters,(floor(random()*24)+1)::int,1)
      ||lpad((floor(random()*10000))::text,4,'0');
    if not exists(select 1 from public.inventory_units where qr_code=v_qr) then
      return v_qr;
    end if;
    v_attempt:=v_attempt+1;
    if v_attempt>100 then
      -- Fallback: 3 harf + 4 raqam
      v_qr:=substr(v_letters,(floor(random()*24)+1)::int,1)
        ||substr(v_letters,(floor(random()*24)+1)::int,1)
        ||substr(v_letters,(floor(random()*24)+1)::int,1)
        ||lpad((floor(random()*10000))::text,4,'0');
      if not exists(select 1 from public.inventory_units where qr_code=v_qr) then
        return v_qr;
      end if;
    end if;
    if v_attempt>200 then
      raise exception 'QR kod generatsiya qilib bo''lmadi — kombinatsiyalar tugagan' using errcode='P0001';
    end if;
  end loop;
end $$;

-- receive_stock funksiyasidagi QR generatsiyasini yangilash
create or replace function public.receive_stock(p_header jsonb,p_lines jsonb,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_receipt uuid; v_existing uuid; v_branch uuid; v_location uuid; v_supplier uuid; v_line jsonb; v_batch uuid;
  v_product record; v_qty integer; v_cost numeric(18,2); v_line_no integer:=0; v_seq integer; v_serials jsonb; v_qr text; v_total integer:=0;
begin
  if auth.uid() is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode='42501'; end if;
  if jsonb_typeof(p_header)<>'object' or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 or jsonb_array_length(p_lines)>50 then raise exception 'Partiya ma''lumotlari noto''g''ri' using errcode='22023'; end if;
  v_branch:=(p_header->>'branch_id')::uuid; v_location:=(p_header->>'receiving_location_id')::uuid; v_supplier:=(p_header->>'supplier_id')::uuid;
  perform public.require_inventory_operator(v_branch);
  select id into v_existing from public.stock_receipts where branch_id=v_branch and idempotency_key=p_idempotency_key;
  if v_existing is not null then return public.get_stock_receipt(v_existing); end if;
  if not exists(select 1 from public.branches where id=v_branch and is_active) then raise exception 'Faol filial topilmadi'; end if;
  if not exists(select 1 from public.locations where id=v_location and branch_id=v_branch and is_active and type in ('warehouse','store')) then raise exception 'Qabul joylashuvi filialga mos emas' using errcode='23514'; end if;
  if not exists(select 1 from public.suppliers where id=v_supplier and is_active) then raise exception 'Faol ta''minotchi topilmadi'; end if;
  insert into public.stock_receipts(receipt_no,branch_id,supplier_id,receiving_location_id,invoice_number,currency,payment_status,received_at,notes,idempotency_key,created_by)
  values(upper(btrim(p_header->>'receipt_no')),v_branch,v_supplier,v_location,nullif(btrim(p_header->>'invoice_number'),''),upper(coalesce(nullif(p_header->>'currency',''),'UZS')),
    coalesce(nullif(p_header->>'payment_status',''),'unpaid'),coalesce((p_header->>'received_at')::timestamptz,now()),nullif(btrim(p_header->>'notes'),''),p_idempotency_key,auth.uid()) returning id into v_receipt;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_line_no:=v_line_no+1; v_qty:=(v_line->>'quantity')::integer; v_cost:=(v_line->>'unit_cost')::numeric; v_serials:=coalesce(v_line->'serial_numbers','[]'::jsonb);
    if v_qty<1 or v_qty>1000 or v_total+v_qty>5000 or v_cost<0 then raise exception 'Partiya qatori miqdori yoki tannarxi noto''g''ri'; end if;
    select id,track_individual_units into v_product from public.products where id=(v_line->>'product_id')::uuid and status<>'archived'; if not found then raise exception 'Mahsulot topilmadi'; end if;
    if jsonb_typeof(v_serials)<>'array' or jsonb_array_length(v_serials) not in (0,v_qty) then raise exception 'Seriya raqamlari soni miqdorga teng bo''lishi kerak'; end if;
    insert into public.stock_batches(receipt_id,line_no,supplier_id,product_id,location_id,reference,received_at,expires_at,quantity,unit_cost,created_by)
    values(v_receipt,v_line_no,v_supplier,v_product.id,v_location,p_header->>'receipt_no',coalesce((p_header->>'received_at')::timestamptz,now()),nullif(v_line->>'expires_at','')::timestamptz,v_qty,v_cost,auth.uid()) returning id into v_batch;
    for v_seq in 1..v_qty loop
      v_qr:=public.generate_short_qr();
      insert into public.inventory_units(product_id,batch_id,qr_code,serial_number,location_id,status,unit_sequence)
      values(v_product.id,v_batch,v_qr,nullif(btrim(v_serials->>(v_seq-1)),''),v_location,'available',v_seq);
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,to_location_id,quantity,unit_cost,reference_type,reference_id,actor_id,metadata)
      select id,v_product.id,v_batch,'received',v_location,1,v_cost,'stock_receipt',v_receipt,auth.uid(),jsonb_build_object('line_no',v_line_no,'unit_sequence',v_seq)
      from public.inventory_units where batch_id=v_batch and unit_sequence=v_seq;
    end loop; v_total:=v_total+v_qty;
  end loop;
  return public.get_stock_receipt(v_receipt);
end; $$;

grant execute on function public.generate_short_qr() to authenticated, service_role;

commit;
