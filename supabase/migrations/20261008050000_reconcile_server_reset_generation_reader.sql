-- Reconcile the live server reset generation reader into version control.
CREATE OR REPLACE FUNCTION public.get_server_reset_generation()
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(value_number, 1)::bigint
  from public.system_settings
  where key = 'server_reset_generation'
  limit 1;
$function$
