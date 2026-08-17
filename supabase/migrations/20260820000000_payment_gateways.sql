begin;

-- Provider secrets remain in server-only environment variables. Public tables only
-- retain immutable identifiers, hashes and state needed for reconciliation.
alter table public.orders
  add column if not exists currency char(3) not null default 'UZS' check(currency ~ '^[A-Z]{3}$'),
  add column if not exists checkout_token_hash text,
  add column if not exists checkout_token_expires_at timestamptz,
  add column if not exists paid_at timestamptz;
insert into public.payment_methods(code,name,is_cash,is_online,is_active,sort_order)
values('cod','Yetkazib berishda to‘lov',true,false,true,50)
on conflict(code) do update set name=excluded.name,is_cash=true,is_online=false;
create index if not exists orders_checkout_token_hash_idx on public.orders(checkout_token_hash) where checkout_token_hash is not null;

create table public.payment_transactions(
  id uuid primary key default gen_random_uuid(),
  merchant_sequence bigint generated always as identity unique,
  order_id uuid not null references public.orders(id) on delete restrict,
  provider text not null check(provider in('click','payme')),
  amount_minor bigint not null check(amount_minor>0),
  currency char(3) not null default 'UZS' check(currency ~ '^[A-Z]{3}$'),
  state text not null default 'initiated' check(state in('initiated','prepared','paid','cancelled','cancelled_after_paid','refunded','failed','ambiguous')),
  idempotency_key uuid not null,
  request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  provider_transaction_id text,
  provider_payment_id text,
  provider_prepare_id text,
  provider_time_ms bigint,
  prepared_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason integer,
  sale_payment_id uuid unique references public.sale_payments(id) on delete restrict,
  last_error text,
  metadata jsonb not null default '{}'::jsonb check(jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(order_id,provider,idempotency_key)
);
create unique index payment_transactions_provider_tx_uidx on public.payment_transactions(provider,provider_transaction_id) where provider_transaction_id is not null;
create unique index payment_transactions_order_paid_uidx on public.payment_transactions(order_id) where state='paid';
create index payment_transactions_order_time_idx on public.payment_transactions(order_id,created_at desc);
create index payment_transactions_statement_idx on public.payment_transactions(provider,provider_time_ms) where provider_time_ms is not null;

create table public.payment_webhook_events(
  id uuid primary key default gen_random_uuid(),
  provider text not null check(provider in('click','payme')),
  event_key text not null,
  request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  method text not null,
  transaction_id uuid references public.payment_transactions(id) on delete restrict,
  response jsonb not null check(jsonb_typeof(response)='object'),
  received_at timestamptz not null default now(),
  unique(provider,event_key),
  unique(provider,request_hash)
);
create index payment_webhook_events_transaction_idx on public.payment_webhook_events(transaction_id,received_at desc);

create table public.payment_refund_transactions(
  id uuid primary key default gen_random_uuid(),
  sale_refund_id uuid not null references public.sale_refunds(id) on delete restrict,
  payment_transaction_id uuid not null references public.payment_transactions(id) on delete restrict,
  sale_payment_id uuid not null references public.sale_payments(id) on delete restrict,
  provider text not null check(provider in('click','payme')),
  amount_minor bigint not null check(amount_minor>0),
  currency char(3) not null default 'UZS' check(currency ~ '^[A-Z]{3}$'),
  state text not null default 'pending' check(state in('pending','awaiting_provider','processing','confirmed','failed','ambiguous')),
  idempotency_key uuid not null unique,
  provider_refund_id text,
  provider_response_hash text,
  attempt_count integer not null default 0 check(attempt_count>=0),
  next_attempt_at timestamptz not null default now(),
  lock_token uuid,
  locked_until timestamptz,
  last_error text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(sale_refund_id,payment_transaction_id)
);
create unique index payment_refunds_provider_id_uidx on public.payment_refund_transactions(provider,provider_refund_id) where provider_refund_id is not null;
create index payment_refunds_queue_idx on public.payment_refund_transactions(provider,state,next_attempt_at) where state in('pending','processing');

create or replace function public.guard_payment_transaction_update()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or current_setting('texnobazar.payment_gateway',true) is distinct from 'allowed'
    or old.id is distinct from new.id or old.merchant_sequence is distinct from new.merchant_sequence
    or old.order_id is distinct from new.order_id or old.provider is distinct from new.provider
    or old.amount_minor is distinct from new.amount_minor or old.currency is distinct from new.currency
    or old.idempotency_key is distinct from new.idempotency_key or old.request_hash is distinct from new.request_hash
    or old.created_at is distinct from new.created_at
    or (old.provider_transaction_id is not null and old.provider_transaction_id is distinct from new.provider_transaction_id)
    or (old.provider_payment_id is not null and old.provider_payment_id is distinct from new.provider_payment_id)
    or (old.provider_prepare_id is not null and old.provider_prepare_id is distinct from new.provider_prepare_id)
    or (old.sale_payment_id is not null and old.sale_payment_id is distinct from new.sale_payment_id)
    or not((old.state='initiated' and new.state in('initiated','prepared','paid','cancelled','failed','ambiguous'))
      or (old.state='prepared' and new.state in('prepared','paid','cancelled','failed','ambiguous'))
      or (old.state='ambiguous' and new.state in('ambiguous','prepared','paid','cancelled','failed'))
      or (old.state='paid' and new.state in('paid','cancelled_after_paid','refunded'))
      or (old.state='cancelled_after_paid' and new.state in('cancelled_after_paid','refunded'))
      or old.state=new.state) then
    raise exception 'Payment transaction mutatsiyasi taqiqlangan' using errcode='55000';
  end if;
  return new;
end $$;
create trigger payment_transactions_guard before update or delete on public.payment_transactions for each row execute function public.guard_payment_transaction_update();
create trigger payment_webhook_events_immutable before update or delete on public.payment_webhook_events for each row execute function public.reject_mutation();
create trigger payment_refunds_immutable_delete before delete on public.payment_refund_transactions for each row execute function public.reject_mutation();
create trigger payment_transactions_audit after insert or update on public.payment_transactions for each row execute function public.audit_row_change();
create trigger payment_refunds_audit after insert or update on public.payment_refund_transactions for each row execute function public.audit_row_change();

create or replace function public.payment_amount_minor(p_amount numeric)
returns bigint language sql immutable strict set search_path='' as $$
  select round(p_amount*100)::bigint;
$$;

create or replace function public.payment_record_webhook_response(p_provider text,p_event_key text,p_request_hash text,p_method text,p_response jsonb,p_transaction_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_existing public.payment_webhook_events%rowtype;
begin
  select * into v_existing from public.payment_webhook_events where provider=p_provider and event_key=p_event_key;
  if found then
    if v_existing.request_hash<>p_request_hash then raise exception 'Webhook replay payload mismatch' using errcode='22023'; end if;
    return v_existing.response;
  end if;
  insert into public.payment_webhook_events(provider,event_key,request_hash,method,response,transaction_id)
  values(p_provider,p_event_key,p_request_hash,p_method,p_response,p_transaction_id)
  on conflict(provider,request_hash) do nothing;
  select * into v_existing from public.payment_webhook_events where provider=p_provider and request_hash=p_request_hash;
  return coalesce(v_existing.response,p_response);
end $$;

create or replace function public.create_online_order_v2(p_customer jsonb,p_shipping_address jsonb,p_lines jsonb,p_payment_method_code text,p_idempotency_key text,p_checkout_token text,p_notes text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_order_id uuid; v_order public.orders%rowtype; v_hash text;
begin
  if p_checkout_token is null or p_checkout_token !~ '^[a-f0-9]{64}$' then raise exception 'Checkout token 256-bit hex bo‘lishi kerak' using errcode='22023'; end if;
  if lower(btrim(p_payment_method_code)) not in('click','payme','cod') then raise exception 'Storefront to‘lov usuli qo‘llab-quvvatlanmaydi' using errcode='22023'; end if;
  v_order_id=public.create_online_order(p_customer,p_shipping_address,p_lines,p_payment_method_code,p_idempotency_key,p_notes);
  v_hash=encode(extensions.digest(convert_to(p_checkout_token,'UTF8'),'sha256'),'hex');
  select * into v_order from public.orders where id=v_order_id for update;
  if v_order.checkout_token_hash is null then
    update public.orders set checkout_token_hash=v_hash,checkout_token_expires_at=now()+interval '48 hours' where id=v_order_id;
  elsif v_order.checkout_token_hash<>v_hash then
    raise exception 'Idempotent buyurtma boshqa checkout tokenga bog‘langan' using errcode='22023';
  end if;
  return jsonb_build_object('order_id',v_order_id,'checkout_token',p_checkout_token,'payment_status',v_order.payment_status);
end $$;

create or replace function public.storefront_payment_methods(p_click_enabled boolean,p_payme_enabled boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('code',m.code,'name',m.name,'is_online',m.is_online,'is_cash',m.is_cash) order by m.sort_order,m.code),'[]'::jsonb)
  from public.payment_methods m where m.is_active and (
    (m.code='click' and coalesce(p_click_enabled,false)) or
    (m.code='payme' and coalesce(p_payme_enabled,false)) or m.code='cod');
$$;

create or replace function public.create_online_payment_attempt(p_order_id uuid,p_provider text,p_checkout_token text,p_customer_user_id uuid,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_o public.orders%rowtype; v_method text; v_tx public.payment_transactions%rowtype; v_minor bigint; v_hash text; v_token_hash text;
begin
  if p_provider not in('click','payme') or p_idempotency_key is null then raise exception 'Provider yoki idempotency key noto‘g‘ri' using errcode='22023'; end if;
  select o.* into v_o from public.orders o where o.id=p_order_id for update;
  if not found then raise exception 'Buyurtma topilmadi' using errcode='P0002'; end if;
  select code into v_method from public.payment_methods where id=v_o.payment_method_id;
  v_token_hash=case when p_checkout_token is null then null else encode(extensions.digest(convert_to(p_checkout_token,'UTF8'),'sha256'),'hex') end;
  if not((v_o.customer_user_id is not null and v_o.customer_user_id=p_customer_user_id) or
    (v_o.checkout_token_hash is not null and v_o.checkout_token_hash=v_token_hash and v_o.checkout_token_expires_at>now())) then
    raise exception 'Buyurtmaga kirish taqiqlangan' using errcode='42501';
  end if;
  if v_method<>p_provider or v_o.status in('cancelled','returned','delivered') then raise exception 'Buyurtma online to‘lov uchun mos emas' using errcode='P0001'; end if;
  v_minor=public.payment_amount_minor(v_o.total);
  v_hash=encode(extensions.digest(convert_to(jsonb_build_object('order_id',p_order_id,'provider',p_provider,'amount_minor',v_minor,'currency',v_o.currency)::text,'UTF8'),'sha256'),'hex');
  select * into v_tx from public.payment_transactions where order_id=p_order_id and provider=p_provider and idempotency_key=p_idempotency_key;
  if found then
    if v_tx.request_hash<>v_hash then raise exception 'Payment idempotency key boshqa payload bilan ishlatilgan' using errcode='22023'; end if;
  else
    if exists(select 1 from public.payment_transactions where order_id=p_order_id and state='paid') then raise exception 'Buyurtma allaqachon to‘langan' using errcode='P0001'; end if;
    insert into public.payment_transactions(order_id,provider,amount_minor,currency,idempotency_key,request_hash)
    values(p_order_id,p_provider,v_minor,v_o.currency,p_idempotency_key,v_hash) returning * into v_tx;
  end if;
  return jsonb_build_object('transaction_id',v_tx.id,'order_id',v_o.id,'order_no',v_o.order_no,'provider',v_tx.provider,
    'amount_minor',v_tx.amount_minor,'amount',v_o.total,'currency',v_tx.currency,'state',v_tx.state);
end $$;

create or replace function public.get_online_payment_status(p_order_id uuid,p_checkout_token text,p_customer_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_o public.orders%rowtype; v_tx public.payment_transactions%rowtype; v_token_hash text;
begin
  select * into v_o from public.orders where id=p_order_id;
  if not found then raise exception 'Buyurtma topilmadi' using errcode='P0002'; end if;
  v_token_hash=case when p_checkout_token is null then null else encode(extensions.digest(convert_to(p_checkout_token,'UTF8'),'sha256'),'hex') end;
  if not((v_o.customer_user_id is not null and v_o.customer_user_id=p_customer_user_id) or
    (v_o.checkout_token_hash is not null and v_o.checkout_token_hash=v_token_hash and v_o.checkout_token_expires_at>now())) then
    raise exception 'Buyurtmaga kirish taqiqlangan' using errcode='42501';
  end if;
  select * into v_tx from public.payment_transactions where order_id=p_order_id order by created_at desc limit 1;
  return jsonb_build_object('order_id',v_o.id,'order_no',v_o.order_no,'order_status',v_o.status,'payment_status',v_o.payment_status,
    'provider',v_tx.provider,'state',coalesce(v_tx.state,case when v_o.payment_status='paid' then 'paid' else 'pending' end),
    'paid_at',coalesce(v_tx.paid_at,v_o.paid_at),'updated_at',coalesce(v_tx.updated_at,v_o.updated_at));
end $$;

create or replace function public.click_process_callback(p_click_trans_id text,p_click_paydoc_id text,p_order_id uuid,p_merchant_prepare_id text,p_amount_minor bigint,p_action integer,p_provider_error integer,p_sign_time text,p_request_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_event_key text:=p_click_trans_id||':'||p_action; v_existing public.payment_webhook_events%rowtype; v_o public.orders%rowtype; v_tx public.payment_transactions%rowtype; v_method text; v_response jsonb; v_error integer:=0; v_note text:='Success';
begin
  select * into v_existing from public.payment_webhook_events where provider='click' and event_key=v_event_key;
  if found then
    if v_existing.request_hash<>p_request_hash then
      return jsonb_build_object('click_trans_id',p_click_trans_id,'merchant_trans_id',p_order_id,'merchant_prepare_id',coalesce(p_merchant_prepare_id,'0'),'merchant_confirm_id',coalesce(p_merchant_prepare_id,'0'),'error',-8,'error_note','Replay payload mismatch');
    end if;
    return v_existing.response;
  end if;
  select o.* into v_o from public.orders o where o.id=p_order_id for update;
  if not found then v_error=-5;v_note='User does not exist';
  else
    select code into v_method from public.payment_methods where id=v_o.payment_method_id;
    if v_method<>'click' then v_error=-5;v_note='User does not exist';
    elsif public.payment_amount_minor(v_o.total)<>p_amount_minor then v_error=-2;v_note='Incorrect parameter amount'; end if;
  end if;
  if v_error=0 and p_action=0 then
    select * into v_tx from public.payment_transactions where provider='click' and provider_transaction_id=p_click_trans_id for update;
    if found then
      if v_tx.order_id<>p_order_id or v_tx.amount_minor<>p_amount_minor then v_error=-8;v_note='Transaction mismatch';
      elsif v_tx.state='paid' then v_error=-4;v_note='Already paid';
      elsif v_tx.state in('cancelled','cancelled_after_paid','failed') then v_error=-9;v_note='Transaction cancelled'; end if;
    else
      select * into v_tx from public.payment_transactions where order_id=p_order_id and provider='click' and state in('initiated','ambiguous') order by created_at desc limit 1 for update;
      if not found then v_error=-5;v_note='Payment attempt does not exist';
      else
        perform set_config('texnobazar.payment_gateway','allowed',true);
        update public.payment_transactions set provider_transaction_id=p_click_trans_id,provider_payment_id=p_click_paydoc_id,
          provider_prepare_id=merchant_sequence::text,state='prepared',prepared_at=coalesce(prepared_at,now()),updated_at=now(),
          metadata=metadata||jsonb_build_object('click_sign_time',p_sign_time) where id=v_tx.id returning * into v_tx;
        perform set_config('texnobazar.payment_gateway','',true);
      end if;
    end if;
  elsif v_error=0 and p_action=1 then
    select * into v_tx from public.payment_transactions where provider='click' and provider_transaction_id=p_click_trans_id and provider_prepare_id=p_merchant_prepare_id for update;
    if not found then v_error=-6;v_note='Transaction does not exist';
    elsif v_tx.order_id<>p_order_id or v_tx.amount_minor<>p_amount_minor then v_error=-8;v_note='Transaction mismatch';
    elsif p_provider_error<0 then
      perform set_config('texnobazar.payment_gateway','allowed',true);
      update public.payment_transactions set state='cancelled',cancelled_at=coalesce(cancelled_at,now()),last_error='Click error '||p_provider_error,updated_at=now() where id=v_tx.id returning * into v_tx;
      perform set_config('texnobazar.payment_gateway','',true);
      update public.orders set payment_status='failed' where id=p_order_id and payment_status='pending';
      v_error=-9;v_note='Transaction cancelled';
    elsif v_tx.state='paid' then v_error=-4;v_note='Already paid';
    elsif v_tx.state<>'prepared' then v_error=-9;v_note='Transaction cancelled';
    else
      perform set_config('texnobazar.payment_gateway','allowed',true);
      update public.payment_transactions set state='paid',provider_payment_id=coalesce(provider_payment_id,p_click_paydoc_id),paid_at=now(),updated_at=now() where id=v_tx.id returning * into v_tx;
      perform set_config('texnobazar.payment_gateway','',true);
      update public.orders set payment_status='paid',paid_at=coalesce(paid_at,now()) where id=p_order_id;
    end if;
  elsif v_error=0 then v_error=-3;v_note='Action not found'; end if;
  v_response=jsonb_build_object('click_trans_id',p_click_trans_id,'merchant_trans_id',p_order_id,
    'merchant_prepare_id',coalesce(v_tx.provider_prepare_id,p_merchant_prepare_id,'0'),'merchant_confirm_id',coalesce(v_tx.provider_prepare_id,p_merchant_prepare_id,'0'),'error',v_error,'error_note',v_note);
  return public.payment_record_webhook_response('click',v_event_key,p_request_hash,case when p_action=0 then 'Prepare' else 'Complete' end,v_response,v_tx.id);
exception when unique_violation then
  return jsonb_build_object('click_trans_id',p_click_trans_id,'merchant_trans_id',p_order_id,'merchant_prepare_id',coalesce(p_merchant_prepare_id,'0'),'merchant_confirm_id',coalesce(p_merchant_prepare_id,'0'),'error',-8,'error_note','Conflicting transaction');
end $$;

create or replace function public.payme_process_request(p_method text,p_params jsonb,p_request_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_event_key text:=p_method||':'||p_request_hash; v_existing public.payment_webhook_events%rowtype; v_response jsonb; v_tx public.payment_transactions%rowtype; v_o public.orders%rowtype; v_method text; v_order_id uuid; v_provider_id text; v_amount bigint; v_now_ms bigint:=(extract(epoch from clock_timestamp())*1000)::bigint; v_reason integer; v_refund public.payment_refund_transactions%rowtype;
begin
  if p_method in('CreateTransaction','PerformTransaction','CancelTransaction') then
    select * into v_existing from public.payment_webhook_events where provider='payme' and event_key=v_event_key;
    if found then return v_existing.response; end if;
  end if;
  if p_method='GetStatement' then
    if not((p_params->>'from') ~ '^\d+$' and (p_params->>'to') ~ '^\d+$') or (p_params->>'from')::bigint>=(p_params->>'to')::bigint then
      v_response=jsonb_build_object('error',jsonb_build_object('code',-31050,'message','Incorrect period','data','from'));
    else
      v_response=jsonb_build_object('result',jsonb_build_object('transactions',coalesce((select jsonb_agg(jsonb_build_object(
        'id',t.provider_transaction_id,'time',t.provider_time_ms,'amount',t.amount_minor,'account',jsonb_build_object('order_id',t.order_id),
        'create_time',(extract(epoch from t.prepared_at)*1000)::bigint,'perform_time',coalesce((extract(epoch from t.paid_at)*1000)::bigint,0),
        'cancel_time',coalesce((extract(epoch from t.cancelled_at)*1000)::bigint,0),'transaction',t.id::text,
        'state',case t.state when 'prepared' then 1 when 'paid' then 2 when 'cancelled' then -1 when 'cancelled_after_paid' then -2 else -1 end,
        'reason',t.cancel_reason,'receivers',null) order by t.provider_time_ms)
        from public.payment_transactions t where t.provider='payme' and t.provider_time_ms between (p_params->>'from')::bigint and (p_params->>'to')::bigint),'[]'::jsonb)));
    end if;
    return v_response;
  end if;
  v_provider_id=nullif(p_params->>'id','');
  if p_method in('CheckPerformTransaction','CreateTransaction') then
    begin v_order_id=(p_params#>>'{account,order_id}')::uuid; exception when others then v_order_id=null; end;
    if (p_params->>'amount') ~ '^\d+$' then v_amount=(p_params->>'amount')::bigint; end if;
    if v_order_id is not null then select * into v_o from public.orders where id=v_order_id for update; end if;
    if v_order_id is null or not found then v_response=jsonb_build_object('error',jsonb_build_object('code',-31050,'message',jsonb_build_object('ru','Заказ не найден','uz','Buyurtma topilmadi','en','Order not found'),'data','order_id'));
    else
      select code into v_method from public.payment_methods where id=v_o.payment_method_id;
      if v_method<>'payme' or v_o.status in('cancelled','returned','delivered') then v_response=jsonb_build_object('error',jsonb_build_object('code',-31050,'message','Order is not payable','data','order_id'));
      elsif v_amount is null or v_amount<>public.payment_amount_minor(v_o.total) then v_response=jsonb_build_object('error',jsonb_build_object('code',-31001,'message','Invalid amount'));
      elsif exists(select 1 from public.payment_transactions where order_id=v_order_id and state='paid') then v_response=jsonb_build_object('error',jsonb_build_object('code',-31008,'message','Order is already paid'));
      elsif not exists(select 1 from public.payment_transactions where order_id=v_order_id and provider='payme' and state in('initiated','prepared','ambiguous')) then v_response=jsonb_build_object('error',jsonb_build_object('code',-31050,'message','Payment attempt not found','data','order_id'));
      elsif p_method='CheckPerformTransaction' then v_response=jsonb_build_object('result',jsonb_build_object('allow',true));
      else
        if v_provider_id is null or not((p_params->>'time') ~ '^\d{1,16}$') then
          v_response=jsonb_build_object('error',jsonb_build_object('code',-31008,'message','Transaction time is invalid'));
        else
          select * into v_tx from public.payment_transactions where provider='payme' and provider_transaction_id=v_provider_id for update;
          if found then
            if v_tx.order_id<>v_order_id or v_tx.amount_minor<>v_amount or v_tx.provider_time_ms is distinct from (p_params->>'time')::bigint then v_response=jsonb_build_object('error',jsonb_build_object('code',-31008,'message','Transaction mismatch'));
            elsif v_tx.state='prepared' and v_tx.prepared_at>now()-interval '12 hours' then v_response=jsonb_build_object('result',jsonb_build_object('create_time',(extract(epoch from v_tx.prepared_at)*1000)::bigint,'transaction',v_tx.id::text,'state',1,'receivers',null));
            else v_response=jsonb_build_object('error',jsonb_build_object('code',-31008,'message','Transaction is not active')); end if;
          else
            select * into v_tx from public.payment_transactions where order_id=v_order_id and provider='payme' and state in('initiated','ambiguous') order by created_at desc limit 1 for update;
            if not found or abs(v_now_ms-(p_params->>'time')::bigint)>43200000 then v_response=jsonb_build_object('error',jsonb_build_object('code',-31008,'message','Transaction time is invalid'));
            else
              perform set_config('texnobazar.payment_gateway','allowed',true);
              update public.payment_transactions set provider_transaction_id=v_provider_id,provider_time_ms=(p_params->>'time')::bigint,state='prepared',prepared_at=now(),updated_at=now() where id=v_tx.id returning * into v_tx;
              perform set_config('texnobazar.payment_gateway','',true);
              v_response=jsonb_build_object('result',jsonb_build_object('create_time',(extract(epoch from v_tx.prepared_at)*1000)::bigint,'transaction',v_tx.id::text,'state',1,'receivers',null));
            end if;
          end if;
        end if;
      end if;
    end if;
  elsif p_method in('PerformTransaction','CancelTransaction','CheckTransaction') then
    select * into v_tx from public.payment_transactions where provider='payme' and provider_transaction_id=v_provider_id for update;
    if not found then v_response=jsonb_build_object('error',jsonb_build_object('code',-31003,'message','Transaction not found'));
    elsif p_method='CheckTransaction' then
      v_response=jsonb_build_object('result',jsonb_build_object('create_time',(extract(epoch from v_tx.prepared_at)*1000)::bigint,
        'perform_time',coalesce((extract(epoch from v_tx.paid_at)*1000)::bigint,0),'cancel_time',coalesce((extract(epoch from v_tx.cancelled_at)*1000)::bigint,0),
        'transaction',v_tx.id::text,'state',case v_tx.state when 'prepared' then 1 when 'paid' then 2 when 'cancelled' then -1 when 'cancelled_after_paid' then -2 else -1 end,'reason',v_tx.cancel_reason));
    elsif p_method='PerformTransaction' then
      if v_tx.state='paid' then v_response=jsonb_build_object('result',jsonb_build_object('transaction',v_tx.id::text,'perform_time',(extract(epoch from v_tx.paid_at)*1000)::bigint,'state',2));
      elsif v_tx.state<>'prepared' then v_response=jsonb_build_object('error',jsonb_build_object('code',-31008,'message','Could not perform operation'));
      elsif v_tx.prepared_at<=now()-interval '12 hours' then
        perform set_config('texnobazar.payment_gateway','allowed',true);
        update public.payment_transactions set state='cancelled',cancelled_at=now(),cancel_reason=4,updated_at=now() where id=v_tx.id returning * into v_tx;
        perform set_config('texnobazar.payment_gateway','',true);
        v_response=jsonb_build_object('error',jsonb_build_object('code',-31008,'message','Transaction expired'));
      else
        perform set_config('texnobazar.payment_gateway','allowed',true);
        update public.payment_transactions set state='paid',paid_at=now(),updated_at=now() where id=v_tx.id returning * into v_tx;
        perform set_config('texnobazar.payment_gateway','',true);
        update public.orders set payment_status='paid',paid_at=coalesce(paid_at,now()) where id=v_tx.order_id;
        v_response=jsonb_build_object('result',jsonb_build_object('transaction',v_tx.id::text,'perform_time',(extract(epoch from v_tx.paid_at)*1000)::bigint,'state',2));
      end if;
    else
      v_reason=case when (p_params->>'reason') ~ '^\d+$' then (p_params->>'reason')::integer else 10 end;
      if v_tx.state in('cancelled','cancelled_after_paid') then v_response=jsonb_build_object('result',jsonb_build_object('transaction',v_tx.id::text,'cancel_time',(extract(epoch from v_tx.cancelled_at)*1000)::bigint,'state',case when v_tx.state='cancelled' then -1 else -2 end));
      elsif v_tx.state='prepared' then
        perform set_config('texnobazar.payment_gateway','allowed',true);
        update public.payment_transactions set state='cancelled',cancelled_at=now(),cancel_reason=v_reason,updated_at=now() where id=v_tx.id returning * into v_tx;
        perform set_config('texnobazar.payment_gateway','',true);
        update public.orders set payment_status='failed' where id=v_tx.order_id and payment_status='pending';
        v_response=jsonb_build_object('result',jsonb_build_object('transaction',v_tx.id::text,'cancel_time',(extract(epoch from v_tx.cancelled_at)*1000)::bigint,'state',-1));
      elsif v_tx.state='paid' then
        select * into v_refund from public.payment_refund_transactions where payment_transaction_id=v_tx.id and state in('pending','awaiting_provider','processing','ambiguous') order by created_at limit 1 for update;
        if exists(select 1 from public.sales where order_id=v_tx.order_id) and not found then v_response=jsonb_build_object('error',jsonb_build_object('code',-31007,'message','Order has been fulfilled'));
        else
          perform set_config('texnobazar.payment_gateway','allowed',true);
          update public.payment_transactions set state='cancelled_after_paid',cancelled_at=now(),cancel_reason=v_reason,updated_at=now() where id=v_tx.id returning * into v_tx;
          perform set_config('texnobazar.payment_gateway','',true);
          if v_refund.id is not null then perform public.confirm_payment_refund(v_refund.id,v_provider_id,p_request_hash); else update public.orders set payment_status='failed' where id=v_tx.order_id; end if;
          v_response=jsonb_build_object('result',jsonb_build_object('transaction',v_tx.id::text,'cancel_time',(extract(epoch from v_tx.cancelled_at)*1000)::bigint,'state',-2));
        end if;
      else v_response=jsonb_build_object('error',jsonb_build_object('code',-31008,'message','Could not cancel operation')); end if;
    end if;
  else v_response=jsonb_build_object('error',jsonb_build_object('code',-32601,'message','Method not found','data',p_method)); end if;
  if p_method in('CheckPerformTransaction','CheckTransaction') then return v_response; end if;
  return public.payment_record_webhook_response('payme',v_event_key,p_request_hash,p_method,v_response,v_tx.id);
exception when unique_violation then
  v_response=jsonb_build_object('error',jsonb_build_object('code',-31008,'message','Conflicting transaction'));
  return public.payment_record_webhook_response('payme',v_event_key,p_request_hash,p_method,v_response,v_tx.id);
end $$;

-- A delivered online order can only consume a provider-confirmed payment.
create or replace function public.finalize_online_order_sale(p_order_id uuid,p_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_o public.orders%rowtype; v_sale uuid; v_x record; v_total numeric(18,2):=0; v_method public.payment_methods%rowtype; v_tx public.payment_transactions%rowtype; v_sale_payment uuid;
begin
  select * into v_o from public.orders where id=p_order_id for update;
  if not found then raise exception 'Buyurtma topilmadi' using errcode='P0002'; end if;
  select * into v_method from public.payment_methods where id=v_o.payment_method_id;
  if v_method.code in('click','payme') then
    select * into v_tx from public.payment_transactions where order_id=p_order_id and provider=v_method.code and state='paid' and amount_minor=public.payment_amount_minor(v_o.total) for update;
    if not found or v_o.payment_status<>'paid' then raise exception 'Provider tasdiqlagan online to‘lov talab qilinadi' using errcode='P0001'; end if;
  elsif v_method.code<>'cod' then raise exception 'Yetkazishda faqat COD yoki tasdiqlangan gateway to‘lovi qabul qilinadi' using errcode='P0001'; end if;
  select id into v_sale from public.sales where order_id=p_order_id; if v_sale is not null then return v_sale; end if;
  perform 1 from public.inventory_units u join public.order_reserved_units r on r.unit_id=u.id where r.order_id=p_order_id and r.released_at is null and r.fulfilled_at is null order by u.id for update of u;
  if not exists(select 1 from public.order_reserved_units where order_id=p_order_id and released_at is null and fulfilled_at is null) then raise exception 'Buyurtma rezervlari topilmadi' using errcode='P0001'; end if;
  v_sale=gen_random_uuid();
  insert into public.sales(id,sale_no,branch_id,seller_id,manager_id,customer_id,order_id,status,subtotal,discount,tax,total)
  values(v_sale,'WEB-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_sale::text,1,8)),v_o.branch_id,p_actor,null,v_o.customer_id,p_order_id,'completed',v_o.subtotal,v_o.discount,0,v_o.subtotal-v_o.discount);
  perform set_config('texnobazar.manager_confirm_sale','allowed',true);
  for v_x in select r.id reservation_id,r.unit_id,u.product_id,u.batch_id,u.location_id,u.status,ol.unit_price,ol.discount,coalesce(sb.unit_cost,p.cost_price) unit_cost
    from public.order_reserved_units r join public.inventory_units u on u.id=r.unit_id join public.order_lines ol on ol.id=r.order_line_id
    join public.products p on p.id=u.product_id left join public.stock_batches sb on sb.id=u.batch_id
    where r.order_id=p_order_id and r.released_at is null and r.fulfilled_at is null order by u.id loop
    if v_x.status<>'reserved' then raise exception 'Online rezerv birligi band emas: %',v_x.unit_id using errcode='P0001'; end if;
    insert into public.sale_lines(sale_id,product_id,unit_id,quantity,unit_cost,unit_price,discount,tax,line_total)
    values(v_sale,v_x.product_id,v_x.unit_id,1,v_x.unit_cost,v_x.unit_price,v_x.discount,0,v_x.unit_price-v_x.discount);
    update public.inventory_units set status='sold',sold_sale_id=v_sale,reserved_until=null,version=version+1 where id=v_x.unit_id;
    update public.order_reserved_units set fulfilled_at=now() where id=v_x.reservation_id;
    insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,quantity,unit_cost,reference_type,reference_id,actor_id)
    values(v_x.unit_id,v_x.product_id,v_x.batch_id,'sold',v_x.location_id,1,v_x.unit_cost,'online_order',p_order_id,p_actor) on conflict do nothing;
    v_total=v_total+v_x.unit_price-v_x.discount;
  end loop;
  perform set_config('texnobazar.manager_confirm_sale','',true);
  insert into public.sale_payments(sale_id,payment_method_id,amount,status,external_reference,received_by,metadata)
  values(v_sale,v_o.payment_method_id,case when v_method.code in('click','payme') then v_o.total else v_total end,'paid',v_tx.provider_transaction_id,p_actor,
    jsonb_build_object('online_order_id',p_order_id,'payment_transaction_id',v_tx.id,'provider',case when v_method.code in('click','payme') then v_method.code else null end)) returning id into v_sale_payment;
  if v_tx.id is not null then
    perform set_config('texnobazar.payment_gateway','allowed',true);
    update public.payment_transactions set sale_payment_id=v_sale_payment,updated_at=now() where id=v_tx.id;
    perform set_config('texnobazar.payment_gateway','',true);
  else update public.orders set payment_status='paid',paid_at=coalesce(paid_at,now()) where id=p_order_id; end if;
  return v_sale;
exception when unique_violation then select id into v_sale from public.sales where order_id=p_order_id; if v_sale is not null then return v_sale; end if; raise;
end $$;

-- Physical return completion creates provider refund work but never attests that
-- Click/Payme has returned money. Cash/COD keeps the synchronous legacy path.
create or replace function public.complete_sale_return(p_return_id uuid,p_resell_location_id uuid,p_replacement_sale_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.sale_returns%rowtype; v_sale public.sales%rowtype; v_x record; v_u public.inventory_units%rowtype; v_dest uuid; v_writeoff uuid; v_completed integer; v_all integer; v_refund public.sale_refunds%rowtype; v_payment record; v_remaining numeric(18,2); v_exchange_method text; v_allocated bigint; v_available bigint; v_requested bigint;
begin
  select * into v_r from public.sale_returns where id=p_return_id for update;
  if not found then raise exception 'Qaytarish topilmadi' using errcode='P0002'; end if; perform public.require_pos_manager(v_r.branch_id);
  if v_r.status='completed' then return to_jsonb(v_r); end if;
  if v_r.status<>'approved' then raise exception 'Faqat approved qaytarish yakunlanadi' using errcode='P0001'; end if;
  select * into v_sale from public.sales where id=v_r.original_sale_id for update;
  select id into v_dest from public.locations where id=p_resell_location_id and branch_id=v_r.branch_id and is_active and type in('store','warehouse');
  if v_dest is null then raise exception 'Qayta sotish joyi filialga mos emas' using errcode='P0002'; end if;
  if p_replacement_sale_id is not null and (v_r.kind<>'exchange' or not exists(select 1 from public.sales where id=p_replacement_sale_id and branch_id=v_r.branch_id and status='completed')) then raise exception 'Replacement sale noto‘g‘ri' using errcode='22023'; end if;
  select id into v_writeoff from public.locations where code='SYSTEM-WRITEOFF' for share;
  perform 1 from public.inventory_units u join public.sale_return_lines x on x.unit_id=u.id where x.return_id=p_return_id order by u.id for update of u;
  for v_x in select x.*,sl.product_id,sl.unit_cost from public.sale_return_lines x join public.sale_lines sl on sl.id=x.sale_line_id where x.return_id=p_return_id order by x.unit_id loop
    select * into v_u from public.inventory_units where id=v_x.unit_id;
    if v_u.status<>'sold' or v_u.sold_sale_id is distinct from v_r.original_sale_id then raise exception 'Sotilgan birlik holati qaytarishga mos emas: %',v_u.id using errcode='P0001'; end if;
    if v_x.condition='resellable' then
      update public.inventory_units set location_id=v_dest,status='available',sold_sale_id=null,reserved_until=null,version=version+1 where id=v_u.id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,unit_cost,reference_type,reference_id,reason,actor_id,metadata)
      values(v_u.id,v_u.product_id,v_u.batch_id,'returned',v_u.location_id,v_dest,1,v_x.unit_cost,'sale_return',p_return_id,v_r.reason,auth.uid(),jsonb_build_object('condition',v_x.condition)) on conflict do nothing;
    else
      update public.inventory_units set location_id=v_writeoff,status='written_off',sold_sale_id=null,reserved_until=null,version=version+1 where id=v_u.id;
      insert into public.inventory_movements(unit_id,product_id,batch_id,movement_type,from_location_id,to_location_id,quantity,unit_cost,reference_type,reference_id,reason,actor_id,metadata)
      values(v_u.id,v_u.product_id,v_u.batch_id,'writeoff',v_u.location_id,v_writeoff,1,v_x.unit_cost,'sale_return',p_return_id,v_r.reason,auth.uid(),jsonb_build_object('condition',v_x.condition)) on conflict do nothing;
    end if;
  end loop;
  update public.sale_returns set status='completed',replacement_sale_id=p_replacement_sale_id,completed_at=now() where id=p_return_id returning * into v_r;
  insert into public.sale_refunds(return_id,sale_id,amount,created_by) values(v_r.id,v_r.original_sale_id,v_r.refund_amount,auth.uid()) returning * into v_refund;
  select count(*) into v_all from public.sale_lines where sale_id=v_r.original_sale_id;
  select count(distinct x.sale_line_id) into v_completed from public.sale_return_lines x join public.sale_returns r on r.id=x.return_id where r.original_sale_id=v_r.original_sale_id and r.status='completed';
  update public.sales set status=case when v_completed>=v_all then 'returned'::public.sale_status else 'partially_returned'::public.sale_status end where id=v_r.original_sale_id;
  if v_r.kind='exchange' and p_replacement_sale_id is not null then
    begin v_remaining=nullif(current_setting('texnobazar.exchange_refund_due',true),'')::numeric; exception when others then v_remaining=null; end;
    v_exchange_method=nullif(current_setting('texnobazar.exchange_refund_method',true),'');
    if v_remaining is null or v_remaining<0 then raise exception 'Exchange residual refund context talab qilinadi' using errcode='P0001'; end if;
  else v_remaining=v_r.refund_amount; end if;
  for v_payment in select sp.*,pm.code,pt.id payment_transaction_id from public.sale_payments sp join public.payment_methods pm on pm.id=sp.payment_method_id left join public.payment_transactions pt on pt.sale_payment_id=sp.id where sp.sale_id=v_r.original_sale_id and sp.status in('paid','partially_refunded') order by sp.created_at,sp.id loop
    exit when v_remaining<=0;
    if v_payment.code in('click','payme') then
      if v_r.kind='exchange' and p_replacement_sale_id is not null and v_exchange_method is distinct from v_payment.code then
        null; -- Residual was disbursed through the separately attested exchange settlement.
      else
        if v_payment.payment_transaction_id is null then raise exception 'Provider payment ledgeri topilmadi' using errcode='P0001'; end if;
        perform 1 from public.payment_refund_transactions where sale_payment_id=v_payment.id for update;
        select coalesce(sum(amount_minor),0) into v_allocated from public.payment_refund_transactions where sale_payment_id=v_payment.id and state<>'failed';
        v_available=public.payment_amount_minor(v_payment.amount)-v_allocated;
        v_requested=public.payment_amount_minor(least(v_remaining,v_payment.amount));
        if v_available<=0 or v_requested<>v_available then
          raise exception 'Click/Payme faqat to‘liq qolgan provider summasini qaytarishni qo‘llaydi; partial refund bloklandi' using errcode='P0001';
        end if;
        insert into public.payment_refund_transactions(sale_refund_id,payment_transaction_id,sale_payment_id,provider,amount_minor,currency,idempotency_key,state)
        values(v_refund.id,v_payment.payment_transaction_id,v_payment.id,v_payment.code,v_requested,'UZS',gen_random_uuid(),case when v_payment.code='payme' then 'awaiting_provider' else 'pending' end);
      end if;
    else
      perform set_config('texnobazar.complete_sale_return','allowed',true);
      update public.sale_payments set status=case when v_remaining>=v_payment.amount then 'refunded'::public.payment_status else 'partially_refunded'::public.payment_status end where id=v_payment.id;
      perform set_config('texnobazar.complete_sale_return','',true);
    end if;
    v_remaining=v_remaining-least(v_remaining,v_payment.amount);
  end loop;
  if v_remaining>0 then raise exception 'Refund summasi to‘lovlardan oshdi' using errcode='P0001'; end if;
  return to_jsonb(v_r);
end $$;

-- Replace the historical exchange caller so only money actually paid back to the
-- customer enters provider-refund accounting; replacement credit stays internal.
create or replace function public.execute_sale_exchange(p_return_id uuid,p_replacement_pending_sale_id uuid,p_resell_location_id uuid,p_settlements jsonb default '[]'::jsonb,p_refund_settlement jsonb default null,p_idempotency_key uuid default gen_random_uuid())
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_r public.sale_returns%rowtype;v_p public.pos_pending_sales%rowtype;v_existing public.exchange_transactions%rowtype;v_sale uuid;v_credit numeric(18,2);v_due numeric(18,2);v_refund numeric(18,2);v_paid numeric(18,2);v_payments jsonb;v_id uuid:=gen_random_uuid();v_hash text;
begin
  select * into v_r from public.sale_returns where id=p_return_id for update;if not found then raise exception 'Almashtirish topilmadi' using errcode='P0002'; end if;perform public.require_pos_manager(v_r.branch_id);
  if p_idempotency_key is null or jsonb_typeof(coalesce(p_settlements,'[]'::jsonb))<>'array' or (p_refund_settlement is not null and jsonb_typeof(p_refund_settlement)<>'object') then raise exception 'Settlement ma’lumotlari noto‘g‘ri' using errcode='22023'; end if;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('return_id',p_return_id,'pending_sale_id',p_replacement_pending_sale_id,'location_id',p_resell_location_id,'settlements',coalesce(p_settlements,'[]'::jsonb),'refund_settlement',p_refund_settlement)::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.exchange_transactions where branch_id=v_r.branch_id and idempotency_key=p_idempotency_key;if found then if v_existing.request_hash<>v_hash then raise exception 'Takroriy kalit boshqa almashtirish uchun ishlatilgan' using errcode='22023';end if;return to_jsonb(v_existing);end if;
  select * into v_p from public.pos_pending_sales where id=p_replacement_pending_sale_id and branch_id=v_r.branch_id for update;
  if not found or v_r.kind<>'exchange' or v_r.status<>'approved' or v_p.status<>'pending' or v_p.expires_at<=now() then raise exception 'Almashtirish yoki replacement POS so‘rovi tayyor emas' using errcode='P0001'; end if;
  if v_p.customer_id is distinct from (select customer_id from public.sales where id=v_r.original_sale_id) then raise exception 'Replacement xaridori original sotuvga mos emas' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_settlements,'[]'::jsonb)) e where lower(e->>'method_code')='exchange_credit') then raise exception 'Ichki exchange kreditini qo‘lda yuborish mumkin emas' using errcode='22023'; end if;
  select coalesce(sum((e->>'amount')::numeric),0) into v_paid from jsonb_array_elements(coalesce(p_settlements,'[]'::jsonb)) e;
  v_credit:=least(v_r.refund_amount,v_p.total);v_due:=greatest(v_p.total-v_r.refund_amount,0);v_refund:=greatest(v_r.refund_amount-v_p.total,0);
  if v_paid<>v_due then raise exception 'Qo‘shimcha to‘lov almashtirish farqiga teng emas' using errcode='22023'; end if;
  if v_refund>0 and (p_refund_settlement is null or (p_refund_settlement->>'amount')::numeric is distinct from v_refund or coalesce(p_refund_settlement->>'method_code','') not in('cash','card','bank_transfer','click','payme') or (p_refund_settlement->>'method_code'<>'cash' and nullif(btrim(p_refund_settlement->>'external_reference'),'') is null)) then raise exception 'Mijozga refund settlement to‘liq ko‘rsatilishi kerak' using errcode='22023';end if;
  if v_refund=0 and p_refund_settlement is not null then raise exception 'Refund bo‘lmagan almashtirish payout qabul qilmaydi' using errcode='22023';end if;
  v_payments:=coalesce(p_settlements,'[]'::jsonb);if v_credit>0 then v_payments:=jsonb_build_array(jsonb_build_object('method_code','exchange_credit','amount',v_credit,'external_reference',v_r.return_no))||v_payments;end if;
  v_sale:=public.manager_confirm_sale(v_p.id,v_payments);
  if v_sale is null then raise exception 'Replacement rezerv muddati tugagan' using errcode='P0001'; end if;
  perform set_config('texnobazar.exchange_refund_due',v_refund::text,true);
  perform set_config('texnobazar.exchange_refund_method',coalesce(p_refund_settlement->>'method_code',''),true);
  perform public.complete_sale_return(v_r.id,p_resell_location_id,v_sale);
  perform set_config('texnobazar.exchange_refund_due','',true);
  perform set_config('texnobazar.exchange_refund_method','',true);
  insert into public.exchange_transactions(id,exchange_no,return_id,original_sale_id,replacement_pending_sale_id,replacement_sale_id,branch_id,return_credit,replacement_total,amount_due,refund_due,settlement_payload,idempotency_key,request_hash,created_by)
  values(v_id,'EXC-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||'-'||upper(substr(v_id::text,1,8)),v_r.id,v_r.original_sale_id,v_p.id,v_sale,v_r.branch_id,v_r.refund_amount,v_p.total,v_due,v_refund,coalesce(p_settlements,'[]'::jsonb),p_idempotency_key,v_hash,auth.uid()) returning * into v_existing;
  if v_refund>0 then insert into public.exchange_refund_disbursements(exchange_id,amount,method_code,external_reference,created_by) values(v_id,v_refund,p_refund_settlement->>'method_code',nullif(btrim(p_refund_settlement->>'external_reference'),''),auth.uid());end if;
  return to_jsonb(v_existing);
end $$;

create or replace function public.confirm_payment_refund(p_refund_id uuid,p_provider_refund_id text,p_response_hash text)
returns void language plpgsql security definer set search_path='' as $$
declare v_r public.payment_refund_transactions%rowtype; v_payment public.sale_payments%rowtype; v_tx public.payment_transactions%rowtype; v_confirmed bigint; v_payment_fully_refunded boolean;
begin
  select * into v_r from public.payment_refund_transactions where id=p_refund_id for update;
  if not found then raise exception 'Provider refund topilmadi' using errcode='P0002'; end if;
  if v_r.state='confirmed' then return; end if;
  select * into v_payment from public.sale_payments where id=v_r.sale_payment_id for update;
  select * into v_tx from public.payment_transactions where id=v_r.payment_transaction_id for update;
  update public.payment_refund_transactions set state='confirmed',provider_refund_id=coalesce(provider_refund_id,nullif(p_provider_refund_id,'')),provider_response_hash=p_response_hash,
    confirmed_at=now(),lock_token=null,locked_until=null,last_error=null,updated_at=now() where id=v_r.id;
  select coalesce(sum(amount_minor),0) into v_confirmed from public.payment_refund_transactions where sale_payment_id=v_payment.id and state='confirmed';
  v_payment_fully_refunded=v_confirmed>=public.payment_amount_minor(v_payment.amount);
  perform set_config('texnobazar.complete_sale_return','allowed',true);
  update public.sale_payments set status=case when v_payment_fully_refunded then 'refunded'::public.payment_status else 'partially_refunded'::public.payment_status end where id=v_payment.id;
  perform set_config('texnobazar.complete_sale_return','',true);
  if v_payment_fully_refunded and v_r.provider='click' and v_tx.state in('paid','cancelled_after_paid') then
    perform set_config('texnobazar.payment_gateway','allowed',true);
    update public.payment_transactions set state='refunded',cancelled_at=coalesce(cancelled_at,now()),updated_at=now() where id=v_tx.id;
    perform set_config('texnobazar.payment_gateway','',true);
  end if;
  update public.orders o set payment_status=case when exists(select 1 from public.sale_payments sp where sp.sale_id=v_payment.sale_id and sp.status<>'refunded')
      then 'partially_refunded'::public.payment_status else 'refunded'::public.payment_status end
    from public.sales s where s.id=v_payment.sale_id and o.id=s.order_id;
end $$;

create or replace function public.claim_payment_refund_batch(p_provider text,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_items jsonb;
begin
  if p_provider<>'click' or p_limit not between 1 and 100 then raise exception 'Refund claim parametrlari noto‘g‘ri' using errcode='22023'; end if;
  with picked as(select r.id,case when r.state='ambiguous' then 'reconcile' else 'reverse' end operation from public.payment_refund_transactions r where r.provider=p_provider and
      (r.state='pending' and r.next_attempt_at<=now() or r.state='processing' and r.locked_until<now() or r.state='ambiguous')
    order by r.created_at for update skip locked limit p_limit), claimed as(
    update public.payment_refund_transactions r set state='processing',attempt_count=attempt_count+1,lock_token=gen_random_uuid(),locked_until=now()+interval '10 minutes',updated_at=now()
    from picked where r.id=picked.id returning r.*)
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'lock_token',c.lock_token,'provider_payment_id',t.provider_payment_id,'idempotency_key',c.idempotency_key,'operation',p.operation) order by c.created_at),'[]'::jsonb)
  into v_items from claimed c join picked p on p.id=c.id join public.payment_transactions t on t.id=c.payment_transaction_id;
  return v_items;
end $$;

create or replace function public.finish_payment_refund(p_refund_id uuid,p_lock_token uuid,p_outcome text,p_provider_refund_id text default null,p_response_hash text default null,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_r public.payment_refund_transactions%rowtype;
begin
  select * into v_r from public.payment_refund_transactions where id=p_refund_id and lock_token=p_lock_token and state='processing' for update;
  if not found then raise exception 'Refund lease topilmadi' using errcode='P0002'; end if;
  if p_outcome='confirmed' then perform public.confirm_payment_refund(p_refund_id,p_provider_refund_id,p_response_hash);
  elsif p_outcome='retry' then update public.payment_refund_transactions set state='pending',next_attempt_at=now()+least(interval '6 hours',interval '5 minutes'*power(2,least(attempt_count,6))),lock_token=null,locked_until=null,last_error=left(p_error,1000),updated_at=now() where id=p_refund_id;
  elsif p_outcome in('failed','ambiguous') then update public.payment_refund_transactions set state=p_outcome,lock_token=null,locked_until=null,last_error=left(p_error,1000),updated_at=now() where id=p_refund_id;
  else raise exception 'Refund outcome noto‘g‘ri' using errcode='22023'; end if;
end $$;

create or replace function public.list_provider_refunds(p_branch_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if p_branch_id is null or not public.current_user_active() or not(public.has_role(array['superadmin','admin']::public.app_role[],null) or public.has_role(array['manager','accountant']::public.app_role[],p_branch_id)) then
    raise exception 'Provider refund ko‘rish uchun manager/accountant roli talab qilinadi' using errcode='42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'return_id',sr.return_id,'provider',pr.provider,'amount_minor',pr.amount_minor,
    'state',pr.state,'last_error',pr.last_error,'created_at',pr.created_at,'confirmed_at',pr.confirmed_at,
    'action_required',case when pr.provider='payme' and pr.state='awaiting_provider' then 'Payme Merchant Cabinetda refundni boshlang; faqat Payme CancelTransaction callbacki tasdiqlaydi.' when pr.state='ambiguous' then 'Avtomatik reconciliation kutilmoqda; qo‘lda qayta refund yubormang.' else null end)
    order by pr.created_at desc) from public.payment_refund_transactions pr join public.sale_refunds sr on sr.id=pr.sale_refund_id join public.sales s on s.id=sr.sale_id where s.branch_id=p_branch_id),'[]'::jsonb);
end $$;

alter table public.payment_transactions enable row level security;
alter table public.payment_webhook_events enable row level security;
alter table public.payment_refund_transactions enable row level security;
revoke all on public.payment_transactions,public.payment_webhook_events,public.payment_refund_transactions from public,anon,authenticated;
grant all on public.payment_transactions,public.payment_webhook_events,public.payment_refund_transactions to service_role;
grant usage,select on sequence public.payment_transactions_merchant_sequence_seq to service_role;

do $$ declare r record;
begin
  for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in(
    'create_online_order_v2','storefront_payment_methods','create_online_payment_attempt','get_online_payment_status','click_process_callback','payme_process_request',
    'payment_amount_minor','payment_record_webhook_response','confirm_payment_refund','claim_payment_refund_batch','finish_payment_refund','list_provider_refunds','guard_payment_transaction_update')
  loop execute format('revoke all on function %s from public,anon,authenticated',r.sig); end loop;
end $$;
-- Retire the unsafe public v1 order surface. v2 binds every order to an owner/capability.
revoke all on function public.create_online_order(jsonb,jsonb,jsonb,text,text,text) from anon,authenticated;
grant execute on function public.create_online_order_v2(jsonb,jsonb,jsonb,text,text,text,text) to anon,authenticated;
grant execute on function public.storefront_payment_methods(boolean,boolean),public.create_online_payment_attempt(uuid,text,text,uuid,uuid),
  public.get_online_payment_status(uuid,text,uuid),public.click_process_callback(text,text,uuid,text,bigint,integer,integer,text,text),
  public.payme_process_request(text,jsonb,text),public.payment_amount_minor(numeric),public.payment_record_webhook_response(text,text,text,text,jsonb,uuid),
  public.confirm_payment_refund(uuid,text,text),public.claim_payment_refund_batch(text,integer),public.finish_payment_refund(uuid,uuid,text,text,text,text),
  public.list_provider_refunds(uuid),public.guard_payment_transaction_update() to service_role;
grant execute on function public.list_provider_refunds(uuid) to authenticated;
grant execute on function public.finalize_online_order_sale(uuid,uuid) to service_role;
grant execute on function public.complete_sale_return(uuid,uuid,uuid) to authenticated,service_role;

commit;
