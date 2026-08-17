-- Close payment-attempt ambiguity and attest exchange provider payouts only after confirmation.
begin;

-- Existing deployments may contain more than one unbound attempt. Never guess
-- between multiple provider-bound attempts: they require operator reconciliation.
do $$
begin
  if exists (
    select 1
    from public.payment_transactions
    where state in ('initiated', 'prepared', 'ambiguous') and provider_transaction_id is not null
    group by order_id, provider
    having count(*) > 1
  ) then
    raise exception 'Multiple provider-bound payment attempts require manual reconciliation before migration' using errcode = 'P0001';
  end if;
end $$;

-- Prefer the provider-bound/prepared attempt, then keep only the newest unbound
-- attempt before enforcing the invariant.
select set_config('texnobazar.payment_gateway', 'allowed', true);
with ranked as (
  select id, row_number() over(
    partition by order_id, provider
    order by (provider_transaction_id is not null) desc,
      case state when 'prepared' then 0 when 'ambiguous' then 1 else 2 end,
      created_at desc, id desc
  ) position
  from public.payment_transactions
  where state in ('initiated', 'prepared', 'ambiguous')
)
update public.payment_transactions t
set state = 'failed', last_error = 'Superseded by the active-attempt uniqueness migration.', updated_at = now()
from ranked r
where r.id = t.id and r.position > 1;
select set_config('texnobazar.payment_gateway', '', true);

create unique index if not exists payment_transactions_one_active_uidx
  on public.payment_transactions(order_id, provider)
  where state in ('initiated', 'prepared', 'ambiguous');

create or replace function public.create_online_payment_attempt(
  p_order_id uuid,
  p_provider text,
  p_checkout_token text,
  p_customer_user_id uuid,
  p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_o public.orders%rowtype;
  v_method text;
  v_tx public.payment_transactions%rowtype;
  v_minor bigint;
  v_hash text;
  v_token_hash text;
begin
  if p_provider not in ('click', 'payme') or p_idempotency_key is null then
    raise exception 'Provider yoki idempotency key noto‘g‘ri' using errcode = '22023';
  end if;
  select o.* into v_o from public.orders o where o.id = p_order_id for update;
  if not found then raise exception 'Buyurtma topilmadi' using errcode = 'P0002'; end if;
  select code into v_method from public.payment_methods where id = v_o.payment_method_id;
  v_token_hash := case when p_checkout_token is null then null else encode(extensions.digest(convert_to(p_checkout_token, 'UTF8'), 'sha256'), 'hex') end;
  if not (
    (v_o.customer_user_id is not null and v_o.customer_user_id = p_customer_user_id)
    or (v_o.checkout_token_hash is not null and v_o.checkout_token_hash = v_token_hash and v_o.checkout_token_expires_at > now())
  ) then raise exception 'Buyurtmaga kirish taqiqlangan' using errcode = '42501'; end if;
  if v_method <> p_provider or v_o.status in ('cancelled', 'returned', 'delivered') then
    raise exception 'Buyurtma online to‘lov uchun mos emas' using errcode = 'P0001';
  end if;

  v_minor := public.payment_amount_minor(v_o.total);
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'order_id', p_order_id, 'provider', p_provider, 'amount_minor', v_minor, 'currency', v_o.currency
  )::text, 'UTF8'), 'sha256'), 'hex');

  select * into v_tx
  from public.payment_transactions
  where order_id = p_order_id and provider = p_provider and idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_tx.request_hash <> v_hash then
      raise exception 'Payment idempotency key boshqa payload bilan ishlatilgan' using errcode = '22023';
    end if;
  else
    if exists(select 1 from public.payment_transactions where order_id = p_order_id and state = 'paid') then
      raise exception 'Buyurtma allaqachon to‘langan' using errcode = 'P0001';
    end if;
    select * into v_tx
    from public.payment_transactions
    where order_id = p_order_id and provider = p_provider and state in ('initiated', 'prepared', 'ambiguous')
    order by created_at desc, id desc
    limit 1 for update;
    if not found then
      insert into public.payment_transactions(order_id, provider, amount_minor, currency, idempotency_key, request_hash)
      values(p_order_id, p_provider, v_minor, v_o.currency, p_idempotency_key, v_hash)
      returning * into v_tx;
    elsif v_tx.request_hash <> v_hash or v_tx.amount_minor <> v_minor or v_tx.currency <> v_o.currency then
      raise exception 'Faol payment attempt buyurtma summasiga mos emas' using errcode = 'P0001';
    end if;
  end if;

  return jsonb_build_object(
    'transaction_id', v_tx.id, 'order_id', v_o.id, 'order_no', v_o.order_no,
    'provider', v_tx.provider, 'amount_minor', v_tx.amount_minor, 'amount', v_o.total,
    'currency', v_tx.currency, 'state', v_tx.state
  );
