-- Migration: Allow managers and accountants to access list_inventory_search_sellers
CREATE OR REPLACE FUNCTION public.list_inventory_search_sellers()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.role() <> 'service_role' AND current_user <> 'postgres' AND session_user <> 'postgres' AND NOT (
    public.has_role(array['superadmin','admin']::public.app_role[], null) OR
    public.is_any_manager() OR
    public.has_role(array['manager','accountant']::public.app_role[], null)
  ) THEN
    RAISE EXCEPTION 'Sotuvchi ma’lumotnomasi uchun admin yoki menejer roli talab qilinadi' USING errcode = '42501';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', p.id,
      'full_name', p.full_name,
      'branch_ids', coalesce((
        SELECT jsonb_agg(distinct r.branch_id)
        FROM public.profile_roles r
        WHERE r.profile_id = p.id
          AND r.role = 'seller'
          AND r.branch_id IS NOT NULL
      ), '[]'::jsonb)
    ) ORDER BY p.full_name, p.id)
    FROM public.profiles p
    WHERE p.is_active
      AND EXISTS (
        SELECT 1
        FROM public.profile_roles r
        WHERE r.profile_id = p.id
          AND r.role = 'seller'
      )
  ), '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_inventory_search_sellers() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_inventory_search_sellers() TO service_role;
