-- Migration: Fix branches_code_check constraint and extend get_external_transfer_references
-- 1. Relaxes branches_code_check so that branch creation with Uzbek/Cyrillic names or custom codes doesn't throw constraint violations
-- 2. Enhances get_external_transfer_references to include active branches and managers list for easy selection in branch transfers

BEGIN;

-- 1. Relax branches_code_check constraint
ALTER TABLE public.branches DROP CONSTRAINT IF EXISTS branches_code_check;

ALTER TABLE public.branches 
  ADD CONSTRAINT branches_code_check 
  CHECK (length(btrim(code)) >= 2 AND length(btrim(code)) <= 64);

-- Trigger to sanitize and ensure code is clean and trimmed
CREATE OR REPLACE FUNCTION public.clean_branch_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.code := btrim(coalesce(NEW.code, ''));
  -- If code is missing or too short, generate a safe unique code
  IF length(NEW.code) < 2 THEN
    NEW.code := 'BR-' || upper(substr(gen_random_uuid()::text, 1, 6));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clean_branch_code ON public.branches;
CREATE TRIGGER trg_clean_branch_code
BEFORE INSERT OR UPDATE OF code ON public.branches
FOR EACH ROW EXECUTE FUNCTION public.clean_branch_code();

-- 2. Update get_external_transfer_references to include branches and managers
CREATE OR REPLACE FUNCTION public.get_external_transfer_references(p_branch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rate numeric;
  v_rate_date date;
BEGIN
  SELECT rate, rate_date INTO v_rate, v_rate_date
  FROM public.exchange_rates
  WHERE currency_from = 'USD' AND currency_to = 'UZS'
  ORDER BY rate_date DESC LIMIT 1;

  IF v_rate IS NULL OR v_rate <= 0 THEN
    v_rate := 11850;
    v_rate_date := current_date;
  END IF;

  RETURN jsonb_build_object(
    'branch_id', p_branch_id,
    'locations', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'code', code, 'type', type) ORDER BY type, name)
      FROM public.locations
      WHERE branch_id = p_branch_id AND is_active AND type IN ('store', 'warehouse')
    ), '[]'::jsonb),
    'exchange_rate', v_rate,
    'exchange_rate_date', v_rate_date,
    'branches', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', b.id,
          'name', b.name,
          'code', b.code,
          'manager_name', coalesce((
            SELECT p.full_name
            FROM public.profile_roles pr
            JOIN public.profiles p ON p.id = pr.profile_id
            WHERE pr.branch_id = b.id AND pr.role = 'manager' AND p.is_active
            ORDER BY pr.created_at DESC LIMIT 1
          ), (
            SELECT p.full_name
            FROM public.profile_roles pr
            JOIN public.profiles p ON p.id = pr.profile_id
            WHERE pr.branch_id = b.id AND p.is_active
            ORDER BY pr.created_at DESC LIMIT 1
          ), ''),
          'manager_phone', coalesce((
            SELECT p.phone
            FROM public.profile_roles pr
            JOIN public.profiles p ON p.id = pr.profile_id
            WHERE pr.branch_id = b.id AND pr.role = 'manager' AND p.is_active
            ORDER BY pr.created_at DESC LIMIT 1
          ), '')
        ) ORDER BY b.name
      )
      FROM public.branches b
      WHERE b.is_active
    ), '[]'::jsonb),
    'managers', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'profile_id', p.id,
          'full_name', p.full_name,
          'phone', p.phone,
          'branch_id', pr.branch_id,
          'branch_name', coalesce(b.name, '')
        ) ORDER BY p.full_name
      )
      FROM public.profile_roles pr
      JOIN public.profiles p ON p.id = pr.profile_id
      LEFT JOIN public.branches b ON b.id = pr.branch_id
      WHERE pr.role = 'manager' AND p.is_active
    ), '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_external_transfer_references(uuid) TO authenticated, service_role, anon;

COMMIT;
