BEGIN;

-- The registry exposes customer-specific reads/actions only when customers:view
-- is present. Re-check that same live permission inside every database RPC so
-- a direct call or a mid-conversation permission revocation cannot bypass it.
DO $permission_alignment$
DECLARE
  v_definition text;
  v_signature regprocedure;
  v_anchor text;
  v_replacement text;
BEGIN
  v_signature:='public.sarah_ai_get_customer_financial_summary(text,text)'::regprocedure;
  v_definition:=pg_catalog.pg_get_functiondef(v_signature);
  v_anchor:='PERFORM public._cp_assert_active_admin_permission(''customers:financial-view'');';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN
    RAISE EXCEPTION 'Financial summary permission anchor changed; refusing unsafe rewrite';
  END IF;
  v_replacement:='PERFORM public._cp_assert_active_admin_permission(''customers:view'');'||E'\n  '||v_anchor;
  EXECUTE replace(v_definition,v_anchor,v_replacement);

  v_signature:='public.sarah_ai_get_customer_orders(text,text,integer)'::regprocedure;
  v_definition:=pg_catalog.pg_get_functiondef(v_signature);
  v_anchor:='PERFORM public._cp_assert_active_admin_permission(''orders:view'');';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN
    RAISE EXCEPTION 'Customer order permission anchor changed; refusing unsafe rewrite';
  END IF;
  v_replacement:='PERFORM public._cp_assert_active_admin_permission(''customers:view'');'||E'\n  '||v_anchor;
  EXECUTE replace(v_definition,v_anchor,v_replacement);

  v_signature:='public.sarah_ai_execute_order_action(uuid,text,text,uuid,text,text,text)'::regprocedure;
  v_definition:=pg_catalog.pg_get_functiondef(v_signature);
  v_anchor:='PERFORM public._cp_assert_active_admin_permission(''orders:view'');';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN
    RAISE EXCEPTION 'Order lifecycle permission anchor changed; refusing unsafe rewrite';
  END IF;
  v_replacement:='PERFORM public._cp_assert_active_admin_permission(''customers:view'');'||E'\n  '||v_anchor;
  EXECUTE replace(v_definition,v_anchor,v_replacement);

  v_signature:='public.sarah_ai_get_customer_financial_history(text,text,integer)'::regprocedure;
  v_definition:=pg_catalog.pg_get_functiondef(v_signature);
  v_anchor:='PERFORM public._cp_assert_active_admin_permission(''customers:financial-view'');';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN
    RAISE EXCEPTION 'Financial history permission anchor changed; refusing unsafe rewrite';
  END IF;
  v_replacement:='PERFORM public._cp_assert_active_admin_permission(''customers:view'');'||E'\n  '||v_anchor;
  EXECUTE replace(v_definition,v_anchor,v_replacement);
END;
$permission_alignment$;

COMMIT;
