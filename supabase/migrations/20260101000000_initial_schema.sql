-- Texnobazar ERP/POS/ecommerce initial schema
-- PostgreSQL 15 / Supabase. All application timestamps are UTC timestamptz.
begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;

create type public.app_role as enum ('superadmin','admin','manager','seller','warehouse','accountant','courier','customer');
create type public.location_type as enum ('store','warehouse','transit','writeoff');
create type public.product_status as enum ('draft','active','archived');
create type public.unit_status as enum ('available','reserved','in_transit','sold','returned','written_off');
create type public.movement_type as enum ('received','transfer_out','transfer_in','reserved','reservation_released','sold','returned','writeoff','adjustment');
create type public.transfer_status as enum ('draft','requested','approved','in_transit','received','cancelled');
create type public.debt_status as enum ('open','partially_paid','paid','void');
create type public.pending_sale_status as enum ('pending','confirmed','rejected','expired');
create type public.sale_status as enum ('completed','partially_returned','returned','void');
create type public.payment_status as enum ('pending','paid','partially_refunded','refunded','failed');
create type public.return_kind as enum ('return','exchange');
create type public.return_status as enum ('requested','approved','completed','rejected','cancelled');
create type public.order_status as enum ('new','confirmed','processing','ready','assigned','shipped','delivered','cancelled','returned');
create type public.delivery_status as enum ('pending','assigned','picked_up','in_transit','delivered','failed','cancelled');
create type public.finance_type as enum ('income','expense');
create type public.payroll_status as enum ('draft','approved','paid','cancelled');
create type public.notification_channel as enum ('in_app','email','sms','push');

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9_-]{2,32}$'),
  name text not null check (length(btrim(name)) between 2 and 160),
  phone text, address jsonb not null default '{}'::jsonb check (jsonb_typeof(address) = 'object'),
  timezone text not null default 'Asia/Tashkent', currency char(3) not null default 'UZS',
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.locations (
  id uuid primary key default gen_random_uuid(), branch_id uuid references public.branches(id) on delete restrict,
  code text not null unique, name text not null, type public.location_type not null,
  is_active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((type in ('transit','writeoff')) or branch_id is not null)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email extensions.citext, full_name text, phone text, avatar_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index profiles_email_uidx on public.profiles(email) where email is not null;

create table public.profile_roles (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role public.app_role not null,
  branch_id uuid references public.branches(id) on delete cascade,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id) on delete set null
);
create unique index profile_roles_global_uidx on public.profile_roles(profile_id, role) where branch_id is null;
create unique index profile_roles_branch_uidx on public.profile_roles(profile_id, role, branch_id) where branch_id is not null;
create index profile_roles_branch_idx on public.profile_roles(branch_id, profile_id);

create table public.categories (
  id uuid primary key default gen_random_uuid(), parent_id uuid references public.categories(id) on delete restrict,
  name text not null, slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text, sort_order integer not null default 0, is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);
create index categories_parent_idx on public.categories(parent_id, sort_order);

