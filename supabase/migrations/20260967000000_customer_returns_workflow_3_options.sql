-- 20260967000000_customer_returns_workflow_3_options.sql
-- Mijoz tovar qaytarishi (1 oylik muddat va 3 ta opsiya + kalendar qidiruvi):
-- 1-opsiya: Aynan shu tovardan yangisiga almashtirib berish (0 so'm, balans tiklanadi, kassa o'zgarmaydi)
-- 2-opsiya: Analog / boshqa tovarga almashtirish (narxi >= qaytarilgan narx, arzon tovar mumkin emas, qimmat bo'lsa farqi kassa so'roviga chiqadi)
-- 3-opsiya: Tovarni qaytarib pulini qaytarish (kassa naqd pulni qaytaradi va asl sotuv kunidagi aylanma hisobotidan chiqariladi)
-- 4-muammoli holat: QR kod yo'qolganda kalendar (sana) bo'yicha sotilgan tovarlarni topish

begin;

-- -----------------------------------------------------------------------------
-- 1. find_sale_return_unit: Sotuvchi ham tekshira olsin va 30 kunlik (1 oylik) qoida tekshirilsin
-- -----------------------------------------------------------------------------

create or replace function public.find_sale_return_unit(p_branch_id uuid, p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_code text := nullif(btrim(p_code), '');
  v_u public.inventory_units%rowtype;
  v_sale public.sales%rowtype;
  v_line public.sale_lines%rowtype;
  v_eligible boolean := true;
  v_reason text;
  v_sale_branch uuid;
  v_sale_branch_name text;
  v_pending jsonb;
  v_provider_count integer := 0;
  v_line_count integer := 0;
  v_warning text;
  v_result jsonb;
  v_days_passed integer := 0;
begin
  if p_branch_id is null then
    raise exception 'Filial talab qilinadi' using errcode = '22023';
  end if;
  perform public.require_pos_seller(p_branch_id);
  if v_code is null then
    raise exception 'QR yoki seriya raqami talab qilinadi' using errcode = '22023';
  end if;

  select * into v_u from public.inventory_units
  where upper(qr_code) = upper(v_code) or upper(coalesce(serial_number, '')) = upper(v_code)
  limit 1;

  if not found then
    raise exception 'QR yoki seriya bo‘yicha birlik topilmadi: %', v_code using errcode = 'P0002';
  end if;

  -- Eng oxirgi sotuv qatori
  select sl.* into v_line from public.sale_lines sl
  join public.sales s on s.id = sl.sale_id
  where sl.unit_id = v_u.id
  order by s.sold_at desc, sl.created_at desc limit 1;

  if found then
    select * into v_sale from public.sales where id = v_line.sale_id;
  end if;

  if v_sale.id is null then
    v_eligible := false;
    v_reason := 'Bu birlik hech qachon sotilmagan — qaytarish uchun sotuv tarixi yo‘q.';
  else
    v_sale_branch := v_sale.branch_id;
    select name into v_sale_branch_name from public.branches where id = v_sale.branch_id;

    -- 1 oylik (30 kunlik) qoida tekshiruvi
    v_days_passed := extract(day from (now() - v_sale.sold_at))::integer;
    if v_sale.sold_at < (now() - interval '30 days') then
      v_eligible := false;
      v_reason := 'Xarid qilingan kundan 1 oydan ortiq vaqt o‘tgan (' || to_char(v_sale.sold_at at time zone 'Asia/Tashkent', 'DD.MM.YYYY') || ', ' || v_days_passed || ' kun oldin). Qaytarish muddati (30 kun) tugagan.';
    elsif v_sale_branch is distinct from p_branch_id then
      v_eligible := false;
      v_reason := 'Bu birlik boshqa filialda sotilgan: ' || coalesce(v_sale_branch_name, '—') || '. Qaytarishni shu filial bajaradi.';
    elsif v_sale.status = 'void' then
      v_eligible := false;
      v_reason := 'Asl sotuv bekor qilingan (void) — qaytarish mumkin emas.';
    elsif v_u.status <> 'sold' or v_u.sold_sale_id is distinct from v_sale.id then
      v_eligible := false;
      v_reason := 'Birlik hozirda sotilgan holatda emas (holat: ' || v_u.status::text || '). Ehtimol allaqachon qaytarilgan yoki hisobdan chiqarilgan.';
    elsif exists (
      select 1 from public.sale_return_lines x
      join public.sale_returns r on r.id = x.return_id
      where x.sale_line_id = v_line.id and r.status in ('requested', 'approved', 'completed')
    ) then
      v_eligible := false;
      v_reason := 'Bu birlik uchun qaytarish allaqachon mavjud yoki yakunlangan.';
    end if;
  end if;

  if v_sale.id is not null then
    select jsonb_build_object(
      'id', r.id,
      'return_no', r.return_no,
      'status', r.status,
      'kind', r.kind,
      'refund_amount', r.refund_amount,
      'created_at', r.created_at
    )
    into v_pending from public.sale_return_lines x
    join public.sale_returns r on r.id = x.return_id
    where x.sale_line_id = v_line.id and r.status in ('requested', 'approved')
    order by r.created_at desc limit 1;

    select count(*) into v_line_count from public.sale_lines where sale_id = v_sale.id;
    select count(*) into v_provider_count from public.sale_payments sp
    join public.payment_methods pm on pm.id = sp.payment_method_id
    where sp.sale_id = v_sale.id and pm.code in ('click', 'payme') and sp.status in ('paid', 'partially_refunded');

    if v_provider_count > 0 and v_line_count > 1 then
      v_warning := 'Sotuv Click/Payme orqali to‘langan. Provayder qismiy qaytarishni qo‘llamaydi — chekdagi barcha birliklarni birga qaytarish talab qilinishi mumkin.';
    end if;
  end if;

  select jsonb_build_object(
    'eligible', v_eligible,
    'reason', v_reason,
    'warning', v_warning,
    'days_passed', v_days_passed,
    'unit', jsonb_build_object(
      'id', u.id,
      'qr_code', u.qr_code,
      'serial_number', u.serial_number,
      'status', u.status,
      'status_label', case u.status::text
        when 'sold' then 'Sotilgan'
        when 'available' then 'Sotuvda'
        when 'returned' then 'Qaytarilgan'
        when 'written_off' then 'Hisobdan chiqarilgan'
        when 'reserved' then 'Rezervda'
        when 'in_transit' then 'Yo‘lda'
        else u.status::text end,
      'location_id', u.location_id,
      'location_name', l.name,
      'location_type', l.type,
      'branch_id', l.branch_id
    ),
    'product', jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'sku', p.sku,
      'barcode', p.barcode,
      'brand_name', br.name,
      'retail_price', p.retail_price,
      'cost_price', p.cost_price,
      'image', (select m.public_url from public.product_media m where m.product_id = p.id order by m.is_primary desc, m.sort_order limit 1)
    ),
    'batch', case when b.id is null then null else jsonb_build_object(
      'id', b.id,
      'reference', b.reference,
      'received_at', b.received_at,
      'unit_cost', b.unit_cost,
      'supplier_name', sup.name
    ) end,
    'unit_cost', coalesce(v_line.unit_cost, b.unit_cost, p.cost_price),
    'sale', case when v_sale.id is null then null else jsonb_build_object(
      'id', v_sale.id,
      'sale_no', v_sale.sale_no,
      'status', v_sale.status,
      'sold_at', v_sale.sold_at,
      'total', v_sale.total,
      'branch_id', v_sale.branch_id,
      'branch_name', v_sale_branch_name,
      'line_count', v_line_count,
      'seller_id', v_sale.seller_id,
      'seller_name', (select full_name from public.profiles where id = v_sale.seller_id),
      'manager_name', (select full_name from public.profiles where id = v_sale.manager_id),
      'customer_id', v_sale.customer_id,
      'customer_name', (select full_name from public.customers where id = v_sale.customer_id),
      'customer_phone', (select phone from public.customers where id = v_sale.customer_id),
      'payment_methods', coalesce((
        select jsonb_agg(distinct pm.name) from public.sale_payments sp
        join public.payment_methods pm on pm.id = sp.payment_method_id
        where sp.sale_id = v_sale.id
      ), '[]'::jsonb)
    ) end,
    'sale_line', case when v_line.id is null then null else jsonb_build_object(
      'id', v_line.id,
      'unit_cost', v_line.unit_cost,
      'unit_price', v_line.unit_price,
      'discount', v_line.discount,
      'tax', v_line.tax,
      'line_total', v_line.line_total,
      'max_refund', v_line.line_total
    ) end,
    'pending_return', v_pending,
    'default_resell_location_id', coalesce(
      (select l2.id from public.locations l2 where l2.id = u.location_id and l2.branch_id = p_branch_id and l2.is_active and l2.type in ('store', 'warehouse')),
      (select l3.id from public.locations l3 where l3.branch_id = p_branch_id and l3.is_active and l3.type = 'store' order by l3.name limit 1)
    )
  ) into v_result
  from public.inventory_units u
  join public.products p on p.id = u.product_id
  join public.locations l on l.id = u.location_id
  left join public.brands br on br.id = p.brand_id
  left join public.stock_batches b on b.id = u.batch_id
  left join public.suppliers sup on sup.id = b.supplier_id
  where u.id = v_u.id;

  return v_result;
