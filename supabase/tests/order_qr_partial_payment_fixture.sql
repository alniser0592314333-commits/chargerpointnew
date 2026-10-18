-- Extend the isolated QR payment fixture with the columns used by the latest public order resolver.
CREATE TABLE IF NOT EXISTS public.device_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  name_ar text,
  name_en text
);
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS device_type_id uuid,
  ADD COLUMN IF NOT EXISTS financial_status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS financially_recognized_at timestamptz;
