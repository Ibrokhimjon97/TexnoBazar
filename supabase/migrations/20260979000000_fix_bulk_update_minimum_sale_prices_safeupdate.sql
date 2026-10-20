-- Migration 20260979000000: Fix safeupdate requirement in bulk_update_minimum_sale_prices
-- Every UPDATE must have an explicit WHERE clause to satisfy Postgres safeupdate extension.

CREATE OR REPLACE FUNCTION public.bulk_update_minimum_sale_prices(
  p_branch_id uuid DEFAULT NULL,
  p_mode text DEFAULT 'zero',
  p_percent numeric DEFAULT 0,
  p_receipt_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_mode text := lower(btrim(p_mode));
  v_pct numeric := coalesce(p_percent, 0);
  v_rate numeric;
  v_updated_batches integer := 0;
  v_updated_products integer := 0;
  v_updated_variants integer := 0;
  v_has_receipts boolean := (p_receipt_ids IS NOT NULL AND array_length(p_receipt_ids, 1) > 0);
BEGIN
  IF current_user <> 'postgres' 
     AND coalesce(current_setting('role', true), '') <> 'service_role'
     AND NOT (public.has_role(array['superadmin','admin']::public.app_role[], null) OR public.is_any_manager()) THEN
    RAISE EXCEPTION 'Minimal narxlarni o‘zgartirish uchun admin yoki menejer roli talab qilinadi' USING errcode = '42501';
  END IF;

  IF v_mode NOT IN ('zero', 'percent') THEN
    RAISE EXCEPTION 'Noto‘g‘ri rejim: faqat "zero" yoki "percent" bo‘lishi mumkin' USING errcode = '22023';
  END IF;

  IF v_pct < 0 THEN
    RAISE EXCEPTION 'Foiz manfiy bo‘lishi mumkin emas' USING errcode = '22023';
  END IF;

  v_rate := coalesce(public.get_effective_exchange_rate('USD', 'UZS'), 12800);
  IF v_rate <= 0 THEN v_rate := 12800; END IF;

  IF v_mode = 'zero' THEN
    -- 1. Update stock_batches
    WITH updated_b AS (
      UPDATE public.stock_batches sb
      SET minimum_sale_price = 0,
          minimum_sale_price_usd = 0
      FROM public.stock_receipts sr
      WHERE sr.id = sb.receipt_id
        AND (p_branch_id IS NULL OR sr.branch_id = p_branch_id)
        AND (NOT v_has_receipts OR sb.receipt_id = ANY(p_receipt_ids))
      RETURNING sb.id, sb.product_id, sb.variant_id
    )
    SELECT count(*), count(DISTINCT product_id)
    INTO v_updated_batches, v_updated_products
    FROM updated_b;

    -- 2. Update products
    IF v_has_receipts THEN
      UPDATE public.products p
      SET minimum_sale_price = 0,
          minimum_sale_price_usd = 0,
          updated_at = now()
      WHERE p.id IN (
        SELECT DISTINCT sb.product_id
        FROM public.stock_batches sb
        WHERE sb.receipt_id = ANY(p_receipt_ids)
      );
    ELSE
      UPDATE public.products p
      SET minimum_sale_price = 0,
          minimum_sale_price_usd = 0,
          updated_at = now()
      WHERE p.id IS NOT NULL
        AND (
          p_branch_id IS NULL
          OR p.id IN (
            SELECT DISTINCT sb2.product_id
            FROM public.stock_batches sb2
            JOIN public.stock_receipts sr2 ON sr2.id = sb2.receipt_id
            WHERE sr2.branch_id = p_branch_id
          )
        );
      GET DIAGNOSTICS v_updated_products = ROW_COUNT;
    END IF;

    -- 3. Update product_variants
    IF v_has_receipts THEN
      UPDATE public.product_variants pv
      SET minimum_sale_price = 0,
          minimum_sale_price_usd = 0,
          updated_at = now()
      WHERE pv.id IN (
        SELECT DISTINCT sb.variant_id
        FROM public.stock_batches sb
        WHERE sb.receipt_id = ANY(p_receipt_ids) AND sb.variant_id IS NOT NULL
      );
    ELSE
      UPDATE public.product_variants pv
      SET minimum_sale_price = 0,
          minimum_sale_price_usd = 0,
          updated_at = now()
      WHERE pv.id IS NOT NULL
        AND (
          p_branch_id IS NULL
          OR pv.id IN (
            SELECT DISTINCT sb2.variant_id
            FROM public.stock_batches sb2
            JOIN public.stock_receipts sr2 ON sr2.id = sb2.receipt_id
            WHERE sr2.branch_id = p_branch_id AND sb2.variant_id IS NOT NULL
          )
        );
      GET DIAGNOSTICS v_updated_variants = ROW_COUNT;
    END IF;

  ELSIF v_mode = 'percent' THEN
    -- Mode: percent (minimum_sale_price = cost_price + (cost_price * v_pct / 100))
    -- Must strictly respect products_minimum_sale_price_chk (minimum_sale_price >= 0 AND minimum_sale_price <= retail_price).

    -- 1. Update stock_batches
    WITH updated_b AS (
      UPDATE public.stock_batches sb
      SET minimum_sale_price = GREATEST(
            0,
            LEAST(
              round(
                CASE 
                  WHEN sb.unit_cost > 0 THEN sb.unit_cost * (1.0 + (v_pct / 100.0))
                  WHEN sb.unit_cost_usd > 0 THEN (sb.unit_cost_usd * (1.0 + (v_pct / 100.0))) * v_rate
                  WHEN p.cost_price > 0 THEN p.cost_price * (1.0 + (v_pct / 100.0))
                  WHEN p.cost_price_usd > 0 THEN (p.cost_price_usd * (1.0 + (v_pct / 100.0))) * v_rate
                  ELSE 0
                END
              ),
              coalesce(nullif(sb.retail_price, 0), nullif(p.retail_price, 0), 999999999999)
            )
          ),
          minimum_sale_price_usd = GREATEST(
            0,
            LEAST(
              round(
                CASE 
                  WHEN sb.unit_cost_usd > 0 THEN sb.unit_cost_usd * (1.0 + (v_pct / 100.0))
                  WHEN sb.unit_cost > 0 THEN (sb.unit_cost * (1.0 + (v_pct / 100.0))) / v_rate
                  WHEN p.cost_price_usd > 0 THEN p.cost_price_usd * (1.0 + (v_pct / 100.0))
                  WHEN p.cost_price > 0 THEN (p.cost_price * (1.0 + (v_pct / 100.0))) / v_rate
                  ELSE 0
                END,
                2
              ),
              coalesce(nullif(sb.retail_price_usd, 0), nullif(p.retail_price_usd, 0), 999999999)
            )
          )
      FROM public.products p, public.stock_receipts sr
      WHERE p.id = sb.product_id
        AND sr.id = sb.receipt_id
        AND (p_branch_id IS NULL OR sr.branch_id = p_branch_id)
        AND (NOT v_has_receipts OR sb.receipt_id = ANY(p_receipt_ids))
      RETURNING sb.id, sb.product_id, sb.variant_id
    )
    SELECT count(*), count(DISTINCT product_id)
    INTO v_updated_batches, v_updated_products
    FROM updated_b;

    -- 2. Update products
    -- Respect products_minimum_sale_price_chk (0 <= minimum_sale_price <= retail_price)
    IF v_has_receipts THEN
      UPDATE public.products p
      SET minimum_sale_price = CASE 
            WHEN coalesce(p.retail_price, 0) <= 0 THEN 0
            ELSE GREATEST(
              0,
              LEAST(
                round(
                  CASE 
                    WHEN p.cost_price > 0 THEN p.cost_price * (1.0 + (v_pct / 100.0))
                    WHEN p.cost_price_usd > 0 THEN (p.cost_price_usd * (1.0 + (v_pct / 100.0))) * v_rate
                    ELSE 0
                  END
                ),
                p.retail_price
              )
            )
          END,
          minimum_sale_price_usd = CASE 
            WHEN coalesce(p.retail_price, 0) <= 0 OR coalesce(p.retail_price_usd, 0) <= 0 THEN 0
            ELSE GREATEST(
              0,
              LEAST(
                round(
                  CASE 
                    WHEN p.cost_price_usd > 0 THEN p.cost_price_usd * (1.0 + (v_pct / 100.0))
                    WHEN p.cost_price > 0 THEN (p.cost_price * (1.0 + (v_pct / 100.0))) / v_rate
                    ELSE 0
                  END,
                  2
                ),
                coalesce(nullif(p.retail_price_usd, 0), 999999999)
              )
            )
          END,
          updated_at = now()
      WHERE p.id IN (
        SELECT DISTINCT sb.product_id
        FROM public.stock_batches sb
        WHERE sb.receipt_id = ANY(p_receipt_ids)
      );
    ELSE
      UPDATE public.products p
      SET minimum_sale_price = CASE 
            WHEN coalesce(p.retail_price, 0) <= 0 THEN 0
            ELSE GREATEST(
              0,
              LEAST(
                round(
                  CASE 
                    WHEN p.cost_price > 0 THEN p.cost_price * (1.0 + (v_pct / 100.0))
                    WHEN p.cost_price_usd > 0 THEN (p.cost_price_usd * (1.0 + (v_pct / 100.0))) * v_rate
                    ELSE 0
                  END
                ),
                p.retail_price
              )
            )
          END,
          minimum_sale_price_usd = CASE 
            WHEN coalesce(p.retail_price, 0) <= 0 OR coalesce(p.retail_price_usd, 0) <= 0 THEN 0
            ELSE GREATEST(
              0,
              LEAST(
                round(
                  CASE 
                    WHEN p.cost_price_usd > 0 THEN p.cost_price_usd * (1.0 + (v_pct / 100.0))
                    WHEN p.cost_price > 0 THEN (p.cost_price * (1.0 + (v_pct / 100.0))) / v_rate
                    ELSE 0
                  END,
                  2
                ),
                coalesce(nullif(p.retail_price_usd, 0), 999999999)
              )
            )
          END,
          updated_at = now()
      WHERE p.id IS NOT NULL
        AND (
          p_branch_id IS NULL
          OR p.id IN (
            SELECT DISTINCT sb2.product_id
            FROM public.stock_batches sb2
            JOIN public.stock_receipts sr2 ON sr2.id = sb2.receipt_id
            WHERE sr2.branch_id = p_branch_id
          )
        );
      GET DIAGNOSTICS v_updated_products = ROW_COUNT;
    END IF;

    -- 3. Update product_variants
    IF v_has_receipts THEN
      UPDATE public.product_variants pv
      SET minimum_sale_price = CASE
            WHEN coalesce(pv.retail_price, 0) <= 0 THEN 0
            ELSE GREATEST(
              0,
              LEAST(
                round(
                  CASE 
                    WHEN pv.cost_price > 0 THEN pv.cost_price * (1.0 + (v_pct / 100.0))
                    WHEN pv.cost_price_usd > 0 THEN (pv.cost_price_usd * (1.0 + (v_pct / 100.0))) * v_rate
                    ELSE 0
                  END
                ),
                coalesce(nullif(pv.retail_price, 0), 999999999999)
              )
            )
          END,
          minimum_sale_price_usd = CASE
            WHEN coalesce(pv.retail_price, 0) <= 0 OR coalesce(pv.retail_price_usd, 0) <= 0 THEN 0
            ELSE GREATEST(
              0,
              LEAST(
                round(
                  CASE 
                    WHEN pv.cost_price_usd > 0 THEN pv.cost_price_usd * (1.0 + (v_pct / 100.0))
                    WHEN pv.cost_price > 0 THEN (pv.cost_price * (1.0 + (v_pct / 100.0))) / v_rate
                    ELSE 0
                  END,
                  2
                ),
                coalesce(nullif(pv.retail_price_usd, 0), 999999999)
              )
            )
          END,
          updated_at = now()
      WHERE pv.id IN (
        SELECT DISTINCT sb.variant_id
        FROM public.stock_batches sb
        WHERE sb.receipt_id = ANY(p_receipt_ids) AND sb.variant_id IS NOT NULL
      );
    ELSE
      UPDATE public.product_variants pv
      SET minimum_sale_price = CASE
            WHEN coalesce(pv.retail_price, 0) <= 0 THEN 0
            ELSE GREATEST(
              0,
              LEAST(
                round(
                  CASE 
                    WHEN pv.cost_price > 0 THEN pv.cost_price * (1.0 + (v_pct / 100.0))
                    WHEN pv.cost_price_usd > 0 THEN (pv.cost_price_usd * (1.0 + (v_pct / 100.0))) * v_rate
                    ELSE 0
                  END
                ),
                coalesce(nullif(pv.retail_price, 0), 999999999999)
              )
            )
          END,
          minimum_sale_price_usd = CASE
            WHEN coalesce(pv.retail_price, 0) <= 0 OR coalesce(pv.retail_price_usd, 0) <= 0 THEN 0
            ELSE GREATEST(
              0,
              LEAST(
                round(
                  CASE 
                    WHEN pv.cost_price_usd > 0 THEN pv.cost_price_usd * (1.0 + (v_pct / 100.0))
                    WHEN pv.cost_price > 0 THEN (pv.cost_price * (1.0 + (v_pct / 100.0))) / v_rate
                    ELSE 0
                  END,
                  2
                ),
                coalesce(nullif(pv.retail_price_usd, 0), 999999999)
              )
            )
          END,
          updated_at = now()
      WHERE pv.id IS NOT NULL
        AND (
          p_branch_id IS NULL
          OR pv.id IN (
            SELECT DISTINCT sb2.variant_id
            FROM public.stock_batches sb2
            JOIN public.stock_receipts sr2 ON sr2.id = sb2.receipt_id
            WHERE sr2.branch_id = p_branch_id AND sb2.variant_id IS NOT NULL
          )
        );
      GET DIAGNOSTICS v_updated_variants = ROW_COUNT;
    END IF;

  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'mode', v_mode,
    'percent', v_pct,
    'rate', v_rate,
    'updated_batches', v_updated_batches,
    'updated_products', v_updated_products,
    'updated_variants', v_updated_variants
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bulk_update_minimum_sale_prices(uuid, text, numeric, uuid[]) TO authenticated, service_role, anon;
