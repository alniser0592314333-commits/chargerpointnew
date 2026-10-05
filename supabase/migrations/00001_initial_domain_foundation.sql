/**
 * Supabase PostgreSQL Migration: 00001_initial_domain_foundation.sql
 * Clean, production-grade schema for Order & Customer Management System.
 * Strict adherence to domain model requirements, integer minor currency units, immutable ledger, and RBAC.
 */

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================
-- 1. ENUMS & STATUS TYPES
-- ==========================================

CREATE TYPE user_role AS ENUM ('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'OPERATOR', 'FINANCE', 'VIEWER');
CREATE TYPE order_status AS ENUM ('pending', 'charging', 'delivered', 'cancelled');
CREATE TYPE item_status AS ENUM ('pending', 'charging', 'delivered', 'cancelled');
CREATE TYPE ledger_event_type AS ENUM (
  'ORDER_ITEM_CHARGE',
  'PAYMENT',
  'REFUND',
  'REVERSAL',
  'CREDIT_ADJUSTMENT',
  'CREDIT_USED',
  'BONUS',
  'CORRECTION'
);
CREATE TYPE qr_token_type AS ENUM ('ORDER', 'CUSTOMER');

-- ==========================================
-- 2. RBAC & ADMINS FOUNDATION
-- ==========================================

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(100) UNIQUE NOT NULL, -- e.g., 'customers:write', 'orders:write'
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE role_permissions (
  role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(100) UNIQUE NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  role_id UUID REFERENCES roles(id) NOT NULL,
  bin_hash VARCHAR(255) NOT NULL, -- Hashed secure representation of BIN
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE admin_custom_permissions (
  admin_id UUID REFERENCES admins(id) ON DELETE CASCADE,
  permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
  granted BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (admin_id, permission_id)
);

-- ==========================================
-- 3. BUSINESS DAYS
-- ==========================================

CREATE TABLE business_days (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date DATE UNIQUE NOT NULL,
  is_closed BOOLEAN NOT NULL DEFAULT FALSE,
  closed_at TIMESTAMPTZ,
  closed_by UUID REFERENCES admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1
);

-- ==========================================
-- 4. CUSTOMERS
-- ==========================================

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(50),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  debt_limit_minor INTEGER NOT NULL DEFAULT 0, -- Stored in minor units (e.g. -1000 for -10.00₪)
  charger_fee_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1
);

-- ==========================================
-- 5. DEVICE TYPES (GLOBAL / ONLINE)
-- ==========================================

CREATE TABLE device_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(150) NOT NULL,
  icon VARCHAR(100) NOT NULL,
  base_price_minor INTEGER NOT NULL CHECK (base_price_minor >= 0),
  charger_fee_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1
);

-- ==========================================
-- 6. QR TOKENS FOUNDATION
-- ==========================================

CREATE TABLE qr_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash VARCHAR(255) UNIQUE NOT NULL, -- Cryptographically non-guessable hash/token
  token_type qr_token_type NOT NULL,
  target_id UUID NOT NULL, -- references either order_id or customer_id
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- 7. ORDERS & ORDER ITEMS
-- ==========================================

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id UUID REFERENCES business_days(id) NOT NULL,
  customer_id UUID REFERENCES customers(id) NOT NULL,
  display_number INTEGER NOT NULL, -- Resets to 1 each business day
  internal_sequence BIGSERIAL UNIQUE NOT NULL, -- Monotonic immutable server sequence
  status order_status NOT NULL DEFAULT 'pending',
  notes TEXT,
  qr_token_id UUID REFERENCES qr_tokens(id),
  charging_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  -- Note: NO UNIQUE constraint on (day_id, customer_id) to allow multiple orders per customer per day
  CONSTRAINT positive_display_number CHECK (display_number > 0)
);

