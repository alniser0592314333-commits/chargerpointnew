DO $migration$
DECLARE v_definition text;
BEGIN
 v_definition := pg_get_functiondef('public.public_resolve_customer_portal(text,boolean)'::regprocedure);
 IF position('LIMIT 30' in v_definition) > 0 THEN
   v_definition := replace(v_definition, 'LIMIT 30', '');
   EXECUTE v_definition;
 END IF;
END;
$migration$;