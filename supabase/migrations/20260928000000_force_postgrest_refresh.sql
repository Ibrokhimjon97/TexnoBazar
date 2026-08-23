-- Force PostgREST schema cache refresh
-- This is a no-op migration that only notifies PostgREST to reload.
-- Sometimes PostgREST needs multiple reload signals after function signature changes.

begin;
notify pgrst, 'reload schema';
notify pgrst, 'reload config';
commit;
