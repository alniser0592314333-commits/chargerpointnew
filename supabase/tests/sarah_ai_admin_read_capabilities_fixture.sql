-- Additional disposable schema for Sarah admin read/order capability migration tests.
-- Applied only after the existing provider, quota, lookup, and profile fixtures.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS debt_limit_minor bigint NOT NULL DEFAULT 0;

CREATE TABLE public.business_days (
  id uuid PRIMARY KEY,
  business_date date NOT NULL UNIQUE,
  display_number integer NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  is_closed boolean NOT NULL DEFAULT false,
  opened_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE public.device_types (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  name_ar text,
  name_en text,
  base_price_minor bigint NOT NULL DEFAULT 0,
  charger_fee_minor bigint NOT NULL DEFAULT 0,
  charger_fee_applicable boolean NOT NULL DEFAULT false,
  charger_fee_enabled boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'ACTIVE',
  deleted_at timestamptz,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE public.orders (
  id uuid PRIMARY KEY,
  day_id uuid NOT NULL REFERENCES public.business_days(id),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  display_number integer NOT NULL,
  status text NOT NULL DEFAULT 'charging',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  cancelled_at timestamptz,
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE public.order_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  device_type_id uuid NOT NULL REFERENCES public.device_types(id),
  item_sequence integer NOT NULL,
  operational_status text NOT NULL DEFAULT 'CHARGING',
  financial_status text NOT NULL DEFAULT 'UNPAID',
  status text NOT NULL DEFAULT 'charging',
  replacement_of_item_id uuid,
  final_charge_snapshot_minor bigint NOT NULL DEFAULT 0,
  charger_fee_snapshot_minor bigint NOT NULL DEFAULT 0,
  discount_snapshot_minor bigint NOT NULL DEFAULT 0,
  device_name_snapshot text,
  delivered_at timestamptz,
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE public.financial_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  amount_minor bigint NOT NULL,
  event_type text NOT NULL DEFAULT 'PAYMENT',
  reference_id uuid,
  order_id uuid,
  order_item_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.goals (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  target_quantity integer NOT NULL,
  current_progress integer NOT NULL DEFAULT 0,
  bonus_amount_minor bigint NOT NULL,
  duration_days integer NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  bonus_ledger_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX goals_one_active_per_customer_idx
  ON public.goals(customer_id) WHERE status='ACTIVE';

CREATE TABLE public.goal_requests (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  requested_target integer,
  status text NOT NULL DEFAULT 'PENDING',
  reviewed_by uuid,
  reviewed_at timestamptz,
  rejection_reason text,
  resulting_goal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
GRANT SELECT ON public.goals,public.goal_requests TO authenticated;

INSERT INTO public.device_types(id,name,name_ar,name_en,base_price_minor,charger_fee_minor,charger_fee_applicable,is_active,status,sort_order)
VALUES
 ('30000000-0000-4000-8000-000000000001','Xiaomi','شاومي','Xiaomi',10000,500,true,true,'ACTIVE',1),
 ('30000000-0000-4000-8000-000000000002','Headphones','سماعة','Headphones',5000,0,false,true,'ACTIVE',2),
 ('30000000-0000-4000-8000-000000000003','Failure Device','فشل اختبار','FAIL',7000,0,false,true,'ACTIVE',3),
 ('30000000-0000-4000-8000-000000000004','Other','أخرى','Other',0,0,false,true,'ACTIVE',4);

INSERT INTO public.admin_custom_permissions(admin_id,permission,is_grant)
VALUES
 ('00000000-0000-4000-8000-000000000002','ai:use',true),
 ('00000000-0000-4000-8000-000000000002','customers:view',true),
 ('00000000-0000-4000-8000-000000000002','customers:financial-view',true),
 ('00000000-0000-4000-8000-000000000002','orders:view',true),
 ('00000000-0000-4000-8000-000000000002','orders:create',true),
 ('00000000-0000-4000-8000-000000000002','orders:edit',true),
 ('00000000-0000-4000-8000-000000000002','orders:deliver',true),
 ('00000000-0000-4000-8000-000000000002','orders:cancel',true),
 ('00000000-0000-4000-8000-000000000002','goals:view',true),
 ('00000000-0000-4000-8000-000000000002','goals:requests:view',true),
 ('00000000-0000-4000-8000-000000000002','goals:manage',true),
 ('00000000-0000-4000-8000-000000000002','goals:approve',true),
 ('00000000-0000-4000-8000-000000000002','finance:create-payment',true),
 ('00000000-0000-4000-8000-000000000002','finance:approve-payment',true),
 ('00000000-0000-4000-8000-000000000007','ai:use',true),
 ('00000000-0000-4000-8000-000000000007','customers:view',true),
 ('00000000-0000-4000-8000-000000000007','orders:create',true),
 ('00000000-0000-4000-8000-000000000008','ai:use',true),
 ('00000000-0000-4000-8000-000000000008','customers:financial-view',true),
 ('00000000-0000-4000-8000-000000000008','orders:view',true),
 ('00000000-0000-4000-8000-000000000008','orders:deliver',true),
 ('00000000-0000-4000-8000-000000000008','goals:view',true),
 ('00000000-0000-4000-8000-000000000008','goals:requests:view',true),
 ('00000000-0000-4000-8000-000000000008','goals:manage',true),
 ('00000000-0000-4000-8000-000000000008','goals:approve',true),
 ('00000000-0000-4000-8000-000000000009','ai:use',true),
 ('00000000-0000-4000-8000-000000000009','customers:view',true),
 ('00000000-0000-4000-8000-000000000009','orders:view',true),
 ('00000000-0000-4000-8000-000000000009','orders:create',true),
 ('00000000-0000-4000-8000-000000000009','orders:edit',true),
ON CONFLICT(admin_id,permission) DO UPDATE SET is_grant=EXCLUDED.is_grant;

CREATE OR REPLACE FUNCTION public.record_canonical_change(
  p_table_name text,
  p_entity_id uuid,
  p_operation text,
  p_payload jsonb,
  p_version integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.calculate_customer_authoritative_balance(p_customer_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(sum(fl.amount_minor),0)::bigint
  FROM public.financial_ledger fl
  WHERE fl.customer_id=p_customer_id;
$function$;

-- Test double for the canonical sync-command boundary. Production Sarah code
-- calls the real execute_sync_command RPC; this fixture only records the same
-- CREATE_ORDER/ADD_ORDER_ITEM aggregate and deliberately fails on FAIL device.
CREATE TABLE public.sarah_ai_test_order_actions(
  command_id uuid PRIMARY KEY,
  command_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL
);

GRANT SELECT ON public.sarah_ai_test_order_actions TO authenticated;

CREATE OR REPLACE FUNCTION public.execute_sync_command(
  p_command_id uuid,
  p_command_type text,
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_payload jsonb,
  p_expected_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_display_number integer;
  v_device public.device_types%ROWTYPE;
  v_has_charger boolean;
  v_charge bigint;
BEGIN
  IF p_command_type='OPEN_DAY' THEN
    SELECT COALESCE(max(display_number),0)+1 INTO v_display_number FROM public.business_days;
    INSERT INTO public.business_days(id,business_date,display_number,status,is_closed,opened_at,created_at,updated_at,version)
    VALUES(
      (p_payload->>'id')::uuid,(p_payload->>'businessDate')::date,v_display_number,
      'OPEN',false,now(),now(),now(),1
    );
    RETURN jsonb_build_object('success',true,'result',jsonb_build_object('id',p_payload->>'id','status','OPEN'));
  ELSIF p_command_type='CREATE_ORDER' THEN
    INSERT INTO public.orders(id,day_id,customer_id,display_number,status,notes)
    VALUES(
      (p_payload->>'id')::uuid,
      (p_payload->>'dayId')::uuid,
      (p_payload->>'customerId')::uuid,
      (p_payload->>'displayNumber')::integer,
      'charging',
      p_payload->>'notes'
    )
    RETURNING display_number INTO v_display_number;
    RETURN jsonb_build_object('success',true,'result',jsonb_build_object('displayNumber',v_display_number));
  ELSIF p_command_type='ADD_ORDER_ITEM' THEN
    SELECT * INTO v_device
    FROM public.device_types
    WHERE id=(p_payload->>'deviceTypeId')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Device type missing';
    END IF;
    IF v_device.name_en='FAIL' THEN
      RAISE EXCEPTION 'Simulated canonical item failure';
    END IF;
    v_has_charger:=COALESCE((p_payload->>'hasCharger')::boolean,false);
    v_charge:=v_device.base_price_minor
      + CASE WHEN v_device.charger_fee_applicable AND NOT v_has_charger
          THEN v_device.charger_fee_minor ELSE 0 END;
    INSERT INTO public.order_items(
      id,order_id,device_type_id,item_sequence,operational_status,financial_status,
      final_charge_snapshot_minor,charger_fee_snapshot_minor,discount_snapshot_minor,device_name_snapshot
    )
    VALUES(
      p_command_id,(p_payload->>'orderId')::uuid,v_device.id,
      (p_payload->>'itemSequence')::integer,'CHARGING','UNPAID',
      v_charge,
      CASE WHEN v_device.charger_fee_applicable AND NOT v_has_charger THEN v_device.charger_fee_minor ELSE 0 END,
      0,v_device.name
    );
    RETURN jsonb_build_object('success',true,'result',jsonb_build_object('provisionalFinalChargeMinor',v_charge));
  ELSIF p_command_type='CREATE_GOAL' THEN
    INSERT INTO public.goals(id,customer_id,target_quantity,current_progress,bonus_amount_minor,duration_days,status,started_at,expires_at)
    VALUES(
      (p_payload->>'id')::uuid,(p_payload->>'customerId')::uuid,
      (p_payload->>'targetQuantity')::integer,0,(p_payload->>'bonusAmountMinor')::bigint,
      (p_payload->>'durationDays')::integer,'ACTIVE',
      (p_payload->>'startedAt')::timestamptz,(p_payload->>'expiresAt')::timestamptz
    );
    RETURN jsonb_build_object('success',true,'result',jsonb_build_object('goalId',p_payload->>'id','status','ACTIVE'));
  ELSIF p_command_type='APPROVE_GOAL_REQUEST' THEN
    INSERT INTO public.goals(id,customer_id,target_quantity,current_progress,bonus_amount_minor,duration_days,status,started_at,expires_at)
    SELECT (p_payload->>'resultingGoalId')::uuid,r.customer_id,
      (p_payload->>'targetQuantity')::integer,0,(p_payload->>'bonusAmountMinor')::bigint,
      (p_payload->>'durationDays')::integer,'ACTIVE',now(),(p_payload->>'expiresAt')::timestamptz
    FROM public.goal_requests r WHERE r.id=(p_payload->>'requestId')::uuid;
    UPDATE public.goal_requests SET status='APPROVED',resulting_goal_id=(p_payload->>'resultingGoalId')::uuid,
      reviewed_at=now(),version=version+1 WHERE id=(p_payload->>'requestId')::uuid;
    RETURN jsonb_build_object('success',true,'result',jsonb_build_object('status','APPROVED'));
  ELSIF p_command_type='REJECT_GOAL_REQUEST' THEN
    UPDATE public.goal_requests SET status='REJECTED',rejection_reason=p_payload->>'rejectionReason',
      reviewed_at=now(),version=version+1 WHERE id=(p_payload->>'requestId')::uuid;
    RETURN jsonb_build_object('success',true,'result',jsonb_build_object('status','REJECTED'));
  ELSIF p_command_type='UPDATE_GOAL_CONFIG' THEN
    UPDATE public.goals SET
      target_quantity=COALESCE((p_payload->>'targetQuantity')::integer,target_quantity),
      duration_days=COALESCE((p_payload->>'durationDays')::integer,duration_days),
      bonus_amount_minor=COALESCE((p_payload->>'bonusAmountMinor')::bigint,bonus_amount_minor),
      expires_at=COALESCE((p_payload->>'expiresAt')::timestamptz,expires_at),
      version=version+1,updated_at=now()
    WHERE id=(p_payload->>'id')::uuid;
    RETURN jsonb_build_object('success',true,'result',jsonb_build_object('version',2));
  ELSIF p_command_type IN ('DELIVER_ORDER_ITEM','CANCEL_ORDER_ITEM','CANCEL_ORDER') THEN
    INSERT INTO public.sarah_ai_test_order_actions(command_id,command_type,aggregate_type,aggregate_id,payload)
    VALUES(p_command_id,p_command_type,p_aggregate_type,p_aggregate_id,p_payload);
    RETURN jsonb_build_object(
      'success',true,'commandType',p_command_type,
      'result',jsonb_build_object('targetId',p_aggregate_id,'status',CASE
        WHEN p_command_type='DELIVER_ORDER_ITEM' THEN 'DELIVERED'
        ELSE 'CANCELLED' END)
    );
  END IF;
  RAISE EXCEPTION 'Unexpected canonical command type: %',p_command_type;
END;
$function$;


CREATE TABLE public.qr_payment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  amount_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  payment_method text NOT NULL DEFAULT 'CASH',
  submission_source text NOT NULL DEFAULT 'ADMIN_MANUAL',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  payment_id uuid,
  approved_amount_minor bigint,
  balance_before_minor bigint,
  balance_after_minor bigint,
  rejection_reason text
);

CREATE OR REPLACE FUNCTION public.admin_cancel_goal(p_goal_id uuid,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
BEGIN
  UPDATE public.goals SET status='CANCELLED',updated_at=now(),version=version+1 WHERE id=p_goal_id AND status='ACTIVE';
  RETURN jsonb_build_object('ok',true,'goal_id',p_goal_id,'status','CANCELLED');
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_review_goal_cancellation(p_goal_id uuid,p_approve boolean,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
BEGIN
  RETURN jsonb_build_object('ok',true,'goal_id',p_goal_id,'approved',p_approve);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_goals_page_data()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $function$
  SELECT jsonb_build_object(
    'goals',COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.goals g),'[]'::jsonb),
    'goal_requests',COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.goal_requests r),'[]'::jsonb),
    'customers',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name)) FROM public.customers c),'[]'::jsonb)
  );
$function$;

CREATE OR REPLACE FUNCTION public.create_admin_pending_customer_payment(
  p_customer_id uuid,
  p_amount_minor bigint,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.qr_payment_submissions(customer_id,amount_minor,status,payment_method,submission_source,note)
  VALUES(p_customer_id,p_amount_minor,'PENDING','CASH','ADMIN_MANUAL',p_note)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success',true,'id',v_id,'status','PENDING');
END;
$function$;

CREATE OR REPLACE FUNCTION public.review_qr_payment_submission(
  p_submission_id uuid,
  p_action text,
  p_bin text DEFAULT NULL,
  p_rejection_reason text DEFAULT NULL,
  p_approved_amount_minor bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_row public.qr_payment_submissions%ROWTYPE;
  v_payment_id uuid;
  v_before bigint := 1234;
BEGIN
  SELECT * INTO v_row FROM public.qr_payment_submissions WHERE id=p_submission_id FOR UPDATE;
  IF NOT FOUND OR v_row.status<>'PENDING' THEN
    RAISE EXCEPTION 'Payment submission is not pending' USING ERRCODE='P0001';
  END IF;
  IF pg_catalog.upper(p_action)='APPROVE' THEN
    IF p_bin IS DISTINCT FROM '1234' THEN
      RAISE EXCEPTION 'BIN_INVALID' USING ERRCODE='P0003';
    END IF;
    v_payment_id:=gen_random_uuid();
    UPDATE public.qr_payment_submissions
    SET status='APPROVED',reviewed_at=now(),payment_id=v_payment_id,
        approved_amount_minor=p_approved_amount_minor,
        balance_before_minor=v_before,
        balance_after_minor=v_before+p_approved_amount_minor
    WHERE id=p_submission_id;
    RETURN jsonb_build_object(
      'success',true,'status','APPROVED','payment_id',v_payment_id,
      'balance_before_minor',v_before,'balance_after_minor',v_before+p_approved_amount_minor
    );
  ELSIF pg_catalog.upper(p_action)='REJECT' THEN
    UPDATE public.qr_payment_submissions
    SET status='REJECTED',reviewed_at=now(),rejection_reason=p_rejection_reason
    WHERE id=p_submission_id;
    RETURN jsonb_build_object('success',true,'status','REJECTED');
  END IF;
  RAISE EXCEPTION 'Unsupported review action' USING ERRCODE='22023';
END;
$function$;