end $$;

-- -----------------------------------------------------------------------------
-- 2. list_branch_sold_units_by_date: QR yo'qolganda sana bo'yicha sotilgan tovarlarni topish
-- -----------------------------------------------------------------------------

create or replace function public.list_branch_sold_units_by_date(
  p_branch_id uuid,
  p_date date,
  p_query text default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_timezone text;
  v_start timestamptz;
  v_end timestamptz;
  v_query text := nullif(btrim(p_query), '');
  v_items jsonb;
begin
  if p_branch_id is null then
    raise exception 'Filial talab qilinadi' using errcode = '22023';
  end if;
  perform public.require_pos_seller(p_branch_id);

  if p_date is null then
    raise exception 'Sana ko‘rsatilishi shart' using errcode = '22023';
  end if;

  select coalesce(b.timezone, 'Asia/Tashkent') into v_timezone
  from public.branches b where b.id = p_branch_id;
  if v_timezone is null then v_timezone := 'Asia/Tashkent'; end if;

  -- 30 kunlik tekshiruv
  if p_date < (current_date - 31) then
    raise exception 'Tanlangan sana 1 oydan (30 kundan) ortiq eski. Qaytarish faqat 1 oygacha bo‘lgan savdolarga amal qiladi.' using errcode = '22023';
  end if;
  if p_date > current_date then
    raise exception 'Kelgusi sanani tanlab bo‘lmaydi' using errcode = '22023';
  end if;

  v_start := p_date::timestamp at time zone v_timezone;
  v_end := (p_date + 1)::timestamp at time zone v_timezone;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.sold_at desc, q.sale_line_id desc), '[]'::jsonb)
  into v_items
  from (
    select
      u.id as unit_id,
      u.qr_code,
      u.serial_number,
      u.status as unit_status,
      p.id as product_id,
      p.name as product_name,
      p.sku,
      (select pm.public_url from public.product_media pm where pm.product_id = p.id order by pm.is_primary desc, pm.sort_order limit 1) as image,
      b.reference as batch_reference,
      b.id as batch_id,
      s.id as sale_id,
      s.sale_no,
      s.sold_at,
      sl.id as sale_line_id,
      sl.unit_price,
      sl.discount,
      sl.tax,
      sl.line_total,
      seller.full_name as seller_name,
      cust.full_name as customer_name,
      cust.phone as customer_phone,
      (
        u.status = 'sold'
        and s.status <> 'void'
        and not exists (
          select 1 from public.sale_return_lines x
          join public.sale_returns r on r.id = x.return_id
          where x.unit_id = u.id and r.status in ('requested', 'approved', 'completed')
        )
      ) as is_returnable
    from public.sale_lines sl
    join public.sales s on s.id = sl.sale_id
    join public.inventory_units u on u.id = sl.unit_id
    join public.products p on p.id = sl.product_id
    left join public.stock_batches b on b.id = u.batch_id
    join public.profiles seller on seller.id = s.seller_id
    left join public.customers cust on cust.id = s.customer_id
    where s.branch_id = p_branch_id
      and s.status <> 'void'
      and s.sold_at >= v_start and s.sold_at < v_end
      and (
        v_query is null
        or p.name ilike '%' || v_query || '%'
        or p.sku ilike '%' || v_query || '%'
        or u.qr_code ilike '%' || v_query || '%'
        or coalesce(u.serial_number, '') ilike '%' || v_query || '%'
        or s.sale_no ilike '%' || v_query || '%'
        or coalesce(cust.full_name, '') ilike '%' || v_query || '%'
        or coalesce(cust.phone, '') ilike '%' || v_query || '%'
        or coalesce(b.reference, '') ilike '%' || v_query || '%'
      )
    order by s.sold_at desc, sl.id desc
    limit 100
  ) q;

  return v_items;
