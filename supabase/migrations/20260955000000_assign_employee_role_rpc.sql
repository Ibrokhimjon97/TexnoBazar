-- Migration: assign_employee_role RPC for seamless employee creation from frontend
CREATE OR REPLACE FUNCTION assign_employee_role(
  p_user_id uuid,
  p_role text,
  p_branch_id uuid,
  p_full_name text DEFAULT NULL,
  p_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_role public.app_role;
BEGIN
  -- Superadmin check
  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat superadmin xodimlarga rol biriktira oladi.' USING errcode = '42501';
  END IF;

  v_role := p_role::public.app_role;

  -- 1. Ensure profile exists and is updated
  INSERT INTO public.profiles (id, full_name, phone, is_active)
  VALUES (p_user_id, trim(p_full_name), trim(p_phone), true)
  ON CONFLICT (id) DO UPDATE SET
    full_name = coalesce(nullif(trim(p_full_name), ''), profiles.full_name),
    phone = coalesce(nullif(trim(p_phone), ''), profiles.phone),
    is_active = true;

  -- 2. Assign role
  DELETE FROM public.profile_roles WHERE profile_id = p_user_id;
  INSERT INTO public.profile_roles (profile_id, role, branch_id, created_by)
  VALUES (p_user_id, v_role, p_branch_id, v_caller_id);

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id);
END;
$$;

GRANT EXECUTE ON FUNCTION assign_employee_role(uuid, text, uuid, text, text) TO authenticated, service_role, anon;

NOTIFY pgrst, 'reload schema';
