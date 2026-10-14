-- The incremental client now uses pull_canonical_changes(bigint, integer),
-- which performs its own auth.uid() and active-admin checks. The legacy RPC is
-- a SECURITY DEFINER table reader without an identity guard; remove it from
-- every client role to prevent authenticated non-admins (and anon/PUBLIC)
-- from reading customer/order/financial change-log payloads.
--
-- Keep service_role access for explicitly trusted operational workflows only.
REVOKE ALL ON FUNCTION public.pull_canonical_delta_changes(bigint, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pull_canonical_delta_changes(bigint, integer)
  TO service_role;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.pull_canonical_delta_changes(bigint,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pull_canonical_delta_changes(bigint,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Legacy change-log pull RPC remains executable by an untrusted role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.pull_canonical_delta_changes(bigint,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Trusted service_role compatibility grant was not preserved';
  END IF;
END;
$verify$;
