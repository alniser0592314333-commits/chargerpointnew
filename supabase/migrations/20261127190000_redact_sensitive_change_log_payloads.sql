BEGIN;

-- Remove credentials and verification secrets recursively before a payload
-- enters the canonical change log. Keep all non-secret business/audit fields.
CREATE OR REPLACE FUNCTION public._cp_redact_sensitive_change_payload(p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  ELSIF pg_catalog.jsonb_typeof(p_value)='object' THEN
    SELECT COALESCE(
      pg_catalog.jsonb_object_agg(
        entry.key,
        public._cp_redact_sensitive_change_payload(entry.value)
      ),
      '{}'::jsonb
    )
    INTO v_result
    FROM pg_catalog.jsonb_each(p_value) AS entry(key,value)
    WHERE pg_catalog.lower(entry.key) NOT IN (
      'bin','adminbin','password','currentpassword','newpassword',
      'passwordhash','password_hash','secret','secretkey','secret_key',
      'apikey','api_key','accesstoken','access_token',
      'refreshtoken','refresh_token','authorization'
    );
    RETURN v_result;
  ELSIF pg_catalog.jsonb_typeof(p_value)='array' THEN
    SELECT COALESCE(
      pg_catalog.jsonb_agg(public._cp_redact_sensitive_change_payload(item.value)),
      '[]'::jsonb
    )
    INTO v_result
    FROM pg_catalog.jsonb_array_elements(p_value) AS item(value);
    RETURN v_result;
  END IF;
  RETURN p_value;
END;
$function$;

REVOKE ALL ON FUNCTION public._cp_redact_sensitive_change_payload(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.record_canonical_change(
  p_entity_type text,
  p_entity_id uuid,
  p_action text,
  p_payload jsonb,
  p_version integer
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_seq bigint;
  v_safe_payload jsonb;
BEGIN
  v_safe_payload := public._cp_redact_sensitive_change_payload(
    COALESCE(p_payload,'{}'::jsonb)
  );

  PERFORM pg_advisory_xact_lock(hashtextextended('chargerpointnew:change_log:commit_order',0));

  IF p_entity_type='system_settings' AND COALESCE(v_safe_payload->>'key','')<>'' THEN
    SELECT cl.sequence_id INTO v_seq
    FROM public.change_log cl
    WHERE cl.entity_type='system_settings'
      AND cl.action=p_action
      AND cl.payload->>'key'=v_safe_payload->>'key'
      AND cl.xmin=pg_current_xact_id()::xid
    ORDER BY cl.sequence_id DESC
    LIMIT 1;
    IF v_seq IS NOT NULL THEN RETURN v_seq; END IF;
  END IF;

  IF p_entity_type IN (
    'customers','business_days','device_types','orders','order_items',
    'financial_ledger','payments','payment_allocations','goals','goal_requests'
  ) THEN
    SELECT cl.sequence_id INTO v_seq
    FROM public.change_log cl
    WHERE cl.entity_type=p_entity_type
      AND cl.entity_id=p_entity_id
      AND cl.action=p_action
      AND cl.version IS NOT DISTINCT FROM COALESCE(p_version,1)
      AND cl.xmin=pg_current_xact_id()::xid
    ORDER BY cl.sequence_id DESC
    LIMIT 1;
    IF v_seq IS NOT NULL THEN RETURN v_seq; END IF;
  END IF;

  INSERT INTO public.change_log(entity_type,entity_id,action,payload,version,changed_at)
  VALUES(p_entity_type,p_entity_id,p_action,v_safe_payload,COALESCE(p_version,1),now())
  RETURNING sequence_id INTO v_seq;
  RETURN v_seq;
END;
$function$;

COMMIT;
