-- Server-controlled app release policy. Only active Super Admin sessions may publish releases.
CREATE TABLE IF NOT EXISTS public.app_release_policies (
  channel text PRIMARY KEY CHECK (channel IN ('customer', 'admin')),
  latest_version text NOT NULL CHECK (latest_version ~ '^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$'),
  version_code integer NOT NULL CHECK (version_code > 0 AND version_code <= 2100000000),
  release_notes text NOT NULL DEFAULT '',
  download_url text NOT NULL DEFAULT '',
  grace_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT app_release_version_code_matches CHECK (
    version_code =
      split_part(latest_version, '.', 1)::bigint * 1000000
      + split_part(latest_version, '.', 2)::bigint * 1000
      + split_part(latest_version, '.', 3)::bigint
  )
);

CREATE OR REPLACE FUNCTION public.guard_app_release_policy_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.channel <> OLD.channel THEN
      RAISE EXCEPTION 'APP_RELEASE_CHANNEL_IMMUTABLE';
    END IF;
    IF NEW.latest_version IS DISTINCT FROM OLD.latest_version
       AND NEW.version_code <= OLD.version_code THEN
      RAISE EXCEPTION 'APP_RELEASE_VERSION_MUST_INCREASE';
    END IF;
    IF NEW.latest_version IS NOT DISTINCT FROM OLD.latest_version
       AND NEW.version_code <> OLD.version_code THEN
      RAISE EXCEPTION 'APP_RELEASE_VERSION_CODE_MISMATCH';
    END IF;
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_app_release_policy_update() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS app_release_policy_guard ON public.app_release_policies;
CREATE TRIGGER app_release_policy_guard
BEFORE INSERT OR UPDATE ON public.app_release_policies
FOR EACH ROW EXECUTE FUNCTION public.guard_app_release_policy_update();

ALTER TABLE public.app_release_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_release_policies FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.app_release_policies TO anon, authenticated;
GRANT INSERT, UPDATE ON public.app_release_policies TO authenticated;

DROP POLICY IF EXISTS app_release_policy_public_read ON public.app_release_policies;
CREATE POLICY app_release_policy_public_read
ON public.app_release_policies
FOR SELECT TO anon, authenticated
USING (true);

DROP POLICY IF EXISTS app_release_policy_super_admin_insert ON public.app_release_policies;
CREATE POLICY app_release_policy_super_admin_insert
ON public.app_release_policies
FOR INSERT TO authenticated
WITH CHECK (public.is_active_super_admin_session());

DROP POLICY IF EXISTS app_release_policy_super_admin_update ON public.app_release_policies;
CREATE POLICY app_release_policy_super_admin_update
ON public.app_release_policies
FOR UPDATE TO authenticated
USING (public.is_active_super_admin_session())
WITH CHECK (public.is_active_super_admin_session());

INSERT INTO public.app_release_policies
  (channel, latest_version, version_code, release_notes, download_url, grace_until)
VALUES
  ('customer', '1.0.0', 1000000, 'الإصدار الأول', '', now() + interval '7 days'),
  ('admin', '1.0.0', 1000000, 'الإصدار الأول', '', now() + interval '7 days')
ON CONFLICT (channel) DO NOTHING;