end $$;

-- -----------------------------------------------------------------------------
-- 3. 1-OPSIYA: execute_pos_same_product_exchange (Aynan shu tovardan yangisiga almashtirish)
-- -----------------------------------------------------------------------------

create or replace function public.execute_pos_same_product_exchange(
  p_branch_id uuid,
  p_returned_unit_id uuid,
  p_replacement_unit_id uuid default null,
  p_reason text default '1-opsiya: Aynan shu tovarga almashtirish'
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u public.inventory_units%rowtype;
  v_line public.sale_lines%rowtype;
  v_sale public.sales%rowtype;
  v_rep_u public.inventory_units%rowtype;
  v_dest uuid;
  v_ret_id uuid := gen_random_uuid();
  v_ret_no text;
  v_reason text := coalesce(nullif(btrim(p_reason), ''), '1-opsiya: Aynan shu tovarga almashtirish');
begin
  if p_branch_id is null or p_returned_unit_id is null then
    raise exception 'Filial va qaytarilayotgan tovar talab qilinadi' using errcode = '22023';
  end if;
  perform public.require_pos_seller(p_branch_id);

  select * into v_u from public.inventory_units where id = p_returned_unit_id for update;
  if not found then raise exception 'Qaytariladigan birlik topilmadi' using errcode = 'P0002'; end if;

  select sl.* into v_line from public.sale_lines sl
  join public.sales s on s.id = sl.sale_id
  where sl.unit_id = v_u.id
  order by s.sold_at desc, sl.created_at desc limit 1;

  if not found then raise exception 'Sotuv tarixi topilmadi' using errcode = 'P0002'; end if;
  select * into v_sale from public.sales where id = v_line.sale_id;

  if v_sale.branch_id is distinct from p_branch_id then
    raise exception 'Bu birlik boshqa filialda sotilgan' using errcode = 'P0001';
  end if;
  if v_sale.sold_at < (now() - interval '30 days') then
    raise exception 'Xarid qilingan kundan 1 oydan ortiq vaqt o‘tgan (30 kunlik muddat tugagan)' using errcode = '22023';
  end if;
  if v_u.status <> 'sold' or v_u.sold_sale_id is distinct from v_sale.id then
    raise exception 'Birlik sotilgan holatda emas (holat: %)', v_u.status::text using errcode = 'P0001';
  end if;

  -- Resell joylashuvni aniqlash (do'kon)
  select id into v_dest from public.locations
  where branch_id = p_branch_id and is_active and type = 'store'
  order by name limit 1;
  if v_dest is null then
    select id into v_dest from public.locations where branch_id = p_branch_id and is_active order by name limit 1;
  end if;

  v_ret_no := 'RET-EX1-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS') || '-' || upper(substr(v_ret_id::text, 1, 6));

  -- 1. Qaytarilgan tovarni do'kon balansiga qaytarish (+1 dona)
  update public.inventory_units
  set status = 'available',
      location_id = v_dest,
      sold_sale_id = null,
      reserved_until = null,
      version = version + 1
  where id = v_u.id;

  insert into public.inventory_movements(
    unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
    quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
  ) values (
    v_u.id, v_u.product_id, v_u.batch_id, 'returned', v_u.location_id, v_dest,
    1, v_line.unit_cost, 'sale_return', v_ret_id, v_reason, auth.uid(),
    jsonb_build_object('kind', 'same_product_exchange', 'original_sale_no', v_sale.sale_no)
  );

  -- 2. Agar o'rniga yangi dona ko'rsatilgan bo'lsa (aynan shu tovardan):
  if p_replacement_unit_id is not null then
    select * into v_rep_u from public.inventory_units where id = p_replacement_unit_id for update;
    if not found then raise exception 'O‘rniga beriladigan birlik topilmadi' using errcode = 'P0002'; end if;
    if v_rep_u.product_id is distinct from v_u.product_id then
      raise exception '1-opsiyada faqat aynan shu tovardan yangi dona berilishi shart' using errcode = '22023';
    end if;
    if v_rep_u.status <> 'available' then
      raise exception 'O‘rniga beriladigan birlik erkin sotuvda emas (holat: %)', v_rep_u.status::text using errcode = 'P0001';
    end if;

    update public.inventory_units
    set status = 'sold',
        sold_sale_id = v_sale.id,
        version = version + 1
    where id = v_rep_u.id;

    insert into public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) values (
      v_rep_u.id, v_rep_u.product_id, v_rep_u.batch_id, 'sold', v_rep_u.location_id, v_rep_u.location_id,
      1, v_line.unit_cost, 'sale_replacement', v_ret_id, '1-opsiya: O‘rniga berilgan yangi birlik', auth.uid(),
      jsonb_build_object('replaced_unit_id', v_u.id, 'original_sale_no', v_sale.sale_no)
    );
  end if;

  -- 3. Sale returns yozuvini qayd qilish (refund = 0, chunki pul o'sha kungi holatida qoladi)
  insert into public.sale_returns(
    id, return_no, original_sale_id, kind, status, branch_id, customer_id,
    reason, refund_amount, requested_by, approved_by, approved_at, completed_at
  ) values (
    v_ret_id, v_ret_no, v_sale.id, 'exchange', 'completed', p_branch_id, v_sale.customer_id,
    v_reason, 0, auth.uid(), auth.uid(), now(), now()
  );

  insert into public.sale_return_lines(
    return_id, sale_line_id, unit_id, quantity, condition, refund_amount
  ) values (
    v_ret_id, v_line.id, v_u.id, 1, 'resellable', 0
  );

  return jsonb_build_object(
    'success', true,
    'return_id', v_ret_id,
    'return_no', v_ret_no,
    'returned_unit_id', v_u.id,
    'replacement_unit_id', p_replacement_unit_id,
    'message', 'Aynan shu tovardan boshqasiga muvaffaqiyatli almashtirildi. Birlik do‘kon balansiga qaytarildi, kassada bugun uchun qo‘shimcha pul hisoblanmaydi.'
  );
end $$;

-- -----------------------------------------------------------------------------
-- 4. 2-OPSIYA: create_pos_exchange_upgrade (Boshqa / analog tovarga almashtirish)
-- -----------------------------------------------------------------------------

create or replace function public.create_pos_exchange_upgrade(
  p_branch_id uuid,
  p_returned_unit_id uuid,
  p_new_unit_id uuid,
  p_reason text default '2-opsiya: Boshqa / analog tovarga almashtirish'
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u public.inventory_units%rowtype;
  v_new_u public.inventory_units%rowtype;
  v_line public.sale_lines%rowtype;
  v_sale public.sales%rowtype;
  v_new_prod public.products%rowtype;
  v_returned_price numeric(18,2);
  v_new_price numeric(18,2);
  v_diff numeric(18,2);
  v_pending_id uuid := gen_random_uuid();
  v_pending_no text;
  v_pending_row public.pos_pending_sales%rowtype;
  v_dest uuid;
begin
  if p_branch_id is null or p_returned_unit_id is null or p_new_unit_id is null then
    raise exception 'Filial, qaytarilayotgan tovar va yangi tovar talab qilinadi' using errcode = '22023';
  end if;
  perform public.require_pos_seller(p_branch_id);

  select * into v_u from public.inventory_units where id = p_returned_unit_id for update;
  if not found then raise exception 'Qaytariladigan birlik topilmadi' using errcode = 'P0002'; end if;

  select sl.* into v_line from public.sale_lines sl
  join public.sales s on s.id = sl.sale_id
  where sl.unit_id = v_u.id
  order by s.sold_at desc, sl.created_at desc limit 1;

  if not found then raise exception 'Sotuv tarixi topilmadi' using errcode = 'P0002'; end if;
  select * into v_sale from public.sales where id = v_line.sale_id;

  if v_sale.branch_id is distinct from p_branch_id then
    raise exception 'Bu birlik boshqa filialda sotilgan' using errcode = 'P0001';
  end if;
  if v_sale.sold_at < (now() - interval '30 days') then
    raise exception 'Xarid qilingan kundan 1 oydan ortiq vaqt o‘tgan (30 kunlik muddat tugagan)' using errcode = '22023';
  end if;
  if v_u.status <> 'sold' or v_u.sold_sale_id is distinct from v_sale.id then
    raise exception 'Birlik sotilgan holatda emas (holat: %)', v_u.status::text using errcode = 'P0001';
  end if;

  -- Yangi tanlangan tovar
  select * into v_new_u from public.inventory_units where id = p_new_unit_id for update;
  if not found then raise exception 'Almashtiriladigan yangi tovar birligi topilmadi' using errcode = 'P0002'; end if;
  if v_new_u.status <> 'available' then
    raise exception 'Yangi birlik erkin sotuvda emas (holat: %)', v_new_u.status::text using errcode = 'P0001';
  end if;

  select * into v_new_prod from public.products where id = v_new_u.product_id;
  if not found then raise exception 'Yangi tovar mahsulot yozuvi topilmadi' using errcode = 'P0002'; end if;

  v_returned_price := round(v_line.line_total, 2);
  v_new_price := round(v_new_prod.retail_price, 2);

  -- Qat'iy narx qoidasi:
  -- Mijoz qaytargan tovar turiga avval to'lagan pul bilan teng yoki undan ko'proq qiymatli tovar olishi kerak!
  -- Lekin almashtirgan tovari narxidan past tovarni o'zini olib do'kondan qolgan pulni so'rashga haqli emas!
  if v_new_price < v_returned_price then
    raise exception 'Almashtiriladigan tovar narxi (% so‘m) qaytarilayotgan tovar narxidan (% so‘m) past bo‘lishi mumkin emas! Mijoz arzonroq tovar olib, do‘kondan qolgan pulni qaytarib olishga haqli emas. Kamida % so‘mlik tovar tanlang.',
      to_char(v_new_price, 'FM999,999,999,999'),
      to_char(v_returned_price, 'FM999,999,999,999'),
      to_char(v_returned_price, 'FM999,999,999,999')
    using errcode = '22023';
  end if;

  v_diff := v_new_price - v_returned_price;

  -- Resell joylashuv
  select id into v_dest from public.locations
  where branch_id = p_branch_id and is_active and type = 'store'
  order by name limit 1;

  -- Narx teng bo'lsa (0 so'm farq): darhol to'g'ridan-to'g'ri almashtirish!
  if v_diff = 0 then
    update public.inventory_units
    set status = 'available', location_id = v_dest, sold_sale_id = null, version = version + 1
    where id = v_u.id;

    insert into public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) values (
      v_u.id, v_u.product_id, v_u.batch_id, 'returned', v_u.location_id, v_dest,
      1, v_line.unit_cost, 'sale_return', null, '2-opsiya: Teng narxli tovar almashtirish', auth.uid(),
      jsonb_build_object('kind', 'equal_value_exchange', 'original_sale_no', v_sale.sale_no)
    );

    update public.inventory_units
    set status = 'sold', sold_sale_id = v_sale.id, version = version + 1
    where id = v_new_u.id;

    insert into public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) values (
      v_new_u.id, v_new_u.product_id, v_new_u.batch_id, 'sold', v_new_u.location_id, v_new_u.location_id,
      1, v_new_prod.cost_price, 'sale_replacement', null, '2-opsiya: Teng narxli yangi tovar', auth.uid(),
      jsonb_build_object('replaced_unit_id', v_u.id, 'original_sale_no', v_sale.sale_no)
    );

    return jsonb_build_object(
      'success', true,
      'difference', 0,
      'is_paid', true,
      'message', 'Tovar teng qiymatli boshqa tovarga muvaffaqiyatli almashtirildi (farq: 0 so‘m). Qoldiq yangilandi.'
    );
  end if;

  -- Narxi qimmatroq bo'lsa (farq > 0):
  -- "dastur avtomatik uni hisobiga 300 000 so`m yozadi va chek kassaga yo`naltiriladi"
  v_pending_no := 'POS-EX-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' || upper(substr(v_pending_id::text, 1, 6));

  -- Yangi tovarni rezerv qilish
  update public.inventory_units
  set status = 'reserved',
      reserved_until = now() + interval '30 minutes',
      version = version + 1
  where id = v_new_u.id;

  insert into public.pos_pending_sales(
    id, pending_no, branch_id, seller_id, customer_id, subtotal, discount, tax, total,
    status, expires_at, created_at, updated_at
  ) values (
    v_pending_id, v_pending_no, p_branch_id, auth.uid(), v_sale.customer_id,
    v_new_price, v_returned_price, 0, v_diff,
    'pending', now() + interval '30 minutes', now(), now()
  ) returning * into v_pending_row;

  insert into public.pos_pending_sale_lines(
    pending_sale_id, unit_id, product_id, unit_price, discount, tax_rate, line_total, unit_cost
  ) values (
    v_pending_id, v_new_u.id, v_new_prod.id, v_new_price, v_returned_price, 0, v_diff, v_new_prod.cost_price
  );

  -- Qaytarish so'rovini ham bog'lash uchun saqlaymiz:
  insert into public.sale_returns(
    original_sale_id, kind, status, branch_id, customer_id, reason, refund_amount, requested_by
  ) values (
    v_sale.id, 'exchange', 'requested', p_branch_id, v_sale.customer_id,
    '2-opsiya almashtirish: Yangi tovar ' || v_new_prod.name || ' (Chek farqi: ' || to_char(v_diff, 'FM999,999,999') || ' so‘m)',
    v_returned_price, auth.uid()
  );

  return jsonb_build_object(
    'success', true,
    'pending_sale_id', v_pending_id,
    'pending_no', v_pending_no,
    'returned_price', v_returned_price,
    'new_price', v_new_price,
    'difference', v_diff,
    'message', 'Mijoz hisobiga ' || to_char(v_diff, 'FM999,999,999') || ' so‘m farq yozildi va chek kassaga yo‘naltirildi.'
  );
