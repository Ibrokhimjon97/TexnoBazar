-- Migration: 20261028070000_enable_rls_all_public_tables.sql
-- Description: Resolve Supabase Security Advisor alert "rls_disabled_in_public".
-- Ensures all tables in public schema have Row-Level Security enabled and proper access policies.

BEGIN;

-- 1. Enable RLS and define policies for external_branch_transfers
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'external_branch_transfers') THEN
    ALTER TABLE public.external_branch_transfers ENABLE ROW LEVEL SECURITY;
    
    DROP POLICY IF EXISTS "auth_read_external_transfers" ON public.external_branch_transfers;
    CREATE POLICY "auth_read_external_transfers" ON public.external_branch_transfers
      FOR SELECT TO authenticated USING (true);

    DROP POLICY IF EXISTS "auth_write_external_transfers" ON public.external_branch_transfers;
    CREATE POLICY "auth_write_external_transfers" ON public.external_branch_transfers
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 2. Enable RLS and define policies for external_branch_transfer_lines
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'external_branch_transfer_lines') THEN
    ALTER TABLE public.external_branch_transfer_lines ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "auth_read_ext_transfer_lines" ON public.external_branch_transfer_lines;
    CREATE POLICY "auth_read_ext_transfer_lines" ON public.external_branch_transfer_lines
      FOR SELECT TO authenticated USING (true);

    DROP POLICY IF EXISTS "auth_write_ext_transfer_lines" ON public.external_branch_transfer_lines;
    CREATE POLICY "auth_write_ext_transfer_lines" ON public.external_branch_transfer_lines
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 3. Enable RLS and define policies for product_code_aliases
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'product_code_aliases') THEN
    ALTER TABLE public.product_code_aliases ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "auth_manage_product_code_aliases" ON public.product_code_aliases;
    CREATE POLICY "auth_manage_product_code_aliases" ON public.product_code_aliases
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 4. Enable RLS and define policies for stock_reconciliations & lines
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'stock_reconciliations') THEN
    ALTER TABLE public.stock_reconciliations ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "auth_manage_stock_reconciliations" ON public.stock_reconciliations;
    CREATE POLICY "auth_manage_stock_reconciliations" ON public.stock_reconciliations
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'stock_reconciliation_lines') THEN
    ALTER TABLE public.stock_reconciliation_lines ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "auth_manage_stock_reconciliation_lines" ON public.stock_reconciliation_lines;
    CREATE POLICY "auth_manage_stock_reconciliation_lines" ON public.stock_reconciliation_lines
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 5. Enable RLS and define policies for branch_debt_transfers
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'branch_debt_transfers') THEN
    ALTER TABLE public.branch_debt_transfers ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "auth_manage_branch_debt_transfers" ON public.branch_debt_transfers;
    CREATE POLICY "auth_manage_branch_debt_transfers" ON public.branch_debt_transfers
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 6. Universal guard: Enable RLS on ANY table in public that currently has rowsecurity = false
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN 
    SELECT tablename 
    FROM pg_tables 
    WHERE schemaname = 'public' 
      AND rowsecurity = false
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    RAISE NOTICE 'Universal guard enabled RLS on public.%', t;
  END LOOP;
END $$;

COMMIT;
