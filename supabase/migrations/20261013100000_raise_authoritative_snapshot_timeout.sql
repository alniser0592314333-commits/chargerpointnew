-- Allow the full authoritative snapshot RPC enough time to serialize the complete
-- cloud dataset on installations where the default role statement_timeout is too
-- short. This does not omit or paginate any collections and does not modify data.
--
-- The function remains one STABLE statement, so all collections still come from
-- the same PostgreSQL statement snapshot. Keep the timeout bounded; do not remove
-- change_log or replace it with only a cursor because full local hydration needs
-- the complete authoritative dataset.
ALTER FUNCTION public.capture_authoritative_business_snapshot()
  SET statement_timeout = '120s';
