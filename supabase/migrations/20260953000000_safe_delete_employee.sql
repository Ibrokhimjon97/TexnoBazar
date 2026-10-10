-- Migration: Safe delete employee RPC
-- Allows superadmin to delete an employee cleanly via Supabase RPC

CREATE OR REPLACE FUNCTION delete_employee(p_employee_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
BEGIN
  -- Superadmin check
  IF v_caller_id IS NOT NULL AND NOT (
    public.has_role(array['superadmin']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Faqat superadmin xodimlarni o‘chira oladi.' USING errcode = '42501';
  END IF;

  -- Cannot delete yourself
  IF v_caller_id IS NOT NULL AND v_caller_id = p_employee_id THEN
    RAISE EXCEPTION 'O‘zingizning profilingizni o‘chira olmaysiz.';
  END IF;

  -- 1. Delete role assignments
  DELETE FROM public.profile_roles WHERE profile_id = p_employee_id;

  -- 2. Delete telegram chat links
  DELETE FROM public.telegram_chat_links WHERE profile_id = p_employee_id;

  -- 3. Deactivate profile
  UPDATE public.profiles SET is_active = false WHERE id = p_employee_id;

  -- 4. Try hard delete from profiles and auth.users if no foreign keys reference them
  BEGIN
    DELETE FROM public.profiles WHERE id = p_employee_id;
    DELETE FROM auth.users WHERE id = p_employee_id;
  EXCEPTION WHEN foreign_key_violation THEN
    -- If historical records (sales, transfers, etc.) exist, profile stays deactivated
    -- and auth user is banned so they can never log in
    UPDATE auth.users 
    SET banned_until = '2099-01-01 00:00:00+00' 
    WHERE id = p_employee_id;
  END;

  RETURN jsonb_build_object('success', true, 'message', 'Xodim muvaffaqiyatli o‘chirildi');
END;
$$;

GRANT EXECUTE ON FUNCTION delete_employee(uuid) TO authenticated, service_role, anon;
