-- Isolated schema fixture for canonical goal command dispatch.
CREATE SCHEMA auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid;
$function$;

CREATE TABLE public.admins(
  id uuid PRIMARY KEY,
  auth_user_id uuid UNIQUE NOT NULL,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  permissions text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE public.account_sessions(
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE public.customers(
  id uuid PRIMARY KEY,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE public.goals(
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  target_quantity integer NOT NULL,
  current_progress integer NOT NULL DEFAULT 0,
  bonus_amount_minor bigint NOT NULL,
  duration_days integer NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  bonus_ledger_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE TABLE public.goal_requests(
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  requested_target integer,
  status text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  rejection_reason text,
  resulting_goal_id uuid,
  version integer NOT NULL DEFAULT 1
);
CREATE TABLE public.processed_commands(
  command_id uuid PRIMARY KEY,
  command_type text NOT NULL,
  payload_hash text NOT NULL,
  aggregate_type text,
  aggregate_id uuid,
  actor_admin_id uuid,
  device_id uuid,
  result_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.system_settings(
  key text PRIMARY KEY,
  value_number bigint,
  value_string text
);
INSERT INTO public.system_settings(key,value_number) VALUES('server_reset_generation',1);

CREATE OR REPLACE FUNCTION public.assert_my_account_session_active()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $function$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM public.account_sessions s
    WHERE s.user_id=auth.uid()
      AND s.session_id=NULLIF(current_setting('request.jwt.claim.session_id',true),'')::uuid
      AND s.revoked_at IS NULL
      AND s.expires_at>now()
  ) THEN
    RAISE EXCEPTION 'Inactive account session' USING ERRCODE='28000';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public._cp_assert_active_admin_permission(p_permission text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $function$
DECLARE v_role text; v_permissions text[];
BEGIN
  SELECT a.role,a.permissions INTO v_role,v_permissions
  FROM public.admins a
  WHERE a.auth_user_id=auth.uid() AND a.is_active IS TRUE;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Active admin required' USING ERRCODE='42501';
  END IF;
  IF v_role NOT IN ('SUPER_ADMIN','Super Admin')
     AND NOT (COALESCE(v_permissions,'{}'::text[]) @> ARRAY[p_permission]::text[]) THEN
    RAISE EXCEPTION 'Missing permission %',p_permission USING ERRCODE='P4003';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_canonical_change(
  p_entity_type text,p_entity_id uuid,p_action text,p_payload jsonb,p_version integer
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path=''
AS $function$
  SELECT 1::bigint;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_goal_business_rules()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.target_quantity<=0 OR NEW.duration_days<3 OR NEW.duration_days>15
     OR NEW.bonus_amount_minor<0 OR NEW.bonus_amount_minor>NEW.target_quantity::bigint*20
     OR NEW.expires_at<>NEW.started_at+make_interval(days=>NEW.duration_days) THEN
    RAISE EXCEPTION 'Goal policy violation' USING ERRCODE='22023';
  END IF;
  IF TG_OP='INSERT' AND (NEW.status<>'ACTIVE' OR NEW.current_progress<>0 OR NEW.bonus_ledger_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid initial goal state' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER goals_enforce_business_rules
BEFORE INSERT OR UPDATE ON public.goals
FOR EACH ROW EXECUTE FUNCTION public.enforce_goal_business_rules();

-- The original dispatcher is renamed by the migration and remains the fallback
-- for all command types not intercepted by the new goal wrapper.
CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command_unlocked(
  p_command_id uuid,p_command_type text,p_payload jsonb,
  p_payload_hash text DEFAULT 'no_hash'::text,
  p_device_id text DEFAULT 'default_device'::text,
  p_actor_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path='public','pg_temp'
AS $function$
BEGIN
  RETURN jsonb_build_object('delegated',true,'commandType',p_command_type);
END;
$function$;

CREATE OR REPLACE FUNCTION public.execute_canonical_sync_command(
  p_command_id uuid,p_command_type text,p_payload jsonb,
  p_payload_hash text DEFAULT 'no_hash'::text,
  p_device_id text DEFAULT 'default_device'::text,
  p_actor_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $function$
BEGIN
  RETURN public.execute_canonical_sync_command_unlocked(
    p_command_id,p_command_type,p_payload,p_payload_hash,p_device_id,p_actor_id
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid) TO authenticated;

INSERT INTO public.admins(id,auth_user_id,role,is_active,permissions) VALUES
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','SUPER_ADMIN',true,'{}'),
('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Operator',true,ARRAY['goals:manage']),
('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','Operator',true,'{}');

INSERT INTO public.account_sessions(user_id,session_id,expires_at) VALUES
('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',now()+interval '1 day'),
('10000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002',now()+interval '1 day'),
('10000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000003',now()+interval '1 day');

INSERT INTO public.customers(id,is_active,status) VALUES
('30000000-0000-4000-8000-000000000001',true,'ACTIVE'),
('30000000-0000-4000-8000-000000000002',true,'ACTIVE'),
('30000000-0000-4000-8000-000000000003',false,'INACTIVE');