CREATE INDEX idx_orders_day_customer ON orders(day_id, customer_id);

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
  device_type_id UUID REFERENCES device_types(id) NOT NULL,
  item_sequence INTEGER NOT NULL,
  status item_status NOT NULL DEFAULT 'pending',
  
  -- Snapshots for historical integrity
  device_name_snapshot VARCHAR(150) NOT NULL,
  device_icon_snapshot VARCHAR(100) NOT NULL,
  base_price_snapshot_minor INTEGER NOT NULL CHECK (base_price_snapshot_minor >= 0),
  charger_fee_enabled_snapshot BOOLEAN NOT NULL,
  customer_charger_fee_exempt_snapshot BOOLEAN NOT NULL,
  charger_fee_snapshot_minor INTEGER NOT NULL CHECK (charger_fee_snapshot_minor >= 0),
  has_charger BOOLEAN NOT NULL DEFAULT FALSE,
  
  -- Calculated minor unit pricing
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  total_price_minor INTEGER NOT NULL CHECK (total_price_minor >= 0),
  
  replacement_of_item_id UUID REFERENCES order_items(id),
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_order_items_order ON order_items(order_id);

-- ==========================================
-- 8. FINANCIAL LEDGER (APPEND-ONLY)
-- ==========================================

CREATE TABLE financial_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type ledger_event_type NOT NULL,
  amount_minor INTEGER NOT NULL, -- Positive for charges/bonuses/payments, negative for refunds/reversals
  order_id UUID REFERENCES orders(id),
  order_item_id UUID REFERENCES order_items(id),
  customer_id UUID REFERENCES customers(id) NOT NULL,
  actor_admin_id UUID REFERENCES admins(id),
  reference_id UUID, -- For linking reversals, corrections, or payment IDs
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledger_customer ON financial_ledger(customer_id);
CREATE INDEX idx_ledger_order ON financial_ledger(order_id);

-- ==========================================
-- 9. PAYMENTS & ALLOCATIONS (FIFO)
-- ==========================================

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  payment_method VARCHAR(50) NOT NULL,
  reference VARCHAR(255),
  actor_admin_id UUID REFERENCES admins(id) NOT NULL,
  command_id UUID UNIQUE NOT NULL, -- Idempotency key
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID REFERENCES payments(id) ON DELETE CASCADE NOT NULL,
  order_id UUID REFERENCES orders(id) NOT NULL,
  allocated_amount_minor INTEGER NOT NULL CHECK (allocated_amount_minor > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_allocations_order ON payment_allocations(order_id);

-- ==========================================
-- 10. IDEMPOTENCY & SYNC FOUNDATION
-- ==========================================

CREATE TABLE processed_commands (
  command_id UUID PRIMARY KEY,
  actor_id UUID REFERENCES admins(id),
  command_type VARCHAR(100) NOT NULL,
  result_payload JSONB,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE change_log (
  sequence_id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(100) NOT NULL,
  entity_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE'
  payload JSONB NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sync_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(100) NOT NULL,
  entity_id UUID NOT NULL,
  local_version INTEGER NOT NULL,
  server_version INTEGER NOT NULL,
  conflict_data JSONB NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- 11. AUDIT LOGS & APP DEVICES
-- ==========================================

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_admin_id UUID REFERENCES admins(id),
  action VARCHAR(150) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id UUID,
  before_state JSONB,
  after_state JSONB,
  device_id UUID,
  command_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE app_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES admins(id),
  platform VARCHAR(50) NOT NULL,
  app_version VARCHAR(50) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- 12. AUTOMATIC UPDATED_AT TRIGGER FUNCTION
-- ==========================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   NEW.version = OLD.version + 1;
   RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_admins_modtime BEFORE UPDATE ON admins FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_business_days_modtime BEFORE UPDATE ON business_days FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_customers_modtime BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_device_types_modtime BEFORE UPDATE ON device_types FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_orders_modtime BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_order_items_modtime BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_app_devices_modtime BEFORE UPDATE ON app_devices FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
