-- Product color variants: a product (e.g. "Artel T55" refrigerator) can have several
-- color options (white, black, brown, custom name). Each variant tracks its own stock
-- (via inventory_units.variant_id), optional price override, and optional own images
-- (via product_media.variant_id). Absence of a price override on a variant means the
-- product's base price applies.
begin;

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  color_name text not null check (length(btrim(color_name)) between 1 and 60),
  color_hex text check (color_hex is null or color_hex ~ '^#[0-9a-fA-F]{6}$'),
  retail_price numeric(18,2) check (retail_price is null or retail_price >= 0),
  wholesale_price numeric(18,2) check (wholesale_price is null or wholesale_price >= 0),
  promotion_price numeric(18,2) check (promotion_price is null or promotion_price >= 0),
  minimum_sale_price numeric(18,2) check (minimum_sale_price is null or minimum_sale_price >= 0),
  sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id, color_name)
);
create index product_variants_product_idx on public.product_variants(product_id, sort_order);
create trigger product_variants_set_updated_at before update on public.product_variants
  for each row execute function public.set_updated_at();
create trigger product_variants_audit after insert or update or delete on public.product_variants
  for each row execute function public.audit_row_change();

-- Every physical unit and every uploaded image can optionally belong to one color variant.
-- Units/media without a variant_id belong to the product's "default" (no-color) bucket.
alter table public.inventory_units add column variant_id uuid references public.product_variants(id) on delete restrict;
create index inventory_units_variant_idx on public.inventory_units(variant_id) where variant_id is not null;

alter table public.stock_batches add column variant_id uuid references public.product_variants(id) on delete restrict;
create index stock_batches_variant_idx on public.stock_batches(variant_id) where variant_id is not null;

alter table public.product_media add column variant_id uuid references public.product_variants(id) on delete cascade;
create index product_media_variant_idx on public.product_media(variant_id) where variant_id is not null;
-- The existing "one primary image per product" invariant must become "one primary
-- image per (product, variant)" so each color can have its own featured photo.
drop index if exists product_media_primary_uidx;
create unique index product_media_primary_uidx on public.product_media(product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)) where is_primary;

alter table public.order_lines add column variant_id uuid references public.product_variants(id) on delete restrict;
alter table public.order_lines add column variant_color text;

-- Postgres forbids PRIMARY KEY from using a NULLS NOT DISTINCT index, so the old
-- (user_id,product_id) primary key is dropped in favor of a surrogate id column, and
-- the real uniqueness (including "one row per product with no variant") is enforced by
-- a separate NULLS NOT DISTINCT unique constraint.
alter table public.customer_cart_items drop constraint customer_cart_items_pkey;
alter table public.customer_cart_items add column id uuid not null default gen_random_uuid();
alter table public.customer_cart_items add column variant_id uuid references public.product_variants(id) on delete cascade;
alter table public.customer_cart_items add constraint customer_cart_items_pkey primary key (id);
-- Plain unique constraints treat NULL as distinct across rows, which would let a customer
-- end up with two rows for the same (product, no-variant) combination. NULLS NOT DISTINCT
-- closes that gap.
create unique index customer_cart_items_identity_uidx on public.customer_cart_items(user_id, product_id, variant_id) nulls not distinct;
alter table public.customer_cart_items add constraint customer_cart_items_identity_key unique using index customer_cart_items_identity_uidx;

create or replace function public.validate_product_variant()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.promotion_price is not null and new.retail_price is not null and new.promotion_price > new.retail_price then
    raise exception 'Aksiya narxi sotish narxidan katta bo‘lmasligi kerak' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists product_variant_guard on public.product_variants;
create trigger product_variant_guard before insert or update on public.product_variants
for each row execute function public.validate_product_variant();

