-- 20260936000000_ai_advanced_operations.sql
-- AI orqali to'liq boshqaruv (tovar yaratish, har bir rang uchun alohida rasm, partiya qabuli, CMS, xarajat, transfer, metadata) uchun atomik RPC'lar

begin;

-- 1. AI Metadata Catalogs (Kategoriyalar, brendlar, ta'minotchilar, filiallar, joylashuvlar)
create or replace function public.ai_get_metadata_catalogs()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_categories jsonb;
  v_brands jsonb;
  v_suppliers jsonb;
  v_branches jsonb;
begin
  if auth.uid() is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;

  select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'slug', slug, 'parent_id', parent_id) order by name)
  into v_categories from public.categories where is_active = true;

  select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'slug', slug) order by name)
  into v_brands from public.brands where is_active = true;

  select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone) order by name)
  into v_suppliers from public.suppliers where is_active = true;

  select jsonb_agg(
    jsonb_build_object(
      'id', b.id,
      'name', b.name,
      'code', b.code,
      'locations', (
        select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'type', l.type) order by l.type desc, l.name)
        from public.locations l
        where l.branch_id = b.id and l.is_active = true
      )
    ) order by b.name
  )
  into v_branches from public.branches b where b.is_active = true;

  return jsonb_build_object(
    'categories', coalesce(v_categories, '[]'::jsonb),
    'brands', coalesce(v_brands, '[]'::jsonb),
    'suppliers', coalesce(v_suppliers, '[]'::jsonb),
    'branches', coalesce(v_branches, '[]'::jsonb)
  );
end;
$$;

