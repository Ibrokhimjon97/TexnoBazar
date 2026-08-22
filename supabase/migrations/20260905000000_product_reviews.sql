-- Product reviews & ratings
-- Customers can leave a review (1-5 stars + text) on any product.
-- Admin controls visibility (is_visible flag).

create table public.product_reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  reviewer_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check (rating >= 1 and rating <= 5),
  body text not null default '' check (length(body) <= 2000),
  is_visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id, reviewer_id)
);

create index product_reviews_product_idx on public.product_reviews(product_id, is_visible, created_at desc);
create index product_reviews_reviewer_idx on public.product_reviews(reviewer_id, created_at desc);

alter table public.product_reviews enable row level security;

-- Authenticated users can read visible reviews
create policy "reviews_select_visible" on public.product_reviews
  for select to authenticated using (is_visible = true);

-- Anon users can also read visible reviews (storefront is public)
create policy "reviews_select_anon" on public.product_reviews
  for select to anon using (is_visible = true);

-- Users can insert their own review
create policy "reviews_insert_own" on public.product_reviews
  for insert to authenticated with check (reviewer_id = auth.uid());

-- Users can update their own review
create policy "reviews_update_own" on public.product_reviews
  for update to authenticated using (reviewer_id = auth.uid()) with check (reviewer_id = auth.uid());

-- Users can delete their own review
create policy "reviews_delete_own" on public.product_reviews
  for delete to authenticated using (reviewer_id = auth.uid());

-- ============================================================
-- RPC: List product reviews (public, storefront)
-- ============================================================
create or replace function public.list_product_reviews(p_product_id uuid, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_items jsonb;
  v_total bigint;
  v_avg numeric;
begin
  select count(*), coalesce(avg(rating), 0)
  into v_total, v_avg
  from public.product_reviews
  where product_id = p_product_id and is_visible = true;

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
  into v_items
  from (
    select
      r.id, r.rating, r.body, r.created_at,
      r.reviewer_id,
      coalesce(p.full_name, p.email, 'Foydalanuvchi') as reviewer_name
    from public.product_reviews r
    left join public.profiles p on p.id = r.reviewer_id
    where r.product_id = p_product_id and r.is_visible = true
    order by r.created_at desc
    limit p_limit offset p_offset
  ) t;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'average_rating', round(v_avg, 1)
  );
end; $$;

grant execute on function public.list_product_reviews(uuid, int, int) to authenticated, anon;

-- ============================================================
-- RPC: Submit a review (authenticated customer)
-- ============================================================
create or replace function public.submit_product_review(p_product_id uuid, p_rating smallint, p_body text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_review public.product_reviews;
begin
  if v_user_id is null then
    raise exception 'Avtorizatsiya talab qilinadi' using errcode = '42501';
  end if;

  if p_rating < 1 or p_rating > 5 then
    raise exception 'Baho 1 dan 5 gacha bo''lishi kerak' using errcode = '22023';
  end if;

  insert into public.product_reviews (product_id, reviewer_id, rating, body)
  values (p_product_id, v_user_id, p_rating, coalesce(left(trim(p_body), 2000), ''))
  on conflict (product_id, reviewer_id) do update
    set rating = excluded.rating,
        body = excluded.body,
        updated_at = now()
  returning * into v_review;

  return jsonb_build_object('id', v_review.id, 'rating', v_review.rating, 'body', v_review.body, 'created_at', v_review.created_at);
end; $$;

grant execute on function public.submit_product_review(uuid, smallint, text) to authenticated;

-- ============================================================
-- RPC: Admin — list all reviews with filters
-- ============================================================
create or replace function public.admin_list_reviews(
  p_product_id uuid default null,
  p_visible boolean default null,
  p_limit int default 50,
  p_offset int default 0
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_items jsonb;
  v_total bigint;
begin
  if not public.has_role('admin') then
    raise exception 'Admin ruxsati talab qilinadi' using errcode = '42501';
  end if;

  select count(*) into v_total
  from public.product_reviews r
  where (p_product_id is null or r.product_id = p_product_id)
    and (p_visible is null or r.is_visible = p_visible);

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
  into v_items
  from (
    select
      r.id, r.product_id, r.reviewer_id, r.rating, r.body, r.is_visible,
      r.created_at, r.updated_at,
      coalesce(p.full_name, p.email, 'Foydalanuvchi') as reviewer_name,
      coalesce(pr.name, 'Nomsiz mahsulot') as product_name
    from public.product_reviews r
    left join public.profiles p on p.id = r.reviewer_id
    left join public.products pr on pr.id = r.product_id
    where (p_product_id is null or r.product_id = p_product_id)
      and (p_visible is null or r.is_visible = p_visible)
    order by r.created_at desc
    limit p_limit offset p_offset
  ) t;

  return jsonb_build_object('items', v_items, 'total', v_total);
end; $$;

grant execute on function public.admin_list_reviews(uuid, boolean, int, int) to authenticated;

-- ============================================================
-- RPC: Admin — toggle review visibility
-- ============================================================
create or replace function public.admin_toggle_review_visibility(p_review_id uuid, p_visible boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role('admin') then
    raise exception 'Admin ruxsati talab qilinadi' using errcode = '42501';
  end if;

  update public.product_reviews
  set is_visible = p_visible, updated_at = now()
  where id = p_review_id;

  if not found then
    raise exception 'Sharh topilmadi' using errcode = 'P0002';
  end if;
end; $$;

grant execute on function public.admin_toggle_review_visibility(uuid, boolean) to authenticated;

-- ============================================================
-- RPC: Admin — delete a review
-- ============================================================
create or replace function public.admin_delete_review(p_review_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role('admin') then
    raise exception 'Admin ruxsati talab qilinadi' using errcode = '42501';
  end if;

  delete from public.product_reviews where id = p_review_id;

  if not found then
    raise exception 'Sharh topilmadi' using errcode = 'P0002';
  end if;
end; $$;

grant execute on function public.admin_delete_review(uuid) to authenticated;
