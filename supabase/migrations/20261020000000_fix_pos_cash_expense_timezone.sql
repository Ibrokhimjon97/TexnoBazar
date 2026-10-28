-- Migration: Fix timezone offset in add_pos_cash_expense and repair corrupted expense timestamps

CREATE OR REPLACE FUNCTION public.add_pos_cash_expense(
  p_branch_id uuid,
  p_amount numeric,
  p_note text,
  p_category text DEFAULT 'other',
  p_date date DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_manager boolean;
  v_title text;
  v_cat text;
  v_period text;
  v_paid_at timestamptz;
  v_row record;
  v_date date;
  v_today_tashkent date;
BEGIN
  IF p_branch_id IS NULL THEN
    RAISE EXCEPTION 'Filial tanlanmagan' USING errcode = '22023';
  END IF;

  v_manager := public.has_role(array['superadmin','admin']::public.app_role[], null)
    OR public.has_role(array['manager']::public.app_role[], p_branch_id);

  IF NOT v_manager THEN
    RAISE EXCEPTION 'Faqat menejer yoki admin xarajat kiritishi mumkin' USING errcode = '42501';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Xarajat summasi 0 dan katta bo‘lishi kerak' USING errcode = '22023';
  END IF;

  v_today_tashkent := (now() AT TIME ZONE 'Asia/Tashkent')::date;
  v_date := coalesce(p_date, v_today_tashkent);
  v_period := to_char(v_date, 'YYYY-MM');

  -- Ensure category is in allowed check constraint
  IF p_category IN ('tax','rent','electricity','water','gas','llc','sole_trader','salary','transport','other') THEN
    v_cat := p_category;
  ELSE
    v_cat := 'other';
  END IF;

  -- Title must be between 2 and 300 chars for check constraint
  v_title := coalesce(nullif(btrim(p_note), ''), 'Kassa xarajati');
  IF length(v_title) < 2 THEN
    v_title := 'Kassa xarajati';
  ELSIF length(v_title) > 280 THEN
    v_title := substr(v_title, 1, 280);
  END IF;

  -- Correct timezone handling:
  -- If p_date matches today in Tashkent, use exact current timestamp now()
  -- If p_date is specified as a different day, interpret that date + current time as Asia/Tashkent wall-clock time
  IF p_date IS NOT NULL THEN
    IF p_date = v_today_tashkent THEN
      v_paid_at := now();
    ELSE
      v_paid_at := ((p_date::text || ' ' || to_char(now() AT TIME ZONE 'Asia/Tashkent', 'HH24:MI:SS'))::timestamp AT TIME ZONE 'Asia/Tashkent');
    END IF;
  ELSE
    v_paid_at := now();
  END IF;

  INSERT INTO public.expenses (
    branch_id,
    category,
    title,
    amount,
    paid_amount,
    currency,
    period_month,
    paid_at,
    note,
    created_by,
    created_at,
    updated_at
  ) VALUES (
    p_branch_id,
    v_cat,
    v_title,
    p_amount,
    p_amount,
    'UZS',
    v_period,
    v_paid_at,
    nullif(btrim(p_note), ''),
    auth.uid(),
    now(),
    now()
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'branch_id', v_row.branch_id,
    'amount', v_row.amount,
    'title', v_row.title,
    'note', v_row.note,
    'category', v_row.category,
    'paid_at', v_row.paid_at,
    'created_at', v_row.created_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_pos_cash_expense(uuid, numeric, text, text, date) TO authenticated, service_role;

-- Delete the 2 duplicate Vimax entries created when user retried thinking it wasn't saving
DELETE FROM public.expenses
WHERE id IN (
  'b390cedc-cb45-48dc-849a-9ebc29d46ea9'::uuid,
  'e9077823-b472-418f-9a47-943ad6339d11'::uuid
);

-- Repair paid_at for all expenses created today that suffered from timezone drift
UPDATE public.expenses
SET paid_at = created_at
WHERE paid_at > created_at
  AND (created_at AT TIME ZONE 'Asia/Tashkent')::date = '2026-10-24';