-- Manager/admin-only: replace the full variant list for a product atomically.
-- Variants already referenced by inventory_units/stock_batches/product_media/order_lines
-- cannot be deleted (they are load-bearing); such variants are deactivated instead.
create or replace function public.save_product_variants(p_product_id uuid, p_variants jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_id uuid;
  v_seen uuid[] := '{}';
  v_keep uuid[] := '{}';
  v_sort integer := 0;
  v_referenced boolean;
begin
  if not (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null)) then
    raise exception 'Mahsulot variantlarini saqlash uchun admin yoki menejer roli talab qilinadi' using errcode = '42501';
  end if;
  if not exists(select 1 from public.products where id = p_product_id) then
    raise exception 'Mahsulot topilmadi' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_variants) is distinct from 'array' then
    raise exception 'Variantlar ro‘yxati massiv bo‘lishi kerak' using errcode = '22023';
  end if;
  if jsonb_array_length(p_variants) > 30 then
    raise exception 'Bir mahsulotda 30 tadan ortiq rang variant bo‘lishi mumkin emas' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_variants) loop
    if nullif(btrim(v_item->>'color_name'), '') is null then
      raise exception 'Rang nomi talab qilinadi' using errcode = '22023';
    end if;
    v_id := nullif(v_item->>'id', '')::uuid;
    if v_id is null then
      insert into public.product_variants(
        product_id, color_name, color_hex, retail_price, wholesale_price, promotion_price, minimum_sale_price, sort_order, is_active
      ) values (
        p_product_id,
        btrim(v_item->>'color_name'),
        nullif(btrim(v_item->>'color_hex'), ''),
        nullif(v_item->>'retail_price', '')::numeric,
        nullif(v_item->>'wholesale_price', '')::numeric,
        nullif(v_item->>'promotion_price', '')::numeric,
        nullif(v_item->>'minimum_sale_price', '')::numeric,
        v_sort,
        coalesce((v_item->>'is_active')::boolean, true)
      ) returning id into v_id;
    else
      update public.product_variants set
        color_name = btrim(v_item->>'color_name'),
        color_hex = nullif(btrim(v_item->>'color_hex'), ''),
        retail_price = nullif(v_item->>'retail_price', '')::numeric,
        wholesale_price = nullif(v_item->>'wholesale_price', '')::numeric,
        promotion_price = nullif(v_item->>'promotion_price', '')::numeric,
        minimum_sale_price = nullif(v_item->>'minimum_sale_price', '')::numeric,
        sort_order = v_sort,
        is_active = coalesce((v_item->>'is_active')::boolean, true)
      where id = v_id and product_id = p_product_id;
      if not found then raise exception 'Variant topilmadi' using errcode = 'P0002'; end if;
    end if;
    v_keep := array_append(v_keep, v_id);
    v_sort := v_sort + 1;
  end loop;

  -- Deactivate (never hard-delete) variants that were dropped from the payload but are
  -- still referenced by stock/media/orders; otherwise remove them entirely.
  for v_id in select id from public.product_variants where product_id = p_product_id and not (id = any(v_keep)) loop
    select exists(
      select 1 from public.inventory_units where variant_id = v_id
      union all select 1 from public.stock_batches where variant_id = v_id
      union all select 1 from public.order_lines where variant_id = v_id
    ) into v_referenced;
    if v_referenced then
      update public.product_variants set is_active = false where id = v_id;
    else
      delete from public.product_media where variant_id = v_id;
      delete from public.product_variants where id = v_id;
    end if;
  end loop;

  return coalesce((
    select jsonb_agg(to_jsonb(v) order by v.sort_order, v.created_at) from public.product_variants v where v.product_id = p_product_id
  ), '[]'::jsonb);
end;
$$;

alter table public.product_variants enable row level security;
create policy product_variants_public_read on public.product_variants for select to anon, authenticated
  using (exists(select 1 from public.products p where p.id = product_id and p.status = 'active' and p.is_published));
create policy product_variants_manager_write on public.product_variants for all to authenticated
  using (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null))
  with check (public.is_any_manager() or public.has_role(array['superadmin','admin']::public.app_role[], null));

grant select on public.product_variants to anon, authenticated;
grant insert, update, delete on public.product_variants to authenticated;
revoke all on function public.validate_product_variant() from public, anon, authenticated;
revoke all on function public.save_product_variants(uuid, jsonb) from public, anon;
grant execute on function public.save_product_variants(uuid, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
