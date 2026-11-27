-- Existing-order item addition: exact customer proof, same order target,
-- canonical ADD_ORDER_ITEM dispatch, and live permission revocation.
INSERT INTO public.customers(
  id,name,phone,balance,is_active,deleted_at,status,charger_fee_exempt,debt_limit_minor,updated_at,version
) VALUES (
  'aaab0000-0000-4000-8000-000000000001',
  'Sarah Existing Order Fixture',NULL,0,true,NULL,'ACTIVE',false,50000,now(),1
) ON CONFLICT(id) DO NOTHING;

INSERT INTO public.business_days(id,business_date,display_number,status,is_closed,opened_at,created_at,updated_at,version)
VALUES('bbab0000-0000-4000-8000-000000000001',current_date + 5000,990,'OPEN',false,now(),now(),now(),1)
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.orders(id,day_id,customer_id,display_number,status,notes)
VALUES(
  'ccab0000-0000-4000-8000-000000000001',
  'bbab0000-0000-4000-8000-000000000001',
  'aaab0000-0000-4000-8000-000000000001',
  990,'charging','existing-order-item-addition fixture'
) ON CONFLICT(id) DO NOTHING;

INSERT INTO public.admin_custom_permissions(admin_id,permission,is_grant)
VALUES
 ('00000000-0000-4000-8000-000000000009','ai:use',true),
 ('00000000-0000-4000-8000-000000000009','customers:view',true),
 ('00000000-0000-4000-8000-000000000009','orders:view',true),
 ('00000000-0000-4000-8000-000000000009','orders:edit',true),
 ('00000000-0000-4000-8000-000000000009','devices:view',true)
ON CONFLICT(admin_id,permission) DO UPDATE SET is_grant=EXCLUDED.is_grant;

DELETE FROM public.sarah_ai_usage_windows
WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000009';

-- Capture the order count as the privileged test runner; the authenticated
-- actor must not receive direct SELECT access to business tables.
CREATE TEMP TABLE sarah_existing_order_count_before AS
SELECT count(*)::integer AS order_count FROM public.orders
WHERE customer_id='aaab0000-0000-4000-8000-000000000001' AND deleted_at IS NULL;

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000009',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000009',false);

DO $add_item_to_existing_order$
DECLARE
  v_lookup jsonb;
  v_code text;
  v_result jsonb;
BEGIN
  v_lookup:=public.sarah_ai_lookup_customers('Sarah Existing Order Fixture');
  IF COALESCE((v_lookup->>'match_count')::integer,0)<>1 THEN
    RAISE EXCEPTION 'Existing-order fixture customer lookup did not resolve uniquely: %',v_lookup;
  END IF;
  v_code:=v_lookup->'matches'->0->>'customer_code';

  v_result:=public.sarah_ai_add_item_to_existing_order(
    'ddab0000-0000-4000-8000-000000000001',
    v_code,'Sarah Existing Order Fixture',
    'ccab0000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001',
    true,NULL
  );

  IF v_result->>'ok'<>'true'
     OR v_result->>'order_id'<>'ccab0000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'Sarah did not add the device to the exact existing order: %',v_result;
  END IF;

END;
$add_item_to_existing_order$;
RESET ROLE;

-- Verify the canonical write and no-new-order invariant as the privileged
-- test runner, without weakening authenticated table grants.
DO $verify_existing_order_item$
DECLARE
  v_before_orders integer;
  v_after_orders integer;
  v_item_count integer;
BEGIN
  SELECT order_count INTO v_before_orders FROM sarah_existing_order_count_before;
  SELECT count(*) INTO v_item_count FROM public.order_items
  WHERE order_id='ccab0000-0000-4000-8000-000000000001'
    AND device_type_id='30000000-0000-4000-8000-000000000001';
  IF v_item_count<>1 THEN
    RAISE EXCEPTION 'Canonical ADD_ORDER_ITEM did not add exactly one item to the existing order';
  END IF;
  SELECT count(*) INTO v_after_orders FROM public.orders
  WHERE customer_id='aaab0000-0000-4000-8000-000000000001' AND deleted_at IS NULL;
  IF v_after_orders<>v_before_orders THEN
    RAISE EXCEPTION 'Adding an item unexpectedly created another order';
  END IF;
END;
$verify_existing_order_item$;

-- The permission is checked again inside PostgreSQL; revoking it in the same
-- Auth session immediately prevents the next add-item operation.
DELETE FROM public.admin_custom_permissions
WHERE admin_id='00000000-0000-4000-8000-000000000009'
  AND permission='orders:edit';
DELETE FROM public.sarah_ai_usage_windows
WHERE actor_auth_user_id='10000000-0000-4000-8000-000000000009';

SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',false);
SELECT pg_catalog.set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000009',false);
SELECT pg_catalog.set_config('request.jwt.claim.session_id','20000000-0000-4000-8000-000000000009',false);
DO $add_item_permission_revoked$
DECLARE v_lookup jsonb; v_code text;
BEGIN
  v_lookup:=public.sarah_ai_lookup_customers('Sarah Existing Order Fixture');
  v_code:=v_lookup->'matches'->0->>'customer_code';
  BEGIN
    PERFORM public.sarah_ai_add_item_to_existing_order(
      'ddab0000-0000-4000-8000-000000000002',
      v_code,'Sarah Existing Order Fixture',
      'ccab0000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      true,NULL
    );
    RAISE EXCEPTION 'Sarah retained orders:edit after it was revoked in the same session';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$add_item_permission_revoked$;
RESET ROLE;

DO $add_item_rpc_acl$
BEGIN
  IF NOT has_function_privilege(
    'authenticated',
    'public.sarah_ai_add_item_to_existing_order(uuid,text,text,uuid,uuid,boolean,bigint)',
    'EXECUTE'
  ) OR has_function_privilege(
    'anon',
    'public.sarah_ai_add_item_to_existing_order(uuid,text,text,uuid,uuid,boolean,bigint)',
    'EXECUTE'
  ) OR has_function_privilege(
    'service_role',
    'public.sarah_ai_add_item_to_existing_order(uuid,text,text,uuid,uuid,boolean,bigint)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Sarah existing-order item RPC grants are incorrect';
  END IF;
END;
$add_item_rpc_acl$;
