-- The internal goal evaluator is called by SECURITY DEFINER wrappers and triggers only.
-- The service role must use the guarded public wrapper rather than bypassing that authorization boundary.
REVOKE ALL ON FUNCTION public.evaluate_customer_active_goal_internal(uuid) FROM PUBLIC, anon, authenticated, service_role;
