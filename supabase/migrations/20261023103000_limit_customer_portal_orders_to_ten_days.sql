DO $migration$
DECLARE v_definition text;
BEGIN
 v_definition:=pg_get_functiondef('public.public_resolve_customer_portal(text)'::regprocedure);
 IF position('AND o.created_at >= statement_timestamp() - interval ''10 days''' in v_definition)=0 THEN
  v_definition:=replace(v_definition,
   'AND o.deleted_at IS NULL'||E'\n'||'          AND o.cancelled_at IS NULL',
   'AND o.deleted_at IS NULL'||E'\n'||'          AND o.cancelled_at IS NULL'||E'\n'||'          AND o.created_at >= statement_timestamp() - interval ''10 days''');
  IF position('AND o.created_at >= statement_timestamp() - interval ''10 days''' in v_definition)=0 THEN
   RAISE EXCEPTION 'Could not safely apply the ten-day customer portal order filter';
  END IF;
  EXECUTE v_definition;
 END IF;
END;
$migration$;