end $$;

-- -----------------------------------------------------------------------------
-- 5. 3-OPSIYA: request_pos_cash_refund (Tovarni qaytarib kassaga naqd pulga yo'naltirish)
-- -----------------------------------------------------------------------------

create or replace function public.request_pos_cash_refund(
  p_branch_id uuid,
  p_unit_id uuid,
  p_reason text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u public.inventory_units%rowtype;
  v_line public.sale_lines%rowtype;
  v_sale public.sales%rowtype;
  v_ret_id uuid := gen_random_uuid();
  v_ret_no text;
  v_reason text := coalesce(nullif(btrim(p_reason), ''), '3-opsiya: Tovarni qaytarib pulini olish');
begin
  if p_branch_id is null or p_unit_id is null then
    raise exception 'Filial va tovar talab qilinadi' using errcode = '22023';
  end if;
  perform public.require_pos_seller(p_branch_id);

  select * into v_u from public.inventory_units where id = p_unit_id for update;
  if not found then raise exception 'Birlik topilmadi' using errcode = 'P0002'; end if;

  select sl.* into v_line from public.sale_lines sl
  join public.sales s on s.id = sl.sale_id
  where sl.unit_id = v_u.id
  order by s.sold_at desc, sl.created_at desc limit 1;

  if not found then raise exception 'Sotuv tarixi topilmadi' using errcode = 'P0002'; end if;
  select * into v_sale from public.sales where id = v_line.sale_id;

  if v_sale.branch_id is distinct from p_branch_id then
    raise exception 'Bu birlik boshqa filialda sotilgan' using errcode = 'P0001';
  end if;
  if v_sale.sold_at < (now() - interval '30 days') then
    raise exception 'Xarid qilingan kundan 1 oydan ortiq vaqt o‘tgan (30 kunlik muddat tugagan)' using errcode = '22023';
  end if;
  if v_u.status <> 'sold' or v_u.sold_sale_id is distinct from v_sale.id then
    raise exception 'Birlik sotilgan holatda emas (holat: %)', v_u.status::text using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.sale_return_lines x
    join public.sale_returns r on r.id = x.return_id
    where x.unit_id = v_u.id and r.status in ('requested', 'approved', 'completed')
  ) then
    raise exception 'Bu tovar uchun qaytarish so‘rovi allaqachon mavjud' using errcode = 'P0001';
  end if;

  v_ret_no := 'RET-REF-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS') || '-' || upper(substr(v_ret_id::text, 1, 6));

  insert into public.sale_returns(
    id, return_no, original_sale_id, kind, status, branch_id, customer_id,
    reason, refund_amount, requested_by
  ) values (
    v_ret_id, v_ret_no, v_sale.id, 'return', 'requested', p_branch_id, v_sale.customer_id,
    v_reason, v_line.line_total, auth.uid()
  );

  insert into public.sale_return_lines(
    return_id, sale_line_id, unit_id, quantity, condition, refund_amount
  ) values (
    v_ret_id, v_line.id, v_u.id, 1, 'resellable', v_line.line_total
  );

  return jsonb_build_object(
    'success', true,
    'return_id', v_ret_id,
    'return_no', v_ret_no,
    'refund_amount', v_line.line_total,
    'message', 'Qaytarish so‘rovi yaratildi. Mijoz kassaga yo‘naltirildi — kassa naqd pulni qaytargach jarayon yakunlanadi.'
  );
