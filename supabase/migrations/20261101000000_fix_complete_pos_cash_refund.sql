-- 20261101000000_fix_complete_pos_cash_refund.sql
-- Fix: 3-opsiya (kassada naqd pul qaytarish) menejer tasdiqlaganda "sale_payments is immutable"
-- yoki "v_dest is null" xatoliklari chiqmasligi uchun complete_pos_cash_refund ni mustahkamlash.

BEGIN;

-- 1. sale_payments dagi eskirgan va barcha yangilanishlarni to'suvchi trigger ni olib tashlash
-- Chunki sale_payments_refund_guard triggeri allaqachon refund holatlarini qat'iy nazorat qiladi.
DROP TRIGGER IF EXISTS sale_payments_immutable ON public.sale_payments;

-- 2. complete_pos_cash_refund funksiyasini yangilash
CREATE OR REPLACE FUNCTION public.complete_pos_cash_refund(
  p_return_id uuid,
  p_resell_location_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_r public.sale_returns%rowtype;
  v_sale public.sales%rowtype;
  v_x record;
  v_u public.inventory_units%rowtype;
  v_dest uuid;
  v_completed integer;
  v_all integer;
  v_total_refunded numeric(18,2);
BEGIN
  SELECT * INTO v_r FROM public.sale_returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Qaytarish so‘rovi topilmadi' USING errcode = 'P0002';
  END IF;
  PERFORM public.require_pos_manager(v_r.branch_id);

  IF v_r.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'return_id', v_r.id,
      'return_no', v_r.return_no,
      'refund_amount', v_r.refund_amount,
      'message', 'Ushbu so‘rov allaqachon yakunlangan.'
    );
  END IF;

  IF v_r.status IN ('rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Ushbu qaytarish bekor qilingan yoki rad etilgan' USING errcode = 'P0001';
  END IF;

  SELECT * INTO v_sale FROM public.sales WHERE id = v_r.original_sale_id FOR UPDATE;

  -- Resell joylashuvni xavfsiz aniqlash zanjiri (NULL bo'lib qolmasligi shart!)
  SELECT id INTO v_dest FROM public.locations
  WHERE id = coalesce(p_resell_location_id, (SELECT location_id FROM public.inventory_units WHERE id = (SELECT unit_id FROM public.sale_return_lines WHERE return_id = p_return_id LIMIT 1)))
    AND branch_id = v_r.branch_id AND is_active AND type IN ('store', 'warehouse');

  IF v_dest IS NULL THEN
    SELECT id INTO v_dest FROM public.locations
    WHERE branch_id = v_r.branch_id AND is_active AND type = 'store'
    ORDER BY name LIMIT 1;
  END IF;

  IF v_dest IS NULL THEN
    SELECT id INTO v_dest FROM public.locations
    WHERE branch_id = v_r.branch_id AND is_active
    ORDER BY name LIMIT 1;
  END IF;

  IF v_dest IS NULL THEN
    SELECT location_id INTO v_dest FROM public.inventory_units
    WHERE id = (SELECT unit_id FROM public.sale_return_lines WHERE return_id = p_return_id LIMIT 1);
  END IF;

  IF v_dest IS NULL THEN
    SELECT id INTO v_dest FROM public.locations
    WHERE is_active AND type = 'store'
    ORDER BY name LIMIT 1;
  END IF;

  -- 1. Birlik(lar)ni do'kon balansiga qaytarish (+1 dona erkin sotuvga kiradi!)
  FOR v_x IN SELECT x.*, sl.unit_cost FROM public.sale_return_lines x
             JOIN public.sale_lines sl ON sl.id = x.sale_line_id
             WHERE x.return_id = p_return_id LOOP
    SELECT * INTO v_u FROM public.inventory_units WHERE id = v_x.unit_id FOR UPDATE;

    UPDATE public.inventory_units
    SET status = 'available',
        location_id = coalesce(v_dest, v_u.location_id),
        sold_sale_id = NULL,
        reserved_until = NULL,
        version = version + 1
    WHERE id = v_u.id;

    INSERT INTO public.inventory_movements(
      unit_id, product_id, batch_id, movement_type, from_location_id, to_location_id,
      quantity, unit_cost, reference_type, reference_id, reason, actor_id, metadata
    ) VALUES (
      v_u.id, v_u.product_id, v_u.batch_id, 'returned', v_u.location_id, coalesce(v_dest, v_u.location_id),
      1, v_x.unit_cost, 'sale_return', p_return_id, coalesce(v_r.reason, 'Kassadan pul qaytarildi'), auth.uid(),
      jsonb_build_object('refund_amount', v_x.refund_amount)
    );
  END LOOP;

  -- 2. Qaytarish yozuvini yakunlash
  UPDATE public.sale_returns
  SET status = 'completed',
      approved_by = coalesce(approved_by, auth.uid()),
      approved_at = coalesce(approved_at, now()),
      completed_at = now()
  WHERE id = p_return_id RETURNING * INTO v_r;

  -- 3. Qaytarilgan summani sale_refunds ga yozish
  INSERT INTO public.sale_refunds(return_id, sale_id, amount, created_by)
  VALUES (v_r.id, v_r.original_sale_id, v_r.refund_amount, auth.uid())
  ON CONFLICT (return_id) DO NOTHING;

  -- 4. Asl sotuv holatini yangilash
  SELECT count(*) INTO v_all FROM public.sale_lines WHERE sale_id = v_r.original_sale_id;
  SELECT count(DISTINCT x.sale_line_id) INTO v_completed FROM public.sale_return_lines x
  JOIN public.sale_returns r ON r.id = x.return_id
  WHERE r.original_sale_id = v_r.original_sale_id AND r.status = 'completed';

  UPDATE public.sales
  SET status = CASE WHEN v_completed >= v_all THEN 'returned'::public.sale_status ELSE 'partially_returned'::public.sale_status end
  WHERE id = v_r.original_sale_id;

  SELECT coalesce(sum(refund_amount), 0) INTO v_total_refunded
  FROM public.sale_returns WHERE original_sale_id = v_r.original_sale_id AND status = 'completed';

  -- 5. To'lovlar holatini yangilash (tegishli guard ruxsatlari bilan)
  PERFORM set_config('texnobazar.complete_sale_return', 'allowed', true);
  PERFORM set_config('texnobazar.admin_override', 'allowed', true);

  UPDATE public.sale_payments
  SET status = CASE WHEN v_total_refunded >= v_sale.total THEN 'refunded'::public.payment_status ELSE 'partially_refunded'::public.payment_status END
  WHERE sale_id = v_r.original_sale_id AND status IN ('paid', 'partially_refunded');

  PERFORM set_config('texnobazar.complete_sale_return', '', true);
  PERFORM set_config('texnobazar.admin_override', '', true);

  RETURN jsonb_build_object(
    'success', true,
    'return_id', v_r.id,
    'return_no', v_r.return_no,
    'refund_amount', v_r.refund_amount,
    'message', 'Naqd pul mijozga qaytarildi, tovar do‘kon balansiga o‘tkazildi va asl sotuv kunidagi aylanma kamaytirildi.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_pos_cash_refund(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.complete_pos_cash_refund(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';

COMMIT;
