-- Harden the online replacement contract after legacy QR compatibility:
-- 1) preserve supplied public_token exactly;
-- 2) derive token_hash as SHA-256 only when the source did not provide one;
-- 3) reject empty replacement payloads before any destructive DELETE.

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

  v_old := $old$IF v_qr_token_hash IS NULL OR trim(v_qr_token_hash) = '' THEN
                v_qr_token_hash := v_qr_public_token;
            END IF;$old$;

  v_new := $new$IF v_qr_token_hash IS NULL OR trim(v_qr_token_hash) = '' THEN
                v_qr_token_hash := encode(digest(v_qr_public_token, 'sha256'), 'hex');
            END IF;$new$;

  IF position(v_old IN v_def) > 0 THEN
    v_def := replace(v_def, v_old, v_new);
  END IF;

  v_old := '    v_bin_verified := verify_admin_bin(p_entered_bin);';
  v_new := '    v_bin_verified := verify_admin_bin(p_entered_bin);' || chr(10) ||
            '    PERFORM public._cp_guard_nonempty_replacement_payload(p_payload);';

  IF position('PERFORM public._cp_guard_nonempty_replacement_payload(p_payload);' IN v_def) = 0 THEN
    IF position(v_old IN v_def)=0 THEN
      RAISE EXCEPTION 'replacement BIN validation anchor not found';
    END IF;
    v_def := replace(v_def,v_old,v_new);
  END IF;

  EXECUTE v_def;
END $$;
