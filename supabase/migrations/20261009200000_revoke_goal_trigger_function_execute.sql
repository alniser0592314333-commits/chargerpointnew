-- Trigger-only goal functions must not be directly executable through the public Data API.
-- Their SECURITY DEFINER behavior is required only when invoked by their table triggers.
REVOKE ALL ON FUNCTION public.enforce_goal_business_rules() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reconcile_active_goal_after_item_change() FROM PUBLIC, anon, authenticated, service_role;