-- 2. AI Create or Update Product (har bir rang uchun alohida rasm va barcha narxlar bilan)
create or replace function public.ai_create_or_update_product(
  p_name text,
  p_category_name text default null,
  p_category_id uuid default null,
  p_brand_name text default null,
  p_brand_id uuid default null,
  p_cost_price numeric default 0,
  p_retail_price numeric default 0,
  p_wholesale_price numeric default null,
  p_promotion_price numeric default null,
  p_minimum_price numeric default null,
  p_description text default null,
  p_sku text default null,
  p_barcode text default null,
  p_youtube_url text default null,
  p_colors jsonb default '[]'::jsonb,
  p_product_id uuid default null,
  p_is_published boolean default true,
  p_image_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cat_id uuid := p_category_id;
  v_brd_id uuid := p_brand_id;
  v_product_id uuid := p_product_id;
  v_sku text := nullif(btrim(coalesce(p_sku, '')), '');
  v_name text := btrim(p_name);
  v_slug text;
  v_clean_slug text;
  v_count integer := 0;
  v_min_price numeric := coalesce(p_minimum_price, p_cost_price, 0);
  v_status public.product_status := case when coalesce(p_is_published, true) then 'active'::public.product_status else 'draft'::public.product_status end;
  v_item jsonb;
  v_var_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;

  if v_name is null or length(v_name) < 2 then
    raise exception 'Mahsulot nomi kamida 2 ta belgidan iborat bo''lishi kerak' using errcode = '22023';
  end if;

  -- Kategoriya nomidan qidirish yoki yaratish
  if v_cat_id is null and p_category_name is not null and length(btrim(p_category_name)) > 0 then
    select id into v_cat_id from public.categories where lower(name) = lower(btrim(p_category_name)) limit 1;
    if v_cat_id is null then
      insert into public.categories (name, slug, is_active)
      values (btrim(p_category_name), regexp_replace(lower(btrim(p_category_name)), '[^a-z0-9]+', '-', 'g') || '-' || substring(gen_random_uuid()::text, 1, 6), true)
      returning id into v_cat_id;
    end if;
  end if;

  -- Brend nomidan qidirish yoki yaratish
  if v_brd_id is null and p_brand_name is not null and length(btrim(p_brand_name)) > 0 then
    select id into v_brd_id from public.brands where lower(name) = lower(btrim(p_brand_name)) limit 1;
    if v_brd_id is null then
      insert into public.brands (name, slug, is_active)
      values (btrim(p_brand_name), regexp_replace(lower(btrim(p_brand_name)), '[^a-z0-9]+', '-', 'g') || '-' || substring(gen_random_uuid()::text, 1, 6), true)
      returning id into v_brd_id;
    end if;
  end if;

  -- Slug yaratish
  v_clean_slug := regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g');
  v_clean_slug := trim(both '-' from v_clean_slug);
  if length(v_clean_slug) = 0 then v_clean_slug := 'product'; end if;
  v_slug := v_clean_slug;

  if v_product_id is null then
    -- SKU bo'lmasa avtomatik generatsiya
    if v_sku is null then
      v_sku := 'INV-' || to_char(now(), 'YYMMDD') || lpad(floor(random()*9000+1000)::text, 4, '0');
    end if;

    -- Unikal slug
    loop
      exit when not exists (select 1 from public.products where slug = v_slug);
      v_count := v_count + 1;
      v_slug := v_clean_slug || '-' || v_count;
    end loop;

    insert into public.products (
      name, slug, sku, category_id, brand_id, cost_price, retail_price,
      wholesale_price, promotion_price, minimum_sale_price, description,
      barcode, is_published, status
    ) values (
      v_name, v_slug, v_sku, v_cat_id, v_brd_id,
      coalesce(p_cost_price, 0), coalesce(p_retail_price, 0),
      p_wholesale_price, p_promotion_price, v_min_price,
      p_description, p_barcode, coalesce(p_is_published, true), v_status
    ) returning id into v_product_id;

  else
    update public.products set
      name = v_name,
      category_id = coalesce(v_cat_id, category_id),
      brand_id = coalesce(v_brd_id, brand_id),
      cost_price = coalesce(p_cost_price, cost_price),
      retail_price = coalesce(p_retail_price, retail_price),
      wholesale_price = coalesce(p_wholesale_price, wholesale_price),
      promotion_price = coalesce(p_promotion_price, promotion_price),
      minimum_sale_price = coalesce(p_minimum_price, minimum_sale_price, p_cost_price),
      description = coalesce(p_description, description),
      barcode = coalesce(p_barcode, barcode),
      is_published = coalesce(p_is_published, is_published),
      status = v_status,
      updated_at = now()
    where id = v_product_id;
  end if;

  -- Rang variantlari (agar berilgan bo'lsa)
  if p_colors is not null and jsonb_typeof(p_colors) = 'array' and jsonb_array_length(p_colors) > 0 then
    perform public.save_product_variants(v_product_id, p_colors);

    -- Har bir rang variantining rasmini product_media ga biriktirish
    for v_item in select value from jsonb_array_elements(p_colors) loop
      if nullif(btrim(coalesce(v_item->>'image_url', '')), '') is not null then
        select id into v_var_id from public.product_variants
        where product_id = v_product_id and color_name = btrim(v_item->>'color_name')
        limit 1;

        if v_var_id is not null then
          insert into public.product_media (product_id, variant_id, public_url, is_primary)
          values (v_product_id, v_var_id, btrim(v_item->>'image_url'), false)
          on conflict do nothing;
        end if;
      end if;
    end loop;
  end if;

  -- Asosiy rasm qo'shish (agar berilgan bo'lsa)
  if p_image_url is not null and length(btrim(p_image_url)) > 0 then
    insert into public.product_media (product_id, public_url, is_primary)
    values (v_product_id, btrim(p_image_url), true)
    on conflict do nothing;
  end if;

  return (
    select jsonb_build_object(
      'product', to_jsonb(p.*),
      'image_url', p_image_url
    )
    from public.products p where p.id = v_product_id
  );
end;
$$;

-- 3. AI Receive Stock Batch (Partiya qabuli)
create or replace function public.ai_receive_stock_batch(
  p_branch_id uuid,
  p_location_id uuid,
  p_supplier_id uuid default null,
  p_lines jsonb default '[]'::jsonb,
  p_currency text default 'USD',
  p_invoice text default null,
  p_payment_status text default 'paid',
  p_paid_amount numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supplier_id uuid := p_supplier_id;
  v_header jsonb;
  v_idempotency_key uuid := gen_random_uuid();
  v_result jsonb;
  v_resolved_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_prod_id uuid;
  v_raw_prod text;
begin
  if auth.uid() is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;

  if v_supplier_id is null then
    select id into v_supplier_id from public.suppliers where is_active = true order by created_at asc limit 1;
    if v_supplier_id is null then
      insert into public.suppliers (name, is_active) values ('Asosiy ta''minotchi', true) returning id into v_supplier_id;
    end if;
  end if;

  -- Agar product_id SKU yoki nom sifatida berilgan bo'lsa, UUID ga o'giramiz
  for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_raw_prod := btrim(coalesce(v_line->>'product_id', ''));
    if v_raw_prod ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_prod_id := v_raw_prod::uuid;
    else
      select id into v_prod_id from public.products where sku ilike v_raw_prod or name ilike v_raw_prod limit 1;
    end if;

    if v_prod_id is not null then
      v_resolved_lines := v_resolved_lines || jsonb_build_array(
        v_line || jsonb_build_object('product_id', v_prod_id)
      );
    end if;
  end loop;

  v_header := jsonb_build_object(
    'branch_id', p_branch_id,
    'receiving_location_id', p_location_id,
    'supplier_id', v_supplier_id,
    'currency', coalesce(p_currency, 'USD'),
    'invoice_number', p_invoice,
    'payment_status', coalesce(p_payment_status, 'paid'),
    'paid_amount', p_paid_amount,
    'received_at', now()
  );

  v_result := public.receive_stock(v_header, v_resolved_lines, v_idempotency_key);
  return v_result;
end;
$$;

-- 4. AI Quick Inventory Stock (Tezkor qoldiq kiritish)
create or replace function public.ai_quick_inventory_stock(
  p_product_id text,
  p_branch_id uuid,
  p_location_id uuid,
  p_quantity integer,
  p_cost_price numeric default null,
  p_retail_price numeric default null,
  p_variant_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prod record;
  v_prod_id uuid;
  v_supplier_id uuid;
  v_cost numeric(18,2);
  v_retail numeric(18,2);
  v_lines jsonb;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;

  if p_quantity is null or p_quantity < 1 or p_quantity > 500 then
    raise exception 'Miqdor 1 dan 500 gacha bo''lishi kerak' using errcode = '22023';
  end if;

  if p_product_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_prod_id := p_product_id::uuid;
  else
    select id into v_prod_id from public.products where sku ilike p_product_id or name ilike p_product_id limit 1;
  end if;

  select * into v_prod from public.products where id = v_prod_id;
  if not found then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;

  -- Standart yoki birinchi ta'minotchi
  select id into v_supplier_id from public.suppliers where is_active = true order by created_at asc limit 1;
  if v_supplier_id is null then
    insert into public.suppliers (name, is_active) values ('Standart ta''minotchi', true) returning id into v_supplier_id;
  end if;

  v_cost := coalesce(p_cost_price, v_prod.cost_price, 0);
  v_retail := coalesce(p_retail_price, v_prod.retail_price, 0);

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'product_id', v_prod.id,
      'variant_id', p_variant_id,
      'quantity', p_quantity,
      'unit_cost', v_cost,
      'retail_price', v_retail
    )
  );

  v_result := public.ai_receive_stock_batch(
    p_branch_id,
    p_location_id,
    v_supplier_id,
    v_lines,
    'USD',
    'AI-QUICK-' || to_char(now(), 'YYMMDD-HH24MI'),
    'paid',
    v_cost * p_quantity
  );

  return v_result;
end;
$$;

-- 5. AI Delete or Archive Product
create or replace function public.ai_delete_or_archive_product(
  p_product_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sold_count integer := 0;
  v_total_units integer := 0;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;

  select name into v_name from public.products where id = p_product_id;
  if not found then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;

  select count(*) filter (where status = 'SOLD'), count(*)
  into v_sold_count, v_total_units
  from public.inventory_units
  where product_id = p_product_id;

  if v_sold_count > 0 then
    update public.products set is_published = false, status = 'archived'::public.product_status where id = p_product_id;
    return jsonb_build_object('ok', true, 'action', 'archived', 'message', format('Mahsulotda %s ta sotilgan birlik borligi sababli u saytdan yashirildi va arxivlandi.', v_sold_count));
  else
    delete from public.inventory_units where product_id = p_product_id;
    delete from public.products where id = p_product_id;
    return jsonb_build_object('ok', true, 'action', 'deleted', 'message', format('Mahsulot (%s) muvaffaqiyatli o''chirildi.', v_name));
  end if;
end;
$$;

-- 6. AI Create Expense (Xarajat yozish)
create or replace function public.ai_create_expense(
  p_branch_id uuid,
  p_category text,
  p_title text,
  p_amount numeric,
  p_note text default null,
  p_paid_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exp uuid;
  v_period text;
  v_valid_category text := p_category;
begin
  if auth.uid() is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Xarajat summasi 0 dan katta bo''lishi kerak' using errcode = '22023';
  end if;

  if v_valid_category not in ('tax','rent','electricity','water','gas','llc','sole_trader','salary','transport','other') then
    v_valid_category := 'other';
  end if;

  v_period := to_char(coalesce(p_paid_at, now()), 'YYYY-MM');

  insert into public.expenses (
    branch_id, category, title, amount, currency, period_month,
    paid_at, note, created_by
  ) values (
    p_branch_id, v_valid_category, coalesce(p_title, 'Xarajat'), p_amount, 'UZS', v_period,
    coalesce(p_paid_at, now()), p_note, auth.uid()
  ) returning id into v_exp;

  return jsonb_build_object('ok', true, 'id', v_exp, 'title', p_title, 'amount', p_amount, 'period', v_period);
end;
$$;

-- 7. AI Relocate Unit (Joylashuvni o'zgartirish)
create or replace function public.ai_relocate_unit(
  p_code text,
  p_target_location_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unit_id uuid;
  v_prod_name text;
  v_loc_name text;
begin
  if auth.uid() is null then
    raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501';
  end if;

  select u.id, p.name into v_unit_id, v_prod_name
  from public.inventory_units u
  join public.products p on p.id = u.product_id
  where u.qr_code = p_code or u.serial_number = p_code or u.id::text = p_code
  limit 1;

  if v_unit_id is null then
    raise exception 'QR kod bo''yicha tovar topilmadi: %', p_code using errcode = 'P0002';
  end if;

  select name into v_loc_name from public.locations where id = p_target_location_id;
  if v_loc_name is null then
    raise exception 'Yangi joylashuv topilmadi' using errcode = 'P0002';
  end if;

  perform public.relocate_inventory_unit(v_unit_id, p_target_location_id, coalesce(p_note, 'AI orqali joyi o''zgartirildi'));

  return jsonb_build_object('ok', true, 'product_name', v_prod_name, 'new_location', v_loc_name);
end;
$$;

-- Grant permissions to authenticated users
grant execute on function public.ai_get_metadata_catalogs() to authenticated, service_role;
grant execute on function public.ai_create_or_update_product(text, text, uuid, text, uuid, numeric, numeric, numeric, numeric, numeric, text, text, text, text, jsonb, uuid, boolean, text) to authenticated, service_role;
grant execute on function public.ai_receive_stock_batch(uuid, uuid, uuid, jsonb, text, text, text, numeric) to authenticated, service_role;
grant execute on function public.ai_quick_inventory_stock(uuid, uuid, uuid, integer, numeric, numeric, uuid) to authenticated, service_role;
grant execute on function public.ai_delete_or_archive_product(uuid) to authenticated, service_role;
grant execute on function public.ai_create_expense(uuid, text, text, numeric, text, timestamptz) to authenticated, service_role;
grant execute on function public.ai_relocate_unit(text, uuid, text) to authenticated, service_role;

commit;
