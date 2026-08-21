-- Allow any authenticated user to insert new suppliers (from receipt modal)
-- Since direct INSERT is blocked by the existing admin_all policy's WITH CHECK,
-- we use a SECURITY DEFINER function to bypass RLS for this specific operation.

create or replace function public.create_supplier_quick(p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Autentifikatsiya talab qilinadi' using errcode = '42501'; end if;
  if nullif(btrim(p_name), '') is null then raise exception 'Ta''minotchi nomi talab qilinadi' using errcode = '22023'; end if;
  
  v_code := upper(regexp_replace(btrim(p_name), '[^A-Za-z0-9]+', '-', 'g'));
  v_code := left(v_code, 20) || '-' || upper(substr(gen_random_uuid()::text, 1, 4));
  
  insert into public.suppliers (code, name, is_active)
  values (v_code, btrim(p_name), true)
  returning id into v_id;
  
  return jsonb_build_object('id', v_id, 'code', v_code, 'name', btrim(p_name));
end; $$;

grant execute on function public.create_supplier_quick(text) to authenticated;
