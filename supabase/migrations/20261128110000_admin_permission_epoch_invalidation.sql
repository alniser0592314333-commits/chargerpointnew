BEGIN;

-- A deliberately minimal Realtime projection. Never publish the admins row:
-- it contains BIN hashes and other account metadata that must not reach clients.
CREATE TABLE IF NOT EXISTS public.admin_permission_epochs (
  admin_id uuid PRIMARY KEY REFERENCES public.admins(id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL UNIQUE,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_permission_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_permission_epochs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_permission_epochs_read_own ON public.admin_permission_epochs;
CREATE POLICY admin_permission_epochs_read_own
  ON public.admin_permission_epochs
  FOR SELECT
  TO authenticated
  USING (auth_user_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.admin_permission_epochs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.admin_permission_epochs TO authenticated;

-- Seed a single minimal epoch row per existing linked administrator.
INSERT INTO public.admin_permission_epochs (admin_id, auth_user_id, version, updated_at)
SELECT a.id, a.auth_user_id, 1, now()
FROM public.admins AS a
WHERE a.auth_user_id IS NOT NULL
ON CONFLICT (admin_id) DO UPDATE
SET auth_user_id = EXCLUDED.auth_user_id;

CREATE OR REPLACE FUNCTION public.bump_admin_permission_epoch(p_admin_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_auth_user_id uuid;
BEGIN
  SELECT a.auth_user_id
    INTO v_auth_user_id
  FROM public.admins AS a
  WHERE a.id = p_admin_id;

  IF v_auth_user_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.admin_permission_epochs (admin_id, auth_user_id, version, updated_at)
  VALUES (p_admin_id, v_auth_user_id, 1, now())
  ON CONFLICT (admin_id) DO UPDATE
    SET auth_user_id = EXCLUDED.auth_user_id,
        version = public.admin_permission_epochs.version + 1,
        updated_at = now();
END;
$function$;

REVOKE ALL ON FUNCTION public.bump_admin_permission_epoch(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.bump_admin_permission_epoch_from_admin_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.bump_admin_permission_epoch(NEW.id);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bump_admin_permission_epoch_from_custom_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
BEGIN
  FOR v_admin_id IN SELECT DISTINCT admin_id FROM inserted_permissions LOOP
    PERFORM public.bump_admin_permission_epoch(v_admin_id);
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bump_admin_permission_epoch_from_custom_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
BEGIN
  FOR v_admin_id IN SELECT DISTINCT admin_id FROM deleted_permissions LOOP
    PERFORM public.bump_admin_permission_epoch(v_admin_id);
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bump_admin_permission_epoch_from_custom_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
BEGIN
  FOR v_admin_id IN
    SELECT admin_id FROM old_permissions
    UNION
    SELECT admin_id FROM new_permissions
  LOOP
    PERFORM public.bump_admin_permission_epoch(v_admin_id);
  END LOOP;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.bump_admin_permission_epoch_from_admin_row() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_admin_permission_epoch_from_custom_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_admin_permission_epoch_from_custom_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_admin_permission_epoch_from_custom_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_admin_permission_epoch_insert ON public.admins;
CREATE TRIGGER trg_admin_permission_epoch_insert
  AFTER INSERT ON public.admins
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_admin_permission_epoch_from_admin_row();

DROP TRIGGER IF EXISTS trg_admin_permission_epoch_update ON public.admins;
CREATE TRIGGER trg_admin_permission_epoch_update
  AFTER UPDATE OF role, permissions, is_active, disabled_at, auth_user_id ON public.admins
  FOR EACH ROW
  WHEN (
    OLD.role IS DISTINCT FROM NEW.role
    OR OLD.permissions IS DISTINCT FROM NEW.permissions
    OR OLD.is_active IS DISTINCT FROM NEW.is_active
    OR OLD.disabled_at IS DISTINCT FROM NEW.disabled_at
    OR OLD.auth_user_id IS DISTINCT FROM NEW.auth_user_id
  )
  EXECUTE FUNCTION public.bump_admin_permission_epoch_from_admin_row();

DROP TRIGGER IF EXISTS trg_admin_permission_epoch_custom_insert ON public.admin_custom_permissions;
CREATE TRIGGER trg_admin_permission_epoch_custom_insert
  AFTER INSERT ON public.admin_custom_permissions
  REFERENCING NEW TABLE AS inserted_permissions
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.bump_admin_permission_epoch_from_custom_insert();

DROP TRIGGER IF EXISTS trg_admin_permission_epoch_custom_delete ON public.admin_custom_permissions;
CREATE TRIGGER trg_admin_permission_epoch_custom_delete
  AFTER DELETE ON public.admin_custom_permissions
  REFERENCING OLD TABLE AS deleted_permissions
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.bump_admin_permission_epoch_from_custom_delete();

DROP TRIGGER IF EXISTS trg_admin_permission_epoch_custom_update ON public.admin_custom_permissions;
CREATE TRIGGER trg_admin_permission_epoch_custom_update
  AFTER UPDATE ON public.admin_custom_permissions
  REFERENCING OLD TABLE AS old_permissions NEW TABLE AS new_permissions
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.bump_admin_permission_epoch_from_custom_update();

-- Postgres Changes is optional at project level; enable the minimal projection
-- when the standard Supabase Realtime publication exists.
DO $publication$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'admin_permission_epochs'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_permission_epochs';
  END IF;
END;
$publication$;


-- Keep bulk permission edits to one DELETE statement and one INSERT statement.
-- The statement-level triggers therefore emit at most two version changes per
-- save, rather than one Realtime event per permission row.
CREATE OR REPLACE FUNCTION public.rpc_set_admin_custom_permissions__session_guarded_impl(
  p_target_admin_id uuid,
  p_permissions text[],
  p_bin text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_caller_id uuid;
BEGIN
  v_caller_id := public.authorize_super_admin_admin_management(p_bin);

  PERFORM 1
  FROM public.admins
  WHERE id = p_target_admin_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target admin not found'
      USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.admin_custom_permissions
  WHERE admin_id = p_target_admin_id;

  INSERT INTO public.admin_custom_permissions (admin_id, permission, is_grant)
  SELECT p_target_admin_id, normalized.permission, TRUE
  FROM (
    SELECT DISTINCT trim(input.input_permission) AS permission
    FROM unnest(COALESCE(p_permissions, ARRAY[]::text[])) AS input(input_permission)
    WHERE input.input_permission IS NOT NULL
      AND trim(input.input_permission) <> ''
  ) AS normalized
  ON CONFLICT (admin_id, permission) DO UPDATE
    SET is_grant = TRUE;

  INSERT INTO public.admin_audit_logs (
    actor_admin_id,
    action,
    target_admin_id,
    metadata
  ) VALUES (
    v_caller_id,
    'ADMIN_CUSTOM_PERMISSIONS_UPDATED',
    p_target_admin_id,
    jsonb_build_object(
      'permissions_count', COALESCE(cardinality(p_permissions), 0),
      'timestamp', now()
    )
  );
END;
$function$;


-- Read the current session and permission epoch on every Sarah request, but
-- return the effective permission array only when the Edge isolate's cache is
-- absent or stale. The caller-supplied version is server-memory-only; the
-- browser cannot populate or control this cache.
CREATE OR REPLACE FUNCTION public.sarah_ai_get_chat_access_context(
  p_cached_permissions_version bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin_id uuid;
  v_auth_user_id uuid;
  v_role text;
  v_permissions_version bigint;
  v_permissions text[] := '{}'::text[];
BEGIN
  PERFORM public.assert_my_account_session_active();

  SELECT a.id, a.auth_user_id, a.role, e.version
    INTO v_admin_id, v_auth_user_id, v_role, v_permissions_version
  FROM public.admins AS a
  JOIN public.admin_permission_epochs AS e ON e.admin_id = a.id
  WHERE a.auth_user_id = auth.uid()
    AND a.is_active IS TRUE
    AND a.disabled_at IS NULL
  LIMIT 1;

  IF v_admin_id IS NULL OR v_auth_user_id IS DISTINCT FROM auth.uid()
     OR v_permissions_version IS NULL THEN
    RAISE EXCEPTION 'Active administrator permission context unavailable'
      USING ERRCODE = '42501';
  END IF;

  IF p_cached_permissions_version IS NOT NULL
     AND p_cached_permissions_version = v_permissions_version THEN
    RETURN jsonb_build_object(
      'authenticated', true,
      'is_admin', true,
      'is_active', true,
      'admin_id', v_admin_id,
      'auth_user_id', v_auth_user_id,
      'role', v_role,
      'permissions_version', v_permissions_version::text,
      'permissions_unchanged', true
    );
  END IF;

  SELECT COALESCE(array_agg(ep.permission ORDER BY ep.permission), '{}'::text[])
    INTO v_permissions
  FROM public.get_effective_permissions__session_guarded_impl(v_admin_id) AS ep;

  RETURN jsonb_build_object(
    'authenticated', true,
    'is_admin', true,
    'is_active', true,
    'admin_id', v_admin_id,
    'auth_user_id', v_auth_user_id,
    'role', v_role,
    'permissions_version', v_permissions_version::text,
    'permissions_unchanged', false,
    'permissions', COALESCE(v_permissions, '{}'::text[])
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sarah_ai_get_chat_access_context(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sarah_ai_get_chat_access_context(bigint) TO authenticated;

COMMIT;