create table public.brands (
  id uuid primary key default gen_random_uuid(), name text not null, slug text not null unique,
  description text, logo_url text, is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(), sku text not null unique, barcode text unique,
  category_id uuid not null references public.categories(id) on delete restrict,
  brand_id uuid references public.brands(id) on delete set null,
  name text not null, slug text not null unique, description text,
  status public.product_status not null default 'draft', is_published boolean not null default false,
  track_individual_units boolean not null default true,
  cost_price numeric(18,2) not null default 0 check (cost_price >= 0),
  retail_price numeric(18,2) not null check (retail_price >= 0), compare_at_price numeric(18,2) check (compare_at_price >= retail_price),
  tax_rate numeric(5,2) not null default 0 check (tax_rate between 0 and 100),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index products_catalog_idx on public.products(category_id, brand_id, status) where is_published;
create index products_name_idx on public.products using gin (to_tsvector('simple', name));

create table public.attribute_definitions (
  id uuid primary key default gen_random_uuid(), category_id uuid references public.categories(id) on delete cascade,
  code text not null, name text not null, data_type text not null check (data_type in ('text','number','boolean','date','select','multiselect')),
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  is_required boolean not null default false, is_filterable boolean not null default false, sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(category_id, code)
);

create table public.product_attribute_values (
  product_id uuid not null references public.products(id) on delete cascade,
  attribute_id uuid not null references public.attribute_definitions(id) on delete cascade,
  value jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(product_id, attribute_id)
);

create table public.product_media (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products(id) on delete cascade,
  r2_key text not null unique, public_url text not null check (public_url ~ '^https://'),
  mime_type text, bytes bigint check (bytes is null or bytes >= 0), width integer check (width is null or width > 0), height integer check (height is null or height > 0),
  alt_text text, sort_order integer not null default 0, is_primary boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index product_media_primary_uidx on public.product_media(product_id) where is_primary;
create index product_media_product_idx on public.product_media(product_id, sort_order);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(), code text not null unique, name text not null,
  contact_name text, phone text, email extensions.citext, address jsonb not null default '{}'::jsonb,
  balance numeric(18,2) not null default 0, is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.stock_batches (
  id uuid primary key default gen_random_uuid(), supplier_id uuid references public.suppliers(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict, location_id uuid not null references public.locations(id) on delete restrict,
  reference text, received_at timestamptz not null default now(), expires_at timestamptz,
  quantity numeric(18,3) not null check (quantity > 0), unit_cost numeric(18,2) not null check (unit_cost >= 0),
  created_by uuid references public.profiles(id) on delete set null, created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > received_at)
);
create index stock_batches_product_location_idx on public.stock_batches(product_id, location_id, received_at);

create table public.inventory_units (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products(id) on delete restrict,
  batch_id uuid references public.stock_batches(id) on delete restrict, qr_code text not null unique,
  serial_number text unique, location_id uuid not null references public.locations(id) on delete restrict,
  status public.unit_status not null default 'available', reserved_until timestamptz,
  sold_sale_id uuid, version bigint not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((status = 'sold' and sold_sale_id is not null) or (status <> 'sold' and sold_sale_id is null))
);
create index inventory_units_available_idx on public.inventory_units(location_id, product_id) where status = 'available';
create index inventory_units_batch_idx on public.inventory_units(batch_id);

create table public.inventory_movements (
  id bigint generated always as identity primary key,
  unit_id uuid references public.inventory_units(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  batch_id uuid references public.stock_batches(id) on delete restrict,
  movement_type public.movement_type not null,
  from_location_id uuid references public.locations(id) on delete restrict,
  to_location_id uuid references public.locations(id) on delete restrict,
  quantity numeric(18,3) not null check (quantity > 0), unit_cost numeric(18,2) check (unit_cost is null or unit_cost >= 0),
  reference_type text not null, reference_id uuid, reason text,
  actor_id uuid references public.profiles(id) on delete set null, occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  check (from_location_id is not null or to_location_id is not null)
);
create index inventory_movements_product_time_idx on public.inventory_movements(product_id, occurred_at desc);
create index inventory_movements_unit_idx on public.inventory_movements(unit_id, occurred_at desc);
create index inventory_movements_reference_idx on public.inventory_movements(reference_type, reference_id);

create table public.transfers (
  id uuid primary key default gen_random_uuid(), transfer_no text not null unique,
  from_location_id uuid not null references public.locations(id) on delete restrict,
  to_location_id uuid not null references public.locations(id) on delete restrict,
  status public.transfer_status not null default 'draft', notes text,
  requested_by uuid references public.profiles(id), approved_by uuid references public.profiles(id), received_by uuid references public.profiles(id),
  requested_at timestamptz, approved_at timestamptz, shipped_at timestamptz, received_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (from_location_id <> to_location_id)
);
create index transfers_status_idx on public.transfers(status, created_at desc);

create table public.transfer_lines (
  id uuid primary key default gen_random_uuid(), transfer_id uuid not null references public.transfers(id) on delete cascade,
  product_id uuid not null references public.products(id), unit_id uuid references public.inventory_units(id),
  quantity numeric(18,3) not null default 1 check (quantity > 0), created_at timestamptz not null default now(),
  unique(transfer_id, unit_id)
);

create table public.branch_debts (
  id uuid primary key default gen_random_uuid(), debtor_branch_id uuid not null references public.branches(id),
  creditor_branch_id uuid not null references public.branches(id), transfer_id uuid references public.transfers(id),
  amount numeric(18,2) not null check (amount > 0), paid_amount numeric(18,2) not null default 0 check (paid_amount >= 0 and paid_amount <= amount),
  status public.debt_status not null default 'open', due_at timestamptz, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (debtor_branch_id <> creditor_branch_id)
);

create table public.inventory_balances (
  location_id uuid not null references public.locations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  on_hand numeric(18,3) not null default 0 check (on_hand >= 0), reserved numeric(18,3) not null default 0 check (reserved >= 0 and reserved <= on_hand),
  updated_at timestamptz not null default now(), primary key(location_id, product_id)
);

create table public.inventory_counts (
  id uuid primary key default gen_random_uuid(), count_no text not null unique,
  location_id uuid not null references public.locations(id) on delete restrict,
  scope jsonb not null default '{}'::jsonb check (jsonb_typeof(scope) = 'object'),
  status text not null default 'draft' check (status in ('draft','counting','review','posted','cancelled')),
  started_by uuid references public.profiles(id), posted_by uuid references public.profiles(id),
  started_at timestamptz, posted_at timestamptz, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index inventory_counts_location_status_idx on public.inventory_counts(location_id,status,created_at desc);

create table public.inventory_count_lines (
  id uuid primary key default gen_random_uuid(), inventory_count_id uuid not null references public.inventory_counts(id) on delete cascade,
  product_id uuid not null references public.products(id), unit_id uuid references public.inventory_units(id),
  expected_quantity numeric(18,3) not null default 0 check (expected_quantity >= 0),
  counted_quantity numeric(18,3) not null default 0 check (counted_quantity >= 0),
  variance numeric(18,3) generated always as (counted_quantity - expected_quantity) stored,
  counted_by uuid references public.profiles(id), counted_at timestamptz, notes text,
  unique(inventory_count_id,unit_id)
);
create index inventory_count_lines_count_idx on public.inventory_count_lines(inventory_count_id,product_id);

create table public.writeoffs (
  id uuid primary key default gen_random_uuid(), writeoff_no text not null unique,
  location_id uuid not null references public.locations(id), status text not null default 'draft' check (status in ('draft','approved','posted','cancelled')),
  reason text not null, created_by uuid references public.profiles(id), approved_by uuid references public.profiles(id),
  posted_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.writeoff_lines (
  id uuid primary key default gen_random_uuid(), writeoff_id uuid not null references public.writeoffs(id) on delete cascade,
  product_id uuid not null references public.products(id), unit_id uuid references public.inventory_units(id),
  quantity numeric(18,3) not null default 1 check (quantity > 0), unit_cost numeric(18,2) not null check (unit_cost >= 0),
  unique(writeoff_id, unit_id)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(), auth_user_id uuid unique references auth.users(id) on delete set null,
  full_name text not null, phone text, email extensions.citext, address jsonb not null default '{}'::jsonb,
  loyalty_points numeric(18,2) not null default 0 check (loyalty_points >= 0), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index customers_phone_uidx on public.customers(phone) where phone is not null;
create unique index customers_email_uidx on public.customers(email) where email is not null;

create table public.payment_methods (
  id uuid primary key default gen_random_uuid(), code text not null unique, name text not null,
  is_cash boolean not null default false, is_online boolean not null default false, is_active boolean not null default true,
  sort_order integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.pos_pending_sales (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references public.branches(id),
  seller_id uuid not null references public.profiles(id), customer_id uuid references public.customers(id),
  status public.pending_sale_status not null default 'pending', subtotal numeric(18,2) not null default 0 check (subtotal >= 0),
  discount numeric(18,2) not null default 0 check (discount >= 0), tax numeric(18,2) not null default 0 check (tax >= 0),
  total numeric(18,2) not null default 0 check (total >= 0 and total = subtotal - discount + tax),
  expires_at timestamptz not null, confirmed_by uuid references public.profiles(id), confirmed_at timestamptz,
  notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index pos_pending_sales_queue_idx on public.pos_pending_sales(branch_id, status, created_at);

create table public.pos_pending_sale_lines (
  id uuid primary key default gen_random_uuid(), pending_sale_id uuid not null references public.pos_pending_sales(id) on delete cascade,
  product_id uuid not null references public.products(id), unit_id uuid not null references public.inventory_units(id),
  quantity numeric(18,3) not null default 1 check (quantity = 1), unit_price numeric(18,2) not null check (unit_price >= 0),
  discount numeric(18,2) not null default 0 check (discount >= 0 and discount <= unit_price),
  tax numeric(18,2) not null default 0 check (tax >= 0), line_total numeric(18,2) not null check (line_total = unit_price - discount + tax),
  created_at timestamptz not null default now(), unique(pending_sale_id, unit_id)
);
create index pending_sale_lines_unit_idx on public.pos_pending_sale_lines(unit_id);

create table public.sales (
  id uuid primary key default gen_random_uuid(), sale_no text not null unique,
  branch_id uuid not null references public.branches(id), seller_id uuid not null references public.profiles(id),
  manager_id uuid references public.profiles(id), customer_id uuid references public.customers(id),
  pending_sale_id uuid unique references public.pos_pending_sales(id), status public.sale_status not null default 'completed',
  subtotal numeric(18,2) not null check (subtotal >= 0), discount numeric(18,2) not null default 0 check (discount >= 0),
  tax numeric(18,2) not null default 0 check (tax >= 0), total numeric(18,2) not null check (total >= 0 and total = subtotal - discount + tax),
  sold_at timestamptz not null default now(), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index sales_branch_time_idx on public.sales(branch_id, sold_at desc);
create index sales_customer_idx on public.sales(customer_id, sold_at desc);

alter table public.inventory_units add constraint inventory_units_sold_sale_fk foreign key(sold_sale_id) references public.sales(id) on delete restrict;

create table public.sale_lines (
  id uuid primary key default gen_random_uuid(), sale_id uuid not null references public.sales(id) on delete restrict,
  product_id uuid not null references public.products(id), unit_id uuid not null unique references public.inventory_units(id),
  quantity numeric(18,3) not null default 1 check (quantity = 1), unit_cost numeric(18,2) not null check (unit_cost >= 0),
  unit_price numeric(18,2) not null check (unit_price >= 0), discount numeric(18,2) not null default 0 check (discount >= 0 and discount <= unit_price),
  tax numeric(18,2) not null default 0 check (tax >= 0), line_total numeric(18,2) not null check (line_total = unit_price - discount + tax),
  created_at timestamptz not null default now()
);
create index sale_lines_sale_idx on public.sale_lines(sale_id);

create table public.sale_payments (
  id uuid primary key default gen_random_uuid(), sale_id uuid not null references public.sales(id) on delete restrict,
  payment_method_id uuid not null references public.payment_methods(id), amount numeric(18,2) not null check (amount > 0),
  status public.payment_status not null default 'paid', external_reference text, received_by uuid references public.profiles(id),
  paid_at timestamptz not null default now(), metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index sale_payments_sale_idx on public.sale_payments(sale_id);

create table public.sale_returns (
  id uuid primary key default gen_random_uuid(), return_no text not null unique, original_sale_id uuid not null references public.sales(id),
  kind public.return_kind not null, status public.return_status not null default 'requested', branch_id uuid not null references public.branches(id),
  customer_id uuid references public.customers(id), reason text not null, refund_amount numeric(18,2) not null default 0 check (refund_amount >= 0),
  replacement_sale_id uuid references public.sales(id), requested_by uuid references public.profiles(id), approved_by uuid references public.profiles(id),
  completed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.sale_return_lines (
  id uuid primary key default gen_random_uuid(), return_id uuid not null references public.sale_returns(id) on delete cascade,
  sale_line_id uuid not null references public.sale_lines(id), unit_id uuid not null references public.inventory_units(id),
  quantity numeric(18,3) not null default 1 check (quantity = 1), condition text not null check (condition in ('resellable','damaged','defective')),
  refund_amount numeric(18,2) not null default 0 check (refund_amount >= 0), unique(return_id, sale_line_id)
);

create table public.orders (
  id uuid primary key default gen_random_uuid(), order_no text not null unique,
  customer_id uuid references public.customers(id), customer_user_id uuid references auth.users(id) on delete set null,
  branch_id uuid references public.branches(id), status public.order_status not null default 'new',
  customer_name text not null, customer_phone text not null, customer_email extensions.citext,
  shipping_address jsonb not null check (jsonb_typeof(shipping_address) = 'object'), notes text,
  subtotal numeric(18,2) not null check (subtotal >= 0), discount numeric(18,2) not null default 0 check (discount >= 0),
  delivery_fee numeric(18,2) not null default 0 check (delivery_fee >= 0), total numeric(18,2) not null check (total >= 0 and total = subtotal - discount + delivery_fee),
  payment_method_id uuid references public.payment_methods(id), payment_status public.payment_status not null default 'pending',
  idempotency_key text unique, placed_at timestamptz not null default now(), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index orders_user_time_idx on public.orders(customer_user_id, placed_at desc);
create index orders_status_idx on public.orders(status, placed_at);

create table public.order_lines (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete restrict,
  product_id uuid not null references public.products(id), product_name text not null, sku text not null,
  quantity numeric(18,3) not null check (quantity > 0), unit_price numeric(18,2) not null check (unit_price >= 0),
  discount numeric(18,2) not null default 0 check (discount >= 0), line_total numeric(18,2) not null check (line_total >= 0),
  created_at timestamptz not null default now()
);
create index order_lines_order_idx on public.order_lines(order_id);

create table public.order_status_history (
  id bigint generated always as identity primary key, order_id uuid not null references public.orders(id) on delete restrict,
  from_status public.order_status, to_status public.order_status not null, note text,
  actor_id uuid references public.profiles(id), created_at timestamptz not null default now()
);
create index order_status_history_order_idx on public.order_status_history(order_id, created_at);

create table public.deliveries (
  id uuid primary key default gen_random_uuid(), order_id uuid not null unique references public.orders(id) on delete restrict,
  courier_id uuid references public.profiles(id), status public.delivery_status not null default 'pending',
  tracking_code text not null unique, assigned_at timestamptz, picked_up_at timestamptz, delivered_at timestamptz,
  proof_url text check (proof_url is null or proof_url ~ '^https://'), recipient_name text, recipient_note text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index deliveries_courier_status_idx on public.deliveries(courier_id, status);

create table public.courier_tracking (
  id bigint generated always as identity primary key, delivery_id uuid not null references public.deliveries(id) on delete cascade,
  courier_id uuid not null references public.profiles(id), latitude numeric(9,6) not null check (latitude between -90 and 90),
  longitude numeric(9,6) not null check (longitude between -180 and 180), accuracy_m numeric(10,2) check (accuracy_m is null or accuracy_m >= 0),
  recorded_at timestamptz not null default now()
);
create index courier_tracking_delivery_time_idx on public.courier_tracking(delivery_id, recorded_at desc);

create table public.finance_accounts (
  id uuid primary key default gen_random_uuid(), branch_id uuid references public.branches(id), code text not null unique,
  name text not null, currency char(3) not null default 'UZS', is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.finance_transactions (
  id uuid primary key default gen_random_uuid(), account_id uuid not null references public.finance_accounts(id),
  branch_id uuid references public.branches(id), type public.finance_type not null, category text not null,
  amount numeric(18,2) not null check (amount > 0), occurred_at timestamptz not null default now(), description text,
  reference_type text, reference_id uuid, created_by uuid references public.profiles(id), created_at timestamptz not null default now()
);
create index finance_transactions_account_time_idx on public.finance_transactions(account_id, occurred_at desc);

create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(), branch_id uuid references public.branches(id), period_start date not null, period_end date not null,
  status public.payroll_status not null default 'draft', total numeric(18,2) not null default 0 check (total >= 0),
  approved_by uuid references public.profiles(id), paid_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (period_end >= period_start), unique(branch_id, period_start, period_end)
);
create table public.payroll_items (
  id uuid primary key default gen_random_uuid(), payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  employee_id uuid not null references public.profiles(id), gross numeric(18,2) not null check (gross >= 0),
  deductions numeric(18,2) not null default 0 check (deductions >= 0 and deductions <= gross),
  net numeric(18,2) generated always as (gross - deductions) stored, metadata jsonb not null default '{}'::jsonb,
  unique(payroll_run_id, employee_id)
);

create table public.cms_pages (
  id uuid primary key default gen_random_uuid(), slug text not null unique, title text not null, body jsonb not null default '{}'::jsonb,
  is_published boolean not null default false, published_at timestamptz, seo jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id), updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((is_published and published_at is not null) or not is_published)
);
create table public.cms_banners (
  id uuid primary key default gen_random_uuid(), title text not null, image_url text not null check (image_url ~ '^https://'),
  r2_key text not null, target_url text, placement text not null, sort_order integer not null default 0,
  starts_at timestamptz, ends_at timestamptz, is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create table public.cms_promotions (
  id uuid primary key default gen_random_uuid(), name text not null, slug text not null unique,
  description text, discount_type text not null check (discount_type in ('percent','fixed')),
  discount_value numeric(18,2) not null check (discount_value > 0), starts_at timestamptz not null, ends_at timestamptz not null,
  is_active boolean not null default true, rules jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), check (ends_at > starts_at)
);
create table public.cms_promotion_products (
  promotion_id uuid not null references public.cms_promotions(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  primary key(promotion_id,product_id)
);
create table public.cms_home_blocks (
  id uuid primary key default gen_random_uuid(), block_type text not null check (block_type in ('hero','categories','products','promotion','rich_text')),
  title text, content jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  sort_order integer not null default 0, is_active boolean not null default true,
  starts_at timestamptz, ends_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create table public.cms_menu_items (
  id uuid primary key default gen_random_uuid(), parent_id uuid references public.cms_menu_items(id) on delete cascade,
  location text not null, label text not null, target_url text not null, sort_order integer not null default 0,
  is_active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);
create index cms_menu_items_location_idx on public.cms_menu_items(location,parent_id,sort_order);
create table public.notifications (
  id uuid primary key default gen_random_uuid(), recipient_id uuid not null references public.profiles(id) on delete cascade,
  channel public.notification_channel not null default 'in_app', title text not null, body text not null,
  data jsonb not null default '{}'::jsonb, read_at timestamptz, sent_at timestamptz, created_at timestamptz not null default now()
);
create index notifications_recipient_idx on public.notifications(recipient_id, read_at, created_at desc);

create table public.audit_log (
  id bigint generated always as identity primary key, actor_id uuid references auth.users(id) on delete set null,
  action text not null, entity_schema text not null default 'public', entity_table text not null, entity_id text,
  old_data jsonb, new_data jsonb, request_id uuid, ip inet, user_agent text, created_at timestamptz not null default now()
);
create index audit_log_entity_idx on public.audit_log(entity_table, entity_id, created_at desc);
create index audit_log_actor_idx on public.audit_log(actor_id, created_at desc);

create table public.system_settings (
  key text primary key, value jsonb not null, description text, is_public boolean not null default false,
  updated_by uuid references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- Shared trigger primitives.
create or replace function public.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

create or replace function public.reject_mutation() returns trigger language plpgsql set search_path = '' as $$
begin raise exception '% is immutable', tg_table_name using errcode = '55000'; end; $$;

create or replace function public.reject_direct_sold_transition() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'sold' and old.status is distinct from 'sold'
     and current_setting('texnobazar.manager_confirm_sale', true) <> 'allowed' then
    raise exception 'SOLD holatiga faqat manager_confirm_sale RPC orqali o‘tish mumkin' using errcode = '42501';
  end if;
  return new;
end; $$;
create trigger inventory_units_sold_guard before update on public.inventory_units
for each row execute function public.reject_direct_sold_transition();

create trigger inventory_movements_immutable before update or delete on public.inventory_movements for each row execute function public.reject_mutation();
create trigger audit_log_immutable before update or delete on public.audit_log for each row execute function public.reject_mutation();
create trigger order_status_history_immutable before update or delete on public.order_status_history for each row execute function public.reject_mutation();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id,email,full_name)
  values(new.id,new.email,coalesce(new.raw_user_meta_data->>'full_name',''))
  on conflict(id) do nothing;
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Helpers deliberately consult normalized role assignments, not mutable JWT metadata.
create or replace function public.current_user_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles p where p.id = auth.uid() and p.is_active)
$$;
create or replace function public.has_role(p_roles public.app_role[], p_branch uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.current_user_active() and exists(
    select 1 from public.profile_roles r where r.profile_id = auth.uid() and r.role = any(p_roles)
      and ((p_branch is null and r.branch_id is null) or (p_branch is not null and (r.branch_id is null or r.branch_id = p_branch)))
  )
$$;
create or replace function public.can_access_branch(p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.has_role(array['superadmin','admin']::public.app_role[], null)
      or public.has_role(array['manager','seller','warehouse','accountant','courier']::public.app_role[], p_branch)
$$;
revoke all on function public.current_user_active() from public;
revoke all on function public.has_role(public.app_role[],uuid) from public;
revoke all on function public.can_access_branch(uuid) from public;
grant execute on function public.current_user_active(), public.has_role(public.app_role[],uuid), public.can_access_branch(uuid) to authenticated, service_role;

-- Apply updated_at consistently to mutable records.
do $$
declare t text;
begin
  foreach t in array array['branches','locations','profiles','categories','brands','products','attribute_definitions','product_attribute_values','product_media','suppliers','inventory_units','transfers','branch_debts','inventory_balances','inventory_counts','writeoffs','customers','payment_methods','pos_pending_sales','sales','sale_returns','orders','deliveries','finance_accounts','payroll_runs','cms_pages','cms_banners','cms_promotions','cms_home_blocks','cms_menu_items','system_settings'] loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- Business RPC: seller creates a short-lived reservation atomically.
create or replace function public.create_pos_pending_sale(
  p_branch_id uuid, p_customer_id uuid, p_lines jsonb, p_discount numeric default 0, p_notes text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_location uuid; v_line jsonb; v_unit public.inventory_units%rowtype;
  v_subtotal numeric(18,2) := 0; v_unit_price numeric(18,2); v_line_discount numeric(18,2); v_tax numeric(18,2); v_line_total numeric(18,2);
begin
  if not public.has_role(array['seller','manager','admin','superadmin']::public.app_role[], p_branch_id) then raise exception 'forbidden' using errcode='42501'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'lines required' using errcode='22023'; end if;
  select id into v_location from public.locations where branch_id=p_branch_id and type='store' and is_active order by created_at limit 1;
  if v_location is null then raise exception 'active store location not found'; end if;
  insert into public.pos_pending_sales(id,branch_id,seller_id,customer_id,status,subtotal,discount,tax,total,expires_at,notes)
  values(v_id,p_branch_id,auth.uid(),p_customer_id,'pending',0,0,0,0,now()+interval '15 minutes',p_notes);
  for v_line in select value from jsonb_array_elements(p_lines) loop
    select * into v_unit from public.inventory_units where id=(v_line->>'unit_id')::uuid for update;
    if not found or v_unit.location_id<>v_location or v_unit.status<>'available' then raise exception 'unit unavailable: %',v_line->>'unit_id' using errcode='P0001'; end if;
    if exists(select 1 from public.pos_pending_sale_lines l join public.pos_pending_sales s on s.id=l.pending_sale_id where l.unit_id=v_unit.id and s.status='pending') then raise exception 'unit already pending: %',v_unit.id; end if;
    select retail_price, round(retail_price*tax_rate/100,2) into v_unit_price,v_tax from public.products where id=v_unit.product_id and status='active';
    if not found then raise exception 'product unavailable'; end if;
    v_line_discount:=coalesce((v_line->>'discount')::numeric,0); v_line_total:=v_unit_price-v_line_discount+v_tax;
    if v_line_discount<0 or v_line_discount>v_unit_price then raise exception 'invalid discount'; end if;
    insert into public.pos_pending_sale_lines(pending_sale_id,product_id,unit_id,unit_price,discount,tax,line_total)
      values(v_id,v_unit.product_id,v_unit.id,v_unit_price,v_line_discount,v_tax,v_line_total);
    update public.inventory_units set status='reserved',reserved_until=now()+interval '15 minutes',version=version+1 where id=v_unit.id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,reference_type,reference_id,actor_id)
      values(v_unit.id,v_unit.product_id,v_unit.batch_id,'reserved',v_location,v_location,1,'pos_pending_sale',v_id,auth.uid());
    v_subtotal:=v_subtotal+v_unit_price; 
  end loop;
  if p_discount<0 or p_discount>v_subtotal then raise exception 'invalid sale discount'; end if;
  update public.pos_pending_sales s set subtotal=v_subtotal,discount=p_discount,tax=(select coalesce(sum(tax),0) from public.pos_pending_sale_lines where pending_sale_id=v_id),
    total=v_subtotal-p_discount+(select coalesce(sum(tax),0) from public.pos_pending_sale_lines where pending_sale_id=v_id) where id=v_id;
  return v_id;
exception when unique_violation then raise exception 'one or more units are already pending' using errcode='P0001';
end; $$;

-- Only this RPC grants application clients a route from RESERVED to SOLD.
create or replace function public.manager_confirm_sale(p_pending_sale_id uuid, p_payments jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_pending public.pos_pending_sales%rowtype; v_sale_id uuid:=gen_random_uuid(); v_line record; v_payment jsonb; v_paid numeric(18,2):=0; v_method uuid; v_location uuid;
begin
  select * into v_pending from public.pos_pending_sales where id=p_pending_sale_id for update;
  if not found or v_pending.status<>'pending' or v_pending.expires_at<=now() then raise exception 'pending sale unavailable or expired'; end if;
  if not public.has_role(array['manager','admin','superadmin']::public.app_role[],v_pending.branch_id) then raise exception 'manager role required' using errcode='42501'; end if;
  perform 1 from public.inventory_units u join public.pos_pending_sale_lines l on l.unit_id=u.id where l.pending_sale_id=p_pending_sale_id order by u.id for update of u;
  if exists(select 1 from public.inventory_units u join public.pos_pending_sale_lines l on l.unit_id=u.id where l.pending_sale_id=p_pending_sale_id and (u.status<>'reserved' or u.reserved_until<=now())) then raise exception 'reserved unit unavailable'; end if;
  if jsonb_typeof(p_payments)<>'array' or jsonb_array_length(p_payments)=0 then raise exception 'payments required'; end if;
  for v_payment in select value from jsonb_array_elements(p_payments) loop v_paid:=v_paid+(v_payment->>'amount')::numeric; end loop;
  if v_paid<>v_pending.total then raise exception 'payment total mismatch'; end if;
  insert into public.sales(id,sale_no,branch_id,seller_id,manager_id,customer_id,pending_sale_id,subtotal,discount,tax,total)
  values(v_sale_id,'SAL-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||substr(v_sale_id::text,1,6),v_pending.branch_id,v_pending.seller_id,auth.uid(),v_pending.customer_id,v_pending.id,v_pending.subtotal,v_pending.discount,v_pending.tax,v_pending.total);
  perform set_config('texnobazar.manager_confirm_sale','allowed',true);
  for v_line in select l.*,u.batch_id,u.location_id,coalesce(b.unit_cost,p.cost_price) unit_cost from public.pos_pending_sale_lines l join public.inventory_units u on u.id=l.unit_id left join public.stock_batches b on b.id=u.batch_id join public.products p on p.id=l.product_id where l.pending_sale_id=p_pending_sale_id loop
    insert into public.sale_lines(sale_id,product_id,unit_id,unit_cost,unit_price,discount,tax,line_total) values(v_sale_id,v_line.product_id,v_line.unit_id,v_line.unit_cost,v_line.unit_price,v_line.discount,v_line.tax,v_line.line_total);
    update public.inventory_units set status='sold',sold_sale_id=v_sale_id,reserved_until=null,version=version+1 where id=v_line.unit_id and status='reserved';
    if not found then raise exception 'double-sale prevented'; end if;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,quantity,unit_cost,reference_type,reference_id,actor_id) values(v_line.unit_id,v_line.product_id,v_line.batch_id,'sold',v_line.location_id,1,v_line.unit_cost,'sale',v_sale_id,auth.uid());
  end loop;
  for v_payment in select value from jsonb_array_elements(p_payments) loop
    select id into v_method from public.payment_methods where code=v_payment->>'method_code' and is_active;
    if v_method is null then raise exception 'invalid payment method'; end if;
    insert into public.sale_payments(sale_id,payment_method_id,amount,status,external_reference,received_by) values(v_sale_id,v_method,(v_payment->>'amount')::numeric,'paid',v_payment->>'external_reference',auth.uid());
  end loop;
  update public.pos_pending_sales set status='confirmed',confirmed_by=auth.uid(),confirmed_at=now() where id=p_pending_sale_id;
  return v_sale_id;
end; $$;

create or replace function public.move_units(p_transfer_id uuid, p_target_status public.transfer_status)
returns void language plpgsql security definer set search_path = '' as $$
declare v_transfer public.transfers%rowtype; v_line record; v_unit public.inventory_units%rowtype;
begin
  select * into v_transfer from public.transfers where id=p_transfer_id for update;
  if not found then raise exception 'transfer not found'; end if;
  if not (public.has_role(array['superadmin','admin']::public.app_role[],null)
    or public.has_role(array['warehouse','manager']::public.app_role[],(select branch_id from public.locations where id=v_transfer.from_location_id))
    or (p_target_status='received' and public.has_role(array['warehouse','manager']::public.app_role[],(select branch_id from public.locations where id=v_transfer.to_location_id)))) then raise exception 'forbidden' using errcode='42501'; end if;
  if p_target_status='in_transit' and v_transfer.status not in ('approved','requested') then raise exception 'invalid transfer transition';
  elsif p_target_status='received' and v_transfer.status<>'in_transit' then raise exception 'invalid transfer transition';
  elsif p_target_status not in ('in_transit','received') then raise exception 'unsupported target'; end if;
  for v_line in select * from public.transfer_lines where transfer_id=p_transfer_id and unit_id is not null order by unit_id loop
    select * into v_unit from public.inventory_units where id=v_line.unit_id for update;
    if p_target_status='in_transit' then
      if v_unit.location_id<>v_transfer.from_location_id or v_unit.status<>'available' then raise exception 'unit % cannot ship',v_unit.id; end if;
      update public.inventory_units set status='in_transit',version=version+1 where id=v_unit.id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,reference_type,reference_id,actor_id) values(v_unit.id,v_unit.product_id,v_unit.batch_id,'transfer_out',v_transfer.from_location_id,v_transfer.to_location_id,1,'transfer',p_transfer_id,auth.uid());
    else
      if v_unit.status<>'in_transit' then raise exception 'unit % is not in transit',v_unit.id; end if;
      update public.inventory_units set status='available',location_id=v_transfer.to_location_id,version=version+1 where id=v_unit.id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,reference_type,reference_id,actor_id) values(v_unit.id,v_unit.product_id,v_unit.batch_id,'transfer_in',v_transfer.from_location_id,v_transfer.to_location_id,1,'transfer',p_transfer_id,auth.uid());
    end if;
  end loop;
  update public.transfers set status=p_target_status,shipped_at=case when p_target_status='in_transit' then now() else shipped_at end,received_at=case when p_target_status='received' then now() else received_at end,received_by=case when p_target_status='received' then auth.uid() else received_by end where id=p_transfer_id;
end; $$;

create or replace function public.create_online_order(p_customer jsonb,p_shipping_address jsonb,p_lines jsonb,p_payment_method_code text,p_idempotency_key text default null,p_notes text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_order uuid:=gen_random_uuid(); v_line jsonb; v_product record; v_subtotal numeric(18,2):=0; v_qty numeric(18,3); v_method uuid; v_existing uuid;
begin
  if p_idempotency_key is not null then select id into v_existing from public.orders where idempotency_key=p_idempotency_key; if found then return v_existing; end if; end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 or jsonb_typeof(p_shipping_address)<>'object' then raise exception 'invalid order payload' using errcode='22023'; end if;
  select id into v_method from public.payment_methods where code=p_payment_method_code and is_active and (is_online or is_cash);
  if v_method is null then raise exception 'invalid payment method'; end if;
  if nullif(btrim(p_customer->>'name'),'') is null or nullif(btrim(p_customer->>'phone'),'') is null then raise exception 'customer name and phone required'; end if;
  insert into public.orders(id,order_no,customer_user_id,status,customer_name,customer_phone,customer_email,shipping_address,notes,subtotal,total,payment_method_id,idempotency_key)
  values(v_order,'ORD-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||substr(v_order::text,1,6),auth.uid(),'new',p_customer->>'name',p_customer->>'phone',nullif(p_customer->>'email',''),p_shipping_address,p_notes,0,0,v_method,p_idempotency_key);
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_qty:=(v_line->>'quantity')::numeric; if v_qty<=0 then raise exception 'quantity must be positive'; end if;
    select id,name,sku,retail_price into v_product from public.products where id=(v_line->>'product_id')::uuid and status='active' and is_published for share;
    if not found then raise exception 'product unavailable'; end if;
    insert into public.order_lines(order_id,product_id,product_name,sku,quantity,unit_price,line_total) values(v_order,v_product.id,v_product.name,v_product.sku,v_qty,v_product.retail_price,round(v_qty*v_product.retail_price,2));
    v_subtotal:=v_subtotal+round(v_qty*v_product.retail_price,2);
  end loop;
  update public.orders set subtotal=v_subtotal,total=v_subtotal where id=v_order;
  insert into public.order_status_history(order_id,to_status,note,actor_id) values(v_order,'new','Online order created',auth.uid());
  return v_order;
exception when unique_violation then
  if p_idempotency_key is not null then select id into v_existing from public.orders where idempotency_key=p_idempotency_key; return v_existing; end if; raise;
end; $$;

create or replace function public.courier_update_delivery_status(p_delivery_id uuid,p_status public.delivery_status,p_note text default null,p_proof_url text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_delivery public.deliveries%rowtype; v_order_status public.order_status;
begin
  select * into v_delivery from public.deliveries where id=p_delivery_id for update;
  if not found or v_delivery.courier_id<>auth.uid() or not exists(select 1 from public.profile_roles r where r.profile_id=auth.uid() and r.role='courier') or not public.current_user_active() then raise exception 'forbidden' using errcode='42501'; end if;
  if not ((v_delivery.status='assigned' and p_status='picked_up') or (v_delivery.status='picked_up' and p_status='in_transit') or (v_delivery.status='in_transit' and p_status in ('delivered','failed'))) then raise exception 'invalid delivery transition'; end if;
  if p_status='delivered' and p_proof_url is null then raise exception 'delivery proof required'; end if;
  update public.deliveries set status=p_status,picked_up_at=case when p_status='picked_up' then now() else picked_up_at end,delivered_at=case when p_status='delivered' then now() else delivered_at end,proof_url=coalesce(p_proof_url,proof_url),recipient_note=coalesce(p_note,recipient_note) where id=p_delivery_id;
  v_order_status:=case p_status when 'picked_up' then 'shipped' when 'in_transit' then 'shipped' when 'delivered' then 'delivered' else 'processing' end;
  update public.orders set status=v_order_status where id=v_delivery.order_id;
  insert into public.order_status_history(order_id,to_status,note,actor_id) values(v_delivery.order_id,v_order_status,p_note,auth.uid());
end; $$;

-- Append-only row audit for critical mutable business records.
create or replace function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log(actor_id,action,entity_schema,entity_table,entity_id,old_data,new_data)
  values(auth.uid(),tg_op,tg_table_schema,tg_table_name,
    coalesce(case when tg_op<>'INSERT' then to_jsonb(old)->>'id' end,case when tg_op<>'DELETE' then to_jsonb(new)->>'id' end),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return case when tg_op='DELETE' then old else new end;
end; $$;
do $$ declare t text; begin
  foreach t in array array['profiles','profile_roles','branches','locations','products','suppliers','inventory_units','transfers','branch_debts','writeoffs','customers','payment_methods','pos_pending_sales','sales','sale_returns','orders','deliveries','finance_transactions','payroll_runs','cms_pages','cms_banners','system_settings'] loop
    execute format('create trigger %I_audit after insert or update or delete on public.%I for each row execute function public.audit_row_change()',t,t);
  end loop;
end $$;

-- RLS is enabled on every public table. Service role retains PostgreSQL BYPASSRLS.
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname='public' loop execute format('alter table public.%I enable row level security',t); end loop;
end $$;

-- Public storefront is intentionally read-only and limited to publishable data.
create policy categories_public_read on public.categories for select to anon,authenticated using(is_active);
create policy brands_public_read on public.brands for select to anon,authenticated using(is_active);
create policy products_public_read on public.products for select to anon,authenticated using(status='active' and is_published);
create policy attributes_public_read on public.attribute_definitions for select to anon,authenticated using(exists(select 1 from public.categories c where c.id=category_id and c.is_active));
create policy product_values_public_read on public.product_attribute_values for select to anon,authenticated using(exists(select 1 from public.products p where p.id=product_id and p.status='active' and p.is_published));
create policy product_media_public_read on public.product_media for select to anon,authenticated using(exists(select 1 from public.products p where p.id=product_id and p.status='active' and p.is_published));
create policy payment_methods_user_read on public.payment_methods for select to anon,authenticated using(is_active);
create policy cms_pages_public_read on public.cms_pages for select to anon,authenticated using(is_published and published_at<=now());
create policy cms_banners_public_read on public.cms_banners for select to anon,authenticated using(is_active and (starts_at is null or starts_at<=now()) and (ends_at is null or ends_at>now()));
create policy cms_promotions_public_read on public.cms_promotions for select to anon,authenticated using(is_active and starts_at<=now() and ends_at>now());
create policy cms_promotion_products_public_read on public.cms_promotion_products for select to anon,authenticated using(exists(select 1 from public.cms_promotions p where p.id=promotion_id and p.is_active and p.starts_at<=now() and p.ends_at>now()));
create policy cms_home_blocks_public_read on public.cms_home_blocks for select to anon,authenticated using(is_active and (starts_at is null or starts_at<=now()) and (ends_at is null or ends_at>now()));
create policy cms_menu_items_public_read on public.cms_menu_items for select to anon,authenticated using(is_active);
create policy public_settings_user_read on public.system_settings for select to anon,authenticated using(is_public);

-- Profile, customer and order ownership.
create policy profiles_self_read on public.profiles for select to authenticated using(id=auth.uid() or public.has_role(array['superadmin','admin','manager']::public.app_role[],null));
create policy profiles_self_update on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
create policy customers_self_read on public.customers for select to authenticated using(auth_user_id=auth.uid() or public.has_role(array['superadmin','admin','manager','seller']::public.app_role[],null));
create policy orders_self_read on public.orders for select to authenticated using(customer_user_id=auth.uid() or (branch_id is not null and public.can_access_branch(branch_id)));
create policy order_lines_owner_read on public.order_lines for select to authenticated using(exists(select 1 from public.orders o where o.id=order_id and (o.customer_user_id=auth.uid() or (o.branch_id is not null and public.can_access_branch(o.branch_id)))));
create policy order_history_owner_read on public.order_status_history for select to authenticated using(exists(select 1 from public.orders o where o.id=order_id and (o.customer_user_id=auth.uid() or (o.branch_id is not null and public.can_access_branch(o.branch_id)))));
create policy notifications_owner_read on public.notifications for select to authenticated using(recipient_id=auth.uid());
create policy notifications_owner_update on public.notifications for update to authenticated using(recipient_id=auth.uid()) with check(recipient_id=auth.uid());
create policy deliveries_courier_read on public.deliveries for select to authenticated using(courier_id=auth.uid() or exists(select 1 from public.orders o where o.id=order_id and o.branch_id is not null and public.can_access_branch(o.branch_id)));
create policy courier_tracking_own on public.courier_tracking for select to authenticated using(courier_id=auth.uid());
create policy courier_tracking_insert_own on public.courier_tracking for insert to authenticated with check(courier_id=auth.uid() and public.current_user_active() and exists(select 1 from public.profile_roles r where r.profile_id=auth.uid() and r.role='courier'));

-- Broad internal read policies remain branch-aware where the row carries branch context.
create policy branches_staff_read on public.branches for select to authenticated using(public.can_access_branch(id));
create policy locations_staff_read on public.locations for select to authenticated using(branch_id is not null and public.can_access_branch(branch_id));
create policy pending_sales_staff_read on public.pos_pending_sales for select to authenticated using(public.can_access_branch(branch_id));
create policy sales_staff_read on public.sales for select to authenticated using(public.can_access_branch(branch_id));
create policy returns_staff_read on public.sale_returns for select to authenticated using(public.can_access_branch(branch_id));
create policy finance_staff_read on public.finance_transactions for select to authenticated using(branch_id is not null and public.has_role(array['superadmin','admin','manager','accountant']::public.app_role[],branch_id));
create policy payroll_staff_read on public.payroll_runs for select to authenticated using(public.has_role(array['superadmin','admin','accountant']::public.app_role[],branch_id));
create policy stock_batches_staff_read on public.stock_batches for select to authenticated using(exists(select 1 from public.locations l where l.id=location_id and l.branch_id is not null and public.can_access_branch(l.branch_id)));
create policy inventory_units_staff_read on public.inventory_units for select to authenticated using(exists(select 1 from public.locations l where l.id=location_id and l.branch_id is not null and public.can_access_branch(l.branch_id)));
create policy inventory_movements_staff_read on public.inventory_movements for select to authenticated using(
  exists(select 1 from public.locations l where l.id=coalesce(to_location_id,from_location_id) and l.branch_id is not null and public.can_access_branch(l.branch_id))
);
create policy transfers_staff_read on public.transfers for select to authenticated using(
  exists(select 1 from public.locations l where l.id=from_location_id and l.branch_id is not null and public.can_access_branch(l.branch_id))
  or exists(select 1 from public.locations l where l.id=to_location_id and l.branch_id is not null and public.can_access_branch(l.branch_id))
);
create policy transfer_lines_staff_read on public.transfer_lines for select to authenticated using(exists(select 1 from public.transfers t where t.id=transfer_id and (
  exists(select 1 from public.locations l where l.id=t.from_location_id and l.branch_id is not null and public.can_access_branch(l.branch_id))
  or exists(select 1 from public.locations l where l.id=t.to_location_id and l.branch_id is not null and public.can_access_branch(l.branch_id))
)));
create policy inventory_counts_staff_read on public.inventory_counts for select to authenticated using(exists(select 1 from public.locations l where l.id=location_id and l.branch_id is not null and public.can_access_branch(l.branch_id)));
create policy inventory_count_lines_staff_read on public.inventory_count_lines for select to authenticated using(exists(select 1 from public.inventory_counts c join public.locations l on l.id=c.location_id where c.id=inventory_count_id and l.branch_id is not null and public.can_access_branch(l.branch_id)));

-- Cost and lifecycle fields are exposed through a role-filtered staff-only view, never via the public products grant.
create view public.staff_product_catalog with (security_barrier=true) as
select p.* from public.products p
where public.current_user_active() and exists(
  select 1 from public.profile_roles r where r.profile_id=auth.uid()
  and r.role in ('superadmin','admin','manager','seller','warehouse','accountant')
);

-- Administrators can manage mutable master/CMS records through RLS; sensitive transaction writes remain RPC/server only.
do $$ declare t text; begin
  foreach t in array array['branches','locations','categories','brands','products','attribute_definitions','product_attribute_values','product_media','suppliers','payment_methods','cms_pages','cms_banners','cms_promotions','cms_promotion_products','cms_home_blocks','cms_menu_items','system_settings'] loop
    execute format('create policy %I_admin_all on public.%I for all to authenticated using(public.has_role(array[''superadmin'',''admin'']::public.app_role[],null)) with check(public.has_role(array[''superadmin'',''admin'']::public.app_role[],null))',t,t);
  end loop;
end $$;

-- Default deny, then narrowly grant table verbs. RLS still applies to these grants.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select (id,sku,barcode,category_id,brand_id,name,slug,description,status,is_published,retail_price,compare_at_price,tax_rate,metadata,created_at,updated_at) on public.products to anon,authenticated;
grant select on public.categories,public.brands,public.attribute_definitions,public.product_attribute_values,public.product_media,public.cms_pages,public.cms_banners,public.cms_promotions,public.cms_promotion_products,public.cms_home_blocks,public.cms_menu_items to anon,authenticated;
grant select on public.payment_methods,public.system_settings to anon,authenticated;
grant select on public.profiles,public.notifications to authenticated;
grant select on public.staff_product_catalog to authenticated;
grant update(full_name,phone,avatar_url) on public.profiles to authenticated;
grant update(read_at) on public.notifications to authenticated;
grant select on public.customers,public.orders,public.order_lines,public.order_status_history,public.deliveries,public.branches,public.locations,public.stock_batches,public.inventory_units,public.inventory_movements,public.transfers,public.transfer_lines,public.inventory_counts,public.inventory_count_lines,public.pos_pending_sales,public.sales,public.sale_returns,public.finance_transactions,public.payroll_runs to authenticated;
grant select,insert on public.courier_tracking to authenticated;
grant insert,update,delete on public.branches,public.locations,public.categories,public.brands,public.products,public.attribute_definitions,public.product_attribute_values,public.product_media,public.suppliers,public.payment_methods,public.cms_pages,public.cms_banners,public.cms_promotions,public.cms_promotion_products,public.cms_home_blocks,public.cms_menu_items,public.system_settings to authenticated;

revoke all on function public.create_pos_pending_sale(uuid,uuid,jsonb,numeric,text) from public;
revoke all on function public.manager_confirm_sale(uuid,jsonb) from public;
revoke all on function public.move_units(uuid,public.transfer_status) from public;
revoke all on function public.create_online_order(jsonb,jsonb,jsonb,text,text,text) from public;
revoke all on function public.courier_update_delivery_status(uuid,public.delivery_status,text,text) from public;
grant execute on function public.create_pos_pending_sale(uuid,uuid,jsonb,numeric,text), public.manager_confirm_sale(uuid,jsonb), public.move_units(uuid,public.transfer_status), public.courier_update_delivery_status(uuid,public.delivery_status,text,text) to authenticated;
grant execute on function public.create_online_order(jsonb,jsonb,jsonb,text,text,text) to anon,authenticated;

-- Server-only service role keeps explicit privileges in addition to BYPASSRLS.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke all on tables from anon,authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

commit;
