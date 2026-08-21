-- AI assistant configuration.
--
-- SECURITY MODEL
-- ==============
-- Provider API keys are secrets. They are stored in public.ai_providers.api_key but:
--   * SELECT on the base table is revoked from `authenticated` entirely.
--   * Admins read provider metadata through list_ai_providers(), which never returns
--     the key (only a has_api_key boolean).
--   * Writes go through save_ai_provider(), a security-definer RPC.
--   * Only the serverless AI endpoint (service_role) ever reads the raw key.
-- This keeps keys out of the browser even if a client tries `select *`.

create table if not exists public.ai_providers (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('openai','anthropic','gemini','groq','kimi','deepseek','openrouter','custom')),
  label text not null check (length(btrim(label)) between 2 and 80),
  api_key text,
  base_url text check (base_url is null or base_url ~ '^https://'),
  models jsonb not null default '[]'::jsonb check (jsonb_typeof(models) = 'array'),
  default_model text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_providers_active_idx on public.ai_providers(is_active, sort_order);

create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text,
  provider_id uuid references public.ai_providers(id) on delete set null,
  model text,
  branch_scope uuid references public.branches(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_conversations_owner_idx on public.ai_conversations(owner_id, updated_at desc);

create table if not exists public.ai_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool')),
  content text,
  tool_calls jsonb,
  tool_name text,
  created_at timestamptz not null default now()
);
create index if not exists ai_messages_conversation_idx on public.ai_messages(conversation_id, id);

-- Every tool invocation is logged, so a write performed "by the AI" is still
-- attributable to the human who asked for it.
create table if not exists public.ai_action_log (
  id bigint generated always as identity primary key,
  conversation_id uuid references public.ai_conversations(id) on delete set null,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  tool_name text not null,
  arguments jsonb not null default '{}'::jsonb,
  result jsonb,
  is_write boolean not null default false,
  status text not null check (status in ('ok','error')),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists ai_action_log_actor_idx on public.ai_action_log(actor_id, created_at desc);
create index if not exists ai_action_log_write_idx on public.ai_action_log(is_write, created_at desc) where is_write;

alter table public.ai_providers enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_action_log enable row level security;

-- No direct table access for clients: everything goes through RPCs below.
revoke all on public.ai_providers from anon, authenticated;
grant all on public.ai_providers to service_role;

-- Conversations/messages are owner-scoped and safe to read directly.
drop policy if exists ai_conversations_owner on public.ai_conversations;
create policy ai_conversations_owner on public.ai_conversations for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists ai_messages_owner on public.ai_messages;
create policy ai_messages_owner on public.ai_messages for all to authenticated
  using (exists(select 1 from public.ai_conversations c where c.id = conversation_id and c.owner_id = auth.uid()))
  with check (exists(select 1 from public.ai_conversations c where c.id = conversation_id and c.owner_id = auth.uid()));
grant select, insert, update, delete on public.ai_conversations to authenticated;
grant select, insert on public.ai_messages to authenticated;
grant all on public.ai_conversations, public.ai_messages to service_role;

drop policy if exists ai_action_log_admin_read on public.ai_action_log;
create policy ai_action_log_admin_read on public.ai_action_log for select to authenticated
  using (actor_id = auth.uid() or public.has_role(array['superadmin','admin']::public.app_role[], null));
grant select on public.ai_action_log to authenticated;
grant all on public.ai_action_log to service_role;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create or replace function public.require_ai_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_role(array['superadmin']::public.app_role[], null) then
    raise exception 'AI sozlamalari uchun global superadmin roli talab qilinadi' using errcode = '42501';
  end if;
end $$;

-- Anyone who can act on business data (admin or branch manager) may use the assistant.
create or replace function public.require_ai_user()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.current_user_active() then
    raise exception 'Faol xodim profili talab qilinadi' using errcode = '42501';
  end if;
  if not exists(
    select 1 from public.profile_roles r
    where r.profile_id = auth.uid() and r.role in ('superadmin','admin','manager','accountant')
  ) then
    raise exception 'AI yordamchisi uchun admin yoki menejer roli talab qilinadi' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Provider management (superadmin only). api_key is never returned.
-- ---------------------------------------------------------------------------
create or replace function public.list_ai_providers()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb;
begin
  perform public.require_ai_admin();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'provider', p.provider, 'label', p.label,
    'base_url', p.base_url, 'models', p.models, 'default_model', p.default_model,
    'is_active', p.is_active, 'sort_order', p.sort_order,
    'has_api_key', p.api_key is not null and btrim(p.api_key) <> '',
    'api_key_hint', case
      when p.api_key is null or length(btrim(p.api_key)) < 8 then null
      else '…' || right(btrim(p.api_key), 4) end,
    'created_at', p.created_at, 'updated_at', p.updated_at
  ) order by p.sort_order, p.label), '[]'::jsonb) into v_items from public.ai_providers p;
  return v_items;
