/**
 * Canonical Enums & Statuses
 */

export type OrderStatus = 'pending' | 'charging' | 'delivered' | 'cancelled';
export type ItemStatus = 'charging' | 'delivered' | 'cancelled';
export type PaymentStatus = 'paid' | 'partially_paid' | 'unpaid';

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'OPERATOR' | 'FINANCE' | 'VIEWER';

export type Permission =
  | 'orders:view'
  | 'orders:create'
  | 'orders:edit'
  | 'orders:deliver'
  | 'orders:cancel'
  | 'orders:correct'
  | 'customers:view'
  | 'customers:create'
  | 'customers:edit'
  | 'customers:deactivate'
  | 'customers:debt-limit'
  | 'customers:charger-exemption'
  | 'customers:financial-view'
  | 'finance:view'
  | 'finance:create-payment'
  | 'finance:approve-payment'
  | 'finance:refund'
  | 'finance:correction'
  | 'finance:credit-adjustment'
  | 'devices:view'
  | 'devices:manage'
  | 'devices:pricing'
  | 'devices:charger-policy'
  | 'settings:manage'
  | 'admin:manage'
  | 'sync:manage'
  | 'sync:view'
  | 'goals:view'
  | 'goals:manage'
  | 'goals:request'
  | 'goals:approve';