end $$;

-- -----------------------------------------------------------------------------
-- 6. complete_pos_cash_refund: Kassir / Menejer pulni qaytarishi va yakunlashi
-- -----------------------------------------------------------------------------

create or replace function public.complete_pos_cash_refund(
  p_return_id uuid,
  p_resell_location_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_r public.sale_returns%rowtype;
  v_sale public.sales%rowtype;
  v_x record;
  v_u public.inventory_units%rowtype;
  v_dest uuid;
  v_completed integer;
  v_all integer;
  v_total_refunded numeric(18,2);
begin
  select * into v_r from public.sale_returns where id = p_return_id for update;
  if not found then raise exception 'Qaytarish so‘rovi topilmadi' using errcode = 'P0002'; end if;
  perform public.require_pos_manager(v_r.branch_id);

  if v_r.status = 'completed' then return to_jsonb(v_r); end if;
  if v_r.status in ('rejected', 'cancelled') then
    raise exception 'Ushbu qaytarish bekor qilingan yoki rad etilgan' using errcode = 'P0001';
  end if;

  select * into v_sale from public.sales where id = v_r.original_sale_id for update;

  select id into v_dest from public.locations
  where id = coalesce(p_resell_location_id, (select location_id from public.inventory_units where id = (select unit_id from public.sale_return_lines where return_id = p_return_id limit 1)))
    and branch_id = v_r.branch_id and is_active and type in ('store', 'warehouse');
  if v_dest is null then
    select id into v_dest from public.locations where branch_id = v_r.branch_id and is_active and type = 'store' order by name limit 1;
  end if;

  -- Birlik(lar)ni omborga qaytarish (+1 dona erkin sotuvga)
  for v_x in select x.*, sl.unit_cost from public.sale_return_lines x
             join public.sale_lines sl on sl.id = x.sale_line_id
             where x.return_id = p_return_id loop
    select * into v_u from public.inventory_units where id = v_x.unit_id for update;

    update public.inventory_units
    set status = 'available',
        location_id = v_dest,
        sold_sale_id = null,
        reserved_until = null,
        version = version + 1
    where id = v_u.id;

    insert into public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) values (
      v_u.id, v_u.product_id, v_u.batch_id, 'returned', v_u.location_id, v_dest,
      1, v_x.unit_cost, 'sale_return', p_return_id, coalesce(v_r.reason, 'Kassadan pul qaytarildi'), auth.uid(),
      jsonb_build_object('refund_amount', v_x.refund_amount)
    );
  end loop;

  -- Yakunlash
  update public.sale_returns
  set status = 'completed',
      approved_by = coalesce(approved_by, auth.uid()),
      approved_at = coalesce(approved_at, now()),
      completed_at = now()
  where id = p_return_id returning * into v_r;

  insert into public.sale_refunds(return_id, sale_id, amount, created_by)
  values (v_r.id, v_r.original_sale_id, v_r.refund_amount, auth.uid())
  on conflict (return_id) do nothing;

  -- Asl sotuv holatini yangilash
  select count(*) into v_all from public.sale_lines where sale_id = v_r.original_sale_id;
  select count(distinct x.sale_line_id) into v_completed from public.sale_return_lines x
  join public.sale_returns r on r.id = x.return_id
  where r.original_sale_id = v_r.original_sale_id and r.status = 'completed';

  update public.sales
  set status = case when v_completed >= v_all then 'returned'::public.sale_status else 'partially_returned'::public.sale_status end
  where id = v_r.original_sale_id;

  select coalesce(sum(refund_amount), 0) into v_total_refunded
  from public.sale_returns where original_sale_id = v_r.original_sale_id and status = 'completed';

  update public.sale_payments
  set status = case when v_total_refunded >= v_sale.total then 'refunded'::public.payment_status else 'partially_refunded'::public.payment_status end
  where sale_id = v_r.original_sale_id and status in ('paid', 'partially_refunded');

  return jsonb_build_object(
    'success', true,
    'return_id', v_r.id,
    'return_no', v_r.return_no,
    'refund_amount', v_r.refund_amount,
    'message', 'Naqd pul mijozga qaytarildi, tovar do‘kon balansiga o‘tkazildi va asl sotuv kunidagi aylanma kamaytirildi.'
  );
