-- Generic transfer/debt immutable trigger must not resolve table-specific record fields.
begin;
create or replace function public.guard_branch_transfer_data() returns trigger
language plpgsql set search_path='' as $$
declare v_old jsonb:=to_jsonb(old); v_new jsonb:=to_jsonb(new);
begin
  if tg_table_name='transfers' and (v_old->>'transfer_no' is distinct from v_new->>'transfer_no'
    or v_old->>'from_location_id' is distinct from v_new->>'from_location_id' or v_old->>'to_location_id' is distinct from v_new->>'to_location_id'
    or v_old->>'from_branch_id' is distinct from v_new->>'from_branch_id' or v_old->>'to_branch_id' is distinct from v_new->>'to_branch_id'
    or v_old->>'currency' is distinct from v_new->>'currency' or v_old->>'total_amount' is distinct from v_new->>'total_amount'
    or v_old->>'idempotency_key' is distinct from v_new->>'idempotency_key' or v_old->>'request_hash' is distinct from v_new->>'request_hash'
    or v_old->>'created_by' is distinct from v_new->>'created_by') then
    raise exception 'Transferning asosiy ma’lumotlarini o‘zgartirib bo‘lmaydi' using errcode='55000';
  elsif tg_table_name='transfer_lines' and (tg_op='DELETE' or v_old->>'transfer_id' is distinct from v_new->>'transfer_id'
    or v_old->>'product_id' is distinct from v_new->>'product_id' or v_old->>'unit_id' is distinct from v_new->>'unit_id'
    or v_old->>'quantity' is distinct from v_new->>'quantity' or v_old->>'unit_price' is distinct from v_new->>'unit_price') then
    raise exception 'Transfer qatorlari o‘zgarmas' using errcode='55000';
  elsif tg_table_name='branch_debts' and (v_old->>'debtor_branch_id' is distinct from v_new->>'debtor_branch_id'
    or v_old->>'creditor_branch_id' is distinct from v_new->>'creditor_branch_id' or v_old->>'transfer_id' is distinct from v_new->>'transfer_id'
    or v_old->>'amount' is distinct from v_new->>'amount' or v_old->>'currency' is distinct from v_new->>'currency') then
    raise exception 'Qarzning asosiy ma’lumotlarini o‘zgartirib bo‘lmaydi' using errcode='55000';
  end if;
  return coalesce(new,old);
end $$;
revoke all on function public.guard_branch_transfer_data() from public,anon,authenticated;
grant execute on function public.guard_branch_transfer_data() to service_role;
commit;
