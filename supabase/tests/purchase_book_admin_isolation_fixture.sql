-- Minimal isolated dependencies needed to exercise the admin-isolation migration.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE
AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;

CREATE TABLE IF NOT EXISTS public.admins (
  id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'SUPER_ADMIN',
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS auth_user_id uuid;
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'SUPER_ADMIN';
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS public.system_settings (
  key text PRIMARY KEY,
  value_number bigint
);
INSERT INTO public.system_settings(key,value_number)
VALUES ('server_reset_generation',1)
ON CONFLICT (key) DO UPDATE SET value_number=EXCLUDED.value_number;

CREATE TABLE IF NOT EXISTS public.change_log (
  sequence_id bigserial PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.assert_my_account_session_active()
RETURNS void LANGUAGE plpgsql STABLE
AS $$ BEGIN RETURN; END; $$;
CREATE OR REPLACE FUNCTION public._cp_assert_active_admin_permission(p_permission text)
RETURNS void LANGUAGE plpgsql STABLE
AS $$ BEGIN RETURN; END; $$;

CREATE OR REPLACE FUNCTION public.capture_sync_bootstrap_snapshot__session_guarded_impl()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
AS $$ SELECT jsonb_build_object(
  'schema_version',1,'captured_at',now(),'server_reset_generation',1,
  'max_change_sequence',COALESCE((SELECT max(sequence_id) FROM public.change_log),0),
  'purchase_suppliers','[]'::jsonb,'purchase_items','[]'::jsonb,
  'purchase_payment_methods','[]'::jsonb,'purchase_months','[]'::jsonb,
  'purchase_weeks','[]'::jsonb,'purchase_days','[]'::jsonb,'purchase_orders','[]'::jsonb
) $$;

CREATE OR REPLACE FUNCTION public.capture_authoritative_business_snapshot__session_guarded_impl()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
AS $$ SELECT jsonb_build_object(
  'schema_version',1,'captured_at',now(),'server_reset_generation',1,
  'max_change_sequence',COALESCE((SELECT max(sequence_id) FROM public.change_log),0),
  'change_log_count',(SELECT count(*) FROM public.change_log),
  'change_log_fingerprint',md5(''),
  'purchase_suppliers','[]'::jsonb,'purchase_items','[]'::jsonb,
  'purchase_payment_methods','[]'::jsonb,'purchase_months','[]'::jsonb,
  'purchase_weeks','[]'::jsonb,'purchase_days','[]'::jsonb,'purchase_orders','[]'::jsonb
) $$;

CREATE OR REPLACE FUNCTION public.capture_authoritative_change_log_page__session_guarded_impl(
  p_after_sequence_id bigint,p_through_sequence_id bigint,p_limit integer DEFAULT 500
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
AS $$ SELECT jsonb_build_object(
  'rows','[]'::jsonb,'next_after_sequence_id',p_after_sequence_id,
  'current_count_through_sequence',0,'server_reset_generation',1,
  'change_log_fingerprint',md5('')
) $$;

CREATE OR REPLACE FUNCTION public.pull_canonical_changes__session_guarded_impl(
  p_since_sequence bigint,p_limit integer DEFAULT 500
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
AS $$ SELECT jsonb_build_object(
  'changes','[]'::jsonb,'latestSequence',p_since_sequence,'serverResetGeneration',1
) $$;
