-- Migration: 20260971000000_convert_stock_receipts_currency.sql
-- Partiyalar yoki inventarizatsiyalarni UZS dan USD ga (yoki aksincha) o'tkazish funksiyasi.
-- Tan narxlari, sotish narxlari va tovarlarning valyuta konstantasi konvertatsiya qilinadi.

CREATE OR REPLACE FUNCTION public.convert_stock_receipts_currency(
  p_receipt_ids uuid[],
  p_target_currency text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target_curr text := UPPER(btrim(p_target_currency));
  v_rate numeric;
  v_rec record;
  v_batch record;
  v_count integer := 0;
  v_batch_count integer := 0;
  v_prod_count integer := 0;
  v_uc numeric(18,2);
  v_uc_usd numeric(18,2);
  v_rp numeric(18,2);
  v_rp_usd numeric(18,2);
  v_wp numeric(18,2);
  v_wp_usd numeric(18,2);
  v_mp numeric(18,2);
  v_mp_usd numeric(18,2);
BEGIN
  IF NOT (public.has_role(array['superadmin','admin']::public.app_role[], null) OR public.is_any_manager()) THEN
    RAISE EXCEPTION 'Valyutani o‘zgartirish uchun admin yoki menejer roli talab qilinadi' USING errcode = '42501';
  END IF;

  IF v_target_curr NOT IN ('USD', 'UZS') THEN
    RAISE EXCEPTION 'Faqat USD yoki UZS valyutasiga o‘tkazish mumkin' USING errcode = '22023';
  END IF;

  IF p_receipt_ids IS NULL OR array_length(p_receipt_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'updated_receipts', 0);
  END IF;

  v_rate := coalesce(public.get_effective_exchange_rate('USD', 'UZS'), 12800);
  IF v_rate <= 0 THEN v_rate := 12800; END IF;

  FOR v_rec IN 
    SELECT id, receipt_no, currency, branch_id 
    FROM public.stock_receipts 
    WHERE id = ANY(p_receipt_ids)
    FOR UPDATE
  LOOP
    IF v_rec.currency IS DISTINCT FROM v_target_curr THEN
      UPDATE public.stock_receipts 
      SET currency = v_target_curr,
          updated_at = now()
      WHERE id = v_rec.id;

      FOR v_batch IN
        SELECT id, product_id, variant_id, quantity, unit_cost, unit_cost_usd, retail_price, retail_price_usd, wholesale_price, wholesale_price_usd, minimum_sale_price, minimum_sale_price_usd
        FROM public.stock_batches
        WHERE receipt_id = v_rec.id
        FOR UPDATE
      LOOP
        IF v_target_curr = 'USD' THEN
          -- UZS -> USD: Bugungi valyuta kursida USD ga o'zgaradi va tannarxi USD da konstanta bo'ladi
          v_uc_usd := CASE 
            WHEN v_batch.unit_cost > 0 THEN round(v_batch.unit_cost / v_rate, 2)
            WHEN v_batch.unit_cost_usd IS NOT NULL AND v_batch.unit_cost_usd > 0 THEN v_batch.unit_cost_usd
            ELSE 0
          END;
          v_uc := round(v_uc_usd * v_rate);

          v_rp_usd := CASE 
            WHEN v_batch.retail_price > 0 THEN round(v_batch.retail_price / v_rate, 2)
            WHEN v_batch.retail_price_usd IS NOT NULL AND v_batch.retail_price_usd > 0 THEN v_batch.retail_price_usd
            ELSE 0
          END;
          v_rp := round(v_rp_usd * v_rate);

          v_wp_usd := CASE 
            WHEN v_batch.wholesale_price > 0 THEN round(v_batch.wholesale_price / v_rate, 2)
            WHEN v_batch.wholesale_price_usd IS NOT NULL AND v_batch.wholesale_price_usd > 0 THEN v_batch.wholesale_price_usd
            ELSE NULL
          END;
          v_wp := CASE WHEN v_wp_usd IS NOT NULL THEN round(v_wp_usd * v_rate) ELSE NULL END;

          v_mp_usd := CASE 
            WHEN v_batch.minimum_sale_price > 0 THEN round(v_batch.minimum_sale_price / v_rate, 2)
            WHEN v_batch.minimum_sale_price_usd IS NOT NULL AND v_batch.minimum_sale_price_usd > 0 THEN v_batch.minimum_sale_price_usd
            ELSE NULL
          END;
          v_mp := CASE WHEN v_mp_usd IS NOT NULL THEN round(v_mp_usd * v_rate) ELSE NULL END;
        ELSE
          -- USD -> UZS: Bugungi kursda So'm qiymatini konstanta qilamiz
          v_uc := CASE 
            WHEN v_batch.unit_cost_usd > 0 THEN round(v_batch.unit_cost_usd * v_rate)
            WHEN v_batch.unit_cost IS NOT NULL AND v_batch.unit_cost > 0 THEN v_batch.unit_cost
            ELSE 0
          END;
          v_uc_usd := round(v_uc / v_rate, 2);

          v_rp := CASE 
            WHEN v_batch.retail_price_usd > 0 THEN round(v_batch.retail_price_usd * v_rate)
            WHEN v_batch.retail_price IS NOT NULL AND v_batch.retail_price > 0 THEN v_batch.retail_price
            ELSE 0
          END;
          v_rp_usd := round(v_rp / v_rate, 2);

          v_wp := CASE 
            WHEN v_batch.wholesale_price_usd > 0 THEN round(v_batch.wholesale_price_usd * v_rate)
            WHEN v_batch.wholesale_price IS NOT NULL AND v_batch.wholesale_price > 0 THEN v_batch.wholesale_price
            ELSE NULL
          END;
          v_wp_usd := CASE WHEN v_wp IS NOT NULL THEN round(v_wp / v_rate, 2) ELSE NULL END;

          v_mp := CASE 
            WHEN v_batch.minimum_sale_price_usd > 0 THEN round(v_batch.minimum_sale_price_usd * v_rate)
            WHEN v_batch.minimum_sale_price IS NOT NULL AND v_batch.minimum_sale_price > 0 THEN v_batch.minimum_sale_price
            ELSE NULL
          END;
          v_mp_usd := CASE WHEN v_mp IS NOT NULL THEN round(v_mp / v_rate, 2) ELSE NULL END;
        END IF;

        UPDATE public.stock_batches
        SET currency = v_target_curr,
            unit_cost = v_uc,
            unit_cost_usd = v_uc_usd,
            retail_price = v_rp,
            retail_price_usd = v_rp_usd,
            wholesale_price = v_wp,
            wholesale_price_usd = v_wp_usd,
            minimum_sale_price = v_mp,
            minimum_sale_price_usd = v_mp_usd
        WHERE id = v_batch.id;

        v_batch_count := v_batch_count + 1;

        -- Tovarning o'zining narx va valyutasini ham yangilash
        UPDATE public.products
        SET currency = v_target_curr,
            cost_price = v_uc,
            cost_price_usd = v_uc_usd,
            retail_price = v_rp,
            retail_price_usd = v_rp_usd,
            wholesale_price = v_wp,
            wholesale_price_usd = v_wp_usd,
            minimum_sale_price = coalesce(v_mp, 0),
            minimum_sale_price_usd = coalesce(v_mp_usd, 0),
            updated_at = now()
        WHERE id = v_batch.product_id;

        IF v_batch.variant_id IS NOT NULL THEN
          UPDATE public.product_variants
          SET cost_price = v_uc,
              cost_price_usd = v_uc_usd,
              retail_price = v_rp,
              retail_price_usd = v_rp_usd,
              wholesale_price = v_wp,
              wholesale_price_usd = v_wp_usd,
              minimum_sale_price = coalesce(v_mp, 0),
              minimum_sale_price_usd = coalesce(v_mp_usd, 0),
              updated_at = now()
          WHERE id = v_batch.variant_id;
        END IF;

        v_prod_count := v_prod_count + 1;
      END LOOP;

      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'rate', v_rate,
    'target_currency', v_target_curr,
    'updated_receipts', v_count,
    'updated_batches', v_batch_count,
    'updated_products', v_prod_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.convert_stock_receipts_currency(uuid[], text) TO authenticated, service_role;
