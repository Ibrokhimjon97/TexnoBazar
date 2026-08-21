begin;

alter table public.cms_banners
  add column if not exists mobile_image_url text,
  add column if not exists mobile_r2_key text,
  add column if not exists image_fit text not null default 'cover',
  add column if not exists image_position_x smallint not null default 50,
  add column if not exists image_position_y smallint not null default 50,
  add column if not exists mobile_image_fit text not null default 'cover',
  add column if not exists mobile_image_position_x smallint not null default 50,
  add column if not exists mobile_image_position_y smallint not null default 50;

alter table public.cms_banners
  drop constraint if exists cms_banners_mobile_image_url_check,
  drop constraint if exists cms_banners_image_fit_check,
  drop constraint if exists cms_banners_image_position_x_check,
  drop constraint if exists cms_banners_image_position_y_check,
  drop constraint if exists cms_banners_mobile_image_fit_check,
  drop constraint if exists cms_banners_mobile_image_position_x_check,
  drop constraint if exists cms_banners_mobile_image_position_y_check;

alter table public.cms_banners
  add constraint cms_banners_mobile_image_url_check check (mobile_image_url is null or mobile_image_url ~ '^https://'),
  add constraint cms_banners_image_fit_check check (image_fit in ('cover','contain','fill')),
  add constraint cms_banners_image_position_x_check check (image_position_x between 0 and 100),
  add constraint cms_banners_image_position_y_check check (image_position_y between 0 and 100),
  add constraint cms_banners_mobile_image_fit_check check (mobile_image_fit in ('cover','contain','fill')),
  add constraint cms_banners_mobile_image_position_x_check check (mobile_image_position_x between 0 and 100),
  add constraint cms_banners_mobile_image_position_y_check check (mobile_image_position_y between 0 and 100);

alter table public.banner_media_uploads
  add column if not exists slot text not null default 'desktop';

alter table public.banner_media_uploads
  drop constraint if exists banner_media_uploads_slot_check;
alter table public.banner_media_uploads
  add constraint banner_media_uploads_slot_check check (slot in ('desktop','mobile'));

create index if not exists banner_media_uploads_banner_slot_idx
  on public.banner_media_uploads(banner_id,slot,created_at desc);

