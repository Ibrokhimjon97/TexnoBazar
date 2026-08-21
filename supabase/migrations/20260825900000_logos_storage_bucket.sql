-- Create a public storage bucket for brand/category logos
insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

-- Allow authenticated users to upload/delete logos
create policy "admin_upload_logos" on storage.objects for insert to authenticated
  with check (bucket_id = 'logos' and public.has_role(array['superadmin','admin']::public.app_role[], null));

create policy "admin_delete_logos" on storage.objects for delete to authenticated
  using (bucket_id = 'logos' and public.has_role(array['superadmin','admin']::public.app_role[], null));

create policy "public_read_logos" on storage.objects for select to anon, authenticated
  using (bucket_id = 'logos');
