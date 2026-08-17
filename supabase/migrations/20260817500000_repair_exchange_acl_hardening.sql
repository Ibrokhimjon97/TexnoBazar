begin;

-- Internal helpers are invoked only from SECURITY DEFINER workflow RPCs.
-- Revoke any legacy/direct authenticated grants before restoring the public API grants.
revoke all on function
  public.ensure_branch_repair_location(uuid),
  public.compute_business_correction_snapshot(uuid,uuid,text,jsonb)
from public, anon, authenticated;

grant execute on function
  public.ensure_branch_repair_location(uuid),
  public.compute_business_correction_snapshot(uuid,uuid,text,jsonb)
to service_role;

commit;
