begin;

-- Force PostgREST schema cache refresh by dropping and recreating the function.
-- The old text-based p_proof_url signature must be fully removed first so PostgREST
-- does not get confused by overloads.
drop function if exists public.courier_update_delivery_status(uuid,public.delivery_status,text,text);
drop function if exists public.courier_update_delivery_status(uuid,public.delivery_status,text,uuid);

create or replace function public.courier_update_delivery_status(
  p_delivery_id uuid,
  p_status      public.delivery_status,
  p_note        text    default null,
  p_proof_id    uuid    default null
)
returns void language plpgsql security definer set search_path='' as $$
declare
  v_d          public.deliveries%rowtype;
  v_o          public.orders%rowtype;
  v_p          public.delivery_proofs%rowtype;
  v_order_status public.order_status;
  v_sale       uuid;
  v_order_id   uuid;
begin
  select order_id into v_order_id from public.deliveries where id = p_delivery_id;
  if not found then
    raise exception 'Yetkazib berish topilmadi' using errcode = 'P0002';
  end if;

  select * into v_o from public.orders  where id = v_order_id   for update;
  select * into v_d from public.deliveries where id = p_delivery_id for update;

  if not found
     or v_d.order_id  <> v_order_id
     or v_d.courier_id <> auth.uid()
     or not public.current_user_active()
     or not exists (
          select 1 from public.profile_roles r
          where r.profile_id = auth.uid()
            and r.role = 'courier'
            and r.branch_id = v_o.branch_id
        )
  then
    raise exception 'Faol biriktirilgan kuryer talab qilinadi' using errcode = '42501';
  end if;

  if v_d.status = p_status then return; end if;

  if not (
    (v_d.status = 'assigned'    and p_status = 'picked_up')  or
    (v_d.status = 'picked_up'   and p_status = 'in_transit') or
    (v_d.status = 'in_transit'  and p_status in ('delivered', 'failed'))
  ) then
    raise exception 'Yetkazib berish status o''tishi noto''g''ri' using errcode = 'P0001';
  end if;

  -- Proof handling for delivered status
  if p_status = 'delivered' then
    if p_proof_id is null then
      select * into v_p
      from public.delivery_proofs
      where delivery_id = p_delivery_id
        and courier_id = auth.uid()
        and status = 'verified'
      order by created_at desc
      limit 1;
    else
      select * into v_p
      from public.delivery_proofs
      where id = p_proof_id
        and delivery_id = p_delivery_id
        and courier_id = auth.uid()
        and status = 'verified'
      for update;
      if not found then
        raise exception 'Tasdiqlangan yetkazish isboti topilmadi' using errcode = 'P0002';
      end if;
    end if;
  end if;

  if p_status = 'failed' and nullif(btrim(p_note), '') is null then
    raise exception 'Muvaffaqiyatsizlik sababi talab qilinadi' using errcode = '22023';
  end if;

  update public.deliveries
  set
    status       = p_status,
    picked_up_at = case when p_status = 'picked_up'  then now() else picked_up_at  end,
    delivered_at = case when p_status = 'delivered'  then now() else delivered_at  end,
    proof_url    = case when p_status = 'delivered'  then v_p.public_url else proof_url end,
    recipient_note = coalesce(nullif(btrim(p_note), ''), recipient_note)
  where id = p_delivery_id;

  v_order_status := case
    when p_status in ('picked_up', 'in_transit') then 'shipped'::public.order_status
    when p_status = 'delivered'                  then 'delivered'::public.order_status
    else 'processing'::public.order_status
  end;

  if p_status = 'delivered' then
    v_sale := public.finalize_online_order_sale(v_d.order_id, auth.uid());
    if v_p.id is not null then
      update public.delivery_proofs
      set status = 'consumed', consumed_at = now()
      where id = v_p.id;
    end if;
  end if;

  update public.orders set status = v_order_status where id = v_d.order_id;

  insert into public.order_status_history(order_id, from_status, to_status, note, actor_id)
  values (v_d.order_id, v_o.status, v_order_status, nullif(btrim(p_note), ''), auth.uid());

  perform public.enqueue_order_notification(
    v_d.order_id,
    case
      when p_status = 'delivered' then 'Buyurtma yetkazildi'
      when p_status = 'failed'    then 'Yetkazib berish amalga oshmadi'
      else 'Yetkazib berish yangilandi'
    end,
    coalesce(nullif(btrim(p_note), ''), 'Yetkazib berish holati: ' || p_status::text),
    jsonb_build_object(
      'delivery_status', p_status,
      'proof_url',  v_p.public_url,
      'proof_id',   p_proof_id,
      'sale_id',    v_sale
    )
  );
end $$;

-- Re-grant execute (drop removed the old grants)
revoke all on function public.courier_update_delivery_status(uuid, public.delivery_status, text, uuid) from public, anon;
grant execute on function public.courier_update_delivery_status(uuid, public.delivery_status, text, uuid)
  to authenticated, service_role;

-- Force PostgREST to reload its schema cache
notify pgrst, 'reload schema';

commit;
