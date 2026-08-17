begin;

-- Close omitted/default EXECUTE grants while preserving the authenticated report API.
revoke all on function
  public.report_sales_rows(date,date,uuid),
  public.report_profit_loss(date,date,uuid),
  public.guard_receipt_delivery_outbox()
from public, anon, authenticated;

grant execute on function
  public.report_sales_rows(date,date,uuid),
  public.report_profit_loss(date,date,uuid)
to authenticated;

grant execute on function
  public.report_sales_rows(date,date,uuid),
  public.report_profit_loss(date,date,uuid),
  public.guard_receipt_delivery_outbox()
to service_role;

commit;
