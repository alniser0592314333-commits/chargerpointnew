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

COMMIT;
