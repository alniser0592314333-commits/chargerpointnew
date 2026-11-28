BEGIN;

INSERT INTO public.admins (id, auth_user_id, role, permissions)
VALUES
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'OPERATOR', ARRAY['orders:view']),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'OPERATOR', ARRAY['customers:view']);

DO $epochs$
DECLARE
  v_before bigint;
  v_after bigint;
BEGIN
  SELECT version INTO v_before
  FROM public.admin_permission_epochs
  WHERE admin_id = '10000000-0000-4000-8000-000000000001';

  INSERT INTO public.admin_custom_permissions (admin_id, permission, is_grant)
  VALUES ('10000000-0000-4000-8000-000000000001', 'orders:create', true);

  SELECT version INTO v_after
  FROM public.admin_permission_epochs
  WHERE admin_id = '10000000-0000-4000-8000-000000000001';
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'One permission statement must emit exactly one epoch increment (insert)';
  END IF;

  v_before := v_after;
  INSERT INTO public.admin_custom_permissions (admin_id, permission, is_grant)
  VALUES
    ('10000000-0000-4000-8000-000000000001', 'orders:edit', true),
    ('10000000-0000-4000-8000-000000000001', 'orders:deliver', true);

  SELECT version INTO v_after
  FROM public.admin_permission_epochs
  WHERE admin_id = '10000000-0000-4000-8000-000000000001';
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'Bulk permission statement must emit one epoch increment, not one per row';
  END IF;

  v_before := v_after;
  UPDATE public.admin_custom_permissions
  SET is_grant = false
  WHERE admin_id = '10000000-0000-4000-8000-000000000001'
    AND permission = 'orders:edit';
  SELECT version INTO v_after
  FROM public.admin_permission_epochs
  WHERE admin_id = '10000000-0000-4000-8000-000000000001';
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'Custom permission update must increment epoch exactly once';
  END IF;

  v_before := v_after;
  DELETE FROM public.admin_custom_permissions
  WHERE admin_id = '10000000-0000-4000-8000-000000000001'
    AND permission = 'orders:deliver';
  SELECT version INTO v_after
  FROM public.admin_permission_epochs
  WHERE admin_id = '10000000-0000-4000-8000-000000000001';
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'Custom permission deletion must increment epoch exactly once';
  END IF;

  v_before := v_after;
  UPDATE public.admins
  SET permissions = ARRAY['orders:view', 'orders:create']
  WHERE id = '10000000-0000-4000-8000-000000000001';

  SELECT version INTO v_after
  FROM public.admin_permission_epochs
  WHERE admin_id = '10000000-0000-4000-8000-000000000001';
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'Admin permission projection change did not increment epoch exactly once';
  END IF;

  v_before := v_after;
  UPDATE public.admins
  SET role = role
  WHERE id = '10000000-0000-4000-8000-000000000001';
  SELECT version INTO v_after
  FROM public.admin_permission_epochs
  WHERE admin_id = '10000000-0000-4000-8000-000000000001';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'No-op authorization update must not emit an epoch change';
  END IF;
END;
$epochs$;

SELECT set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);
DO $cache$
DECLARE
  v_first jsonb;
  v_same jsonb;
  v_changed jsonb;
  v_version bigint;
BEGIN
  v_first := public.sarah_ai_get_chat_access_context(NULL);
  IF COALESCE((v_first ->> 'permissions_unchanged')::boolean, true) IS NOT FALSE
     OR NOT (v_first ? 'permissions') THEN
    RAISE EXCEPTION 'Cache miss must return the current effective permissions';
  END IF;
  v_version := (v_first ->> 'permissions_version')::bigint;

  v_same := public.sarah_ai_get_chat_access_context(v_version);
  IF COALESCE((v_same ->> 'permissions_unchanged')::boolean, false) IS NOT TRUE
     OR (v_same ? 'permissions') THEN
    RAISE EXCEPTION 'Cache hit must return identity/version only, not re-read permissions';
  END IF;

  INSERT INTO public.admin_custom_permissions (admin_id, permission, is_grant)
  VALUES ('10000000-0000-4000-8000-000000000001', 'orders:correct', true);

  v_changed := public.sarah_ai_get_chat_access_context(v_version);
  IF COALESCE((v_changed ->> 'permissions_unchanged')::boolean, true) IS NOT FALSE
     OR NOT (v_changed ? 'permissions')
     OR NOT ((v_changed -> 'permissions') ? 'orders:correct') THEN
    RAISE EXCEPTION 'Permission epoch change must force a fresh permission projection';
  END IF;

  v_version := (v_changed ->> 'permissions_version')::bigint;
  v_same := public.sarah_ai_get_chat_access_context(v_version);
  IF COALESCE((v_same ->> 'permissions_unchanged')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Fresh permission version must become a cache hit';
  END IF;
END;
$cache$;

DO $acl$
BEGIN
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity
          FROM pg_class WHERE oid = 'public.admin_permission_epochs'::regclass) THEN
    RAISE EXCEPTION 'Permission epoch table must enforce RLS';
  END IF;
  IF has_table_privilege('anon', 'public.admin_permission_epochs', 'SELECT') THEN
    RAISE EXCEPTION 'Anonymous role must not read permission epochs';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.admin_permission_epochs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.admin_permission_epochs', 'INSERT')
     OR has_table_privilege('authenticated', 'public.admin_permission_epochs', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.admin_permission_epochs', 'DELETE') THEN
    RAISE EXCEPTION 'Authenticated role must have read-only access to permission epochs';
  END IF;
  IF has_function_privilege('anon', 'public.sarah_ai_get_chat_access_context(bigint)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.sarah_ai_get_chat_access_context(bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Sarah access-context RPC must be authenticated-only';
  END IF;
END;
$acl$;

SET LOCAL request.jwt.claim.sub = '20000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
DO $own_row$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.admin_permission_epochs;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Admin must only see its own permission epoch; saw % rows', v_count;
  END IF;
END;
$own_row$;

RESET ROLE;
SET LOCAL request.jwt.claim.sub = '20000000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
DO $other_row$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.admin_permission_epochs;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Second admin must only see its own permission epoch; saw % rows', v_count;
  END IF;
END;
$other_row$;

RESET ROLE;
ROLLBACK;
