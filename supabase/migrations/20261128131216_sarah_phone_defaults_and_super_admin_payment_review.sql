-- Sarah order defaults and payment approval permission parity.
--
-- Policy:
--   * A generic phone with no brand/model resolves to the Xiaomi catalog type.
--   * An omitted charger flag means the item arrived WITHOUT a charger.
--   * Explicit non-boolean charger values remain invalid.
--   * Super Admin approval is authorized by role in the same way as the
--     canonical permission helper; ordinary admins still need live permissions.
--
-- Keep the existing RPC signatures, idempotency, customer/session proofs,
-- canonical order commands, and canonical payment/BIN verification intact.

DO $migration$
DECLARE
  v_def text;
  v_old text;
  v_new text;
  v_changed integer;
BEGIN
  -- Patch the existing, already-secured order creation RPC without replacing
  -- its large body or changing its permission/idempotency behavior.
  v_def := pg_catalog.pg_get_functiondef(
    'public.sarah_ai_create_order_with_items(uuid,text,text,jsonb,text)'::regprocedure
  );

  v_old := 'v_item_name:=pg_catalog.btrim(COALESCE(v_item->>''device_name'',v_item->>''deviceName'',''''));';
  v_new := 'v_item_name:=pg_catalog.btrim(COALESCE(NULLIF(v_item->>''device_name'',''''),NULLIF(v_item->>''deviceName'',''''),''هاتف شاومي''));' || E'\n' ||
    '    IF pg_catalog.lower(v_item_name) IN (''جوال'',''هاتف'',''موبايل'',''جهاز جوال'',''phone'',''mobile'',''smartphone'',''cellphone'') THEN v_item_name:=''هاتف شاومي''; END IF;';
  IF pg_catalog.strpos(v_def, v_old) = 0 THEN
    RAISE EXCEPTION 'Sarah order RPC device-name default patch did not match the deployed function';
  END IF;
  v_def := pg_catalog.replace(v_def, v_old, v_new);

  v_old := $old$
    IF pg_catalog.jsonb_typeof(COALESCE(v_item->'has_charger',v_item->'hasCharger')) IS DISTINCT FROM 'boolean' THEN
      v_result:=jsonb_build_object('ok',false,'error','ITEM_CHARGER_SELECTION_REQUIRED','item_index',v_item_index);
      RETURN v_result;
    END IF;
    v_has_charger:=COALESCE((v_item->>'has_charger')::boolean,(v_item->>'hasCharger')::boolean,false);
$old$;
  v_new := $new$
    IF (v_item ? 'has_charger' AND pg_catalog.jsonb_typeof(v_item->'has_charger') NOT IN ('boolean','null'))
       OR (v_item ? 'hasCharger' AND pg_catalog.jsonb_typeof(v_item->'hasCharger') NOT IN ('boolean','null')) THEN
      v_result:=jsonb_build_object('ok',false,'error','ITEM_CHARGER_SELECTION_INVALID','item_index',v_item_index);
      RETURN v_result;
    END IF;
    -- Missing or JSON null means no charger. Only an explicit true means with charger.
    v_has_charger:=COALESCE((v_item->>'has_charger')::boolean,(v_item->>'hasCharger')::boolean,false);
$new$;
  IF pg_catalog.strpos(v_def, v_old) = 0 THEN
    RAISE EXCEPTION 'Sarah order RPC charger-default patch did not match the deployed function';
  END IF;
  v_def := pg_catalog.replace(v_def, v_old, v_new);
  EXECUTE v_def;

  -- The manual payment flow creates a pending submission and then delegates
  -- approval to review_qr_payment_submission. That canonical reviewer used to
  -- require finance:approve-payment in the raw permission array even for a
  -- Super Admin, unlike the app's _cp_assert_active_admin_permission helper.
  -- Super Admin role is now an explicit server-side alternative; ordinary
  -- admins remain subject to their current effective permission set.
  v_def := pg_catalog.pg_get_functiondef(
    'public.review_qr_payment_submission(uuid,text,text,text,bigint)'::regprocedure
  );
  v_old := $old$
  IF v_admin_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.get_effective_permissions(v_admin_id)
    WHERE permission = 'finance:approve-payment'
  ) THEN
$old$;
  v_new := $new$
  IF v_admin_id IS NULL OR (
    NOT EXISTS (
      SELECT 1 FROM public.get_effective_permissions(v_admin_id)
      WHERE permission = 'finance:approve-payment'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.admins a
      WHERE a.id = v_admin_id
        AND a.role IN ('SUPER_ADMIN', 'Super Admin')
    )
  ) THEN
$new$;
  IF pg_catalog.strpos(v_def, v_old) = 0 THEN
    RAISE EXCEPTION 'Payment reviewer Super Admin permission patch did not match the deployed function';
  END IF;
  v_def := pg_catalog.replace(v_def, v_old, v_new);
  EXECUTE v_def;
END
$migration$;
