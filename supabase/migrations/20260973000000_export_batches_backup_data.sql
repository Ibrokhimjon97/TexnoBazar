-- Migration 20260973000000: Optimized lightweight batch & inventory backup RPC
-- Prevents 500 errors caused by huge product_media and cms_banners in work_mem.
-- Only exports the exact tables required for batches and inventory restore.

create or replace function public.export_batches_backup_data(
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
  -- Allow service_role, superadmin, or admin
  if coalesce(auth.jwt()->>'role', '') = 'service_role' then
    v_is_superadmin := true;
  else
    select exists(
      select 1 from public.profile_roles
      where profile_id = v_actor_id and role in ('superadmin', 'admin')
    ) into v_is_superadmin;

    select exists(
      select 1 from public.profile_roles
      where profile_id = v_actor_id and role in ('manager', 'inventory_operator')
    ) into v_is_manager;
  end if;

  if not (v_is_superadmin or v_is_manager) then
    raise exception 'Partiyalar zahira nusxasini yuklab olish uchun ruxsat etilmagan.' using errcode = '42501';
  end if;

  -- If manager, scope to their branch if not provided
  if not v_is_superadmin and v_effective_branch_id is null then
    select branch_id into v_effective_branch_id
    from public.profile_roles
    where profile_id = v_actor_id and role in ('manager', 'inventory_operator')
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
    'products', coalesce((
      select jsonb_agg(to_jsonb(p)) from (
        select id, sku, barcode, category_id, brand_id, name, slug, description,
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
        join public.stock_receipts sr on sr.id = b.receipt_id
        where v_effective_branch_id is null or sr.branch_id = v_effective_branch_id
        order by b.received_at desc
      ) b
    ), '[]'::jsonb),
    'inventory_units', coalesce((
      select jsonb_agg(to_jsonb(u)) from (
        select u.id, u.product_id, u.variant_id, u.batch_id, u.qr_code, u.serial_number,
               u.location_id, u.status, u.sold_sale_id, u.created_at, u.updated_at
        from public.inventory_units u
        join public.stock_batches sb on sb.id = u.batch_id
        join public.stock_receipts sr on sr.id = sb.receipt_id
        where v_effective_branch_id is null or sr.branch_id = v_effective_branch_id
        order by u.created_at
      ) u
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.export_batches_backup_data(uuid) from public, anon;
grant execute on function public.export_batches_backup_data(uuid) to authenticated, service_role;
