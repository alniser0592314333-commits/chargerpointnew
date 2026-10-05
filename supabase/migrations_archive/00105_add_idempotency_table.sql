-- Migration: Add idempotency_log table
CREATE TABLE IF NOT EXISTS public.idempotency_log (
    command_id UUID PRIMARY KEY,
    command_type TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result_payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ensure payments has a unique constraint if needed, but idempotency_log handles the canonical check
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_command_id ON public.payments(command_id);