create or replace function public.queue_banner_media_cleanup(p_banner_id uuid,p_upload_id uuid,p_r2_key text,p_uploader_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_upload public.banner_media_uploads%rowtype;
begin
  if auth.role()<>'service_role' then raise exception 'Service role talab qilinadi' using errcode='42501'; end if;
  if exists(select 1 from public.cms_banners where r2_key=p_r2_key or mobile_r2_key=p_r2_key) then
    raise exception 'Banner media ishlatilmoqda' using errcode='P0001';
  end if;
  select * into v_upload from public.banner_media_uploads
    where id=p_upload_id and banner_id=p_banner_id and uploader_id=p_uploader_id and r2_key=p_r2_key for update;
  if not found or v_upload.status not in('pending','verified','delete_pending') then
    raise exception 'Banner upload cleanup uchun topilmadi' using errcode='P0002';
  end if;
  update public.banner_media_uploads set status='delete_pending'
    where id=p_upload_id and status in('pending','verified');
  insert into public.media_cleanup_queue(r2_key,scope,status,next_attempt_at)
    values(p_r2_key,'banners','pending',now())
  on conflict(r2_key) do update set status='pending',next_attempt_at=now(),last_error=null,locked_at=null,lock_token=null;
end $$;

create or replace function public.delete_cms_banner(p_banner_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare v_b public.cms_banners%rowtype;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) then
    raise exception 'Global admin roli talab qilinadi' using errcode='42501';
  end if;
  select * into v_b from public.cms_banners where id=p_banner_id for update;
  if not found then raise exception 'Banner topilmadi' using errcode='P0002'; end if;
  if v_b.is_active and (v_b.starts_at is null or v_b.starts_at<=now()) and (v_b.ends_at is null or v_b.ends_at>now()) then
    raise exception 'Faol banner media faylini o‘chirishdan oldin bannerni faolsizlantiring' using errcode='P0001';
  end if;
  insert into public.media_cleanup_queue(r2_key,scope,status,next_attempt_at)
    values(v_b.r2_key,'banners','pending',now())
  on conflict(r2_key) do update set status='pending',next_attempt_at=now(),last_error=null,locked_at=null,lock_token=null;
  if v_b.mobile_r2_key is not null and v_b.mobile_r2_key<>v_b.r2_key then
    insert into public.media_cleanup_queue(r2_key,scope,status,next_attempt_at)
      values(v_b.mobile_r2_key,'banners','pending',now())
    on conflict(r2_key) do update set status='pending',next_attempt_at=now(),last_error=null,locked_at=null,lock_token=null;
  end if;
  delete from public.cms_banners where id=p_banner_id;
  return v_b.r2_key;
end $$;

create or replace function public.save_cms_banner_v2(
  p_banner jsonb,
  p_desktop_upload_id uuid default null,
  p_mobile_upload_id uuid default null
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_id uuid;
  v_existing public.cms_banners%rowtype;
  v_desktop_upload public.banner_media_uploads%rowtype;
  v_mobile_upload public.banner_media_uploads%rowtype;
  v_result public.cms_banners%rowtype;
  v_image_url text;
  v_r2_key text;
  v_mobile_image_url text;
  v_mobile_r2_key text;
  v_target_url text;
  v_image_fit text;
  v_mobile_image_fit text;
  v_image_position_x smallint;
  v_image_position_y smallint;
  v_mobile_image_position_x smallint;
  v_mobile_image_position_y smallint;
  v_remove_mobile boolean;
begin
  if not public.has_role(array['superadmin','admin']::public.app_role[],null) or jsonb_typeof(p_banner)<>'object' then
    raise exception 'Global admin va banner payloadi talab qilinadi' using errcode='42501';
  end if;
  begin v_id=(p_banner->>'id')::uuid;
  exception when invalid_text_representation then raise exception 'Banner ID noto‘g‘ri' using errcode='22023'; end;
  if v_id is null or nullif(btrim(p_banner->>'title'),'') is null or nullif(btrim(p_banner->>'placement'),'') is null then
    raise exception 'Banner maydonlari noto‘g‘ri' using errcode='22023';
  end if;
  if coalesce((p_banner->>'sort_order')::integer,0)<0 then
    raise exception 'Banner tartib raqami noto‘g‘ri' using errcode='22023';
  end if;

  v_target_url=nullif(btrim(p_banner->>'target_url'),'');
  if v_target_url is not null and not (
    (left(v_target_url,1)='/' and left(v_target_url,2)<>'//')
    or v_target_url ~ '^https://[^[:space:]]+$'
  ) then raise exception 'Banner havolasi ichki /... yoki https://... bo‘lishi kerak' using errcode='22023'; end if;

  begin
    v_image_fit=coalesce(nullif(p_banner->>'image_fit',''),'cover');
    v_mobile_image_fit=coalesce(nullif(p_banner->>'mobile_image_fit',''),'cover');
    v_image_position_x=coalesce((p_banner->>'image_position_x')::smallint,50);
    v_image_position_y=coalesce((p_banner->>'image_position_y')::smallint,50);
    v_mobile_image_position_x=coalesce((p_banner->>'mobile_image_position_x')::smallint,50);
    v_mobile_image_position_y=coalesce((p_banner->>'mobile_image_position_y')::smallint,50);
    v_remove_mobile=coalesce((p_banner->>'remove_mobile_image')::boolean,false);
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Banner rasm muharriri qiymatlari noto‘g‘ri' using errcode='22023';
  end;
  if v_image_fit not in('cover','contain','fill') or v_mobile_image_fit not in('cover','contain','fill')
    or v_image_position_x not between 0 and 100 or v_image_position_y not between 0 and 100
    or v_mobile_image_position_x not between 0 and 100 or v_mobile_image_position_y not between 0 and 100 then
    raise exception 'Banner rasm muharriri qiymatlari noto‘g‘ri' using errcode='22023';
  end if;
  if nullif(p_banner->>'starts_at','') is not null and nullif(p_banner->>'ends_at','') is not null
    and (p_banner->>'starts_at')::timestamptz >= (p_banner->>'ends_at')::timestamptz then
    raise exception 'Banner tugash vaqti boshlanish vaqtidan keyin bo‘lishi kerak' using errcode='22023';
  end if;

  select * into v_existing from public.cms_banners where id=v_id for update;

  if p_desktop_upload_id is not null then
    select * into v_desktop_upload from public.banner_media_uploads
      where id=p_desktop_upload_id and banner_id=v_id and uploader_id=auth.uid() and slot='desktop' and status='verified' for update;
    if not found then raise exception 'Tasdiqlangan desktop banner upload topilmadi' using errcode='P0002'; end if;
    v_image_url=v_desktop_upload.public_url;
    v_r2_key=v_desktop_upload.r2_key;
  elsif v_existing.id is not null then
    v_image_url=v_existing.image_url;
    v_r2_key=v_existing.r2_key;
  else
    raise exception 'Yangi banner uchun desktop upload talab qilinadi' using errcode='22023';
  end if;

  if p_mobile_upload_id is not null then
    select * into v_mobile_upload from public.banner_media_uploads
      where id=p_mobile_upload_id and banner_id=v_id and uploader_id=auth.uid() and slot='mobile' and status='verified' for update;
    if not found then raise exception 'Tasdiqlangan mobile banner upload topilmadi' using errcode='P0002'; end if;
    v_mobile_image_url=v_mobile_upload.public_url;
    v_mobile_r2_key=v_mobile_upload.r2_key;
  elsif v_remove_mobile then
    v_mobile_image_url=null;
    v_mobile_r2_key=null;
  elsif v_existing.id is not null then
    v_mobile_image_url=v_existing.mobile_image_url;
    v_mobile_r2_key=v_existing.mobile_r2_key;
  end if;

  insert into public.cms_banners(
    id,title,image_url,r2_key,mobile_image_url,mobile_r2_key,target_url,placement,sort_order,
    starts_at,ends_at,is_active,image_fit,image_position_x,image_position_y,
    mobile_image_fit,mobile_image_position_x,mobile_image_position_y
  ) values(
    v_id,btrim(p_banner->>'title'),v_image_url,v_r2_key,v_mobile_image_url,v_mobile_r2_key,v_target_url,btrim(p_banner->>'placement'),
    coalesce((p_banner->>'sort_order')::integer,0),nullif(p_banner->>'starts_at','')::timestamptz,
    nullif(p_banner->>'ends_at','')::timestamptz,coalesce((p_banner->>'is_active')::boolean,true),
    v_image_fit,v_image_position_x,v_image_position_y,v_mobile_image_fit,v_mobile_image_position_x,v_mobile_image_position_y
  )
  on conflict(id) do update set
    title=excluded.title,image_url=excluded.image_url,r2_key=excluded.r2_key,
    mobile_image_url=excluded.mobile_image_url,mobile_r2_key=excluded.mobile_r2_key,
    target_url=excluded.target_url,placement=excluded.placement,sort_order=excluded.sort_order,
    starts_at=excluded.starts_at,ends_at=excluded.ends_at,is_active=excluded.is_active,
    image_fit=excluded.image_fit,image_position_x=excluded.image_position_x,image_position_y=excluded.image_position_y,
    mobile_image_fit=excluded.mobile_image_fit,mobile_image_position_x=excluded.mobile_image_position_x,
    mobile_image_position_y=excluded.mobile_image_position_y,updated_at=now()
  returning * into v_result;

  if p_desktop_upload_id is not null then
    update public.banner_media_uploads set status='attached',attached_at=now()
      where id=p_desktop_upload_id and status='verified';
  end if;
  if p_mobile_upload_id is not null then
    update public.banner_media_uploads set status='attached',attached_at=now()
      where id=p_mobile_upload_id and status='verified';
  end if;

  if v_existing.id is not null and v_existing.r2_key<>v_r2_key then
    insert into public.media_cleanup_queue(r2_key,scope,status,next_attempt_at)
      values(v_existing.r2_key,'banners','pending',now())
    on conflict(r2_key) do update set status='pending',next_attempt_at=now(),last_error=null,locked_at=null,lock_token=null;
  end if;
  if v_existing.id is not null and v_existing.mobile_r2_key is not null
    and v_existing.mobile_r2_key is distinct from v_mobile_r2_key then
    insert into public.media_cleanup_queue(r2_key,scope,status,next_attempt_at)
      values(v_existing.mobile_r2_key,'banners','pending',now())
    on conflict(r2_key) do update set status='pending',next_attempt_at=now(),last_error=null,locked_at=null,lock_token=null;
  end if;

  return to_jsonb(v_result);
end $$;

create or replace function public.storefront_cms_payload()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'banners',coalesce((select jsonb_agg(jsonb_build_object(
      'id',b.id,'title',b.title,'image_url',b.image_url,'mobile_image_url',b.mobile_image_url,
      'target_url',b.target_url,'placement',b.placement,'sort_order',b.sort_order,
      'starts_at',b.starts_at,'ends_at',b.ends_at,'image_fit',b.image_fit,
      'image_position_x',b.image_position_x,'image_position_y',b.image_position_y,
      'mobile_image_fit',b.mobile_image_fit,'mobile_image_position_x',b.mobile_image_position_x,
      'mobile_image_position_y',b.mobile_image_position_y
    ) order by b.placement,b.sort_order,b.id) from public.cms_banners b
      where b.is_active and (b.starts_at is null or b.starts_at<=now()) and (b.ends_at is null or b.ends_at>now())),'[]'::jsonb),
    'home_blocks',coalesce((select jsonb_agg(to_jsonb(h) order by h.sort_order,h.id) from public.cms_home_blocks h where h.is_active and (h.starts_at is null or h.starts_at<=now()) and (h.ends_at is null or h.ends_at>now())),'[]'::jsonb),
    'menu_items',coalesce((select jsonb_agg(to_jsonb(m) order by m.location,m.sort_order,m.id) from public.cms_menu_items m where m.is_active),'[]'::jsonb),
    'promotions',coalesce((select jsonb_agg((to_jsonb(p)-'rules')||jsonb_build_object('product_ids',(select coalesce(jsonb_agg(x.product_id),'[]'::jsonb) from public.cms_promotion_products x where x.promotion_id=p.id)) order by p.starts_at,p.id) from public.cms_promotions p where p.is_active and p.starts_at<=now() and p.ends_at>now()),'[]'::jsonb),
    'pages',coalesce((select jsonb_agg(to_jsonb(p)-'created_by'-'updated_by' order by p.slug) from public.cms_pages p where p.is_published and p.published_at<=now()),'[]'::jsonb),
    'settings',coalesce((select jsonb_object_agg(s.key,s.value) from public.system_settings s
      where s.key=any(public.storefront_public_setting_keys())),'{}'::jsonb));
$$;

revoke all on function public.save_cms_banner_v2(jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.save_cms_banner_v2(jsonb,uuid,uuid) to authenticated;
grant execute on function public.save_cms_banner_v2(jsonb,uuid,uuid) to service_role;

commit;
