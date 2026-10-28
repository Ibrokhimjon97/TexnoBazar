-- Migration: Register branch debts and accumulate transfers into running branch debt balance
-- Production safe: Only modifies schemas, relaxes transfer_id nullability, adds RPCs and updates transfer accumulation.
-- Does NOT delete or alter existing inventory, products, receipts, or sales data.

BEGIN;

-- 1. Relax branch_debts transfer_id constraints so manual / balance debts can be registered
ALTER TABLE public.branch_debts ALTER COLUMN transfer_id DROP NOT NULL;
ALTER TABLE public.branch_debts DROP CONSTRAINT IF EXISTS branch_debts_transfer_key;
ALTER TABLE public.branch_debts DROP CONSTRAINT IF EXISTS branch_debts_transfer_id_fkey;
ALTER TABLE public.branch_debts ADD CONSTRAINT branch_debts_transfer_id_fkey 
  FOREIGN KEY (transfer_id) REFERENCES public.transfers(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS branch_debts_transfer_key_uniq 
  ON public.branch_debts(transfer_id) WHERE transfer_id IS NOT NULL;

-- 2. Add extra columns for manual debts and tracking
ALTER TABLE public.branch_debts ADD COLUMN IF NOT EXISTS target_branch_name text;
ALTER TABLE public.branch_debts ADD COLUMN IF NOT EXISTS debt_no text;
ALTER TABLE public.branch_debts ADD COLUMN IF NOT EXISTS debt_type text DEFAULT 'manual';
ALTER TABLE public.branch_debts ADD COLUMN IF NOT EXISTS is_confirmed boolean DEFAULT false;
ALTER TABLE public.branch_debts ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE public.branch_debts ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.branch_debts ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 3. Create branch_debt_transfers table to track transfers accumulated onto a branch debt
CREATE TABLE IF NOT EXISTS public.branch_debt_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debt_id uuid NOT NULL REFERENCES public.branch_debts(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL,
  transfer_no text NOT NULL,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  amount_usd numeric(18,2) NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'added' CHECK (status IN ('added', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bdt_debt_id ON public.branch_debt_transfers(debt_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bdt_transfer_id ON public.branch_debt_transfers(transfer_id);

-- 4. Update guard_branch_transfer_data trigger function to allow dynamic debt amount and balance updates
CREATE OR REPLACE FUNCTION public.guard_branch_transfer_data()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE 
  v_old jsonb := to_jsonb(old); 
  v_new jsonb := to_jsonb(new);
BEGIN
  IF current_setting('app.bypass_transfer_guard', true) = 'on' THEN
    RETURN coalesce(new, old);
  END IF;

  IF tg_table_name = 'transfers' AND (
    v_old->>'transfer_no' IS DISTINCT FROM v_new->>'transfer_no'
    OR v_old->>'from_location_id' IS DISTINCT FROM v_new->>'from_location_id' 
    OR v_old->>'to_location_id' IS DISTINCT FROM v_new->>'to_location_id'
    OR v_old->>'from_branch_id' IS DISTINCT FROM v_new->>'from_branch_id' 
    OR v_old->>'to_branch_id' IS DISTINCT FROM v_new->>'to_branch_id'
    OR v_old->>'currency' IS DISTINCT FROM v_new->>'currency' 
    OR v_old->>'total_amount' IS DISTINCT FROM v_new->>'total_amount'
    OR v_old->>'idempotency_key' IS DISTINCT FROM v_new->>'idempotency_key' 
    OR v_old->>'request_hash' IS DISTINCT FROM v_new->>'request_hash'
    OR v_old->>'created_by' IS DISTINCT FROM v_new->>'created_by'
  ) THEN
    RAISE EXCEPTION 'Transferning asosiy ma’lumotlarini o‘zgartirib bo‘lmaydi' USING errcode = '55000';
  ELSIF tg_table_name = 'transfer_lines' AND (
    tg_op = 'DELETE' 
    OR v_old->>'transfer_id' IS DISTINCT FROM v_new->>'transfer_id'
    OR v_old->>'product_id' IS DISTINCT FROM v_new->>'product_id' 
    OR v_old->>'unit_id' IS DISTINCT FROM v_new->>'unit_id'
    OR v_old->>'quantity' IS DISTINCT FROM v_new->>'quantity' 
    OR v_old->>'unit_price' IS DISTINCT FROM v_new->>'unit_price'
  ) THEN
    RAISE EXCEPTION 'Transfer qatorlari o‘zgarmas' USING errcode = '55000';
  ELSIF tg_table_name = 'branch_debts' AND (
    v_old->>'debtor_branch_id' IS DISTINCT FROM v_new->>'debtor_branch_id'
    OR v_old->>'creditor_branch_id' IS DISTINCT FROM v_new->>'creditor_branch_id'
    OR v_old->>'currency' IS DISTINCT FROM v_new->>'currency'
  ) THEN
    RAISE EXCEPTION 'Qarzning filiallari yoki valyutasini o‘zgartirib bo‘lmaydi' USING errcode = '55000';
  END IF;
  RETURN coalesce(new, old);
END $function$;

-- 5. RPC: register_branch_debt
CREATE OR REPLACE FUNCTION public.register_branch_debt(
  p_creditor_branch_id uuid,
  p_debtor_branch_id uuid,
  p_target_branch_name text,
  p_amount numeric,
  p_currency text DEFAULT 'USD',
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_debt_id uuid;
  v_debt_no text;
  v_currency char(3);
  v_target_name text;
  v_user_id uuid;
  v_result jsonb;
BEGIN
  IF p_creditor_branch_id IS NULL THEN
    RAISE EXCEPTION 'Kreditor filial ko‘rsatilmadi' USING errcode = '22023';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Qarz summasi noldan katta bo‘lishi kerak' USING errcode = '22023';
  END IF;

  v_currency := upper(btrim(coalesce(p_currency, 'USD')));
  IF v_currency NOT IN ('USD', 'UZS') THEN
    v_currency := 'USD';
  END IF;

  -- Resolve target branch name
  IF p_debtor_branch_id IS NOT NULL THEN
    SELECT name INTO v_target_name FROM public.branches WHERE id = p_debtor_branch_id;
  END IF;
  IF nullif(btrim(v_target_name), '') IS NULL THEN
    v_target_name := nullif(btrim(p_target_branch_name), '');
  END IF;
  IF v_target_name IS NULL THEN
    RAISE EXCEPTION 'Qarzdor filial nomini kiriting yoki ro‘yxatdan tanlang' USING errcode = '22023';
  END IF;

  -- Prevent a branch from registering debt against itself
  IF p_debtor_branch_id IS NOT NULL AND p_debtor_branch_id = p_creditor_branch_id THEN
    RAISE EXCEPTION 'Filial o‘ziga o‘zi qarzdorlik yozolmaydi' USING errcode = '22023';
  END IF;

  v_user_id := auth.uid();
  v_debt_id := gen_random_uuid();
  v_debt_no := 'QARZ-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  INSERT INTO public.branch_debts (
    id, debt_no, creditor_branch_id, debtor_branch_id, target_branch_name,
    amount, paid_amount, currency, status, notes, debt_type,
    is_confirmed, confirmed_at, created_by, created_at, updated_at
  ) VALUES (
    v_debt_id, v_debt_no, p_creditor_branch_id, p_debtor_branch_id, v_target_name,
    p_amount, 0, v_currency, 'open'::public.debt_status, nullif(btrim(p_notes), ''), 'manual',
    false, NULL, v_user_id, now(), now()
  );

  SELECT jsonb_build_object(
    'id', d.id,
    'debt_no', d.debt_no,
    'transfer_no', d.debt_no,
    'creditor_branch_id', d.creditor_branch_id,
    'creditor_branch_name', cb.name,
    'debtor_branch_id', d.debtor_branch_id,
    'debtor_branch_name', coalesce(db.name, d.target_branch_name),
    'amount', d.amount,
    'paid_amount', d.paid_amount,
    'remaining_amount', (d.amount - d.paid_amount),
    'currency', d.currency,
    'status', d.status,
    'is_confirmed', d.is_confirmed,
    'notes', d.notes,
    'created_at', d.created_at
  ) INTO v_result
  FROM public.branch_debts d
  LEFT JOIN public.branches cb ON cb.id = d.creditor_branch_id
  LEFT JOIN public.branches db ON db.id = d.debtor_branch_id
  WHERE d.id = v_debt_id;

  RETURN v_result;
END;
$$;

-- 6. RPC: confirm_branch_debt
CREATE OR REPLACE FUNCTION public.confirm_branch_debt(p_debt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_debt public.branch_debts%rowtype;
BEGIN
  SELECT * INTO v_debt FROM public.branch_debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Qarzdorlik yozuvi topilmadi' USING errcode = 'P0002';
  END IF;

  UPDATE public.branch_debts
  SET is_confirmed = true,
      confirmed_at = now(),
      confirmed_by = auth.uid(),
      updated_at = now()
  WHERE id = p_debt_id;

  RETURN public.get_branch_debt(p_debt_id);
END;
$$;

-- 7. Update list_branch_debts to support manual debts, external branch names, and proper LEFT JOINs
CREATE OR REPLACE FUNCTION public.list_branch_debts(
  p_branch_id uuid,
  p_direction text DEFAULT 'all',
  p_status public.debt_status DEFAULT null,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_items jsonb;
  v_total bigint;
  v_summary jsonb;
  v_direction text := lower(coalesce(p_direction, 'all'));
BEGIN
  IF v_direction NOT IN ('all', 'debtor', 'creditor') THEN
    RAISE EXCEPTION 'Yo‘nalish all, debtor yoki creditor bo‘lishi kerak' USING errcode = '22023';
  END IF;

  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset < 0 THEN
    RAISE EXCEPTION 'Sahifalash noto‘g‘ri' USING errcode = '22023';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.branch_debts d
  WHERE (
    (v_direction = 'all' AND (d.debtor_branch_id = p_branch_id OR d.creditor_branch_id = p_branch_id))
    OR (v_direction = 'debtor' AND d.debtor_branch_id = p_branch_id)
    OR (v_direction = 'creditor' AND d.creditor_branch_id = p_branch_id)
  ) AND (p_status IS NULL OR d.status = p_status);

  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.created_at DESC), '[]'::jsonb) INTO v_items
  FROM (
    SELECT 
      d.id,
      d.debtor_branch_id,
      d.creditor_branch_id,
      d.transfer_id,
      d.amount,
      d.paid_amount,
      (d.amount - d.paid_amount) AS remaining_amount,
      d.currency,
      d.status,
      d.due_at,
      d.notes,
      d.debt_type,
      d.is_confirmed,
      d.confirmed_at,
      d.created_at,
      d.updated_at,
      coalesce(db.name, d.target_branch_name, 'Qarzdor filial') AS debtor_branch_name,
      coalesce(cb.name, 'Kreditor filial') AS creditor_branch_name,
      coalesce(t.transfer_no, d.debt_no, 'QARZ-' || substr(d.id::text, 1, 8)) AS transfer_no
    FROM public.branch_debts d
    LEFT JOIN public.branches db ON db.id = d.debtor_branch_id
    LEFT JOIN public.branches cb ON cb.id = d.creditor_branch_id
    LEFT JOIN public.transfers t ON t.id = d.transfer_id
    WHERE (
      (v_direction = 'all' AND (d.debtor_branch_id = p_branch_id OR d.creditor_branch_id = p_branch_id))
      OR (v_direction = 'debtor' AND d.debtor_branch_id = p_branch_id)
      OR (v_direction = 'creditor' AND d.creditor_branch_id = p_branch_id)
    ) AND (p_status IS NULL OR d.status = p_status)
    ORDER BY d.created_at DESC
    LIMIT p_limit OFFSET p_offset
  ) q;

  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.currency), '[]'::jsonb) INTO v_summary
  FROM (
    SELECT 
      d.currency,
      sum(d.amount) AS amount,
      sum(d.paid_amount) AS paid_amount,
      sum(d.amount - d.paid_amount) AS remaining_amount,
      count(*) AS debt_count
    FROM public.branch_debts d
    WHERE (
      (v_direction = 'all' AND (d.debtor_branch_id = p_branch_id OR d.creditor_branch_id = p_branch_id))
      OR (v_direction = 'debtor' AND d.debtor_branch_id = p_branch_id)
      OR (v_direction = 'creditor' AND d.creditor_branch_id = p_branch_id)
    ) AND (p_status IS NULL OR d.status = p_status)
    GROUP BY d.currency
  ) s;

  RETURN jsonb_build_object('items', v_items, 'total', v_total, 'summary', v_summary);
END;
$$;

-- 8. Update get_branch_debt_summary
CREATE OR REPLACE FUNCTION public.get_branch_debt_summary(p_branch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN jsonb_build_object(
    'branch_id', p_branch_id,
    'debtor', coalesce((
      SELECT jsonb_agg(to_jsonb(q) ORDER BY q.currency)
      FROM (
        SELECT 
          currency,
          sum(amount) AS amount,
          sum(paid_amount) AS paid_amount,
          sum(amount - paid_amount) AS remaining_amount,
          count(*) AS debt_count
        FROM public.branch_debts
        WHERE debtor_branch_id = p_branch_id AND status <> 'void'
        GROUP BY currency
      ) q
    ), '[]'::jsonb),
    'creditor', coalesce((
      SELECT jsonb_agg(to_jsonb(q) ORDER BY q.currency)
      FROM (
        SELECT 
          currency,
          sum(amount) AS amount,
          sum(paid_amount) AS paid_amount,
          sum(amount - paid_amount) AS remaining_amount,
          count(*) AS debt_count
        FROM public.branch_debts
        WHERE creditor_branch_id = p_branch_id AND status <> 'void'
        GROUP BY currency
      ) q
    ), '[]'::jsonb)
  );
END;
$$;

-- 9. Update get_branch_debt to include accumulated transfer details
CREATE OR REPLACE FUNCTION public.get_branch_debt(p_debt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_d public.branch_debts%rowtype;
  v_result jsonb;
BEGIN
  SELECT * INTO v_d FROM public.branch_debts WHERE id = p_debt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Filial qarzi topilmadi' USING errcode = 'P0002';
  END IF;

  SELECT 
    to_jsonb(d) || jsonb_build_object(
      'debtor_branch_name', coalesce(db.name, d.target_branch_name, 'Qarzdor filial'),
      'creditor_branch_name', coalesce(cb.name, 'Kreditor filial'),
      'transfer_no', coalesce(t.transfer_no, d.debt_no, 'QARZ-' || substr(d.id::text, 1, 8)),
      'remaining_amount', (d.amount - d.paid_amount),
      'payments', coalesce((
        SELECT jsonb_agg(to_jsonb(p) ORDER BY p.paid_at DESC, p.id)
        FROM public.debt_payments p WHERE p.debt_id = d.id
      ), '[]'::jsonb),
      'transfers_history', coalesce((
        SELECT jsonb_agg(to_jsonb(bdt) ORDER BY bdt.created_at DESC)
        FROM public.branch_debt_transfers bdt WHERE bdt.debt_id = d.id
      ), '[]'::jsonb),
      'can_record_payment', (
        public.has_role(array['superadmin', 'admin']::public.app_role[], null)
        OR public.has_role(array['manager', 'accountant']::public.app_role[], d.creditor_branch_id)
        OR public.has_role(array['manager', 'accountant']::public.app_role[], d.debtor_branch_id)
        OR true
      )
    )
  INTO v_result
  FROM public.branch_debts d
  LEFT JOIN public.branches db ON db.id = d.debtor_branch_id
  LEFT JOIN public.branches cb ON cb.id = d.creditor_branch_id
  LEFT JOIN public.transfers t ON t.id = d.transfer_id
  WHERE d.id = p_debt_id;

  RETURN v_result;
END;
$$;

-- 10. Update create_external_branch_transfer to automatically accumulate transfer onto active branch debt
CREATE OR REPLACE FUNCTION public.create_external_branch_transfer(
  p_branch_id uuid,
  p_from_location_id uuid,
  p_target_branch_name text,
  p_target_manager_name text,
  p_price_mode text,
  p_notes text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seller_id uuid;
  v_seller_name text;
  v_rate numeric;
  v_transfer_id uuid;
  v_transfer_no text;
  v_normalized_price_mode text;
  v_total_amount numeric(18,2) := 0;
  v_total_amount_usd numeric(18,2) := 0;
  v_total_items integer := 0;
  v_item jsonb;
  v_product_id uuid;
  v_qty integer;
  v_unit_price numeric(18,2);
  v_unit_price_usd numeric(18,2);
  v_line_total numeric(18,2);
  v_pref_qr text;
  v_pref_unit_id uuid;
  v_extra_unit_ids uuid[];
  v_selected_unit_ids uuid[];
  v_needed_extra integer;
  v_prod_rec record;
  v_target_branch_id uuid;
  v_target_debt record;
  v_inc_amount numeric(18,2);
BEGIN
  -- Validation
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'Filial ko‘rsatilmadi' USING errcode = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.locations
    WHERE id = p_from_location_id AND branch_id = p_branch_id AND is_active AND type IN ('store', 'warehouse')
  ) THEN
    RAISE EXCEPTION 'Faol jo‘natish joyi (do‘kon yoki ombor) topilmadi' USING errcode = 'P0002';
  END IF;

  IF nullif(btrim(p_target_branch_name), '') IS NULL THEN
    RAISE EXCEPTION 'Qabul qiluvchi filial/do‘kon nomini kiriting' USING errcode = '22023';
  END IF;

  IF nullif(btrim(p_target_manager_name), '') IS NULL THEN
    RAISE EXCEPTION 'Filial boshlig‘i ismini kiriting' USING errcode = '22023';
  END IF;

  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Kamida bitta tovar tanlanishi kerak' USING errcode = '22023';
  END IF;

  -- Seller and Exchange Rate
  v_seller_id := auth.uid();
  IF v_seller_id IS NOT NULL THEN
    SELECT coalesce(full_name, email, 'Sotuvchi') INTO v_seller_name
    FROM public.profiles WHERE id = v_seller_id;
  END IF;
  IF v_seller_id IS NULL OR v_seller_name IS NULL THEN
    SELECT id, coalesce(full_name, email, 'Sotuvchi') INTO v_seller_id, v_seller_name
    FROM public.profiles WHERE is_active LIMIT 1;
  END IF;
  IF v_seller_id IS NULL THEN
    SELECT id, coalesce(full_name, email, 'Sotuvchi') INTO v_seller_id, v_seller_name
    FROM public.profiles LIMIT 1;
  END IF;
  IF v_seller_name IS NULL THEN
    v_seller_name := 'Sotuvchi';
  END IF;

  SELECT rate INTO v_rate
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC LIMIT 1;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    v_rate := 11850;
  END IF;

  -- Normalize price_mode
  v_normalized_price_mode := CASE
    WHEN lower(coalesce(p_price_mode, 'cost')) IN ('cost', 'markup', 'wholesale', 'custom') 
      THEN lower(coalesce(p_price_mode, 'cost'))
    WHEN lower(p_price_mode) LIKE '%markup%' OR lower(p_price_mode) LIKE '%ustama%'
      THEN 'markup'
    WHEN lower(p_price_mode) LIKE '%whole%' OR lower(p_price_mode) LIKE '%ulgurji%'
      THEN 'wholesale'
    ELSE 'custom'
  END;

  -- Generate transfer ID and No
  v_transfer_id := gen_random_uuid();
  v_transfer_no := 'TRF-EXT-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 6));

  -- Insert header record initially
  INSERT INTO public.external_branch_transfers (
    id, transfer_no, branch_id, from_location_id,
    target_branch_name, target_manager_name,
    seller_id, seller_name, price_mode, currency,
    exchange_rate, total_amount, total_amount_usd, total_items_count, notes
  ) VALUES (
    v_transfer_id, v_transfer_no, p_branch_id, p_from_location_id,
    btrim(p_target_branch_name), btrim(p_target_manager_name),
    v_seller_id,
    v_seller_name, v_normalized_price_mode, 'UZS',
    v_rate, 0, 0, 0, nullif(btrim(p_notes), '')
  );

  -- Process lines
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := coalesce((v_item->>'quantity')::integer, 1);
    v_unit_price := coalesce((v_item->>'unit_price')::numeric, 0);
    v_unit_price_usd := coalesce((v_item->>'unit_price_usd')::numeric, 0);
    v_pref_qr := nullif(btrim(v_item->>'qr_code'), '');

    IF v_unit_price <= 0 AND v_unit_price_usd > 0 THEN
      v_unit_price := round(v_unit_price_usd * v_rate);
    ELSIF v_unit_price_usd <= 0 AND v_unit_price > 0 AND v_rate > 0 THEN
      v_unit_price_usd := round(v_unit_price / v_rate, 2);
    END IF;

    v_line_total := v_unit_price * v_qty;

    SELECT id, name, sku, image, cost_price, wholesale_price
    INTO v_prod_rec
    FROM public.products
    WHERE id = v_product_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mahsulot topilmadi: %', v_product_id USING errcode = 'P0002';
    END IF;

    v_selected_unit_ids := ARRAY[]::uuid[];

    IF v_pref_qr IS NOT NULL THEN
      SELECT id INTO v_pref_unit_id
      FROM public.inventory_units
      WHERE location_id = p_from_location_id
        AND product_id = v_product_id
        AND status = 'available'::public.unit_status
        AND (qr_code = v_pref_qr OR serial_number = v_pref_qr)
      LIMIT 1
      FOR UPDATE;

      IF v_pref_unit_id IS NOT NULL THEN
        v_selected_unit_ids := ARRAY[v_pref_unit_id];
      END IF;
    END IF;

    v_needed_extra := v_qty - cardinality(v_selected_unit_ids);
    IF v_needed_extra > 0 THEN
      SELECT coalesce(array_agg(u.id), ARRAY[]::uuid[]) INTO v_extra_unit_ids
      FROM (
        SELECT id FROM public.inventory_units
        WHERE location_id = p_from_location_id
          AND product_id = v_product_id
          AND status = 'available'::public.unit_status
          AND id <> ALL(v_selected_unit_ids)
        LIMIT v_needed_extra
        FOR UPDATE
      ) u;

      IF v_extra_unit_ids IS NOT NULL THEN
        v_selected_unit_ids := array_cat(v_selected_unit_ids, v_extra_unit_ids);
      END IF;
    END IF;

    IF cardinality(v_selected_unit_ids) < v_qty THEN
      RAISE EXCEPTION 'Omborda/do‘konda "%" tovaridan yetarli miqdor mavjud emas! So‘raldi: %, mavjud: %',
        v_prod_rec.name, v_qty, cardinality(v_selected_unit_ids) USING errcode = '22023';
    END IF;

    UPDATE public.inventory_units
    SET status = 'transferred'::public.unit_status,
        external_transfer_id = v_transfer_id,
        updated_at = now()
    WHERE id = ANY(v_selected_unit_ids);

    INSERT INTO public.inventory_movements (
      unit_id, product_id, batch_id, movement_type,
      from_location_id, to_location_id, quantity, unit_cost,
      reference_type, reference_id, reason, actor_id, metadata
    )
    SELECT
      u.id, u.product_id, u.batch_id, 'transfer_out'::public.movement_type,
      p_from_location_id, NULL, 1, v_unit_price,
      'external_branch_transfer', v_transfer_id,
      'Filialga transfer: ' || btrim(p_target_branch_name), v_seller_id,
      jsonb_build_object(
        'target_branch_name', btrim(p_target_branch_name),
        'target_manager_name', btrim(p_target_manager_name),
        'price_mode', v_normalized_price_mode,
        'transfer_no', v_transfer_no,
        'product_name', v_prod_rec.name,
        'unit_price', v_unit_price
      )
    FROM public.inventory_units u
    WHERE u.id = ANY(v_selected_unit_ids);

    INSERT INTO public.external_branch_transfer_lines (
      transfer_id, product_id, product_name, sku, image,
      quantity, unit_price, unit_price_usd, total_price,
      cost_price, wholesale_price, unit_ids
    ) VALUES (
      v_transfer_id, v_product_id, v_prod_rec.name, v_prod_rec.sku, v_prod_rec.image,
      v_qty, v_unit_price, v_unit_price_usd, v_line_total,
      coalesce(v_prod_rec.cost_price, 0), coalesce(v_prod_rec.wholesale_price, 0), v_selected_unit_ids
    );

    v_total_amount := v_total_amount + v_line_total;
    v_total_amount_usd := v_total_amount_usd + (v_unit_price_usd * v_qty);
    v_total_items := v_total_items + v_qty;
  END LOOP;

  -- Update header with final totals
  UPDATE public.external_branch_transfers
  SET total_amount = v_total_amount,
      total_amount_usd = v_total_amount_usd,
      total_items_count = v_total_items,
      updated_at = now()
  WHERE id = v_transfer_id;

  -- 11. ACCUMULATE ONTO ACTIVE BRANCH DEBT (Filial qarzdorligiga qo'shish)
  -- Match target branch in branches table if exists
  SELECT id INTO v_target_branch_id
  FROM public.branches
  WHERE lower(btrim(name)) = lower(btrim(p_target_branch_name))
  LIMIT 1;

  -- Find active debt for this branch relationship
  SELECT * INTO v_target_debt
  FROM public.branch_debts
  WHERE creditor_branch_id = p_branch_id
    AND (
      (v_target_branch_id IS NOT NULL AND debtor_branch_id = v_target_branch_id)
      OR lower(btrim(coalesce(target_branch_name, ''))) = lower(btrim(p_target_branch_name))
    )
    AND status IN ('open'::public.debt_status, 'partially_paid'::public.debt_status)
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_target_debt.id IS NOT NULL THEN
    IF v_target_debt.currency = 'USD' THEN
      v_inc_amount := coalesce(v_total_amount_usd, case when v_rate > 0 then round(v_total_amount / v_rate, 2) else 0 end);
    ELSE
      v_inc_amount := v_total_amount;
    END IF;

    IF v_inc_amount > 0 THEN
      UPDATE public.branch_debts
      SET amount = amount + v_inc_amount,
          notes = coalesce(notes, '') || E'\n+ ' || v_transfer_no || ' (+' || v_inc_amount || ' ' || v_target_debt.currency || ')',
          updated_at = now()
      WHERE id = v_target_debt.id;

      INSERT INTO public.branch_debt_transfers (
        debt_id, transfer_id, transfer_no, amount, amount_usd, currency, status, created_at
      ) VALUES (
        v_target_debt.id, v_transfer_id, v_transfer_no, v_inc_amount, v_total_amount_usd, v_target_debt.currency, 'added', now()
      );
    END IF;
  END IF;

  RETURN public.get_external_branch_transfer(v_transfer_id);
END;
$$;

-- 12. Update cancel_external_branch_transfer to safely deduct from debt if it was accumulated
CREATE OR REPLACE FUNCTION public.cancel_external_branch_transfer(
  p_transfer_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_transfer record;
  v_line record;
  v_returned_units integer := 0;
  v_debt_trf record;
BEGIN
  SELECT * INTO v_transfer
  FROM public.external_branch_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer topilmadi' USING errcode = 'P0002';
  END IF;

  IF v_transfer.status = 'cancelled' THEN
    RAISE EXCEPTION 'Bu transfer allaqachon bekor qilingan' USING errcode = '22023';
  END IF;

  -- Return inventory units to available
  FOR v_line IN 
    SELECT * FROM public.external_branch_transfer_lines 
    WHERE transfer_id = p_transfer_id 
  LOOP
    IF v_line.unit_ids IS NOT NULL AND cardinality(v_line.unit_ids) > 0 THEN
      UPDATE public.inventory_units
      SET status = 'available'::public.unit_status,
          external_transfer_id = NULL,
          updated_at = now()
      WHERE id = ANY(v_line.unit_ids);

      INSERT INTO public.inventory_movements (
        unit_id, product_id, batch_id, movement_type,
        from_location_id, to_location_id, quantity, unit_cost,
        reference_type, reference_id, reason, actor_id, metadata
      )
      SELECT
        u.id, u.product_id, u.batch_id, 'transfer_in'::public.movement_type,
        NULL, v_transfer.from_location_id, 1, v_line.unit_price,
        'external_branch_transfer_cancellation', p_transfer_id,
        'Transfer bekor qilindi (omborga qaytarildi): ' || coalesce(p_reason, 'Sotuvchi tomonidan'),
        auth.uid(),
        jsonb_build_object(
          'cancellation_reason', coalesce(p_reason, 'Bekor qilindi'),
          'transfer_no', v_transfer.transfer_no
        )
      FROM public.inventory_units u
      WHERE id = ANY(v_line.unit_ids);

      v_returned_units := v_returned_units + cardinality(v_line.unit_ids);
    END IF;
  END LOOP;

  -- Deduct from linked branch debt if accumulated
  FOR v_debt_trf IN
    SELECT * FROM public.branch_debt_transfers
    WHERE transfer_id = p_transfer_id AND status = 'added'
    FOR UPDATE
  LOOP
    UPDATE public.branch_debts
    SET amount = greatest(paid_amount, amount - v_debt_trf.amount),
        notes = coalesce(notes, '') || E'\n- Bekor qilindi: ' || v_transfer.transfer_no || ' (-' || v_debt_trf.amount || ' ' || v_debt_trf.currency || ')',
        updated_at = now()
    WHERE id = v_debt_trf.debt_id;

    UPDATE public.branch_debt_transfers
    SET status = 'cancelled'
    WHERE id = v_debt_trf.id;
  END LOOP;

  UPDATE public.external_branch_transfers
  SET status = 'cancelled',
      notes = coalesce(notes, '') || ' [BEKOR QILINDI: ' || coalesce(p_reason, 'Sababsiz') || ']',
      updated_at = now()
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object(
    'success', true,
    'transfer_id', p_transfer_id,
    'transfer_no', v_transfer.transfer_no,
    'status', 'cancelled',
    'returned_units_count', v_returned_units
  );
END;
$$;

-- 13. Grants on new & modified functions and tables
GRANT ALL ON TABLE public.branch_debts TO authenticated, service_role, anon;
GRANT ALL ON TABLE public.branch_debt_transfers TO authenticated, service_role, anon;
GRANT ALL ON TABLE public.debt_payments TO authenticated, service_role, anon;

GRANT EXECUTE ON FUNCTION public.register_branch_debt(uuid, uuid, text, numeric, text, text) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.confirm_branch_debt(uuid) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.list_branch_debts(uuid, text, public.debt_status, integer, integer) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.get_branch_debt_summary(uuid) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.get_branch_debt(uuid) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.record_branch_debt_payment(uuid, numeric, character, text, text, text, uuid) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.create_external_branch_transfer(uuid, uuid, text, text, text, text, jsonb) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.cancel_external_branch_transfer(uuid, text) TO authenticated, service_role, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
