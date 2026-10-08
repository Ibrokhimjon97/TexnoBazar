-- Backup and 100% Restore System for Texnobazar
-- Exports and restores products, variants, media metadata, categories, brands,
-- attributes, suppliers, stock receipts, stock batches, individual inventory units (with TNB1- QR codes),
-- locations, and inventory balances.
begin;

-- 1. EXPORT FUNCTION
create or replace function public.export_backup_data(
  p_branch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_is_superadmin boolean := false;
  v_is_manager boolean := false;
  v_effective_branch_id uuid := p_branch_id;
  v_result jsonb;
begin
  -- Allow service_role or superadmin
  if coalesce(auth.jwt()->>'role', '') = 'service_role' then
    v_is_superadmin := true;
  else
    select exists(
      select 1 from public.profile_roles
      where profile_id = v_actor_id and role in ('superadmin', 'admin')
    ) into v_is_superadmin;

    select exists(
      select 1 from public.profile_roles
      where profile_id = v_actor_id and role = 'manager'
        and (p_branch_id is null or branch_id = p_branch_id)
    ) into v_is_manager;
  end if;

  if not (v_is_superadmin or v_is_manager) then
    raise exception 'Zahira nusxasini yuklab olish uchun ruxsat etilmagan.' using errcode = '42501';
  end if;

  -- If manager, scope to their branch if not global
  if not v_is_superadmin and v_effective_branch_id is null then
    select branch_id into v_effective_branch_id
    from public.profile_roles
    where profile_id = v_actor_id and role = 'manager'
    limit 1;
  end if;

  select jsonb_build_object(
    'version', '1.0.0',
    'exported_at', now(),
    'branch_id', v_effective_branch_id,
    'categories', coalesce((
      select jsonb_agg(to_jsonb(c)) from (
        select id, parent_id, name, slug, description, sort_order, is_active,
               seo_image_url, image_url, created_at, updated_at
        from public.categories
        order by sort_order, name
      ) c
    ), '[]'::jsonb),
    'brands', coalesce((
      select jsonb_agg(to_jsonb(b)) from (
        select id, name, slug, description, logo_url, is_active, created_at, updated_at
        from public.brands
        order by name
      ) b
    ), '[]'::jsonb),
    'attribute_definitions', coalesce((
      select jsonb_agg(to_jsonb(a)) from (
        select id, category_id, code, name, data_type, options, is_required, is_filterable, sort_order, created_at, updated_at
        from public.attribute_definitions
        order by category_id, sort_order
      ) a
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(to_jsonb(p)) from (
        select id, sku, barcode, category_id, brand_id, name, slug, description, description_blocks,
               seo_title, seo_description, seo_image_url,
               status, is_published, track_individual_units, cost_price, retail_price,
               compare_at_price, wholesale_price, promotion_price, minimum_sale_price,
               tax_rate, metadata, created_at, updated_at
        from public.products
        order by name
      ) p
    ), '[]'::jsonb),
    'product_variants', coalesce((
      select jsonb_agg(to_jsonb(v)) from (
        select id, product_id, color_name, color_hex, retail_price, wholesale_price,
               promotion_price, minimum_sale_price, sort_order, is_active, created_at, updated_at
        from public.product_variants
        order by product_id, sort_order
      ) v
    ), '[]'::jsonb),
    'product_attribute_values', coalesce((
      select jsonb_agg(to_jsonb(pav)) from (
        select product_id, attribute_id, value, created_at, updated_at
        from public.product_attribute_values
      ) pav
    ), '[]'::jsonb),
    'product_media', coalesce((
      select jsonb_agg(to_jsonb(m)) from (
        select id, product_id, variant_id, r2_key, public_url, mime_type, bytes,
               width, height, alt_text, sort_order, is_primary, created_at, updated_at
        from public.product_media
        order by product_id, sort_order
      ) m
    ), '[]'::jsonb),
    'suppliers', coalesce((
      select jsonb_agg(to_jsonb(s)) from (
        select id, code, name, contact_name, phone, email, address, balance, is_active, created_at, updated_at
        from public.suppliers
        order by name
      ) s
    ), '[]'::jsonb),
    'branches', coalesce((
      select jsonb_agg(to_jsonb(br)) from (
        select id, code, name, phone, address, timezone, currency, is_active, created_at, updated_at
        from public.branches
        where v_effective_branch_id is null or id = v_effective_branch_id
      ) br
    ), '[]'::jsonb),
    'locations', coalesce((
      select jsonb_agg(to_jsonb(loc)) from (
        select id, branch_id, code, name, type, is_active, created_at, updated_at
        from public.locations
        where v_effective_branch_id is null or branch_id = v_effective_branch_id
      ) loc
    ), '[]'::jsonb),
    'stock_receipts', coalesce((
      select jsonb_agg(to_jsonb(sr)) from (
        select sr.id, sr.receipt_no, sr.branch_id, sr.supplier_id, sr.receiving_location_id,
               sr.invoice_number, sr.currency, sr.payment_status, sr.received_at, sr.notes,
               sr.idempotency_key, sr.created_by, sr.paid_amount, sr.created_at, sr.updated_at
        from public.stock_receipts sr
        where v_effective_branch_id is null or sr.branch_id = v_effective_branch_id
        order by sr.received_at desc
      ) sr
    ), '[]'::jsonb),
    'stock_batches', coalesce((
      select jsonb_agg(to_jsonb(b)) from (
        select b.id, b.receipt_id, b.supplier_id, b.product_id, b.variant_id, b.location_id, b.reference,
               b.received_at, b.expires_at, b.quantity, b.unit_cost, b.retail_price,
               b.wholesale_price, b.minimum_sale_price, b.line_no, b.created_by, b.created_at
        from public.stock_batches b
        join public.locations l on l.id = b.location_id
        where v_effective_branch_id is null or l.branch_id = v_effective_branch_id
        order by b.received_at desc
      ) b
    ), '[]'::jsonb),
    'inventory_units', coalesce((
      select jsonb_agg(to_jsonb(u)) from (
        select u.id, u.product_id, u.variant_id, u.batch_id, u.qr_code, u.serial_number,
               u.location_id, u.status, u.sold_sale_id, u.created_at, u.updated_at
        from public.inventory_units u
        join public.locations l on l.id = u.location_id
        where v_effective_branch_id is null or l.branch_id = v_effective_branch_id
        order by u.created_at
      ) u
    ), '[]'::jsonb),
    'inventory_balances', coalesce((
      select jsonb_agg(to_jsonb(bal)) from (
        select bal.location_id, bal.product_id, bal.on_hand, bal.reserved, bal.updated_at
        from public.inventory_balances bal
        join public.locations l on l.id = bal.location_id
        where v_effective_branch_id is null or l.branch_id = v_effective_branch_id
      ) bal
    ), '[]'::jsonb),
    'cms_banners', coalesce((
      select jsonb_agg(to_jsonb(cb)) from (
        select id, title, image_url, r2_key, target_url, placement, sort_order,
               starts_at, ends_at, is_active, mobile_image_url, mobile_r2_key,
               image_fit, image_position_x, image_position_y,
               mobile_image_fit, mobile_image_position_x, mobile_image_position_y,
               created_at, updated_at
        from public.cms_banners
        order by sort_order
      ) cb
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- 2. RESTORE FUNCTION
create or replace function public.restore_backup_data(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_is_superadmin boolean := false;
  v_is_manager boolean := false;

  v_item jsonb;
  v_cat_count int := 0;
  v_brand_count int := 0;
  v_attr_count int := 0;
  v_prod_count int := 0;
  v_var_count int := 0;
  v_media_count int := 0;
  v_supp_count int := 0;
  v_receipt_count int := 0;
  v_batch_count int := 0;
  v_unit_count int := 0;
  v_bal_count int := 0;
  v_banner_count int := 0;
begin
  -- Check caller authorization
  if coalesce(auth.jwt()->>'role', '') = 'service_role' then
    v_is_superadmin := true;
  else
    select exists(
      select 1 from public.profile_roles
      where profile_id = v_actor_id and role in ('superadmin', 'admin')
    ) into v_is_superadmin;

    select exists(
      select 1 from public.profile_roles
      where profile_id = v_actor_id and role = 'manager'
    ) into v_is_manager;
  end if;

  if not (v_is_superadmin or v_is_manager) then
    raise exception 'Zahiradan tiklash uchun ruxsat etilmagan.' using errcode = '42501';
  end if;

  if v_actor_id is null then
    select id into v_actor_id from public.profiles where is_active order by created_at limit 1;
  end if;

  if p_payload is null or not (jsonb_typeof(p_payload) = 'object') then
    raise exception 'Zahira ma''lumoti noto''g''ri formatda.' using errcode = '22023';
  end if;

  -- 1. Restore Categories
  if p_payload ? 'categories' and jsonb_typeof(p_payload->'categories') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'categories')
    loop
      insert into public.categories (id, parent_id, name, slug, description, sort_order, is_active, seo_image_url, image_url)
      values (
        (v_item->>'id')::uuid,
        nullif(v_item->>'parent_id', '')::uuid,
        coalesce(v_item->>'name', 'Kategoriya'),
        coalesce(v_item->>'slug', 'cat-' || substr(md5(random()::text), 1, 8)),
        v_item->>'description',
        coalesce((v_item->>'sort_order')::int, 0),
        coalesce((v_item->>'is_active')::boolean, true),
        v_item->>'seo_image_url',
        v_item->>'image_url'
      )
      on conflict (id) do update set
        parent_id = excluded.parent_id,
        name = excluded.name,
        slug = excluded.slug,
        description = excluded.description,
        sort_order = excluded.sort_order,
        is_active = excluded.is_active,
        seo_image_url = excluded.seo_image_url,
        image_url = excluded.image_url;
      v_cat_count := v_cat_count + 1;
    end loop;
  end if;

  -- 2. Restore Brands
  if p_payload ? 'brands' and jsonb_typeof(p_payload->'brands') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'brands')
    loop
      insert into public.brands (id, name, slug, description, logo_url, is_active)
      values (
        (v_item->>'id')::uuid,
        coalesce(v_item->>'name', 'Brend'),
        coalesce(v_item->>'slug', 'brand-' || substr(md5(random()::text), 1, 8)),
        v_item->>'description',
        v_item->>'logo_url',
        coalesce((v_item->>'is_active')::boolean, true)
      )
      on conflict (id) do update set
        name = excluded.name,
        slug = excluded.slug,
        description = excluded.description,
        logo_url = excluded.logo_url,
        is_active = excluded.is_active;
      v_brand_count := v_brand_count + 1;
    end loop;
  end if;

  -- 3. Restore Attribute Definitions
  if p_payload ? 'attribute_definitions' and jsonb_typeof(p_payload->'attribute_definitions') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'attribute_definitions')
    loop
      insert into public.attribute_definitions (id, category_id, code, name, data_type, options, is_required, is_filterable, sort_order)
      values (
        (v_item->>'id')::uuid,
        (v_item->>'category_id')::uuid,
        coalesce(v_item->>'code', 'attr'),
        coalesce(v_item->>'name', 'Xususiyat'),
        coalesce(v_item->>'data_type', 'text'),
        coalesce(v_item->'options', '[]'::jsonb),
        coalesce((v_item->>'is_required')::boolean, false),
        coalesce((v_item->>'is_filterable')::boolean, false),
        coalesce((v_item->>'sort_order')::int, 0)
      )
      on conflict (id) do update set
        name = excluded.name,
        data_type = excluded.data_type,
        options = excluded.options,
        is_required = excluded.is_required,
        is_filterable = excluded.is_filterable,
        sort_order = excluded.sort_order;
      v_attr_count := v_attr_count + 1;
    end loop;
  end if;

  -- 4. Restore Products
  if p_payload ? 'products' and jsonb_typeof(p_payload->'products') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'products')
    loop
      insert into public.products (
        id, sku, barcode, category_id, brand_id, name, slug, description, description_blocks,
        seo_title, seo_description, seo_image_url, status, is_published, track_individual_units,
        cost_price, retail_price, compare_at_price, wholesale_price, promotion_price,
        minimum_sale_price, tax_rate, metadata
      )
      values (
        (v_item->>'id')::uuid,
        coalesce(v_item->>'sku', 'SKU-' || substr(md5(random()::text), 1, 8)),
        nullif(v_item->>'barcode', ''),
        (v_item->>'category_id')::uuid,
        nullif(v_item->>'brand_id', '')::uuid,
        coalesce(v_item->>'name', 'Mahsulot'),
        coalesce(v_item->>'slug', 'prod-' || substr(md5(random()::text), 1, 8)),
        v_item->>'description',
        coalesce(v_item->'description_blocks', '[]'::jsonb),
        v_item->>'seo_title',
        v_item->>'seo_description',
        v_item->>'seo_image_url',
        coalesce((v_item->>'status')::public.product_status, 'draft'::public.product_status),
        coalesce((v_item->>'is_published')::boolean, false),
        coalesce((v_item->>'track_individual_units')::boolean, true),
        coalesce((v_item->>'cost_price')::numeric, 0),
        coalesce((v_item->>'retail_price')::numeric, 0),
        nullif(v_item->>'compare_at_price', '')::numeric,
        nullif(v_item->>'wholesale_price', '')::numeric,
        nullif(v_item->>'promotion_price', '')::numeric,
        coalesce((v_item->>'minimum_sale_price')::numeric, 0),
        coalesce((v_item->>'tax_rate')::numeric, 0),
        coalesce(v_item->'metadata', '{}'::jsonb)
      )
      on conflict (id) do update set
        sku = excluded.sku,
        barcode = excluded.barcode,
        category_id = excluded.category_id,
        brand_id = excluded.brand_id,
        name = excluded.name,
        slug = excluded.slug,
        description = excluded.description,
        description_blocks = excluded.description_blocks,
        seo_title = excluded.seo_title,
        seo_description = excluded.seo_description,
        seo_image_url = excluded.seo_image_url,
        status = excluded.status,
        is_published = excluded.is_published,
        track_individual_units = excluded.track_individual_units,
        cost_price = excluded.cost_price,
        retail_price = excluded.retail_price,
        compare_at_price = excluded.compare_at_price,
        wholesale_price = excluded.wholesale_price,
        promotion_price = excluded.promotion_price,
        minimum_sale_price = excluded.minimum_sale_price,
        tax_rate = excluded.tax_rate,
        metadata = excluded.metadata;
      v_prod_count := v_prod_count + 1;
    end loop;
  end if;

  -- 5. Restore Product Variants
  if p_payload ? 'product_variants' and jsonb_typeof(p_payload->'product_variants') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'product_variants')
    loop
      insert into public.product_variants (
        id, product_id, color_name, color_hex, retail_price, wholesale_price,
        promotion_price, minimum_sale_price, sort_order, is_active
      )
      values (
        (v_item->>'id')::uuid,
        (v_item->>'product_id')::uuid,
        coalesce(v_item->>'color_name', 'Standart'),
        v_item->>'color_hex',
        nullif(v_item->>'retail_price', '')::numeric,
        nullif(v_item->>'wholesale_price', '')::numeric,
        nullif(v_item->>'promotion_price', '')::numeric,
        nullif(v_item->>'minimum_sale_price', '')::numeric,
        coalesce((v_item->>'sort_order')::int, 0),
        coalesce((v_item->>'is_active')::boolean, true)
      )
      on conflict (id) do update set
        color_name = excluded.color_name,
        color_hex = excluded.color_hex,
        retail_price = excluded.retail_price,
        wholesale_price = excluded.wholesale_price,
        promotion_price = excluded.promotion_price,
        minimum_sale_price = excluded.minimum_sale_price,
        sort_order = excluded.sort_order,
        is_active = excluded.is_active;
      v_var_count := v_var_count + 1;
    end loop;
  end if;

  -- 6. Restore Product Attribute Values
  if p_payload ? 'product_attribute_values' and jsonb_typeof(p_payload->'product_attribute_values') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'product_attribute_values')
    loop
      insert into public.product_attribute_values (product_id, attribute_id, value)
      values (
        (v_item->>'product_id')::uuid,
        (v_item->>'attribute_id')::uuid,
        coalesce(v_item->'value', '""'::jsonb)
      )
      on conflict (product_id, attribute_id) do update set
        value = excluded.value;
    end loop;
  end if;

  -- 7. Restore Product Media
  if p_payload ? 'product_media' and jsonb_typeof(p_payload->'product_media') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'product_media')
    loop
      insert into public.product_media (
        id, product_id, variant_id, r2_key, public_url, mime_type, bytes,
        width, height, alt_text, sort_order, is_primary
      )
      values (
        (v_item->>'id')::uuid,
        (v_item->>'product_id')::uuid,
        nullif(v_item->>'variant_id', '')::uuid,
        coalesce(v_item->>'r2_key', 'media/' || gen_random_uuid()),
        coalesce(v_item->>'public_url', 'https://'),
        v_item->>'mime_type',
        (v_item->>'bytes')::bigint,
        (v_item->>'width')::int,
        (v_item->>'height')::int,
        v_item->>'alt_text',
        coalesce((v_item->>'sort_order')::int, 0),
        coalesce((v_item->>'is_primary')::boolean, false)
      )
      on conflict (id) do update set
        variant_id = excluded.variant_id,
        r2_key = excluded.r2_key,
        public_url = excluded.public_url,
        mime_type = excluded.mime_type,
        bytes = excluded.bytes,
        width = excluded.width,
        height = excluded.height,
        alt_text = excluded.alt_text,
        sort_order = excluded.sort_order,
        is_primary = excluded.is_primary;
      v_media_count := v_media_count + 1;
    end loop;
  end if;

  -- 8. Restore Suppliers
  if p_payload ? 'suppliers' and jsonb_typeof(p_payload->'suppliers') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'suppliers')
    loop
      insert into public.suppliers (id, code, name, contact_name, phone, email, address, balance, is_active)
      values (
        (v_item->>'id')::uuid,
        coalesce(v_item->>'code', 'SUPP-' || substr(md5(random()::text), 1, 6)),
        coalesce(v_item->>'name', 'Yetkazib beruvchi'),
        v_item->>'contact_name',
        v_item->>'phone',
        v_item->>'email',
        coalesce(v_item->'address', '{}'::jsonb),
        coalesce((v_item->>'balance')::numeric, 0),
        coalesce((v_item->>'is_active')::boolean, true)
      )
      on conflict (id) do update set
        code = excluded.code,
        name = excluded.name,
        contact_name = excluded.contact_name,
        phone = excluded.phone,
        email = excluded.email,
        address = excluded.address,
        is_active = excluded.is_active;
      v_supp_count := v_supp_count + 1;
    end loop;
  end if;

  -- 9. Restore Branches & Locations (if present)
  if p_payload ? 'branches' and jsonb_typeof(p_payload->'branches') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'branches')
    loop
      insert into public.branches (id, code, name, phone, address, timezone, currency, is_active)
      values (
        (v_item->>'id')::uuid,
        coalesce(v_item->>'code', 'BR-' || substr(md5(random()::text), 1, 6)),
        coalesce(v_item->>'name', 'Filial'),
        v_item->>'phone',
        coalesce(v_item->'address', '{}'::jsonb),
        coalesce(v_item->>'timezone', 'Asia/Tashkent'),
        coalesce(v_item->>'currency', 'UZS'),
        coalesce((v_item->>'is_active')::boolean, true)
      )
      on conflict (id) do update set
        name = excluded.name,
        phone = excluded.phone,
        address = excluded.address,
        is_active = excluded.is_active;
    end loop;
  end if;

  if p_payload ? 'locations' and jsonb_typeof(p_payload->'locations') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'locations')
    loop
      insert into public.locations (id, branch_id, code, name, type, is_active)
      values (
        (v_item->>'id')::uuid,
        (v_item->>'branch_id')::uuid,
        coalesce(v_item->>'code', 'LOC-' || substr(md5(random()::text), 1, 6)),
        coalesce(v_item->>'name', 'Joylashuv'),
        (v_item->>'type')::public.location_type,
        coalesce((v_item->>'is_active')::boolean, true)
      )
      on conflict (id) do update set
        branch_id = excluded.branch_id,
        name = excluded.name,
        type = excluded.type,
        is_active = excluded.is_active;
    end loop;
  end if;

  -- 10. Restore Stock Receipts
  if p_payload ? 'stock_receipts' and jsonb_typeof(p_payload->'stock_receipts') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'stock_receipts')
    loop
      insert into public.stock_receipts (
        id, receipt_no, branch_id, supplier_id, receiving_location_id,
        invoice_number, currency, payment_status, received_at, notes, idempotency_key, created_by, paid_amount
      )
      values (
        (v_item->>'id')::uuid,
        coalesce(v_item->>'receipt_no', 'REC-' || substr(md5(random()::text), 1, 8)),
        (v_item->>'branch_id')::uuid,
        nullif(v_item->>'supplier_id', '')::uuid,
        (v_item->>'receiving_location_id')::uuid,
        v_item->>'invoice_number',
        coalesce(v_item->>'currency', 'UZS'),
        coalesce(v_item->>'payment_status', 'paid'),
        coalesce((v_item->>'received_at')::timestamptz, now()),
        v_item->>'notes',
        coalesce(nullif(v_item->>'idempotency_key', '')::uuid, gen_random_uuid()),
        coalesce(nullif(v_item->>'created_by', '')::uuid, v_actor_id),
        coalesce((v_item->>'paid_amount')::numeric, 0)
      )
      on conflict (id) do update set
        receipt_no = excluded.receipt_no,
        supplier_id = excluded.supplier_id,
        receiving_location_id = excluded.receiving_location_id,
        invoice_number = excluded.invoice_number,
        currency = excluded.currency,
        payment_status = excluded.payment_status,
        received_at = excluded.received_at,
        notes = excluded.notes,
        paid_amount = excluded.paid_amount;
      v_receipt_count := v_receipt_count + 1;
    end loop;
  end if;

  -- 11. Restore Stock Batches
  if p_payload ? 'stock_batches' and jsonb_typeof(p_payload->'stock_batches') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'stock_batches')
    loop
      insert into public.stock_batches (
        id, receipt_id, supplier_id, product_id, variant_id, location_id, reference,
        received_at, expires_at, quantity, unit_cost, retail_price, wholesale_price,
        minimum_sale_price, line_no, created_by
      )
      values (
        (v_item->>'id')::uuid,
        nullif(v_item->>'receipt_id', '')::uuid,
        nullif(v_item->>'supplier_id', '')::uuid,
        (v_item->>'product_id')::uuid,
        nullif(v_item->>'variant_id', '')::uuid,
        (v_item->>'location_id')::uuid,
        v_item->>'reference',
        coalesce((v_item->>'received_at')::timestamptz, now()),
        nullif(v_item->>'expires_at', '')::timestamptz,
        coalesce((v_item->>'quantity')::numeric, 1),
        coalesce((v_item->>'unit_cost')::numeric, 0),
        coalesce((v_item->>'retail_price')::numeric, 0),
        nullif(v_item->>'wholesale_price', '')::numeric,
        nullif(v_item->>'minimum_sale_price', '')::numeric,
        coalesce((v_item->>'line_no')::int, 1),
        coalesce(nullif(v_item->>'created_by', '')::uuid, v_actor_id)
      )
      on conflict (id) do update set
        receipt_id = excluded.receipt_id,
        supplier_id = excluded.supplier_id,
        reference = excluded.reference,
        quantity = excluded.quantity,
        unit_cost = excluded.unit_cost,
        retail_price = excluded.retail_price,
        wholesale_price = excluded.wholesale_price,
        minimum_sale_price = excluded.minimum_sale_price,
        line_no = excluded.line_no;
      v_batch_count := v_batch_count + 1;
    end loop;
  end if;

  -- 12. Restore Inventory Units
  if p_payload ? 'inventory_units' and jsonb_typeof(p_payload->'inventory_units') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'inventory_units')
    loop
      insert into public.inventory_units (
        id, product_id, variant_id, batch_id, qr_code, serial_number, location_id, status, sold_sale_id
      )
      values (
        (v_item->>'id')::uuid,
        (v_item->>'product_id')::uuid,
        nullif(v_item->>'variant_id', '')::uuid,
        nullif(v_item->>'batch_id', '')::uuid,
        coalesce(v_item->>'qr_code', 'TNB1-' || substr(md5(random()::text), 1, 16)),
        nullif(v_item->>'serial_number', ''),
        (v_item->>'location_id')::uuid,
        coalesce((v_item->>'status')::public.unit_status, 'available'::public.unit_status),
        nullif(v_item->>'sold_sale_id', '')::uuid
      )
      on conflict (id) do update set
        variant_id = excluded.variant_id,
        batch_id = excluded.batch_id,
        qr_code = excluded.qr_code,
        serial_number = excluded.serial_number,
        location_id = excluded.location_id,
        status = excluded.status,
        sold_sale_id = excluded.sold_sale_id;
      v_unit_count := v_unit_count + 1;
    end loop;
  end if;

  -- 13. Recompute Inventory Balances
  insert into public.inventory_balances (location_id, product_id, on_hand, reserved, updated_at)
  select
    u.location_id,
    u.product_id,
    count(*) filter (where u.status in ('available', 'reserved')) as on_hand,
    count(*) filter (where u.status = 'reserved') as reserved,
    now()
  from public.inventory_units u
  group by u.location_id, u.product_id
  on conflict (location_id, product_id) do update set
    on_hand = excluded.on_hand,
    reserved = excluded.reserved,
    updated_at = now();

  get diagnostics v_bal_count = row_count;

  -- 14. Restore CMS Banners
  if p_payload ? 'cms_banners' and jsonb_typeof(p_payload->'cms_banners') = 'array' then
    for v_item in select * from jsonb_array_elements(p_payload->'cms_banners')
    loop
      insert into public.cms_banners (
        id, title, image_url, r2_key, target_url, placement, sort_order,
        starts_at, ends_at, is_active, mobile_image_url, mobile_r2_key,
        image_fit, image_position_x, image_position_y,
        mobile_image_fit, mobile_image_position_x, mobile_image_position_y
      )
      values (
        (v_item->>'id')::uuid,
        coalesce(v_item->>'title', 'Banner'),
        v_item->>'image_url',
        v_item->>'r2_key',
        v_item->>'target_url',
        coalesce(v_item->>'placement', 'home_hero'),
        coalesce((v_item->>'sort_order')::int, 0),
        nullif(v_item->>'starts_at', '')::timestamptz,
        nullif(v_item->>'ends_at', '')::timestamptz,
        coalesce((v_item->>'is_active')::boolean, true),
        v_item->>'mobile_image_url',
        v_item->>'mobile_r2_key',
        coalesce(v_item->>'image_fit', 'fill'),
        coalesce((v_item->>'image_position_x')::int, 50),
        coalesce((v_item->>'image_position_y')::int, 50),
        coalesce(v_item->>'mobile_image_fit', 'fill'),
        coalesce((v_item->>'mobile_image_position_x')::int, 50),
        coalesce((v_item->>'mobile_image_position_y')::int, 50)
      )
      on conflict (id) do update set
        title = excluded.title,
        image_url = excluded.image_url,
        r2_key = excluded.r2_key,
        target_url = excluded.target_url,
        placement = excluded.placement,
        sort_order = excluded.sort_order,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        is_active = excluded.is_active,
        mobile_image_url = excluded.mobile_image_url,
        mobile_r2_key = excluded.mobile_r2_key,
        image_fit = excluded.image_fit,
        image_position_x = excluded.image_position_x,
        image_position_y = excluded.image_position_y,
        mobile_image_fit = excluded.mobile_image_fit,
        mobile_image_position_x = excluded.mobile_image_position_x,
        mobile_image_position_y = excluded.mobile_image_position_y;
      v_banner_count := v_banner_count + 1;
    end loop;
  end if;

  return jsonb_build_object(
    'success', true,
    'categories_restored', v_cat_count,
    'brands_restored', v_brand_count,
    'attributes_restored', v_attr_count,
    'products_restored', v_prod_count,
    'variants_restored', v_var_count,
    'media_restored', v_media_count,
    'suppliers_restored', v_supp_count,
    'receipts_restored', v_receipt_count,
    'batches_restored', v_batch_count,
    'units_restored', v_unit_count,
    'balances_updated', v_bal_count,
    'banners_restored', v_banner_count
  );
end;
$$;

revoke all on function public.export_backup_data(uuid) from public, anon;
revoke all on function public.restore_backup_data(jsonb) from public, anon;
grant execute on function public.export_backup_data(uuid) to authenticated, service_role;
grant execute on function public.restore_backup_data(jsonb) to authenticated, service_role;

commit;
