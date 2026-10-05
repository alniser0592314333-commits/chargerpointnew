-- Migration 00015: Safe Cleanup of Legacy Activation Code Tables
-- Removes unused legacy tables activation_codes and activation_code_attempts (superseded by 00012 bootstrap)
-- Does NOT touch admins, auth.users, roles, permissions, BIN verification, or bootstrap functions.

DROP TABLE IF EXISTS public.activation_code_attempts CASCADE;
DROP TABLE IF EXISTS public.activation_codes CASCADE;
