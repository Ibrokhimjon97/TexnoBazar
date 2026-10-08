-- Add image_url column to categories table
alter table public.categories
  add column if not exists image_url text;

-- Add constraint to ensure image_url is a valid https URL if provided
do $$
begin
  if not exists(
    select 1 from pg_constraint 
    where conrelid='public.categories'::regclass 
    and conname='categories_image_url_chk'
  ) then
    alter table public.categories 
      add constraint categories_image_url_chk 
      check(image_url is null or image_url ~ '^https://');
  end if;
end $$;
