DO $migration$
DECLARE v_definition text;
BEGIN
 v_definition:=pg_get_functiondef('public.public_resolve_customer_portal(text)'::regprocedure);
 v_definition:=replace(v_definition,'public.public_resolve_customer_portal(p_public_token text)','public.public_resolve_customer_portal(p_public_token text, p_include_history boolean)');
 v_definition:=replace(v_definition,'AND o.created_at >= statement_timestamp() - interval ''10 days''','AND (p_include_history IS TRUE OR o.created_at >= statement_timestamp() - interval ''10 days'')');
 IF position('p_include_history boolean' in v_definition)=0 OR position('p_include_history IS TRUE OR' in v_definition)=0 THEN
  RAISE EXCEPTION 'Could not safely construct history-aware customer portal projection';
 END IF;
 EXECUTE v_definition;
END;
$migration$;
REVOKE ALL ON FUNCTION public.public_resolve_customer_portal(text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.public_resolve_customer_portal(text,boolean) TO service_role;