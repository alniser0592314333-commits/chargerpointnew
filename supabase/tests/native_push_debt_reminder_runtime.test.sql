\set ON_ERROR_STOP on
DO $test$
DECLARE
  v_device uuid := '10000000-0000-4000-8000-000000000001';
  v_customer uuid := '20000000-0000-4000-8000-000000000001';
  v_user uuid := '30000000-0000-4000-8000-000000000001';
  v_auth_session uuid := '40000000-0000-4000-8000-000000000001';
BEGIN
  INSERT INTO auth.sessions(id,user_id,not_after) VALUES (v_auth_session,v_user,NULL);
  INSERT INTO public.customers(id,is_active,deleted_at,status) VALUES (v_customer,true,NULL,'ACTIVE');
  INSERT INTO public.customer_account_links(customer_id,auth_user_id,account_status) VALUES (v_customer,v_user,'ACTIVE');
  INSERT INTO public.native_push_devices(id,device_id,token,app_variant,principal_id,customer_id,auth_session_id,disabled_at)
  VALUES (v_device,gen_random_uuid(),repeat('x',40),'customer',v_user,v_customer,v_auth_session::text,NULL);

  IF public.native_push_device_is_current(v_device,false,false) IS TRUE THEN
    RAISE EXCEPTION 'A customer push without an active portal session must be rejected by default';
  END IF;
  IF public.native_push_device_is_current(v_device,false,true) IS NOT TRUE THEN
    RAISE EXCEPTION 'Debt-reminder mode must permit an expired/missing portal session when Auth and account remain active';
  END IF;

  UPDATE public.customer_account_links SET account_status='FROZEN' WHERE customer_id=v_customer;
  IF public.native_push_device_is_current(v_device,false,true) IS TRUE THEN
    RAISE EXCEPTION 'Debt-reminder mode must not bypass a frozen customer account';
  END IF;
  UPDATE public.customer_account_links SET account_status='ACTIVE' WHERE customer_id=v_customer;

  UPDATE public.customers SET is_active=false WHERE id=v_customer;
  IF public.native_push_device_is_current(v_device,false,true) IS TRUE THEN
    RAISE EXCEPTION 'Debt-reminder mode must not bypass an inactive customer';
  END IF;
  UPDATE public.customers SET is_active=true WHERE id=v_customer;

  UPDATE auth.sessions SET not_after=now()-interval '1 second' WHERE id=v_auth_session;
  IF public.native_push_device_is_current(v_device,false,true) IS TRUE THEN
    RAISE EXCEPTION 'Debt-reminder mode must never bypass an expired Supabase Auth session';
  END IF;
  UPDATE auth.sessions SET not_after=NULL WHERE id=v_auth_session;

  -- Admin push delivery must be denied for disabled or idle-expired sessions.
  INSERT INTO auth.sessions(id,user_id,not_after)
  VALUES ('40000000-0000-4000-8000-000000000002',
          '30000000-0000-4000-8000-000000000002',NULL);
  INSERT INTO public.admins(id,auth_user_id,is_active,disabled_at)
  VALUES ('50000000-0000-4000-8000-000000000002',
          '30000000-0000-4000-8000-000000000002',true,NULL);
  INSERT INTO public.account_sessions(session_id,user_id,revoked_at,session_expires_at)
  VALUES ('40000000-0000-4000-8000-000000000002',
          '30000000-0000-4000-8000-000000000002',NULL,now()+interval '7 days');
  INSERT INTO public.native_push_devices(id,device_id,token,app_variant,principal_id,customer_id,auth_session_id,disabled_at)
  VALUES ('10000000-0000-4000-8000-000000000002',gen_random_uuid(),repeat('y',40),
          'admin','30000000-0000-4000-8000-000000000002',NULL,
          '40000000-0000-4000-8000-000000000002',NULL);

  IF public.native_push_device_is_current('10000000-0000-4000-8000-000000000002',false,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Valid active admin push device was unexpectedly rejected';
  END IF;
  UPDATE public.admins SET disabled_at=now()
  WHERE id='50000000-0000-4000-8000-000000000002';
  IF public.native_push_device_is_current('10000000-0000-4000-8000-000000000002',false,false) IS TRUE THEN
    RAISE EXCEPTION 'Disabled administrator still qualified for native push delivery';
  END IF;
  UPDATE public.admins SET disabled_at=NULL
  WHERE id='50000000-0000-4000-8000-000000000002';
  UPDATE public.account_sessions SET session_expires_at=now()-interval '1 second'
  WHERE session_id='40000000-0000-4000-8000-000000000002';
  IF public.native_push_device_is_current('10000000-0000-4000-8000-000000000002',false,false) IS TRUE THEN
    RAISE EXCEPTION 'Idle-expired administrator session still qualified for native push delivery';
  END IF;

  IF has_function_privilege('anon','public.native_push_device_is_current(uuid,boolean,boolean)','EXECUTE')
     OR has_function_privilege('authenticated','public.native_push_device_is_current(uuid,boolean,boolean)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.native_push_device_is_current(uuid,boolean,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'Three-argument native push verifier ACL is not service-role-only';
  END IF;
END;
$test$;
