CREATE TABLE IF NOT EXISTS public.customer_history_access_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
 requested_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 reviewed_by uuid REFERENCES public.admins(id),
 access_expires_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_history_access_one_pending_idx
 ON public.customer_history_access_requests(customer_id) WHERE status='PENDING';
CREATE INDEX IF NOT EXISTS customer_history_access_expiry_idx
 ON public.customer_history_access_requests(customer_id,access_expires_at DESC) WHERE status='APPROVED';