end $$;

create or replace function public.execute_sale_exchange(
  p_return_id uuid,
  p_replacement_pending_sale_id uuid,
  p_resell_location_id uuid,
  p_settlements jsonb default '[]'::jsonb,
  p_refund_settlement jsonb default null,
  p_idempotency_key uuid default gen_random_uuid()
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_r public.sale_returns%rowtype;
  v_p public.pos_pending_sales%rowtype;
  v_existing public.exchange_transactions%rowtype;
  v_sale uuid;
  v_credit numeric(18,2);
  v_due numeric(18,2);
  v_refund numeric(18,2);
  v_paid numeric(18,2);
  v_payments jsonb;
  v_id uuid := gen_random_uuid();
  v_hash text;
  v_refund_method text;
begin
  select * into v_r from public.sale_returns where id = p_return_id for update;
  if not found then raise exception 'Almashtirish topilmadi' using errcode = 'P0002'; end if;
  perform public.require_pos_manager(v_r.branch_id);
  if p_idempotency_key is null or jsonb_typeof(coalesce(p_settlements, '[]'::jsonb)) <> 'array'
    or (p_refund_settlement is not null and jsonb_typeof(p_refund_settlement) <> 'object') then
    raise exception 'Settlement ma’lumotlari noto‘g‘ri' using errcode = '22023';
  end if;
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'return_id', p_return_id, 'pending_sale_id', p_replacement_pending_sale_id,
    'location_id', p_resell_location_id, 'settlements', coalesce(p_settlements, '[]'::jsonb),
    'refund_settlement', p_refund_settlement
  )::text, 'UTF8'), 'sha256'), 'hex');
  select * into v_existing from public.exchange_transactions
  where branch_id = v_r.branch_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_hash <> v_hash then raise exception 'Takroriy kalit boshqa almashtirish uchun ishlatilgan' using errcode = '22023'; end if;
    return to_jsonb(v_existing);
  end if;

  select * into v_p from public.pos_pending_sales
  where id = p_replacement_pending_sale_id and branch_id = v_r.branch_id for update;
  if not found or v_r.kind <> 'exchange' or v_r.status <> 'approved' or v_p.status <> 'pending' or v_p.expires_at <= now() then
    raise exception 'Almashtirish yoki replacement POS so‘rovi tayyor emas' using errcode = 'P0001';
  end if;
  if v_p.customer_id is distinct from (select customer_id from public.sales where id = v_r.original_sale_id) then
    raise exception 'Replacement xaridori original sotuvga mos emas' using errcode = '22023';
  end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_settlements, '[]'::jsonb)) e where lower(e ->> 'method_code') = 'exchange_credit') then
    raise exception 'Ichki exchange kreditini qo‘lda yuborish mumkin emas' using errcode = '22023';
  end if;
  select coalesce(sum((e ->> 'amount')::numeric), 0) into v_paid
  from jsonb_array_elements(coalesce(p_settlements, '[]'::jsonb)) e;
  v_credit := least(v_r.refund_amount, v_p.total);
  v_due := greatest(v_p.total - v_r.refund_amount, 0);
  v_refund := greatest(v_r.refund_amount - v_p.total, 0);
  v_refund_method := p_refund_settlement ->> 'method_code';
  if v_paid <> v_due then raise exception 'Qo‘shimcha to‘lov almashtirish farqiga teng emas' using errcode = '22023'; end if;
  if v_refund > 0 and (
    p_refund_settlement is null
    or (p_refund_settlement ->> 'amount')::numeric is distinct from v_refund
    or coalesce(v_refund_method, '') not in ('cash', 'card', 'bank_transfer', 'click', 'payme')
    or (v_refund_method <> 'cash' and nullif(btrim(p_refund_settlement ->> 'external_reference'), '') is null)
  ) then raise exception 'Mijozga refund settlement to‘liq ko‘rsatilishi kerak' using errcode = '22023'; end if;
  if v_refund = 0 and p_refund_settlement is not null then
    raise exception 'Refund bo‘lmagan almashtirish payout qabul qilmaydi' using errcode = '22023';
  end if;
  if v_refund > 0 and v_refund_method in ('click', 'payme') and not exists (
    select 1
    from public.sale_payments sp
    join public.payment_methods pm on pm.id = sp.payment_method_id and pm.code = v_refund_method
    join public.payment_transactions pt on pt.sale_payment_id = sp.id
    where sp.sale_id = v_r.original_sale_id and sp.status in ('paid', 'partially_refunded')
  ) then raise exception 'Online refund uchun original provider payment ledgeri talab qilinadi' using errcode = 'P0001'; end if;

  v_payments := coalesce(p_settlements, '[]'::jsonb);
  if v_credit > 0 then
    v_payments := jsonb_build_array(jsonb_build_object('method_code', 'exchange_credit', 'amount', v_credit, 'external_reference', v_r.return_no)) || v_payments;
  end if;
  v_sale := public.manager_confirm_sale(v_p.id, v_payments);
  if v_sale is null then raise exception 'Replacement rezerv muddati tugagan' using errcode = 'P0001'; end if;
  perform set_config('texnobazar.exchange_refund_due', v_refund::text, true);
  perform set_config('texnobazar.exchange_refund_method', coalesce(v_refund_method, ''), true);
  perform public.complete_sale_return(v_r.id, p_resell_location_id, v_sale);
  perform set_config('texnobazar.exchange_refund_due', '', true);
  perform set_config('texnobazar.exchange_refund_method', '', true);

  insert into public.exchange_transactions(
    id, exchange_no, return_id, original_sale_id, replacement_pending_sale_id, replacement_sale_id,
    branch_id, return_credit, replacement_total, amount_due, refund_due, settlement_payload,
    idempotency_key, request_hash, created_by
  ) values (
    v_id, 'EXC-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || upper(substr(v_id::text, 1, 8)),
    v_r.id, v_r.original_sale_id, v_p.id, v_sale, v_r.branch_id, v_r.refund_amount, v_p.total,
    v_due, v_refund, coalesce(p_settlements, '[]'::jsonb), p_idempotency_key, v_hash, auth.uid()
  ) returning * into v_existing;

  -- Cash/card/bank transfer are synchronously attested by the manager. Click/Payme
  -- are inserted by confirm_payment_refund only after the provider confirms reversal.
  if v_refund > 0 and v_refund_method not in ('click', 'payme') then
    insert into public.exchange_refund_disbursements(exchange_id, amount, method_code, external_reference, created_by)
    values(v_id, v_refund, v_refund_method, nullif(btrim(p_refund_settlement ->> 'external_reference'), ''), auth.uid());
  end if;
  return to_jsonb(v_existing);
