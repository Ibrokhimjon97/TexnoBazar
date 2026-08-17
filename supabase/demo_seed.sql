-- Explicit, idempotent demo catalog for development/test environments.
-- Rows are ordinary records and remain editable through the superadmin catalog.
begin;

do $$
declare
  v_branch_id uuid;
  v_supplier_id uuid;
  v_product_id uuid;
  v_category_id uuid;
  v_brand_id uuid;
  v_media_id uuid;
  v_batch_id uuid;
  v_unit_id uuid;
  v_inserted boolean;
  v_index integer;
  v_product record;
  v_location record;
begin
  insert into public.branches(id, code, name, phone, address, timezone, currency, is_active)
  values(
    'd0000000-0000-4000-8000-000000000001', 'TNB_DEMO', 'Texnobazar demo filiali', '+998 00 000 00 00',
    '{"country":"UZ","city":"Toshkent","line1":"Demo savdo nuqtasi"}'::jsonb,
    'Asia/Tashkent', 'UZS', true
  ) on conflict do nothing;
  select id into v_branch_id from public.branches where code = 'TNB_DEMO';

  insert into public.locations(id, branch_id, code, name, type, is_active)
  values
    ('d0000000-0000-4000-8000-000000000011', v_branch_id, 'TNB-DEMO-STORE', 'Demo do‘kon', 'store', true),
    ('d0000000-0000-4000-8000-000000000012', v_branch_id, 'TNB-DEMO-WH', 'Demo ombor', 'warehouse', true)
  on conflict do nothing;

  insert into public.suppliers(id, code, name, contact_name, phone, address, is_active)
  values(
    'd0000000-0000-4000-8000-000000000021', 'TNB-DEMO-SUP', 'Texnobazar demo ta’minotchisi',
    'Demo operator', '+998 00 000 00 01', '{"country":"UZ","city":"Toshkent"}'::jsonb, true
  ) on conflict do nothing;
  select id into v_supplier_id from public.suppliers where code = 'TNB-DEMO-SUP';

  insert into public.categories(id, name, slug, description, sort_order, is_active)
  values
    ('c0000000-0000-4000-8000-000000000001', 'Smartfonlar', 'demo-smartfonlar', 'Test smartfonlar katalogi', 10, true),
    ('c0000000-0000-4000-8000-000000000002', 'Noutbuklar', 'demo-noutbuklar', 'Test noutbuklar katalogi', 20, true),
    ('c0000000-0000-4000-8000-000000000003', 'Aksessuarlar', 'demo-aksessuarlar', 'Test aksessuarlar katalogi', 30, true),
    ('c0000000-0000-4000-8000-000000000004', 'Uy texnikasi', 'demo-uy-texnikasi', 'Test uy texnikasi katalogi', 40, true)
  on conflict do nothing;

  insert into public.brands(id, name, slug, description, is_active)
  values
    ('b0000000-0000-4000-8000-000000000001', 'Nova', 'demo-nova', 'Demo mobil qurilmalar brendi', true),
    ('b0000000-0000-4000-8000-000000000002', 'Orbit', 'demo-orbit', 'Demo kompyuter texnikasi brendi', true),
    ('b0000000-0000-4000-8000-000000000003', 'Pulse', 'demo-pulse', 'Demo aksessuarlar brendi', true),
    ('b0000000-0000-4000-8000-000000000004', 'HomeLab', 'demo-homelab', 'Demo maishiy texnika brendi', true)
  on conflict do nothing;

  for v_product in
    select * from (values
      ('10000000-0000-4000-8000-000000000001'::uuid, 'TNB-DEMO-PHONE-01', '4780000000011', 'demo-smartfonlar', 'demo-nova', 'Nova X Pro 256 GB', 'demo-nova-x-pro-256', 'Kuchli kamera, yorqin ekran va katta xotirali demo smartfon.', 4200000::numeric, 5799000::numeric, 5499000::numeric, 6299000::numeric),
      ('10000000-0000-4000-8000-000000000002'::uuid, 'TNB-DEMO-PHONE-02', '4780000000028', 'demo-smartfonlar', 'demo-nova', 'Nova Lite 128 GB', 'demo-nova-lite-128', 'Kundalik foydalanish uchun qulay va tejamkor demo smartfon.', 2100000::numeric, 2999000::numeric, 2799000::numeric, 3299000::numeric),
      ('10000000-0000-4000-8000-000000000003'::uuid, 'TNB-DEMO-LAPTOP-01', '4780000000035', 'demo-noutbuklar', 'demo-orbit', 'OrbitBook Air 14', 'demo-orbitbook-air-14', '14 dyuymli ekran, 16 GB tezkor xotira va 512 GB SSD.', 6800000::numeric, 8499000::numeric, 8199000::numeric, 8999000::numeric),
      ('10000000-0000-4000-8000-000000000004'::uuid, 'TNB-DEMO-EARBUDS-01', '4780000000042', 'demo-aksessuarlar', 'demo-pulse', 'Pulse Buds ANC', 'demo-pulse-buds-anc', 'Shovqinni faol pasaytirish va uzoq ishlash vaqtiga ega quloqchin.', 420000::numeric, 699000::numeric, 649000::numeric, 749000::numeric),
      ('10000000-0000-4000-8000-000000000005'::uuid, 'TNB-DEMO-WATCH-01', '4780000000059', 'demo-aksessuarlar', 'demo-pulse', 'Pulse Watch S2', 'demo-pulse-watch-s2', 'Faollik va sog‘lom turmush ko‘rsatkichlarini kuzatuvchi demo soat.', 720000::numeric, 1099000::numeric, 999000::numeric, 1199000::numeric),
      ('10000000-0000-4000-8000-000000000006'::uuid, 'TNB-DEMO-BLENDER-01', '4780000000066', 'demo-uy-texnikasi', 'demo-homelab', 'HomeLab Blend 900', 'demo-homelab-blend-900', '900 vatt quvvatli, ikki idishli demo blender.', 510000::numeric, 799000::numeric, 749000::numeric, 849000::numeric)
    ) as p(id, sku, barcode, category_slug, brand_slug, name, slug, description, cost_price, retail_price, promotion_price, compare_at_price)
  loop
    select id into v_category_id from public.categories where slug = v_product.category_slug;
    select id into v_brand_id from public.brands where slug = v_product.brand_slug;
    v_product_id := null;

    insert into public.products(
      id, sku, barcode, category_id, brand_id, name, slug, description, description_blocks,
      seo_title, seo_description, seo_image_url, status, is_published, track_individual_units,
      cost_price, retail_price, wholesale_price, promotion_price, minimum_sale_price,
      compare_at_price, tax_rate, metadata
    ) values (
      v_product.id, v_product.sku, v_product.barcode, v_category_id, v_brand_id,
      v_product.name, v_product.slug, v_product.description,
      jsonb_build_array(
        jsonb_build_object('type', 'heading', 'level', 2, 'text', 'Mahsulot haqida'),
        jsonb_build_object('type', 'text', 'text', v_product.description),
        jsonb_build_object('type', 'list', 'items', jsonb_build_array('Admin panelda tahrirlanadi', 'Real birlik qoldig‘iga ega', 'Test buyurtmalari uchun tayyor'))
      ),
      v_product.name, v_product.description,
      'https://placehold.co/1200x1200/png?text=' || v_product.sku,
      'active', false, true,
      v_product.cost_price, v_product.retail_price,
      round((v_product.cost_price + v_product.retail_price) / 2, 2), v_product.promotion_price,
      v_product.cost_price, v_product.compare_at_price, 12,
      jsonb_build_object('demo_seed', 'texnobazar-v1', 'editable', true)
    ) on conflict do nothing returning id into v_product_id;

    v_inserted := v_product_id is not null;
    if not v_inserted then
      select id into v_product_id
      from public.products
      where id = v_product.id or sku = v_product.sku or slug = v_product.slug or barcode = v_product.barcode
      order by case when id = v_product.id then 0 else 1 end
      limit 1;
    end if;

    if v_inserted then
      v_media_id := (
        substr(md5('media:' || v_product_id::text), 1, 8) || '-' ||
        substr(md5('media:' || v_product_id::text), 9, 4) || '-' ||
        substr(md5('media:' || v_product_id::text), 13, 4) || '-' ||
        substr(md5('media:' || v_product_id::text), 17, 4) || '-' ||
        substr(md5('media:' || v_product_id::text), 21, 12)
      )::uuid;
      insert into public.product_media(id, product_id, r2_key, public_url, mime_type, bytes, width, height, alt_text, sort_order, is_primary)
      values(
        v_media_id, v_product_id,
        'products/' || v_product_id::text || '/' || v_media_id::text || '.png',
        'https://placehold.co/1200x1200/png?text=' || v_product.sku,
        'image/png', 1024, 1200, 1200, v_product.name, 0, true
      ) on conflict do nothing;

      insert into public.product_attribute_values(product_id, attribute_id, value)
      select v_product_id, a.id,
        case a.data_type
          when 'text' then to_jsonb('Demo'::text)
          when 'number' then '1'::jsonb
          when 'boolean' then 'true'::jsonb
          when 'date' then to_jsonb(current_date::text)
          when 'select' then a.options -> 0
          when 'multiselect' then jsonb_build_array(a.options -> 0)
        end
      from public.attribute_definitions a
      where a.is_required
        and (a.category_id is null or a.category_id = v_category_id)
        and (a.data_type not in ('select', 'multiselect') or jsonb_array_length(a.options) > 0)
      on conflict do nothing;

      perform public.assert_product_publishable(v_product_id);
      update public.products set status = 'active', is_published = true where id = v_product_id;
    end if;
  end loop;

  -- Add three individually traceable units for every seeded product at every active
  -- store/warehouse, including the deterministic demo locations above.
  for v_location in
    select id, code from public.locations where is_active and type in ('store', 'warehouse') order by id
  loop
    for v_product in
      select id, cost_price from public.products where metadata ->> 'demo_seed' = 'texnobazar-v1' order by id
    loop
      v_batch_id := (
        substr(md5('batch:' || v_location.id::text || ':' || v_product.id::text), 1, 8) || '-' ||
        substr(md5('batch:' || v_location.id::text || ':' || v_product.id::text), 9, 4) || '-' ||
        substr(md5('batch:' || v_location.id::text || ':' || v_product.id::text), 13, 4) || '-' ||
        substr(md5('batch:' || v_location.id::text || ':' || v_product.id::text), 17, 4) || '-' ||
        substr(md5('batch:' || v_location.id::text || ':' || v_product.id::text), 21, 12)
      )::uuid;

      insert into public.stock_batches(id, supplier_id, product_id, location_id, reference, quantity, unit_cost)
      values(v_batch_id, v_supplier_id, v_product.id, v_location.id, 'TNB-DEMO-SEED', 3, v_product.cost_price)
      on conflict do nothing;

      for v_index in 1..3 loop
        v_unit_id := (
          substr(md5('unit:' || v_location.id::text || ':' || v_product.id::text || ':' || v_index), 1, 8) || '-' ||
          substr(md5('unit:' || v_location.id::text || ':' || v_product.id::text || ':' || v_index), 9, 4) || '-' ||
          substr(md5('unit:' || v_location.id::text || ':' || v_product.id::text || ':' || v_index), 13, 4) || '-' ||
          substr(md5('unit:' || v_location.id::text || ':' || v_product.id::text || ':' || v_index), 17, 4) || '-' ||
          substr(md5('unit:' || v_location.id::text || ':' || v_product.id::text || ':' || v_index), 21, 12)
        )::uuid;
        insert into public.inventory_units(
          id, product_id, batch_id, qr_code, serial_number, location_id, status, unit_sequence
        ) values(
          v_unit_id, v_product.id, v_batch_id,
          'TNB-DEMO-' || upper(substr(md5(v_unit_id::text), 1, 20)),
          'TNB-SN-' || upper(substr(md5('serial:' || v_unit_id::text), 1, 16)),
          v_location.id, 'available', v_index
        ) on conflict do nothing;
      end loop;
    end loop;
  end loop;
end
$$;

commit;
