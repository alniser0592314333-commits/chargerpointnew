DO $customer_charger_fee_authority$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.execute_canonical_sync_command_unlocked(uuid,text,jsonb,text,text,uuid)'::regprocedure
  ) INTO v_definition;

  IF position('default_charger_fee_minor' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Canonical order pricing must read default_charger_fee_minor';
  END IF;
  IF position('p_payload->>''chargerFeeSnapshotMinor''' IN v_definition) > 0
     OR position('p_payload->>''charger_fee_snapshot_minor''' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'Canonical order pricing must not trust the client charger-fee snapshot';
  END IF;
  IF position('v_authoritative_charger_fee := COALESCE(v_setting_charger_fee, 50)' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Order-item edit must use the configured charger fee';
  END IF;
  IF position('charger_fee_applicable' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Canonical pricing must retain the device charger-applicability rule';
  END IF;
END
$customer_charger_fee_authority$;
