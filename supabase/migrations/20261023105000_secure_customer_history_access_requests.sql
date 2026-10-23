ALTER TABLE public.customer_history_access_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_history_access_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.customer_history_access_requests TO service_role;