end $$;

-- -----------------------------------------------------------------------------
-- 7. list_my_pos_sales_filtered: Qaytarilgan pul o'sha kungi savdo aylanmasidan chiqarilsin!
-- -----------------------------------------------------------------------------

create or replace function public.list_my_pos_sales_filtered(
  p_branch_id uuid,
  p_date date,
  p_query text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_timezone text;
  v_date date;
  v_start timestamptz;
  v_end timestamptz;
  v_query text := nullif(btrim(p_query), '');
  v_items jsonb;
  v_total bigint;
  v_kpi jsonb;
begin
  perform public.require_pos_seller(p_branch_id);
  if p_limit not between 1 and 100 or p_offset < 0 then
    raise exception 'Sahifalash noto‘g‘ri' using errcode = '22023';
  end if;

  select coalesce(b.timezone, 'Asia/Tashkent') into v_timezone
  from public.branches b where b.id = p_branch_id;
  if v_timezone is null then v_timezone := 'Asia/Tashkent'; end if;

  v_date := coalesce(p_date, (now() at time zone v_timezone)::date);
  v_start := v_date::timestamp at time zone v_timezone;
  v_end := (v_date + 1)::timestamp at time zone v_timezone;

  select count(*) into v_total
  from public.sales s
  where s.branch_id = p_branch_id
    and s.seller_id = auth.uid()
    and s.status <> 'void'
    and s.sold_at >= v_start and s.sold_at < v_end
    and (
      v_query is null
      or s.sale_no ilike '%' || v_query || '%'
      or exists (
        select 1
        from public.sale_lines x
        join public.products p on p.id = x.product_id
        join public.inventory_units u on u.id = x.unit_id
        where x.sale_id = s.id
          and (
            p.name ilike '%' || v_query || '%'
            or p.sku ilike '%' || v_query || '%'
            or u.qr_code ilike '%' || v_query || '%'
            or coalesce(u.serial_number, '') ilike '%' || v_query || '%'
          )
      )
    );

  select coalesce(jsonb_agg(to_jsonb(q) order by q.sold_at desc, q.id), '[]'::jsonb)
  into v_items
  from (
    select
      s.id, s.sale_no, s.pending_sale_id, s.seller_id,
      seller.full_name as seller_name,
      s.manager_id, manager.full_name as manager_name,
      s.subtotal, s.discount, s.tax,
      -- Agar tovar qaytarilgan bo'lsa, sof tushum = total - refund:
      greatest(0, s.total - coalesce((
        select sum(r.refund_amount) from public.sale_returns r
        where r.original_sale_id = s.id and r.status = 'completed'
      ), 0)) as total,
      s.status, s.sold_at,
      (select count(*) from public.sale_lines x where x.sale_id = s.id) as unit_count,
      greatest(0, (
        select coalesce(sum(x.line_total - x.tax - x.unit_cost), 0)
        from public.sale_lines x where x.sale_id = s.id
      ) - coalesce((
        select sum(r.refund_amount) from public.sale_returns r
        where r.original_sale_id = s.id and r.status = 'completed'
      ), 0)) as profit
    from public.sales s
    join public.profiles seller on seller.id = s.seller_id
    left join public.profiles manager on manager.id = s.manager_id
    where s.branch_id = p_branch_id
      and s.seller_id = auth.uid()
      and s.status <> 'void'
      and s.sold_at >= v_start and s.sold_at < v_end
      and (
        v_query is null
        or s.sale_no ilike '%' || v_query || '%'
        or exists (
          select 1
          from public.sale_lines x
          join public.products p on p.id = x.product_id
          join public.inventory_units u on u.id = x.unit_id
          where x.sale_id = s.id
            and (
              p.name ilike '%' || v_query || '%'
              or p.sku ilike '%' || v_query || '%'
              or u.qr_code ilike '%' || v_query || '%'
              or coalesce(u.serial_number, '') ilike '%' || v_query || '%'
            )
        )
      )
    order by s.sold_at desc, s.id
    limit p_limit offset p_offset
  ) q;

  -- KPI hisob-kitobi: qaytarilgan tovarlar summasi ayiriladi!
  select jsonb_build_object(
    'count', count(*),
    'total', coalesce(sum(q.total), 0),
    'profit', coalesce(sum(q.profit), 0),
    'avg_check', coalesce(round(avg(q.total) filter (where q.total > 0), 2), 0),
    'discount', coalesce(sum(q.discount), 0)
  )
  into v_kpi
  from (
    select
      greatest(0, s.total - coalesce((
        select sum(r.refund_amount) from public.sale_returns r
        where r.original_sale_id = s.id and r.status = 'completed'
      ), 0)) as total,
      s.discount,
      greatest(0, (
        select coalesce(sum(x.line_total - x.tax - x.unit_cost), 0)
        from public.sale_lines x where x.sale_id = s.id
      ) - coalesce((
        select sum(r.refund_amount) from public.sale_returns r
        where r.original_sale_id = s.id and r.status = 'completed'
      ), 0)) as profit
    from public.sales s
    where s.branch_id = p_branch_id
      and s.seller_id = auth.uid()
      and s.status not in ('void', 'returned')
      and s.sold_at >= v_start and s.sold_at < v_end
      and (
        v_query is null
        or s.sale_no ilike '%' || v_query || '%'
        or exists (
          select 1
          from public.sale_lines x
          join public.products p on p.id = x.product_id
          join public.inventory_units u on u.id = x.unit_id
          where x.sale_id = s.id
            and (
              p.name ilike '%' || v_query || '%'
              or p.sku ilike '%' || v_query || '%'
              or u.qr_code ilike '%' || v_query || '%'
              or coalesce(u.serial_number, '') ilike '%' || v_query || '%'
            )
        )
      )
  ) q;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'date', v_date,
    'today', v_kpi
  );