end $$;

create or replace function public.confirm_payment_refund(
  p_refund_id uuid,
  p_provider_refund_id text,
  p_response_hash text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_r public.payment_refund_transactions%rowtype;
  v_payment public.sale_payments%rowtype;
  v_tx public.payment_transactions%rowtype;
  v_confirmed bigint;
  v_payment_fully_refunded boolean;
  v_exchange public.exchange_transactions%rowtype;
  v_exchange_confirmed bigint;
  v_provider_reference text;
begin
  select * into v_r from public.payment_refund_transactions where id = p_refund_id for update;
  if not found then raise exception 'Provider refund topilmadi' using errcode = 'P0002'; end if;
  if v_r.state = 'confirmed' then return; end if;
  select * into v_payment from public.sale_payments where id = v_r.sale_payment_id for update;
  select * into v_tx from public.payment_transactions where id = v_r.payment_transaction_id for update;
  v_provider_reference := coalesce(nullif(p_provider_refund_id, ''), nullif(v_r.provider_refund_id, ''));

  select et.* into v_exchange
  from public.exchange_transactions et
  join public.sale_refunds sr on sr.return_id = et.return_id
  where sr.id = v_r.sale_refund_id
  for update of et;
  if found and v_provider_reference is null then
    raise exception 'Exchange provider refund reference talab qilinadi' using errcode = '22023';
  end if;

  update public.payment_refund_transactions
  set state = 'confirmed', provider_refund_id = coalesce(provider_refund_id, v_provider_reference),
      provider_response_hash = p_response_hash, confirmed_at = now(), lock_token = null,
      locked_until = null, last_error = null, updated_at = now()
  where id = v_r.id;

  select coalesce(sum(amount_minor), 0) into v_confirmed
  from public.payment_refund_transactions
  where sale_payment_id = v_payment.id and state = 'confirmed';
  v_payment_fully_refunded := v_confirmed >= public.payment_amount_minor(v_payment.amount);
  perform set_config('texnobazar.complete_sale_return', 'allowed', true);
  update public.sale_payments
  set status = case when v_payment_fully_refunded then 'refunded'::public.payment_status else 'partially_refunded'::public.payment_status end
  where id = v_payment.id;
  perform set_config('texnobazar.complete_sale_return', '', true);

  if v_payment_fully_refunded and v_r.provider = 'click' and v_tx.state in ('paid', 'cancelled_after_paid') then
    perform set_config('texnobazar.payment_gateway', 'allowed', true);
    update public.payment_transactions
    set state = 'refunded', cancelled_at = coalesce(cancelled_at, now()), updated_at = now()
    where id = v_tx.id;
    perform set_config('texnobazar.payment_gateway', '', true);
  end if;
  update public.orders o
  set payment_status = case
    when exists(select 1 from public.sale_payments sp where sp.sale_id = v_payment.sale_id and sp.status <> 'refunded')
      then 'partially_refunded'::public.payment_status
    else 'refunded'::public.payment_status
  end
  from public.sales s where s.id = v_payment.sale_id and o.id = s.order_id;

  if v_exchange.id is not null then
    select coalesce(sum(pr.amount_minor), 0) into v_exchange_confirmed
    from public.payment_refund_transactions pr
    join public.sale_refunds sr on sr.id = pr.sale_refund_id
    where sr.return_id = v_exchange.return_id and pr.state = 'confirmed';
    if v_exchange_confirmed > public.payment_amount_minor(v_exchange.refund_due) then
      raise exception 'Exchange provider refund tasdiqlari refund due summasidan oshdi' using errcode = 'P0001';
    end if;
    if v_exchange_confirmed = public.payment_amount_minor(v_exchange.refund_due) then
      insert into public.exchange_refund_disbursements(exchange_id, amount, method_code, external_reference, created_by)
      values(v_exchange.id, v_exchange.refund_due, v_r.provider, v_provider_reference, v_exchange.created_by)
      on conflict(exchange_id) do nothing;
    end if;
  end if;
end $$;

revoke all on function public.create_online_payment_attempt(uuid,text,text,uuid,uuid),
  public.execute_sale_exchange(uuid,uuid,uuid,jsonb,jsonb,uuid),
  public.confirm_payment_refund(uuid,text,text)
from public, anon, authenticated;
grant execute on function public.create_online_payment_attempt(uuid,text,text,uuid,uuid),
  public.confirm_payment_refund(uuid,text,text) to service_role;
grant execute on function public.execute_sale_exchange(uuid,uuid,uuid,jsonb,jsonb,uuid) to authenticated, service_role;

create or replace function public.payment_runtime_hardening_version()
returns text language sql immutable set search_path = '' as $$ select '20260822000000'::text $$;
revoke all on function public.payment_runtime_hardening_version() from public, anon, authenticated;
grant execute on function public.payment_runtime_hardening_version() to service_role;

commit;
