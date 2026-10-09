-- Goal evaluator internals and trigger-only functions must not be directly executable by client or service roles.
-- SECURITY DEFINER execution is needed only through the authenticated public wrapper and table triggers.
REVOKE ALL ON FUNCTION public.evaluate_customer_active_goal_internal(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_goal_business_rules() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reconcile_active_goal_after_item_change() FROM PUBLIC, anon, authenticated, service_role;
