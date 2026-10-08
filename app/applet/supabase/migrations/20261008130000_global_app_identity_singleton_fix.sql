-- Global App Identity: enforce one canonical server-authoritative row.
-- Preserves the currently configured custom logo while eliminating the duplicate
-- identity row that caused other devices to resolve the default logo.
BEGIN;

ALTER TABLE public.global_app_identity
  ADD COLUMN IF NOT EXISTS singleton boolean;

-- The legacy row named "global" contains the currently configured custom brand.
-- Move that authoritative data into the canonical singleton row before removing
-- the duplicate legacy row.
UPDATE public.global_app_identity AS canonical
SET
  app_name = legacy.app_name,
  white_logo_url = legacy.white_logo_url,
  dark_logo_url = legacy.dark_logo_url,
  version = GREATEST(canonical.version, legacy.version) + 1,
  updated_at = NOW(),
  updated_by = legacy.updated_by,
  singleton = TRUE
FROM public.global_app_identity AS legacy
WHERE canonical.id = '00000000-0000-0000-0000-000000000001'
  AND legacy.id = 'global'
  AND legacy.id <> canonical.id;

-- The canonical row is the only row allowed to be the singleton.
UPDATE public.global_app_identity
SET singleton = FALSE
WHERE id <> '00000000-0000-0000-0000-000000000001';

DELETE FROM public.global_app_identity
WHERE id <> '00000000-0000-0000-0000-000000000001';

ALTER TABLE public.global_app_identity
  ALTER COLUMN singleton SET DEFAULT TRUE,
  ALTER COLUMN singleton SET NOT NULL;

DO $
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.global_app_identity'::regclass
      AND conname = 'global_app_identity_singleton_true_chk'
  ) THEN
    ALTER TABLE public.global_app_identity
      ADD CONSTRAINT global_app_identity_singleton_true_chk
      CHECK (singleton = TRUE);
  END IF;
END
$;

CREATE UNIQUE INDEX IF NOT EXISTS global_app_identity_singleton_uidx
  ON public.global_app_identity (singleton);

CREATE OR REPLACE FUNCTION public.get_global_app_identity()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', id,
    'app_name', app_name,
    'white_logo_url', white_logo_url,
    'dark_logo_url', dark_logo_url,
    'version', version,
    'updated_at', updated_at,
    'updated_by', updated_by
  )
  FROM public.global_app_identity
  WHERE id = '00000000-0000-0000-0000-000000000001'
    AND singleton = TRUE
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.update_global_app_identity(
  p_app_name text,
  p_white_logo_url text,
  p_dark_logo_url text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.admins a
    WHERE a.id = public.current_admin_id()
      AND (a.role = 'SUPER_ADMIN' OR 'settings:manage' = ANY(a.permissions))
  ) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = 'P4003';
  END IF;

  UPDATE public.global_app_identity
  SET
    app_name = COALESCE(p_app_name, app_name),
    white_logo_url = p_white_logo_url,
    dark_logo_url = p_dark_logo_url,
    version = version + 1,
    updated_at = NOW(),
    updated_by = public.current_admin_id()
  WHERE id = '00000000-0000-0000-0000-000000000001'
    AND singleton = TRUE;

  RETURN public.get_global_app_identity();
END;
$$;

COMMIT;
