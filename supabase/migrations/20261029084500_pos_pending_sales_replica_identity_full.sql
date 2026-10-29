-- Migration: 20261029084500_pos_pending_sales_replica_identity_full.sql
-- Description:
-- Set REPLICA IDENTITY FULL on public.pos_pending_sales so Supabase Realtime engine
-- can evaluate RLS policies with all row columns (branch_id, seller_id) for instant realtime events.

BEGIN;

ALTER TABLE public.pos_pending_sales REPLICA IDENTITY FULL;

COMMIT;
