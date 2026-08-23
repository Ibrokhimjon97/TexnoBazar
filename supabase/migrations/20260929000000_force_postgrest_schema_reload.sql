-- Force PostgREST to see schema changes by altering function comment
-- This is a workaround for PostgREST schema cache not refreshing reliably

COMMENT ON FUNCTION public.courier_update_delivery_status(uuid, delivery_status, text, uuid) 
IS 'Updates delivery status with note and optional proof. Parameters: p_delivery_id (uuid), p_status (delivery_status), p_note (text, optional), p_proof_id (uuid, optional)';

-- Send multiple notify signals
SELECT pg_notify('pgrst', 'reload schema');
SELECT pg_notify('pgrst', 'reload config');

-- Verify function exists and is callable
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = 'courier_update_delivery_status'
    AND n.nspname = 'public'
    AND pg_get_function_arguments(p.oid) = 'p_delivery_id uuid, p_status delivery_status, p_note text DEFAULT NULL::text, p_proof_id uuid DEFAULT NULL::uuid'
  ) THEN
    RAISE EXCEPTION 'courier_update_delivery_status function with correct signature not found';
  END IF;
  
  RAISE NOTICE 'courier_update_delivery_status verified successfully';
END $$;
