-- Migration: 20261101010000_audit_prune_batching_and_index.sql
-- Fix: Eski auditlarni tozalashda 8 soniyalik statement_timeout xatoligini bartaraf etish.
-- 1. audit_log(created_at) btree indeksi
-- 2. prune_old_audit_logs funksiyasiga batching (bo'lib-bo'lib tozalash) qo'llash
-- 3. get_audit_stats funksiyasini 1 ta tezkor agregatsiya orqali optimallashtirish

BEGIN;

-- 1. created_at ustuniga tezkor btree indeksi
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON public.audit_log (created_at DESC);

-- 2. Eski funksiyalarni tozalash (overload mojarolarini oldini olish)
DROP FUNCTION IF EXISTS public.prune_old_audit_logs(integer);
DROP FUNCTION IF EXISTS public.prune_old_audit_logs(integer, integer);

CREATE OR REPLACE FUNCTION public.prune_old_audit_logs(
  p_days integer DEFAULT 14,
  p_batch_size integer DEFAULT 5000
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_batch_size integer := coalesce(nullif(p_batch_size, 0), 5000);
  v_deleted_count bigint := 0;
  v_cutoff timestamptz;
  v_has_more boolean := false;
BEGIN
  IF NOT public.has_role(array['superadmin']::public.app_role[], null) THEN
    RAISE EXCEPTION 'Eski audit yozuvlarini tozalash faqat superadmin uchun ruxsat etilgan' USING errcode = '42501';
  END IF;

  IF p_days < 1 THEN
    RAISE EXCEPTION 'Kamida 1 kunlik audit yozuvlari saqlanishi kerak' USING errcode = '22023';
  END IF;

  v_cutoff := now() - (p_days || ' days')::interval;

  PERFORM set_config('texnobazar.audit_cleanup', 'allowed', true);

  -- Index Scan orqali eng eski 5000 tagacha yozuvni tezkor o'chirish (~1 soniya)
  WITH to_delete AS (
    SELECT id FROM public.audit_log
    WHERE created_at < v_cutoff
    ORDER BY created_at ASC
    LIMIT v_batch_size
  )
  DELETE FROM public.audit_log a
  USING to_delete
  WHERE a.id = to_delete.id;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  -- Hali yana o'chirilishi kerak bo'lgan eski yozuvlar bormi? (1 ms tezkor tekshiruv)
  SELECT EXISTS(
    SELECT 1 FROM public.audit_log
    WHERE created_at < v_cutoff
    LIMIT 1
  ) INTO v_has_more;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_count', v_deleted_count,
    'batch_deleted', v_deleted_count,
    'has_more', v_has_more,
    'cutoff', v_cutoff
  );
END;
$$;

-- 3. get_audit_stats ni bitta tezkor agregatsiyaga aylantirish
CREATE OR REPLACE FUNCTION public.get_audit_stats()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_total_rows bigint;
  v_older_1d bigint;
  v_older_3d bigint;
  v_older_7d bigint;
  v_older_14d bigint;
  v_older_30d bigint;
  v_audit_size text;
  v_db_size text;
BEGIN
  IF NOT public.has_role(array['superadmin','admin']::public.app_role[], null) THEN
    RAISE EXCEPTION 'Ruxsat berilmagan' USING errcode = '42501';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE created_at < now() - interval '1 day'),
    count(*) FILTER (WHERE created_at < now() - interval '3 days'),
    count(*) FILTER (WHERE created_at < now() - interval '7 days'),
    count(*) FILTER (WHERE created_at < now() - interval '14 days'),
    count(*) FILTER (WHERE created_at < now() - interval '30 days')
  INTO
    v_total_rows,
    v_older_1d,
    v_older_3d,
    v_older_7d,
    v_older_14d,
    v_older_30d
  FROM public.audit_log;

  SELECT pg_size_pretty(pg_total_relation_size('public.audit_log')) INTO v_audit_size;
  SELECT pg_size_pretty(pg_database_size(current_database())) INTO v_db_size;

  RETURN jsonb_build_object(
    'total_rows', v_total_rows,
    'older_1d', v_older_1d,
    'older_3d', v_older_3d,
    'older_7d', v_older_7d,
    'older_14d', v_older_14d,
    'older_30d', v_older_30d,
    'audit_size', v_audit_size,
    'db_size', v_db_size
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prune_old_audit_logs(integer, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.prune_old_audit_logs(integer, integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_audit_stats() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_audit_stats() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';

COMMIT;