end $$;

-- -----------------------------------------------------------------------------
-- 8. list_sales_history: Tarixda qaytarilgan savdolar refund summasi chegirilsin
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_sales_history(
  p_branch_id uuid DEFAULT NULL,
  p_seller_id uuid DEFAULT NULL,
  p_from date DEFAULT current_date,
  p_to date DEFAULT current_date,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_items jsonb;
  v_total bigint;
  v_from date := p_from;
  v_to date := p_to;
  v_tmp date;
BEGIN
  PERFORM public.require_report_access(p_branch_id);

  IF v_from IS NULL AND v_to IS NULL THEN
    v_from := current_date;
    v_to := current_date;
  ELSIF v_from IS NULL THEN
    v_from := v_to;
  ELSIF v_to IS NULL THEN
    v_to := v_from;
  END IF;

  IF v_to < v_from THEN
    v_tmp := v_from;
    v_from := v_to;
    v_to := v_tmp;
  END IF;

  WITH filtered AS (
    SELECT
      sl.id AS line_id,
      sl.unit_id,
      sl.product_id,
      sl.unit_price,
      sl.discount,
      sl.tax,
      sl.line_total,
      sl.unit_cost,
      s.id AS sale_id,
      s.sale_no,
      s.sold_at,
      s.status::text AS sale_status,
      s.branch_id,
      b.name AS branch_name,
      b.code AS branch_code,
      seller.full_name AS seller_name,
      s.seller_id,
      manager.full_name AS manager_name,
      p.name AS product_name,
      p.sku,
      p.slug AS product_slug,
      p.is_published,
      (SELECT pm.public_url FROM public.product_media pm
       WHERE pm.product_id = p.id AND pm.is_primary = true
       LIMIT 1) AS primary_media_url,
      u.qr_code,
      u.serial_number,
      coalesce((select sum(r.refund_amount) from public.sale_returns r where r.original_sale_id = s.id and r.status = 'completed'), 0) as total_refunded,
      count(*) OVER () AS total_count
    FROM public.sale_lines sl
    JOIN public.sales s ON s.id = sl.sale_id
    JOIN public.branches b ON b.id = s.branch_id
    JOIN public.profiles seller ON seller.id = s.seller_id
    LEFT JOIN public.profiles manager ON manager.id = s.manager_id
    JOIN public.products p ON p.id = sl.product_id
    LEFT JOIN public.inventory_units u ON u.id = sl.unit_id
    WHERE s.status <> 'void'
      AND s.sold_at >= public.business_day_start(v_from)
      AND s.sold_at < public.business_day_start(v_to + 1)
      AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
      AND (p_seller_id IS NULL OR s.seller_id = p_seller_id)
      AND (
        p_query IS NULL OR btrim(p_query) = ''
        OR p.name ILIKE '%' || btrim(p_query) || '%'
        OR p.sku ILIKE '%' || btrim(p_query) || '%'
        OR coalesce(u.qr_code, '') ILIKE '%' || btrim(p_query) || '%'
        OR coalesce(u.serial_number, '') ILIKE '%' || btrim(p_query) || '%'
      )
    ORDER BY s.sold_at DESC, sl.id DESC
    LIMIT greatest(coalesce(p_limit, 50), 1)
    OFFSET greatest(coalesce(p_offset, 0), 0)
  )
  SELECT
    coalesce(jsonb_agg((to_jsonb(f) - 'total_count') ORDER BY f.sold_at DESC, f.line_id DESC), '[]'::jsonb),
    coalesce(max(f.total_count), 0)
  INTO v_items, v_total
  FROM filtered f;

  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. Grantlar
-- -----------------------------------------------------------------------------

revoke all on function public.find_sale_return_unit(uuid, text) from public, anon;
grant execute on function public.find_sale_return_unit(uuid, text) to authenticated, service_role;

revoke all on function public.list_branch_sold_units_by_date(uuid, date, text) from public, anon;
grant execute on function public.list_branch_sold_units_by_date(uuid, date, text) to authenticated, service_role;

revoke all on function public.execute_pos_same_product_exchange(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.execute_pos_same_product_exchange(uuid, uuid, uuid, text) to authenticated, service_role;

revoke all on function public.create_pos_exchange_upgrade(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.create_pos_exchange_upgrade(uuid, uuid, uuid, text) to authenticated, service_role;

revoke all on function public.request_pos_cash_refund(uuid, uuid, text) from public, anon;
grant execute on function public.request_pos_cash_refund(uuid, uuid, text) to authenticated, service_role;

revoke all on function public.complete_pos_cash_refund(uuid, uuid) from public, anon;
grant execute on function public.complete_pos_cash_refund(uuid, uuid) to authenticated, service_role;

grant execute on function public.list_my_pos_sales_filtered(uuid, date, text, integer, integer) to authenticated, service_role;
grant execute on function public.list_sales_history(uuid, uuid, date, date, text, integer, integer) to authenticated, service_role;

commit;
