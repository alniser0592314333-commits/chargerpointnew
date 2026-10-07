-- Legacy backup compatibility for QR token placeholders.
-- Legacy portable data may contain IDs like "<order-uuid>:qr" and no
-- cryptographic public token. The current qr_tokens contract requires:
--   * UUID primary key
--   * non-null public_token/token_hash
-- Therefore preserve target/type and mint a fresh secure token only for
-- these legacy placeholders. Do not weaken the UUID contract.

DO $$
DECLARE
  v_def TEXT;
  v_old TEXT;
  v_new TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname='replace_online_business_data'
     AND pg_get_function_identity_arguments(p.oid)='p_entered_bin text, p_payload jsonb';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'replace_online_business_data not found';
  END IF;

  v_old := $old$
        v_entity_uuid_str := v_item->>'id';
        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' OR v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Invalid qr_token ID %: must be a valid UUID', v_entity_uuid_str;
        END IF;

        INSERT INTO qr_tokens (id, token_hash, public_token, token_type, target_id, is_active)
        VALUES (
            v_entity_uuid_str::UUID,
            COALESCE(v_item->>'token_hash', v_item->>'tokenHash', v_item->>'public_token', v_item->>'publicToken'),
            COALESCE(v_item->>'public_token', v_item->>'publicToken'),
            (COALESCE(v_item->>'token_type', v_item->>'tokenType', 'CUSTOMER'))::qr_token_type,
            (COALESCE(v_item->>'target_id', v_item->>'targetId'))::UUID,
            COALESCE((v_item->>'is_active')::BOOLEAN, (v_item->>'isActive')::BOOLEAN, TRUE)
        );
        v_count_qr_tokens := v_count_qr_tokens + 1;
  $old$;

  v_new := $new$
        v_entity_uuid_str := v_item->>'id';

        IF v_entity_uuid_str IS NULL OR trim(v_entity_uuid_str) = '' THEN
            RAISE EXCEPTION 'Invalid qr_token ID: ID cannot be null, empty, or whitespace';
        END IF;

        IF v_entity_uuid_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            IF v_entity_uuid_str ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:qr$' THEN
                v_entity_uuid_str := gen_random_uuid()::TEXT;
            ELSE
                RAISE EXCEPTION 'Invalid qr_token ID %: must be a valid UUID or supported legacy :qr key', v_item->>'id';
            END IF;
        END IF;

        DECLARE
            v_qr_target_id TEXT := COALESCE(v_item->>'target_id', v_item->>'targetId');
            v_qr_public_token TEXT := COALESCE(v_item->>'public_token', v_item->>'publicToken');
            v_qr_token_hash TEXT := COALESCE(v_item->>'token_hash', v_item->>'tokenHash');
        BEGIN
            IF v_qr_target_id IS NULL OR v_qr_target_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                RAISE EXCEPTION 'Invalid qr_token target_id %: must be a valid UUID', v_qr_target_id;
            END IF;

            IF v_qr_public_token IS NULL OR trim(v_qr_public_token) = '' THEN
                v_qr_public_token := encode(gen_random_bytes(16), 'hex');
            END IF;
            IF v_qr_token_hash IS NULL OR trim(v_qr_token_hash) = '' THEN
                v_qr_token_hash := v_qr_public_token;
            END IF;

            INSERT INTO qr_tokens (id, token_hash, public_token, token_type, target_id, is_active)
            VALUES (
                v_entity_uuid_str::UUID,
                v_qr_token_hash,
                v_qr_public_token,
                (COALESCE(v_item->>'token_type', v_item->>'tokenType', 'ORDER'))::qr_token_type,
                v_qr_target_id::UUID,
                COALESCE((v_item->>'is_active')::BOOLEAN, (v_item->>'isActive')::BOOLEAN, TRUE)
            );
            v_count_qr_tokens := v_count_qr_tokens + 1;
        END;
  $new$;

  IF position(v_old IN v_def)=0 THEN
    RAISE EXCEPTION 'QR block not found';
  END IF;

  v_def := replace(v_def,v_old,v_new);
  EXECUTE v_def;
END $$;
