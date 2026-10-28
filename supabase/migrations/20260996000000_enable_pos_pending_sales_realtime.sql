-- Migration: Enable realtime for pos_pending_sales
-- Ensures manager cashier page receives instant updates without refresh when sellers submit sales.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables 
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'pos_pending_sales'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.pos_pending_sales;
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