end $$;

create or replace function public.save_ai_provider(p_provider jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_key text; v_models jsonb;
begin
  perform public.require_ai_admin();
  v_id := nullif(btrim(p_provider->>'id'), '')::uuid;
  v_key := nullif(btrim(p_provider->>'api_key'), '');
  v_models := case when jsonb_typeof(p_provider->'models') = 'array' then p_provider->'models' else '[]'::jsonb end;

  if v_id is null then
    if v_key is null then
      raise exception 'API kalit talab qilinadi' using errcode = '22023';
    end if;
    insert into public.ai_providers(provider, label, api_key, base_url, models, default_model, is_active, sort_order, created_by)
    values(
      btrim(p_provider->>'provider'),
      btrim(p_provider->>'label'),
      v_key,
      nullif(btrim(p_provider->>'base_url'), ''),
      v_models,
      nullif(btrim(p_provider->>'default_model'), ''),
      coalesce((p_provider->>'is_active')::boolean, true),
      coalesce((p_provider->>'sort_order')::integer, 0),
      auth.uid()
    ) returning id into v_id;
  else
    update public.ai_providers set
      provider = coalesce(nullif(btrim(p_provider->>'provider'), ''), provider),
      label = coalesce(nullif(btrim(p_provider->>'label'), ''), label),
      -- Empty api_key means "keep the stored one" so the UI never has to echo it back.
      api_key = coalesce(v_key, api_key),
      base_url = case when p_provider ? 'base_url' then nullif(btrim(p_provider->>'base_url'), '') else base_url end,
      models = case when p_provider ? 'models' then v_models else models end,
      default_model = case when p_provider ? 'default_model' then nullif(btrim(p_provider->>'default_model'), '') else default_model end,
      is_active = coalesce((p_provider->>'is_active')::boolean, is_active),
      sort_order = coalesce((p_provider->>'sort_order')::integer, sort_order),
      updated_at = now()
    where id = v_id;
    if not found then raise exception 'AI provayder topilmadi' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end $$;

create or replace function public.delete_ai_provider(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_ai_admin();
  delete from public.ai_providers where id = p_id;
end $$;

-- Model picker for the chat UI: available to any assistant user, still no keys.
create or replace function public.list_ai_models()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb;
begin
  perform public.require_ai_user();
  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_id', p.id, 'provider', p.provider, 'label', p.label,
    'models', p.models, 'default_model', p.default_model
  ) order by p.sort_order, p.label), '[]'::jsonb) into v_items
  from public.ai_providers p
  where p.is_active and p.api_key is not null and btrim(p.api_key) <> '';
  return v_items;
end $$;

grant execute on function public.require_ai_admin() to authenticated;
grant execute on function public.require_ai_user() to authenticated;
grant execute on function public.list_ai_providers() to authenticated;
grant execute on function public.save_ai_provider(jsonb) to authenticated;
grant execute on function public.delete_ai_provider(uuid) to authenticated;
grant execute on function public.list_ai_models() to authenticated;
