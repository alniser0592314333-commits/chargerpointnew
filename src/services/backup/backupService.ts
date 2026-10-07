/**
 * Durable Backup Snapshot & Consolidation Service (Phase B.4)
 * Supports multiple persistent local snapshots, immutable records,
 * OFFLINE / ONLINE / CONSOLIDATED modes, safe reconciliation,
 * staged restore, and strict authorization & secret scrubbing.
 */

import { ID, Timestamp } from '../../types/common';
import { PaymentAllocationEntity } from '../../domain/models';
import {
  localDb,
  BackupSnapshotRecord,
  BackupSnapshotData,
  BackupSourceType,
  SyncStateRecord,
} from '../../infrastructure/localDb/localDb';
import { AuthorizationContext } from '../../application/authContext';
import {
  NotFoundError,
  SnapshotIntegrityError,
  SnapshotFormatError,
  AuthorizationError,
} from '../../domain/errors';
import { invokeSupabaseRestGet, invokeSupabaseRpc } from '../supabase/client';

export const PORTABLE_BACKUP_FORMAT_IDENTIFIER = 'ORDER_SYSTEM_PORTABLE_BACKUP';
export const PORTABLE_BACKUP_FORMAT_VERSION = 1;

export interface PortableBackupFile {
  formatIdentifier: typeof PORTABLE_BACKUP_FORMAT_IDENTIFIER;
  formatVersion: number;
  schemaVersion: number;
  snapshotVersion: number;
  snapshotId: string;
  snapshotName: string;
  createdAt: string;
  sourceType: BackupSourceType;
  checkpointSequence?: number;
  createdBy?: {
    id: ID;
    username: string;
    fullName?: string;
  };
  importedAt?: string;
  metadata: {
    recordCounts: Record<string, number>;
    totalEntities: number;
    checksum: string;
    description?: string;
  };
  data: BackupSnapshotData;
}

export function sanitizeFileName(name: string): string {
  if (!name) return 'backup';
  return name.replace(/[^\w\s\u0600-\u06FF-]/g, '').trim().replace(/\s+/g, '_') || 'backup';
}

/**
 * Deterministically computes a checksum over snapshot data using canonical JSON representation
 * and FNV-1a hashing.
 */
export function computeSnapshotChecksum(data: unknown): string {
  const canonicalStringify = (obj: any): string => {
    if (obj === null || obj === undefined) {
      return 'null';
    }
    if (obj instanceof Date) {
      return JSON.stringify(obj.toISOString());
    }
    if (typeof obj !== 'object') {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return '[' + obj.map((item) => (item === undefined ? 'null' : canonicalStringify(item))).join(',') + ']';
    }
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
  };

  const str = canonicalStringify(data);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const FORBIDDEN_EXACT_NORMALIZED_KEYS = new Set([
  'password',
  'passwordhash',
  'hashedpassword',
  'bin',
  'bincode',
  'binhash',
  'binsalt',
  'salt',
  'token',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'secret',
  'secretkey',
  'apikey',
  'privatekey',
]);

const FORBIDDEN_COMPOUND_SUFFIXES = [
  'password',
  'passwordhash',
  'bincode',
  'binhash',
  'binsalt',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'secretkey',
  'apikey',
  'privatekey',
  'secret',
];

export function isForbiddenKey(key: string): boolean {
  if (!key) return false;
  const norm = key.replace(/[-_]/g, '').toLowerCase();
  if (FORBIDDEN_EXACT_NORMALIZED_KEYS.has(norm)) {
    return true;
  }
  for (const suffix of FORBIDDEN_COMPOUND_SUFFIXES) {
    if (norm.length > suffix.length && norm.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively strips sensitive credentials, passwords, BIN secrets, and auth tokens
 * from any entity prior to inclusion in snapshot payloads.
 */
export function sanitizeEntity<T>(entity: T): T {
  if (entity === null || entity === undefined) return entity;
  if (typeof entity !== 'object') return entity;

  if (Array.isArray(entity)) {
    return entity.map((item) => sanitizeEntity(item)) as unknown as T;
  }

  const copy: Record<string, any> = {};
  for (const [key, val] of Object.entries(entity as Record<string, any>)) {
    if (isForbiddenKey(key)) {
      continue;
    }
    if (val && typeof val === 'object') {
      copy[key] = sanitizeEntity(val);
    } else {
      copy[key] = val;
    }
  }
  return copy as T;
}

export function normalizeCustomerEntity(c: any): any {
  if (!c) return c;
  const activeVal = c.isActive ?? c.is_active ?? true;
  const exemptVal = c.chargerFeeExempt ?? c.charger_fee_exempt ?? false;
  const debtLimit = c.debtLimitMinor ?? c.debt_limit_minor ?? c.balanceMinor ?? c.balance_minor ?? 0;
  return {
    id: c.id,
    name: c.name,
    phone: c.phone || c.phone_number || c.phoneNumber || '',
    isActive: Boolean(activeVal),
    is_active: Boolean(activeVal),
    notes: c.notes || '',
    debtLimitMinor: debtLimit,
    debt_limit_minor: debtLimit,
    chargerFeeExempt: Boolean(exemptVal),
    charger_fee_exempt: Boolean(exemptVal),
    createdAt: c.createdAt || c.created_at || new Date().toISOString(),
    updatedAt: c.updatedAt || c.updated_at || c.createdAt || c.created_at || new Date().toISOString(),
    version: c.version || 1,
  };
}

export function normalizeBusinessDayEntity(b: any): any {
  if (!b) return b;
  const businessDate =
    b.businessDate ||
    b.business_date ||
    b.date ||
    (b.id?.startsWith('day-') ? b.id.slice(4) : b.id) ||
    '';
  const closedVal = b.isClosed ?? b.is_closed ?? false;
  return {
    id: b.id,
    businessDate,
    business_date: businessDate,
    isClosed: Boolean(closedVal),
    is_closed: Boolean(closedVal),
    closedAt: b.closedAt || b.closed_at,
    closedBy: b.closedBy || b.closed_by,
    createdAt: b.createdAt || b.created_at || new Date().toISOString(),
    updatedAt: b.updatedAt || b.updated_at,
  };
}

export function normalizeDeviceTypeEntity(d: any): any {
  if (!d) return d;
  const activeVal = d.isActive ?? d.is_active ?? true;
  const chargerVal = d.chargerFeeEnabled ?? d.charger_fee_enabled ?? true;
  const basePrice =
    d.basePriceMinor ??
    d.base_price_minor ??
    d.defaultPriceMinor ??
    d.default_price_minor ??
    d.servicePriceMinor ??
    d.service_price_minor ??
    0;
  return {
    id: d.id,
    name: d.name,
    nameAr: d.nameAr || d.name_ar || d.name,
    name_ar: d.nameAr || d.name_ar || d.name,
    nameEn: d.nameEn || d.name_en || d.name,
    name_en: d.nameEn || d.name_en || d.name,
    icon: d.icon || 'smartphone',
    basePriceMinor: basePrice,
    base_price_minor: basePrice,
    chargerFeeEnabled: Boolean(chargerVal),
    charger_fee_enabled: Boolean(chargerVal),
    isActive: Boolean(activeVal),
    is_active: Boolean(activeVal),
    sortOrder: d.sortOrder ?? d.sort_order ?? 0,
    sort_order: d.sortOrder ?? d.sort_order ?? 0,
    createdAt: d.createdAt || d.created_at || new Date().toISOString(),
    updatedAt: d.updatedAt || d.updated_at,
    deletedAt: d.deletedAt || d.deleted_at,
  };
}

export function normalizeOrderEntity(o: any): any {
  if (!o) return o;
  const dayId = o.dayId || o.day_id;
  const custId = o.customerId || o.customer_id;
  const dispNum = o.displayNumber ?? o.display_number ?? 1;
  const intSeq = o.internalSequence ?? o.internal_sequence ?? 0;
  const balanceSnap = o.customerBalanceSnapshotMinor ?? o.customer_balance_snapshot_minor ?? 0;
  return {
    id: o.id,
    dayId,
    day_id: dayId,
    customerId: custId,
    customer_id: custId,
    displayNumber: dispNum,
    display_number: dispNum,
    internalSequence: intSeq,
    internal_sequence: intSeq,
    status: o.status || 'pending',
    customerBalanceSnapshotMinor: balanceSnap,
    customer_balance_snapshot_minor: balanceSnap,
    notes: o.notes || '',
    qrTokenId: o.qrTokenId || o.qr_token_id,
    chargingAt: o.chargingAt || o.charging_at,
    deliveredAt: o.deliveredAt || o.delivered_at,
    cancelledAt: o.cancelledAt || o.cancelled_at,
    deletedAt: o.deletedAt || o.deleted_at,
    createdAt: o.createdAt || o.created_at || new Date().toISOString(),
    updatedAt: o.updatedAt || o.updated_at,
    version: o.version || 1,
  };
}

export function normalizeOrderItemEntity(i: any): any {
  if (!i) return i;
  const unitPrice =
    i.unitPriceMinor ??
    i.unit_price_minor ??
    i.servicePriceMinor ??
    i.service_price_minor ??
    i.basePriceSnapshotMinor ??
    i.base_price_snapshot_minor ??
    0;
  const totalPrice =
    i.totalPriceMinor ??
    i.total_price_minor ??
    unitPrice;
  const orderId = i.orderId || i.order_id;
  const deviceTypeId = i.deviceTypeId || i.device_type_id;
  const seq = i.itemSequence ?? i.item_sequence ?? 1;
  const baseSnap = i.basePriceSnapshotMinor ?? i.base_price_snapshot_minor ?? unitPrice;
  const chargerEnabledSnap = i.chargerFeeEnabledSnapshot ?? i.charger_fee_enabled_snapshot ?? false;
  const custExemptSnap = i.customerChargerFeeExemptSnapshot ?? i.customer_charger_fee_exempt_snapshot ?? false;
  const chargerFeeSnap = i.chargerFeeSnapshotMinor ?? i.charger_fee_snapshot_minor ?? 0;
  const hasCharger = i.hasCharger ?? i.has_charger ?? false;

  const rawStatus = (
    i.status ||
    i.deliveryStatus ||
    i.delivery_status ||
    'charging'
  );
  const normalizedStatus = (rawStatus === 'delivered' || rawStatus === 'cancelled' || rawStatus === 'pending')
    ? rawStatus
    : 'charging';
  const finStatus = i.financialStatus || i.financial_status || (normalizedStatus === 'delivered' ? 'RECOGNIZED' : 'UNRECOGNIZED');
  const payStatus = i.paymentStatus || i.payment_status || 'UNPAID';

  return {
    id: i.id,
    orderId,
    order_id: orderId,
    deviceTypeId,
    device_type_id: deviceTypeId,
    itemSequence: seq,
    item_sequence: seq,
    status: normalizedStatus,
    financialStatus: finStatus,
    financial_status: finStatus,
    paymentStatus: payStatus,
    payment_status: payStatus,
    deviceNameSnapshot: i.deviceNameSnapshot || i.device_name_snapshot || '',
    device_name_snapshot: i.deviceNameSnapshot || i.device_name_snapshot || '',
    deviceIconSnapshot: i.deviceIconSnapshot || i.device_icon_snapshot || 'smartphone',
    device_icon_snapshot: i.deviceIconSnapshot || i.device_icon_snapshot || 'smartphone',
    basePriceSnapshotMinor: baseSnap,
    base_price_snapshot_minor: baseSnap,
    chargerFeeEnabledSnapshot: Boolean(chargerEnabledSnap),
    charger_fee_enabled_snapshot: Boolean(chargerEnabledSnap),
    customerChargerFeeExemptSnapshot: Boolean(custExemptSnap),
    customer_charger_fee_exempt_snapshot: Boolean(custExemptSnap),
    chargerFeeSnapshotMinor: chargerFeeSnap,
    charger_fee_snapshot_minor: chargerFeeSnap,
    hasCharger: Boolean(hasCharger),
    has_charger: Boolean(hasCharger),
    unitPriceMinor: unitPrice,
    unit_price_minor: unitPrice,
    totalPriceMinor: totalPrice,
    total_price_minor: totalPrice,
    replacementOfItemId: i.replacementOfItemId || i.replacement_of_item_id,
    deliveredAt: i.deliveredAt || i.delivered_at,
    financiallyRecognizedAt: i.financiallyRecognizedAt || i.financially_recognized_at,
    deletedAt: i.deletedAt || i.deleted_at,
    createdAt: i.createdAt || i.created_at || new Date().toISOString(),
    updatedAt: i.updatedAt || i.updated_at,
    version: i.version || 1,
  };
}

export function normalizeFinancialLedgerEntity(l: any): any {
  if (!l) return l;
  return {
    id: l.id,
    sequenceNumber: l.sequenceNumber ?? l.sequence_number,
    sequence_number: l.sequenceNumber ?? l.sequence_number,
    eventType: l.eventType || l.event_type || l.entryType || l.entry_type || 'ORDER_ITEM_CHARGE',
    event_type: l.eventType || l.event_type || l.entryType || l.entry_type || 'ORDER_ITEM_CHARGE',
    amountMinor: l.amountMinor ?? l.amount_minor ?? 0,
    amount_minor: l.amountMinor ?? l.amount_minor ?? 0,
    orderId: l.orderId || l.order_id,
    order_id: l.orderId || l.order_id,
    orderItemId: l.orderItemId || l.order_item_id,
    order_item_id: l.orderItemId || l.order_item_id,
    customerId: l.customerId || l.customer_id,
    customer_id: l.customerId || l.customer_id,
    actorAdminId: l.actorAdminId || l.actor_admin_id,
    actor_admin_id: l.actorAdminId || l.actor_admin_id,
    referenceId: l.referenceId || l.reference_id,
    reference_id: l.referenceId || l.reference_id,
    linkedLedgerId: l.linkedLedgerId || l.linked_ledger_id,
    linked_ledger_id: l.linkedLedgerId || l.linked_ledger_id,
    metadata: l.metadata ?? {},
    createdAt: l.createdAt || l.created_at || new Date().toISOString(),
    created_at: l.createdAt || l.created_at || new Date().toISOString(),
  };
}

export function normalizePaymentEntity(p: any): any {
  if (!p) return p;
  return {
    id: p.id,
    customerId: p.customerId || p.customer_id,
    customer_id: p.customerId || p.customer_id,
    amountMinor: p.amountMinor ?? p.amount_minor ?? 0,
    amount_minor: p.amountMinor ?? p.amount_minor ?? 0,
    paymentMethod: p.paymentMethod || p.payment_method || 'CASH',
    payment_method: p.paymentMethod || p.payment_method || 'CASH',
    reference: p.reference ?? '',
    actorAdminId: p.actorAdminId || p.actor_admin_id,
    actor_admin_id: p.actorAdminId || p.actor_admin_id,
    commandId: p.commandId || p.command_id,
    command_id: p.commandId || p.command_id,
    createdAt: p.createdAt || p.created_at || new Date().toISOString(),
    created_at: p.createdAt || p.created_at || new Date().toISOString(),
  };
}

export function normalizePaymentAllocationEntity(a: any): any {
  if (!a) return a;
  return {
    id: a.id,
    paymentId: a.paymentId || a.payment_id,
    payment_id: a.paymentId || a.payment_id,
    orderItemId: a.orderItemId || a.order_item_id,
    order_item_id: a.orderItemId || a.order_item_id,
    orderId: a.orderId || a.order_id,
    order_id: a.orderId || a.order_id,
    allocatedAmountMinor: a.allocatedAmountMinor ?? a.allocated_amount_minor ?? 0,
    allocated_amount_minor: a.allocatedAmountMinor ?? a.allocated_amount_minor ?? 0,
    createdAt: a.createdAt || a.created_at || new Date().toISOString(),
    created_at: a.createdAt || a.created_at || new Date().toISOString(),
  };
}
export function normalizeQrTokenEntity(q: any): any {
  if (!q) return q;

  // QR identity is durable data. A legacy local placeholder such as
  // "<order-uuid>:qr" is migrated exactly once at restore/normalization time
  // into a real UUID + random public token. Once that canonical identity exists,
  // every subsequent backup/restore preserves it verbatim.
  const legacyPlaceholder =
    typeof q.id === 'string' &&
    /:qr$/i.test(q.id) &&
    !(q.publicToken ?? q.public_token ?? q.token);

  const generatedId =
    legacyPlaceholder && typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : q.id;

  const generatedPublicToken =
    legacyPlaceholder && typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '')
      : null;

  const publicToken =
    q.publicToken ??
    q.public_token ??
    q.token ??
    generatedPublicToken ??
    null;
  const tokenHash =
    q.tokenHash ??
    q.token_hash ??
    null;
  const tokenType =
    q.tokenType ??
    q.token_type ??
    q.entityType ??
    q.entity_type ??
    'ORDER';
  const targetId =
    q.targetId ??
    q.target_id ??
    q.entityId ??
    q.entity_id ??
    (typeof q.id === 'string' && /:qr$/i.test(q.id) ? q.id.replace(/:qr$/i, '') : null);
  const isActive = q.isActive ?? q.is_active ?? true;
  const expiresAt = q.expiresAt ?? q.expires_at ?? null;

  if (legacyPlaceholder && (!generatedId || generatedId === q.id || !publicToken || !targetId)) {
    throw new SnapshotFormatError(
      'Legacy QR placeholder could not be safely migrated to a permanent QR identity'
    );
  }

  return {
    id: generatedId,
    publicToken,
    public_token: publicToken,
    tokenHash,
    token_hash: tokenHash,
    tokenType,
    token_type: tokenType,
    targetId,
    target_id: targetId,
    isActive: Boolean(isActive),
    is_active: Boolean(isActive),
    expiresAt,
    expires_at: expiresAt,
    token: publicToken,
    entityType: tokenType,
    entity_type: tokenType,
    entityId: targetId,
    entity_id: targetId,
    createdAt: q.createdAt || q.created_at || new Date().toISOString(),
    created_at: q.createdAt || q.created_at || new Date().toISOString(),
  };
}

export interface CreateSnapshotOptions {
  name?: string;
  bin?: string;
  customOnlineData?: Partial<BackupSnapshotData>;
}

const REPLACEMENT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function replacementField(row: any, ...keys: string[]): any {
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null) return row[key];
  }
  return undefined;
}

export function validateReplacementData(data: Partial<BackupSnapshotData>): void {
  const collections: Record<string, any[]> = {
    device_types: data.deviceTypes || [],
    business_days: data.businessDays || [],
    customers: data.customers || [],
    qr_tokens: data.qrTokens || [],
    orders: data.orders || [],
    order_items: data.orderItems || [],
    payments: data.payments || [],
    financial_ledger: data.financialLedger || [],
    payment_allocations: data.paymentAllocations || [],
  };

  const ids = new Map<string, Set<string>>();
  for (const [table, rows] of Object.entries(collections)) {
    if (!Array.isArray(rows)) throw new SnapshotFormatError(`Replacement collection ${table} is not an array`);
    ids.set(table, new Set());
    for (const row of rows) {
      const id = String(row?.id || '').trim();
      if (!REPLACEMENT_UUID_RE.test(id)) {
        throw new SnapshotFormatError(`Invalid ${table} ID: ${id || '<missing>'}`);
      }
      if (ids.get(table)!.has(id)) throw new SnapshotFormatError(`Duplicate ${table} ID: ${id}`);
      ids.get(table)!.add(id);
    }
  }

  const has = (table: string, id: any) => Boolean(id && ids.get(table)?.has(String(id)));
  const requireRef = (table: string, id: any, owner: string) => {
    if (!has(table, id)) throw new SnapshotFormatError(`${owner} references missing ${table} ${id || '<missing>'}`);
  };

  for (const row of collections.orders) {
    const status = String(replacementField(row, 'status') || 'pending').toLowerCase();
    if (!['pending', 'charging', 'delivered', 'cancelled'].includes(status)) {
      throw new SnapshotFormatError(`Order ${row.id} has unsupported status ${status}`);
    }
    requireRef('business_days', replacementField(row, 'dayId', 'day_id'), `Order ${row.id}`);
    requireRef('customers', replacementField(row, 'customerId', 'customer_id'), `Order ${row.id}`);
  }

  for (const row of collections.order_items) {
    const status = String(replacementField(row, 'status') || 'charging').toLowerCase();
    const operational = String(replacementField(row, 'operationalStatus', 'operational_status') || 'CHARGING').toUpperCase();
    const financial = String(replacementField(row, 'financialStatus', 'financial_status') || 'UNRECOGNIZED').toUpperCase();
    const payment = String(replacementField(row, 'paymentStatus', 'payment_status') || 'UNPAID').toUpperCase();
    if (!['charging', 'delivered', 'cancelled'].includes(status)) throw new SnapshotFormatError(`Order item ${row.id} has unsupported status ${status}`);
    if (!['CHARGING', 'DELIVERED', 'CANCELLED'].includes(operational)) throw new SnapshotFormatError(`Order item ${row.id} has unsupported operational status ${operational}`);
    if (!['UNRECOGNIZED', 'RECOGNIZED', 'REVERSED'].includes(financial)) throw new SnapshotFormatError(`Order item ${row.id} has unsupported financial status ${financial}`);
    if (!['UNPAID', 'PARTIALLY_PAID', 'PAID'].includes(payment)) throw new SnapshotFormatError(`Order item ${row.id} has unsupported payment status ${payment}`);
    requireRef('orders', replacementField(row, 'orderId', 'order_id'), `Order item ${row.id}`);
    requireRef('device_types', replacementField(row, 'deviceTypeId', 'device_type_id'), `Order item ${row.id}`);
    const replacementId = replacementField(row, 'replacementOfItemId', 'replacement_of_item_id');
    if (replacementId) requireRef('order_items', replacementId, `Order item ${row.id}`);
  }

  for (const row of collections.payments) {
    const amount = Number(replacementField(row, 'amountMinor', 'amount_minor') ?? 0);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new SnapshotFormatError(`Payment ${row.id} has invalid amount`);
    requireRef('customers', replacementField(row, 'customerId', 'customer_id'), `Payment ${row.id}`);
  }

  for (const row of collections.financial_ledger) {
    requireRef('customers', replacementField(row, 'customerId', 'customer_id'), `Ledger ${row.id}`);
    const orderId = replacementField(row, 'orderId', 'order_id');
    const itemId = replacementField(row, 'orderItemId', 'order_item_id');
    const linkedId = replacementField(row, 'linkedLedgerId', 'linked_ledger_id');
    if (orderId) requireRef('orders', orderId, `Ledger ${row.id}`);
    if (itemId) requireRef('order_items', itemId, `Ledger ${row.id}`);
    if (linkedId) requireRef('financial_ledger', linkedId, `Ledger ${row.id}`);
  }

  for (const row of collections.payment_allocations) {
    const amount = Number(replacementField(row, 'allocatedAmountMinor', 'allocated_amount_minor') ?? 0);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new SnapshotFormatError(`Payment allocation ${row.id} has invalid amount`);
    requireRef('payments', replacementField(row, 'paymentId', 'payment_id'), `Payment allocation ${row.id}`);
    const orderId = replacementField(row, 'orderId', 'order_id');
    requireRef('orders', orderId, `Payment allocation ${row.id}`);
    const itemId = replacementField(row, 'orderItemId', 'order_item_id');
    if (itemId) {
      requireRef('order_items', itemId, `Payment allocation ${row.id}`);
      const item = collections.order_items.find((x) => x.id === itemId);
      if (item && String(replacementField(item, 'orderId', 'order_id')) !== String(orderId)) {
        throw new SnapshotFormatError(`Payment allocation ${row.id} points to an item from a different order`);
      }
    } else {
      const candidates = collections.order_items.filter((x) => String(replacementField(x, 'orderId', 'order_id')) === String(orderId));
      if (candidates.length !== 1) {
        throw new SnapshotFormatError(`Payment allocation ${row.id} is missing orderItemId and its order does not have exactly one item`);
      }
    }
  }

  for (const row of collections.qr_tokens) {
    const publicToken = replacementField(row, 'publicToken', 'public_token', 'token');
    const targetId = replacementField(row, 'targetId', 'target_id', 'entityId', 'entity_id');
    if (!publicToken) throw new SnapshotFormatError(`QR token ${row.id} is missing publicToken`);
    if (!REPLACEMENT_UUID_RE.test(String(targetId || ''))) throw new SnapshotFormatError(`QR token ${row.id} has invalid targetId`);
  }

  // Active QR uniqueness is a server invariant. Reject duplicate active target/type
  // combinations before a destructive call instead of discovering them after DELETE.
  const activeQrKeys = new Set<string>();
  for (const row of collections.qr_tokens) {
    const active = replacementField(row, 'isActive', 'is_active') ?? true;
    if (Boolean(active)) {
      const type = String(replacementField(row, 'tokenType', 'token_type', 'entityType', 'entity_type') || 'ORDER').toUpperCase();
      const key = `${String(replacementField(row, 'targetId', 'target_id', 'entityId', 'entity_id'))}::${type}`;
      if (activeQrKeys.has(key)) throw new SnapshotFormatError(`Duplicate active QR token for ${key}`);
      activeQrKeys.add(key);
    }
  }
}

export class BackupService {
  /**
   * Captures current offline business data from IndexedDB kvStore.
   */
  async captureOfflineData(): Promise<BackupSnapshotData> {
    const customers = (await localDb.list('customers')).map(sanitizeEntity);
    const businessDays = (await localDb.list('businessDays')).map(sanitizeEntity);
    const orders = (await localDb.list('orders')).map(sanitizeEntity);
    const orderItems = (await localDb.list('orderItems')).map(sanitizeEntity);
    const financialLedger = (await localDb.list('financialLedger')).map(sanitizeEntity);
    const payments = (await localDb.list('payments')).map(sanitizeEntity);
    const paymentAllocations = (await localDb.list('paymentAllocations')).map(sanitizeEntity);
    const deviceTypes = (await localDb.list('deviceTypes')).map(sanitizeEntity);
    const qrTokens = (await localDb.list('qr_tokens')).map(sanitizeEntity);
    const orderNumberReservations = (await localDb.list('orderNumberReservations')).map(sanitizeEntity);
    const syncState = await localDb.getSyncState('global');

    return {
      customers,
      businessDays,
      orders,
      orderItems,
      financialLedger,
      payments,
      paymentAllocations,
      deviceTypes,
      qrTokens,
      orderNumberReservations,
      syncState,
    };
  }

  /**
   * Alias for captureOfflineData to provide semantic consistency across Local -> Online pipelines.
   */
  async captureLocalData(): Promise<BackupSnapshotData> {
    return this.captureOfflineData();
  }

  /**
   * Captures authoritative online business data from PostgreSQL via Supabase REST.
   */
  async captureOnlineData(customOnlineData?: Partial<BackupSnapshotData>): Promise<BackupSnapshotData> {
    if (customOnlineData) {
      return {
        customers: (customOnlineData.customers || []).map(sanitizeEntity),
        businessDays: (customOnlineData.businessDays || []).map(sanitizeEntity),
        orders: (customOnlineData.orders || []).map(sanitizeEntity),
        orderItems: (customOnlineData.orderItems || []).map(sanitizeEntity),
        financialLedger: (customOnlineData.financialLedger || []).map(sanitizeEntity),
        payments: (customOnlineData.payments || []).map(sanitizeEntity),
        paymentAllocations: (customOnlineData.paymentAllocations || []).map(sanitizeEntity),
        deviceTypes: (customOnlineData.deviceTypes || []).map(sanitizeEntity),
        qrTokens: (customOnlineData.qrTokens || []).map(sanitizeEntity),
        orderNumberReservations: (customOnlineData.orderNumberReservations || []).map(sanitizeEntity),
        syncState: customOnlineData.syncState || null,
      };
    }

    const fetchTable = async (table: string): Promise<any[]> => {
      const pageSize = 1000;
      let offset = 0;
      const allRows: any[] = [];
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await invokeSupabaseRestGet<any>(
          table,
          `select=*&order=id.asc&limit=${pageSize}&offset=${offset}`
        );

        if (error) {
          throw new Error(`Failed to fetch online table "${table}" at offset ${offset}: ${error}`);
        }

        if (!data || !Array.isArray(data)) {
          throw new Error(`Invalid response format fetching online table "${table}" at offset ${offset}: expected array`);
        }

        allRows.push(...data);
        if (data.length < pageSize) {
          hasMore = false;
        } else {
          offset += pageSize;
        }
      }

      return allRows.map(sanitizeEntity);
    };

    const [
      customers,
      businessDays,
      orders,
      orderItems,
      financialLedger,
      payments,
      paymentAllocations,
      deviceTypes,
      qrTokens,
    ] = await Promise.all([
      fetchTable('customers').then((rows) => rows.map(normalizeCustomerEntity)),
      fetchTable('business_days').then((rows) => rows.map(normalizeBusinessDayEntity)),
      fetchTable('orders').then((rows) => rows.map(normalizeOrderEntity)),
      fetchTable('order_items').then((rows) => rows.map(normalizeOrderItemEntity)),
      fetchTable('financial_ledger').then((rows) => rows.map(normalizeFinancialLedgerEntity)),
      fetchTable('payments').then((rows) => rows.map(normalizePaymentEntity)),
      fetchTable('payment_allocations').then((rows) => rows.map(normalizePaymentAllocationEntity)),
      fetchTable('device_types').then((rows) => rows.map(normalizeDeviceTypeEntity)),
      fetchTable('qr_tokens').then((rows) => rows.map(normalizeQrTokenEntity)),
    ]);

    return {
      customers,
      businessDays,
      orders,
      orderItems,
      financialLedger,
      payments,
      paymentAllocations,
      deviceTypes,
      qrTokens,
      syncState: null,
    };
  }

  /**
   * Consolidated reconciliation of Online + Offline data.
   * Safely merges online authoritative data with pending offline changes,
   * without arbitrary last-write-wins or discarding local pending work.
   */
  reconcileConsolidatedData(
    online: BackupSnapshotData,
    offline: BackupSnapshotData,
    pendingOutbox: any[]
  ): {
    consolidated: BackupSnapshotData;
    metadata: {
      onlineRecordCount: number;
      offlineRecordCount: number;
      reconciledCount: number;
      unresolvedConflicts: Array<{
        entityType: string;
        entityId: ID;
        reason: string;
        onlineVersion?: unknown;
        offlineVersion?: unknown;
      }>;
    };
  } {
    const unresolvedConflicts: Array<{
      entityType: string;
      entityId: ID;
      reason: string;
      onlineVersion?: unknown;
      offlineVersion?: unknown;
    }> = [];

    let reconciledCount = 0;

    const getPendingCommandsForEntity = (entityType: string, id: string): any[] => {
      const cmds: any[] = [];
      for (const cmd of pendingOutbox) {
        if (
          cmd.aggregateId === id ||
          cmd.commandId === id ||
          (cmd.aggregateType === entityType && cmd.aggregateId === id) ||
          (cmd.payload && typeof cmd.payload === 'object' && ((cmd.payload as any).id === id || (cmd.payload as any).entityId === id))
        ) {
          cmds.push(cmd);
        }
      }
      return cmds;
    };

    const isDeleteCommand = (cmd: any): boolean => {
      if (!cmd) return false;
      const type = String(cmd.commandType || '').toUpperCase();
      if (
        type.includes('DELETE') ||
        type.includes('REMOVE') ||
        type.includes('CANCEL') ||
        type === 'VOID'
      ) {
        return true;
      }
      if (cmd.payload && typeof cmd.payload === 'object') {
        const p = cmd.payload as any;
        if (p.deletedAt || p.isDeleted === true || p.action === 'DELETE' || p.action === 'REMOVE') {
          return true;
        }
      }
      return false;
    };

    const reconcileTable = (
      onlineList: any[],
      offlineList: any[],
      entityType: string,
      idField: string = 'id'
    ): any[] => {
      const onlineMap = new Map<ID, any>(onlineList.map((item) => [item[idField], item]));
      const offlineMap = new Map<ID, any>(offlineList.map((item) => [item[idField], item]));
      const mergedMap = new Map<ID, any>();

      // 1. Process all online items (authoritative baseline)
      for (const [id, onlineItem] of onlineMap.entries()) {
        const offlineItem = offlineMap.get(id);
        const entityPendingCommands = getPendingCommandsForEntity(entityType, id);
        const pendingDeleteCmd = entityPendingCommands.find(isDeleteCommand);
        const pendingCmd = pendingDeleteCmd || entityPendingCommands[entityPendingCommands.length - 1];

        if (pendingDeleteCmd) {
          // An offline pending DELETE exists for an entity that still exists online
          unresolvedConflicts.push({
            entityType,
            entityId: id,
            reason: 'Online record exists but local pending DELETE has not yet been authoritatively committed remotely',
            onlineVersion: onlineItem,
            offlineVersion: {
              status: 'deleted_pending_sync',
              commandId: pendingDeleteCmd.commandId,
              commandType: pendingDeleteCmd.commandType,
            },
          });
          // Do NOT silently restore as authoritative unchanged data.
          // Preserve deletion intent in consolidated snapshot with explicit pending delete marker
          mergedMap.set(id, {
            ...onlineItem,
            _conflict: 'PENDING_OFFLINE_DELETE',
            _reconciliation: 'pending_delete',
            _pendingDelete: true,
          });
          reconciledCount++;
        } else if (!offlineItem) {
          // Exists purely online
          mergedMap.set(id, onlineItem);
          reconciledCount++;
        } else if (!pendingCmd) {
          // Both exist, and offline has NO pending local changes: online is authoritative
          mergedMap.set(id, onlineItem);
          reconciledCount++;
        } else {
          // Offline has a pending outbox command on this entity
          const onlineVer = onlineItem.version ?? 1;
          const offlineVer = offlineItem.version ?? 1;

          if (onlineVer > offlineVer) {
            // Concurrent remote modification detected while local had un-synced edit: conflict
            unresolvedConflicts.push({
              entityType,
              entityId: id,
              reason: 'Concurrent remote modification detected while local change was pending',
              onlineVersion: onlineItem,
              offlineVersion: offlineItem,
            });
            // Keep authoritative online version with conflict flag
            mergedMap.set(id, { ...onlineItem, _conflict: 'CONCURRENT_REMOTE_MODIFICATION' });
          } else {
            // Offline pending edit based on same version: preserve offline state marked pending
            mergedMap.set(id, { ...offlineItem, _reconciliation: 'offline_pending' });
            reconciledCount++;
          }
        }
      }

      // 2. Process offline items that do not exist online yet (e.g. created offline)
      for (const [id, offlineItem] of offlineMap.entries()) {
        if (!mergedMap.has(id)) {
          const entityPendingCommands = getPendingCommandsForEntity(entityType, id);
          const pendingCmd = entityPendingCommands[entityPendingCommands.length - 1];
          if (pendingCmd) {
            mergedMap.set(id, { ...offlineItem, _reconciliation: 'local_pending_create' });
          } else {
            mergedMap.set(id, { ...offlineItem, _reconciliation: 'local_only' });
          }
          reconciledCount++;
        }
      }

      return Array.from(mergedMap.values());
    };

    const consolidatedCustomers = reconcileTable(online.customers, offline.customers, 'customers');
    const consolidatedDays = reconcileTable(online.businessDays, offline.businessDays, 'business_days');
    const consolidatedOrders = reconcileTable(online.orders, offline.orders, 'orders');
    const consolidatedItems = reconcileTable(online.orderItems, offline.orderItems, 'order_items');
    const consolidatedLedger = reconcileTable(online.financialLedger, offline.financialLedger, 'financial_ledger');
    const consolidatedPayments = reconcileTable(online.payments, offline.payments, 'payments');
    const consolidatedAllocations = reconcileTable(online.paymentAllocations, offline.paymentAllocations, 'payment_allocations');
    const consolidatedDevices = reconcileTable(online.deviceTypes, offline.deviceTypes, 'device_types');

    const countEntities = (data: BackupSnapshotData): number => {
      return (
        data.customers.length +
        data.businessDays.length +
        data.orders.length +
        data.orderItems.length +
        data.financialLedger.length +
        data.payments.length +
        data.paymentAllocations.length +
        data.deviceTypes.length
      );
    };

    const onlineRecordCount = countEntities(online);
    const offlineRecordCount = countEntities(offline);

    const consolidatedData: BackupSnapshotData = {
      customers: consolidatedCustomers,
      businessDays: consolidatedDays,
      orders: consolidatedOrders,
      orderItems: consolidatedItems,
      financialLedger: consolidatedLedger,
      payments: consolidatedPayments,
      paymentAllocations: consolidatedAllocations,
      deviceTypes: consolidatedDevices,
      qrTokens: offline.qrTokens || online.qrTokens || [],
      syncState: online.syncState || offline.syncState || null,
      consolidationMetadata: {
        onlineRecordCount,
        offlineRecordCount,
        reconciledCount,
        unresolvedConflicts,
      },
    };

    return {
      consolidated: consolidatedData,
      metadata: {
        onlineRecordCount,
        offlineRecordCount,
        reconciledCount,
        unresolvedConflicts,
      },
    };
  }

  /**
   * Creates an immutable persistent backup snapshot.
   */
  async createSnapshot(
    sourceType: BackupSourceType,
    auth: AuthorizationContext,
    options?: CreateSnapshotOptions
  ): Promise<BackupSnapshotRecord> {
    const actor = auth.requireAuth();
    auth.assertPermission('settings:manage');

    await auth.verifyBin(options?.bin as any);

    let rawData: BackupSnapshotData;

    if (sourceType === 'OFFLINE') {
      rawData = await this.captureOfflineData();
    } else if (sourceType === 'ONLINE') {
      rawData = await this.captureOnlineData(options?.customOnlineData);
    } else if (sourceType === 'CONSOLIDATED') {
      const [online, offline, outbox] = await Promise.all([
        this.captureOnlineData(options?.customOnlineData),
        this.captureOfflineData(),
        localDb.listOutbox(),
      ]);
      const { consolidated } = this.reconcileConsolidatedData(online, offline, outbox);
      rawData = consolidated;
    } else {
      throw new Error(`Unsupported backup source type: ${sourceType}`);
    }

    // Ensure all entities are thoroughly sanitized from secrets
    const sanitizedData: BackupSnapshotData = {
      customers: rawData.customers.map(sanitizeEntity),
      businessDays: rawData.businessDays.map(sanitizeEntity),
      orders: rawData.orders.map(sanitizeEntity),
      orderItems: rawData.orderItems.map(sanitizeEntity),
      financialLedger: rawData.financialLedger.map(sanitizeEntity),
      payments: rawData.payments.map(sanitizeEntity),
      paymentAllocations: rawData.paymentAllocations.map(sanitizeEntity),
      deviceTypes: rawData.deviceTypes.map(sanitizeEntity),
      qrTokens: (rawData.qrTokens || []).map(sanitizeEntity),
      orderNumberReservations: (rawData.orderNumberReservations || []).map(sanitizeEntity),
      syncState: rawData.syncState ? sanitizeEntity(rawData.syncState) : null,
      consolidationMetadata: rawData.consolidationMetadata
        ? sanitizeEntity(rawData.consolidationMetadata)
        : undefined,
    };

    const recordCounts: Record<string, number> = {
      customers: sanitizedData.customers.length,
      businessDays: sanitizedData.businessDays.length,
      orders: sanitizedData.orders.length,
      orderItems: sanitizedData.orderItems.length,
      financialLedger: sanitizedData.financialLedger.length,
      payments: sanitizedData.payments.length,
      paymentAllocations: sanitizedData.paymentAllocations.length,
      deviceTypes: sanitizedData.deviceTypes.length,
    };

    const totalEntities = Object.values(recordCounts).reduce((sum, n) => sum + n, 0);
    const checksum = computeSnapshotChecksum(sanitizedData);
    const now = new Date();
    const snapshotId = `snap_${now.getTime()}_${Math.random().toString(36).substring(2, 9)}`;
    const snapshotName =
      options?.name ||
      `${now.toISOString().replace('T', ' ').slice(0, 19)} (${sourceType.toLowerCase()})`;

    const record: BackupSnapshotRecord = {
      snapshotId,
      snapshotName,
      createdAt: now.toISOString(),
      sourceType,
      schemaVersion: 1,
      snapshotVersion: 1,
      createdBy: {
        id: actor.id,
        username: actor.username,
        fullName: actor.fullName,
      },
      status: 'COMPLETED',
      metadata: {
        recordCounts,
        totalEntities,
        checksum,
      },
      data: sanitizedData,
    };

    await localDb.saveSnapshot(record);
    return record;
  }

  async listSnapshots(): Promise<BackupSnapshotRecord[]> {
    return localDb.listSnapshots();
  }

  async getSnapshot(snapshotId: ID): Promise<BackupSnapshotRecord | null> {
    return localDb.getSnapshot(snapshotId);
  }

  async deleteSnapshot(
    snapshotId: ID,
    auth: AuthorizationContext,
    options?: { bin?: string }
  ): Promise<boolean> {
    auth.requireAuth();
    auth.assertPermission('settings:manage');

    await auth.verifyBin(options?.bin as any);

    return localDb.deleteSnapshot(snapshotId);
  }

  /**
   * Restores an immutable snapshot into local offline storage.
   * Performs staged validation before clearing operational tables.
   */
  async restoreSnapshot(
    snapshotId: ID,
    auth: AuthorizationContext,
    options?: { bin?: string }
  ): Promise<{ success: boolean; snapshotId: ID; restoredCount: number }> {
    auth.requireAuth();
    auth.assertPermission('settings:manage');

    await auth.verifyBin(options?.bin as any);

    const snapshot = await localDb.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new NotFoundError(`Snapshot ${snapshotId} not found`);
    }

    // 1. Validate Schema / Format Compatibility
    if (snapshot.schemaVersion !== 1 || snapshot.snapshotVersion !== 1) {
      throw new SnapshotFormatError(
        `Incompatible snapshot format. Supported version: 1, Found: schema ${snapshot.schemaVersion}, snapshot ${snapshot.snapshotVersion}`
      );
    }

    // 2. Validate Integrity Checksum
    const expectedChecksum = snapshot.metadata.checksum;
    const computedChecksum = computeSnapshotChecksum(snapshot.data);
    if (expectedChecksum !== computedChecksum) {
      throw new SnapshotIntegrityError(
        `Snapshot checksum mismatch. Expected ${expectedChecksum}, computed ${computedChecksum}. Data may be corrupted or tampered.`
      );
    }

    // 3. Validate Entity Structure
    const d = snapshot.data;
    if (
      !Array.isArray(d.customers) ||
      !Array.isArray(d.businessDays) ||
      !Array.isArray(d.orders) ||
      !Array.isArray(d.orderItems)
    ) {
      throw new SnapshotFormatError('Invalid snapshot entity collections structure');
    }

    // 4. Bind the restored operational state to the CURRENT server generation.
    // Otherwise the next sync preflight could interpret this restore as stale and
    // clear the freshly restored local read model.
    const { data: restoreServerGeneration, error: restoreGenerationError } =
      await invokeSupabaseRpc<any>('get_server_reset_generation', {});
    if (restoreGenerationError || restoreServerGeneration === null || restoreServerGeneration === undefined) {
      throw new Error(restoreGenerationError || 'Failed to read authoritative server reset generation before restore');
    }
    const authoritativeRestoreGeneration = Number(restoreServerGeneration);

    // 5. Staged Transactional Replacement of Business Data inside atomic runTransaction
    // Notice: backupSnapshots is explicitly PRESERVED and protected!
    await localDb.runTransaction(
      ['kvStore', 'outbox', 'syncState', 'syncHistory'],
      'readwrite',
      (tx) => {
        localDb.clearOperationalTablesWithTx(tx);

        // Populate operational stores from snapshot
        for (const c of d.customers) localDb.setWithTx(tx, 'customers', c.id, c);
        for (const b of d.businessDays) localDb.setWithTx(tx, 'businessDays', b.id, b);
        for (const o of d.orders) localDb.setWithTx(tx, 'orders', o.id, o);
        for (const i of d.orderItems) localDb.setWithTx(tx, 'orderItems', i.id, i);
        for (const l of d.financialLedger || []) localDb.setWithTx(tx, 'financialLedger', l.id, l);
        for (const p of d.payments || []) localDb.setWithTx(tx, 'payments', p.id, p);
        for (const a of d.paymentAllocations || []) {
           // Ensure camelCase consistency for entities stored in kvStore
           const normAlloc: PaymentAllocationEntity = {
             id: a.id,
             paymentId: a.paymentId || a.payment_id,
             orderId: a.orderId || a.order_id,
             allocatedAmountMinor: a.allocatedAmountMinor ?? a.allocated_amount_minor ?? 0,
             createdAt: a.createdAt || a.created_at,
           };
           localDb.setWithTx(tx, 'paymentAllocations', normAlloc.id, normAlloc);
        }
        for (const dev of d.deviceTypes || []) localDb.setWithTx(tx, 'deviceTypes', dev.id, dev);
        for (const q of d.qrTokens || []) { const normalizedQr = normalizeQrTokenEntity(q); localDb.setWithTx(tx, 'qr_tokens', normalizedQr.id, normalizedQr); }
        for (const r of d.orderNumberReservations || []) localDb.setWithTx(tx, 'orderNumberReservations', r.id, r);

        localDb.setSyncStateWithTx(tx, {
          ...(d.syncState || {
            table: 'global',
            lastAppliedChangeSequence: 0,
            lastPulledAt: '',
          }),
          resetGeneration: authoritativeRestoreGeneration,
          reconciliationRequired: false,
          status: 'READY',
        });
      }
    );

    // Part B Repair: Set authoritative markers to prevent accidental "fresh client" wipes on reload
    await localDb.clearLocalResetMarker();
    await localDb.setInitialHydrationCompleted(true);
    
    // Explicitly set the migration version in localStorage to prevent runCleanBootMigrationIfNeeded from wiping this data
    const storage = typeof window !== 'undefined' ? window.localStorage : null;
    if (storage) {
      const { CURRENT_MIGRATION_VERSION } = await import('../../components/pages/dayOrdersStore');
      storage.setItem('sys_db_version', CURRENT_MIGRATION_VERSION);
    }

    // Post-Restore Runtime Read Model Synchronization:
    // Rehydrate in-memory read models so IndexedDB and runtime repositories never diverge.
    const { reloadStoreFromLocal } = await import('../../components/pages/dayOrdersStore');
    await reloadStoreFromLocal();

    return {
      success: true,
      snapshotId,
      restoredCount: snapshot.metadata.totalEntities,
    };
  }

  /**
   * Resets local operational business data while preserving all backup snapshots.
   */
  async deleteLocalBusinessData(auth: AuthorizationContext, options?: { bin?: string }): Promise<void> {
    auth.requireAuth();
    auth.assertPermission('settings:manage');

    await auth.verifyBin(options?.bin as any);

    await localDb.clearOperationalTables({ clearOutbox: true, clearSyncState: true });
    await localDb.setLocalResetMarker(true);

    const { reloadStoreFromLocal } = await import('../../components/pages/dayOrdersStore');
    await reloadStoreFromLocal();
  }

  /**
   * Clears local sync history while preserving all backup snapshots.
   */
  async clearSyncHistory(auth: AuthorizationContext): Promise<void> {
    auth.requireAuth();
    auth.assertPermission('settings:manage');
    await localDb.clearSyncHistory();
  }

  /**
   * Restores authoritative online data directly to local operational storage,
   * preserving all backup snapshots.
   */
  async restoreOnlineToLocal(
    auth: AuthorizationContext,
    options?: { bin?: string; customOnlineData?: Partial<BackupSnapshotData> }
  ): Promise<{ success: boolean; restoredCount: number }> {
    auth.requireAuth();
    auth.assertPermission('settings:manage');

    await auth.verifyBin(options?.bin as any);

    const onlineData = await this.captureOnlineData(options?.customOnlineData);

    // Bind the restored local read model to the CURRENT server generation so
    // the next sync cannot mistake this authoritative online restore for stale data.
    const { data: restoreServerGeneration, error: restoreGenerationError } =
      await invokeSupabaseRpc<any>('get_server_reset_generation', {});
    if (restoreGenerationError || restoreServerGeneration === null || restoreServerGeneration === undefined) {
      throw new Error(restoreGenerationError || 'Failed to read authoritative server reset generation before restore');
    }
    const authoritativeRestoreGeneration = Number(restoreServerGeneration);

    // Staged clean and populate inside atomic runTransaction
    await localDb.runTransaction(
      ['kvStore', 'outbox', 'syncState', 'syncHistory'],
      'readwrite',
      (tx) => {
        localDb.clearOperationalTablesWithTx(tx);

        for (const c of onlineData.customers) localDb.setWithTx(tx, 'customers', c.id, c);
        for (const b of onlineData.businessDays) localDb.setWithTx(tx, 'businessDays', b.id, b);
        for (const o of onlineData.orders) localDb.setWithTx(tx, 'orders', o.id, o);
        for (const i of onlineData.orderItems) localDb.setWithTx(tx, 'orderItems', i.id, i);
        for (const l of onlineData.financialLedger || []) localDb.setWithTx(tx, 'financialLedger', l.id, l);
        for (const p of onlineData.payments || []) localDb.setWithTx(tx, 'payments', p.id, p);
        for (const a of onlineData.paymentAllocations || []) {
          const normAlloc: PaymentAllocationEntity = {
            id: a.id,
            paymentId: a.paymentId || a.payment_id,
            orderId: a.orderId || a.order_id,
            allocatedAmountMinor: a.allocatedAmountMinor ?? a.allocated_amount_minor ?? 0,
            createdAt: a.createdAt || a.created_at,
          };
          localDb.setWithTx(tx, 'paymentAllocations', normAlloc.id, normAlloc);
        }
        for (const dev of onlineData.deviceTypes || []) localDb.setWithTx(tx, 'deviceTypes', dev.id, dev);
        for (const q of onlineData.qrTokens || []) { const normalizedQr = normalizeQrTokenEntity(q); localDb.setWithTx(tx, 'qr_tokens', normalizedQr.id, normalizedQr); }
        for (const r of onlineData.orderNumberReservations || []) localDb.setWithTx(tx, 'orderNumberReservations', r.id, r);

        localDb.setSyncStateWithTx(tx, {
          ...(onlineData.syncState || {
            table: 'global',
            lastAppliedChangeSequence: 0,
            lastPulledAt: '',
          }),
          resetGeneration: authoritativeRestoreGeneration,
          reconciliationRequired: false,
          status: 'READY',
        });
      }
    );

    // Part B Repair: Set authoritative markers to prevent accidental "fresh client" wipes on reload
    await localDb.clearLocalResetMarker();
    await localDb.setInitialHydrationCompleted(true);
    
    // Explicitly set the migration version in localStorage to prevent runCleanBootMigrationIfNeeded from wiping this data
    const storage = typeof window !== 'undefined' ? window.localStorage : null;
    if (storage) {
      const { CURRENT_MIGRATION_VERSION } = await import('../../components/pages/dayOrdersStore');
      storage.setItem('sys_db_version', CURRENT_MIGRATION_VERSION);
    }

    const { reloadStoreFromLocal } = await import('../../components/pages/dayOrdersStore');
    await reloadStoreFromLocal();

    const restoredCount =
      onlineData.customers.length +
      onlineData.businessDays.length +
      onlineData.orders.length +
      onlineData.orderItems.length +
      onlineData.financialLedger.length +
      onlineData.payments.length +
      onlineData.paymentAllocations.length +
      onlineData.deviceTypes.length +
      (onlineData.qrTokens || []).length;

    return {
      success: true,
      restoredCount,
    };
  }

  /**
   * Generates an item-by-item, ID-matched preview difference between Local and Online business data.
   * Compares each table by strictly matching entity.id (Rule: Local ID === Online ID).
   */
  async previewReplacementDiff(
    customOnlineData?: Partial<BackupSnapshotData>,
    customLocalData?: Partial<BackupSnapshotData>
  ): Promise<{
    summary: Record<
      string,
      {
        localCount: number;
        onlineCount: number;
        toInsert: number;
        toUpdate: number;
        toDelete: number;
      }
    >;
    totalLocal: number;
    totalOnline: number;
    totalToInsert: number;
    totalToUpdate: number;
    totalToDelete: number;
  }> {
    const online = await this.captureOnlineData(customOnlineData);
    const local = customLocalData
      ? { ...(await this.captureLocalData()), ...customLocalData }
      : await this.captureLocalData();

    validateReplacementData(local);

    const tables: Array<{ key: keyof BackupSnapshotData; name: string }> = [
      { key: 'deviceTypes', name: 'device_types' },
      { key: 'businessDays', name: 'business_days' },
      { key: 'customers', name: 'customers' },
      { key: 'qrTokens', name: 'qr_tokens' },
      { key: 'orders', name: 'orders' },
      { key: 'orderItems', name: 'order_items' },
      { key: 'payments', name: 'payments' },
      { key: 'financialLedger', name: 'financial_ledger' },
      { key: 'paymentAllocations', name: 'payment_allocations' },
    ];

    const summary: Record<
      string,
      {
        localCount: number;
        onlineCount: number;
        toInsert: number;
        toUpdate: number;
        toDelete: number;
      }
    > = {};

    let totalLocal = 0;
    let totalOnline = 0;
    let totalToInsert = 0;
    let totalToUpdate = 0;
    let totalToDelete = 0;

    for (const t of tables) {
      const localList: any[] = (local[t.key] as any[]) || [];
      const onlineList: any[] = (online[t.key] as any[]) || [];

      const onlineIdSet = new Set(onlineList.map((x) => x.id).filter(Boolean));
      const localIdSet = new Set(localList.map((x) => x.id).filter(Boolean));

      let toInsert = 0;
      let toUpdate = 0;
      for (const item of localList) {
        if (onlineIdSet.has(item.id)) {
          toUpdate++;
        } else {
          toInsert++;
        }
      }

      let toDelete = 0;
      for (const item of onlineList) {
        if (!localIdSet.has(item.id)) {
          toDelete++;
        }
      }

      summary[t.name] = {
        localCount: localList.length,
        onlineCount: onlineList.length,
        toInsert,
        toUpdate,
        toDelete,
      };

      totalLocal += localList.length;
      totalOnline += onlineList.length;
      totalToInsert += toInsert;
      totalToUpdate += toUpdate;
      totalToDelete += toDelete;
    }

    return {
      summary,
      totalLocal,
      totalOnline,
      totalToInsert,
      totalToUpdate,
      totalToDelete,
    };
  }

  /**
   * Atomically executes Local -> Online Business Data Replacement.
   * 1. Validates caller authorization and BIN.
   * 2. Captures an authoritative safety snapshot of Online data before replacement.
   * 3. Gathers local business data and validates all entities (including payment_allocations).
   * 4. Delegates atomic replacement to server RPC replace_online_business_data.
   * 5. Returns replacement outcome and counts.
   */
  async replaceOnlineWithLocalData(
    auth: AuthorizationContext,
    bin: string,
    options?: {
      safetySnapshotName?: string;
      customLocalData?: Partial<BackupSnapshotData>;
      customOnlineSafetyData?: Partial<BackupSnapshotData>;
    }
  ): Promise<{
    success: boolean;
    operation: string;
    replacementId: string;
    completedAt: string;
    counts: Record<string, number>;
    safetySnapshotId: string;
  }> {
    auth.requireAuth();
    auth.assertPermission('settings:manage');

    if (!bin || !/^\d{4,}$/.test(bin.trim())) {
      throw new AuthorizationError('BIN must contain at least 4 numeric digits.');
    }

    const localData = options?.customLocalData
      ? { ...(await this.captureLocalData()), ...options.customLocalData }
      : await this.captureLocalData();

    const localBusinessEntityCount =
      (localData.customers || []).length +
      (localData.businessDays || []).length +
      (localData.orders || []).length +
      (localData.orderItems || []).length +
      (localData.payments || []).length +
      (localData.financialLedger || []).length +
      (localData.paymentAllocations || []).length +
      (localData.deviceTypes || []).length +
      (localData.qrTokens || []).length;

    if (localBusinessEntityCount === 0) {
      throw new Error(
        'SAFE_REPLACE_BLOCKED: Local business data is empty. Cloud data was not modified.'
      );
    }

    // Complete local preflight before taking the destructive RPC path.
    validateReplacementData(localData);

    const allocations = localData.paymentAllocations || [];
    for (const alloc of allocations) {
      const amount = Number((alloc as any).allocatedAmountMinor ?? (alloc as any).allocated_amount_minor);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error(`Invalid payment allocation amount for ${alloc.id}`);
      }
    }

    const onlineSafetyData = await this.captureOnlineData(options?.customOnlineSafetyData);
    const safetySnapshot = await this.createSnapshot('ONLINE', auth, {
      name: options?.safetySnapshotName || `Pre-Replacement Safety Snapshot ${new Date().toISOString()}`,
      bin: bin.trim(),
      customOnlineData: onlineSafetyData,
    });

    const payload = {
      device_types: (localData.deviceTypes || []).map((d: any) => ({
        id: d.id,
        name: d.name,
        name_ar: d.nameAr ?? d.name_ar ?? d.name,
        name_en: d.nameEn ?? d.name_en ?? d.name,
        icon: d.icon || 'smartphone',
        base_price_minor: d.basePriceMinor ?? d.base_price_minor ?? 0,
        charger_fee_enabled: d.chargerFeeEnabled ?? d.charger_fee_enabled ?? true,
        charger_fee_applicable: d.chargerFeeApplicable ?? d.charger_fee_applicable ?? true,
        is_active: d.isActive ?? d.is_active ?? true,
        status: d.status ?? 'ACTIVE',
        sort_order: d.sortOrder ?? d.sort_order ?? 0,
        created_at: d.createdAt ?? d.created_at,
        updated_at: d.updatedAt ?? d.updated_at,
        deleted_at: d.deletedAt ?? d.deleted_at,
        version: d.version ?? 1,
      })),
      business_days: (localData.businessDays || []).map((b: any) => ({
        id: b.id,
        business_date: b.businessDate ?? b.business_date ?? b.date,
        display_number: b.displayNumber ?? b.display_number ?? 1,
        status: b.status ?? (b.isClosed ?? b.is_closed ? 'CLOSED' : 'OPEN'),
        is_closed: b.isClosed ?? b.is_closed ?? false,
        opened_at: b.openedAt ?? b.opened_at,
        closed_at: b.closedAt ?? b.closed_at,
        closed_by: b.closedBy ?? b.closed_by,
        created_at: b.createdAt ?? b.created_at,
        updated_at: b.updatedAt ?? b.updated_at,
        version: b.version ?? 1,
      })),
      customers: (localData.customers || []).map((c: any) => ({
        id: c.id,
        name: c.name,
        phone: c.phone ?? c.phone_number ?? c.phoneNumber ?? null,
        status: c.status ?? (c.isActive ?? c.is_active ?? true ? 'ACTIVE' : 'DELETED'),
        is_active: c.isActive ?? c.is_active ?? true,
        notes: c.notes ?? '',
        debt_limit_minor: c.debtLimitMinor ?? c.debt_limit_minor ?? 0,
        charger_fee_exempt: c.chargerFeeExempt ?? c.charger_fee_exempt ?? false,
        created_at: c.createdAt ?? c.created_at,
        updated_at: c.updatedAt ?? c.updated_at,
        deleted_at: c.deletedAt ?? c.deleted_at,
        version: c.version ?? 1,
      })),
      qr_tokens: (localData.qrTokens || []).map((q: any) => ({
        id: q.id,
        public_token: q.publicToken ?? q.public_token ?? q.token,
        token_type: q.tokenType ?? q.token_type ?? q.entityType ?? q.entity_type ?? 'ORDER',
        target_id: q.targetId ?? q.target_id ?? q.entityId ?? q.entity_id,
        is_active: q.isActive ?? q.is_active ?? true,
        expires_at: q.expiresAt ?? q.expires_at ?? null,
        created_at: q.createdAt ?? q.created_at,
      })),
      orders: (localData.orders || []).map((o: any) => ({
        id: o.id,
        day_id: o.dayId ?? o.day_id,
        customer_id: o.customerId ?? o.customer_id,
        display_number: o.displayNumber ?? o.display_number ?? 1,
        internal_sequence: o.internalSequence ?? o.internal_sequence ?? 0,
        status: o.status || 'pending',
        notes: o.notes ?? '',
        qr_token_id: o.qrTokenId ?? o.qr_token_id ?? null,
        charging_at: o.chargingAt ?? o.charging_at ?? null,
        delivered_at: o.deliveredAt ?? o.delivered_at ?? null,
        cancelled_at: o.cancelledAt ?? o.cancelled_at ?? null,
        created_at: o.createdAt ?? o.created_at,
        updated_at: o.updatedAt ?? o.updated_at,
        deleted_at: o.deletedAt ?? o.deleted_at,
        version: o.version ?? 1,
      })),
      order_items: (localData.orderItems || []).map((i: any) => ({
        id: i.id,
        order_id: i.orderId ?? i.order_id,
        device_type_id: i.deviceTypeId ?? i.device_type_id,
        item_sequence: i.itemSequence ?? i.item_sequence ?? 1,
        operational_status: i.operationalStatus ?? i.operational_status ?? (i.status === 'delivered' ? 'DELIVERED' : i.status === 'cancelled' ? 'CANCELLED' : 'CHARGING'),
        financial_status: i.financialStatus ?? i.financial_status ?? (i.status === 'delivered' ? 'RECOGNIZED' : 'UNRECOGNIZED'),
        payment_status: i.paymentStatus ?? i.payment_status ?? 'UNPAID',
        status: i.status || 'charging',
        device_name_snapshot: i.deviceNameSnapshot ?? i.device_name_snapshot ?? '',
        device_icon_snapshot: i.deviceIconSnapshot ?? i.device_icon_snapshot ?? 'smartphone',
        base_price_snapshot_minor: i.basePriceSnapshotMinor ?? i.base_price_snapshot_minor ?? 0,
        charger_fee_snapshot_minor: i.chargerFeeSnapshotMinor ?? i.charger_fee_snapshot_minor ?? 0,
        discount_snapshot_minor: i.discountSnapshotMinor ?? i.discount_snapshot_minor ?? 0,
        final_charge_snapshot_minor: i.finalChargeSnapshotMinor ?? i.final_charge_snapshot_minor ?? i.totalPriceMinor ?? i.total_price_minor ?? 0,
        unit_price_minor: i.unitPriceMinor ?? i.unit_price_minor ?? 0,
        total_price_minor: i.totalPriceMinor ?? i.total_price_minor ?? 0,
        has_charger: i.hasCharger ?? i.has_charger ?? false,
        charger_fee_enabled_snapshot: i.chargerFeeEnabledSnapshot ?? i.charger_fee_enabled_snapshot ?? true,
        customer_charger_fee_exempt_snapshot: i.customerChargerFeeExemptSnapshot ?? i.customer_charger_fee_exempt_snapshot ?? false,
        delivered_at: i.deliveredAt ?? i.delivered_at ?? null,
        financially_recognized_at: i.financiallyRecognizedAt ?? i.financially_recognized_at ?? null,
        cancelled_at: i.cancelledAt ?? i.cancelled_at ?? null,
        replacement_of_item_id: i.replacementOfItemId ?? i.replacement_of_item_id ?? null,
        notes: i.notes ?? null,
        created_at: i.createdAt ?? i.created_at,
        updated_at: i.updatedAt ?? i.updated_at,
        deleted_at: i.deletedAt ?? i.deleted_at,
        version: i.version ?? 1,
      })),
      payments: (localData.payments || []).map((p: any) => ({
        id: p.id,
        customer_id: p.customerId ?? p.customer_id,
        amount_minor: p.amountMinor ?? p.amount_minor ?? 0,
        payment_method: p.paymentMethod ?? p.payment_method ?? 'CASH',
        reference: p.reference ?? '',
        actor_admin_id: p.actorAdminId ?? p.actor_admin_id ?? null,
        command_id: p.commandId ?? p.command_id ?? null,
        notes: p.notes ?? '',
        created_at: p.createdAt ?? p.created_at,
      })),
      financial_ledger: (localData.financialLedger || []).map((l: any) => ({
        id: l.id,
        sequence_number: l.sequenceNumber ?? l.sequence_number ?? null,
        event_type: l.eventType ?? l.event_type ?? 'ORDER_ITEM_CHARGE',
        amount_minor: l.amountMinor ?? l.amount_minor ?? 0,
        order_id: l.orderId ?? l.order_id ?? null,
        order_item_id: l.orderItemId ?? l.order_item_id ?? null,
        customer_id: l.customerId ?? l.customer_id,
        actor_admin_id: l.actorAdminId ?? l.actor_admin_id ?? null,
        reference_id: l.referenceId ?? l.reference_id ?? null,
        linked_ledger_id: l.linkedLedgerId ?? l.linked_ledger_id ?? null,
        metadata: l.metadata ?? {},
        created_at: l.createdAt ?? l.created_at,
      })),
      payment_allocations: allocations.map((a: any) => ({
        id: a.id,
        payment_id: a.paymentId ?? a.payment_id,
        order_item_id: a.orderItemId ?? a.order_item_id ?? null,
        order_id: a.orderId ?? a.order_id,
        allocated_amount_minor: a.allocatedAmountMinor ?? a.allocated_amount_minor,
        created_at: a.createdAt ?? a.created_at,
      })),
    };

    const { data, error } = await invokeSupabaseRpc<any>('replace_online_business_data', {
      p_entered_bin: bin.trim(),
      p_payload: payload,
    });

    if (error || !data || !data.success) {
      throw new Error(error || 'Local -> Online Replacement failed on server');
    }

    return {
      success: true,
      operation: data.operation || 'REPLACE_ONLINE_BUSINESS_DATA',
      replacementId: data.replacementId,
      completedAt: data.completedAt,
      counts: data.counts || {},
      safetySnapshotId: safetySnapshot.snapshotId,
    };
  }

  /**
   * Atomically resets online business data in PostgreSQL via reset_online_business_data RPC.
   * Enforces client-side AuthorizationContext checks, BIN validation, and server RPC delegation.
   */
  async deleteOnlineBusinessData(
    auth: AuthorizationContext,
    bin: string
  ): Promise<{
    success: boolean;
    operation: string;
    resetId: string;
    completedAt: string;
    deletedCounts: Record<string, number>;
  }> {
    auth.requireAuth();
    auth.assertPermission('settings:manage');

    if (!bin || !bin.trim()) {
      throw new AuthorizationError('BIN is required for Online Business Reset.');
    }

    // Capture a local recovery snapshot before a destructive cloud reset.
    // The reset generation may legitimately reconcile/clear the local operational
    // read model afterward; this snapshot preserves the pre-reset local state
    // without changing the operational database or sync semantics.
    const localRecoveryData = await this.captureLocalData();
    const localRecoveryCount =
      (localRecoveryData.customers || []).length +
      (localRecoveryData.businessDays || []).length +
      (localRecoveryData.orders || []).length +
      (localRecoveryData.orderItems || []).length +
      (localRecoveryData.financialLedger || []).length +
      (localRecoveryData.payments || []).length +
      (localRecoveryData.paymentAllocations || []).length +
      (localRecoveryData.deviceTypes || []).length +
      (localRecoveryData.qrTokens || []).length;

    if (localRecoveryCount > 0) {
      await this.createSnapshot('OFFLINE', auth, {
        name: `Pre-Cloud-Reset Local Recovery Snapshot ${new Date().toISOString()}`,
        customOnlineData: localRecoveryData,
      });
    }

    const { data, error } = await invokeSupabaseRpc<any>('reset_online_business_data', {
      p_entered_bin: bin.trim(),
    });

    if (error || !data || !data.success) {
      throw new Error(error || 'Online Business Reset failed on server');
    }

    return data;
  }

  /**
   * Exports an existing backup snapshot into a canonical portable backup JSON representation.
   */
  async exportSnapshotToPortableFormat(
    snapshotId: ID
  ): Promise<{ fileName: string; fileContent: string; portableData: PortableBackupFile }> {
    const snapshot = await localDb.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new NotFoundError(`Snapshot ${snapshotId} not found`);
    }

    // Recursively sanitize entity collections to ensure zero secrets are present
    const sanitizedData: BackupSnapshotData = {
      customers: (snapshot.data.customers || []).map(sanitizeEntity),
      businessDays: (snapshot.data.businessDays || []).map(sanitizeEntity),
      orders: (snapshot.data.orders || []).map(sanitizeEntity),
      orderItems: (snapshot.data.orderItems || []).map(sanitizeEntity),
      financialLedger: (snapshot.data.financialLedger || []).map(sanitizeEntity),
      payments: (snapshot.data.payments || []).map(sanitizeEntity),
      paymentAllocations: (snapshot.data.paymentAllocations || []).map(sanitizeEntity),
      deviceTypes: (snapshot.data.deviceTypes || []).map(sanitizeEntity),
      qrTokens: (snapshot.data.qrTokens || []).map(sanitizeEntity),
      orderNumberReservations: (snapshot.data.orderNumberReservations || []).map(sanitizeEntity),
      syncState: snapshot.data.syncState ? sanitizeEntity(snapshot.data.syncState) : null,
      consolidationMetadata: snapshot.data.consolidationMetadata
        ? sanitizeEntity(snapshot.data.consolidationMetadata)
        : undefined,
    };

    const checksum = computeSnapshotChecksum(sanitizedData);

    const portableData: PortableBackupFile = {
      formatIdentifier: PORTABLE_BACKUP_FORMAT_IDENTIFIER,
      formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
      schemaVersion: snapshot.schemaVersion || 1,
      snapshotVersion: snapshot.snapshotVersion || 1,
      snapshotId: snapshot.snapshotId,
      snapshotName: snapshot.snapshotName,
      createdAt: snapshot.createdAt,
      sourceType: snapshot.sourceType,
      createdBy: snapshot.createdBy ? sanitizeEntity(snapshot.createdBy) : undefined,
      metadata: {
        recordCounts: snapshot.metadata.recordCounts,
        totalEntities: snapshot.metadata.totalEntities,
        checksum: checksum,
        description: snapshot.metadata.description,
      },
      data: sanitizedData,
    };

    const fileContent = JSON.stringify(portableData, null, 2);
    const dateStr = (snapshot.createdAt || new Date().toISOString()).slice(0, 10);
    const safeName = sanitizeFileName(snapshot.snapshotName);
    const fileName = `${safeName}_${dateStr}.backup.json`;

    return {
      fileName,
      fileContent,
      portableData,
    };
  }

  /**
   * Validates untrusted external portable backup file content prior to any database write.
   */
  validateAndParsePortableBackup(jsonString: string): {
    valid: boolean;
    portableFile?: PortableBackupFile;
    error?: string;
    errorCode?: string;
  } {
    if (!jsonString || typeof jsonString !== 'string' || !jsonString.trim()) {
      return { valid: false, error: 'Empty backup file content', errorCode: 'EMPTY_FILE' };
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonString);
    } catch (err: any) {
      return {
        valid: false,
        error: `Invalid JSON syntax: ${err?.message || 'JSON parse error'}`,
        errorCode: 'INVALID_JSON',
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { valid: false, error: 'Backup content must be a JSON object', errorCode: 'INVALID_FORMAT' };
    }

    if (parsed.formatIdentifier && parsed.formatIdentifier !== PORTABLE_BACKUP_FORMAT_IDENTIFIER) {
      return {
        valid: false,
        error: `Unrecognized backup format identifier: "${parsed.formatIdentifier}". Expected "${PORTABLE_BACKUP_FORMAT_IDENTIFIER}".`,
        errorCode: 'UNRECOGNIZED_FORMAT',
      };
    }

    if (parsed.formatVersion && typeof parsed.formatVersion === 'number' && parsed.formatVersion > PORTABLE_BACKUP_FORMAT_VERSION) {
      return {
        valid: false,
        error: `Unsupported format version ${parsed.formatVersion}. Maximum supported format version is ${PORTABLE_BACKUP_FORMAT_VERSION}.`,
        errorCode: 'UNSUPPORTED_VERSION',
      };
    }

    const schemaVersion = parsed.schemaVersion ?? 1;
    const snapshotVersion = parsed.snapshotVersion ?? 1;
    if (schemaVersion !== 1 || snapshotVersion !== 1) {
      return {
        valid: false,
        error: `Incompatible backup schema/snapshot version (schema ${schemaVersion}, snapshot ${snapshotVersion}). Expected 1.`,
        errorCode: 'INCOMPATIBLE_VERSION',
      };
    }

    // Required fields check
    if (!parsed.snapshotId || typeof parsed.snapshotId !== 'string') {
      return { valid: false, error: 'Missing or invalid "snapshotId" in backup file', errorCode: 'MISSING_FIELD' };
    }
    if (!parsed.snapshotName || typeof parsed.snapshotName !== 'string') {
      return { valid: false, error: 'Missing or invalid "snapshotName" in backup file', errorCode: 'MISSING_FIELD' };
    }
    if (!parsed.createdAt || typeof parsed.createdAt !== 'string') {
      return { valid: false, error: 'Missing or invalid "createdAt" timestamp in backup file', errorCode: 'MISSING_FIELD' };
    }
    if (!parsed.metadata || typeof parsed.metadata !== 'object') {
      return { valid: false, error: 'Missing or invalid "metadata" section in backup file', errorCode: 'MISSING_FIELD' };
    }
    if (!parsed.data || typeof parsed.data !== 'object') {
      return { valid: false, error: 'Missing or invalid "data" section in backup file', errorCode: 'MISSING_FIELD' };
    }

    // Collection arrays validation
    const d = parsed.data;
    const requiredCollections = ['customers', 'businessDays', 'orders', 'orderItems'];
    for (const col of requiredCollections) {
      if (!Array.isArray(d[col])) {
        return {
          valid: false,
          error: `Invalid or missing collection array "${col}" in backup data payload`,
          errorCode: 'INVALID_DATA_COLLECTION',
        };
      }
    }

    if (d.financialLedger && !Array.isArray(d.financialLedger)) {
      return { valid: false, error: 'Collection "financialLedger" must be an array if present', errorCode: 'INVALID_DATA_COLLECTION' };
    }
    if (d.payments && !Array.isArray(d.payments)) {
      return { valid: false, error: 'Collection "payments" must be an array if present', errorCode: 'INVALID_DATA_COLLECTION' };
    }
    if (d.paymentAllocations && !Array.isArray(d.paymentAllocations)) {
      return { valid: false, error: 'Collection "paymentAllocations" must be an array if present', errorCode: 'INVALID_DATA_COLLECTION' };
    }
    if (d.deviceTypes && !Array.isArray(d.deviceTypes)) {
      return { valid: false, error: 'Collection "deviceTypes" must be an array if present', errorCode: 'INVALID_DATA_COLLECTION' };
    }
    if (d.orderNumberReservations && !Array.isArray(d.orderNumberReservations)) {
      return { valid: false, error: 'Collection "orderNumberReservations" must be an array if present', errorCode: 'INVALID_DATA_COLLECTION' };
    }

    // Sanitize entity collections recursively from secrets
    const sanitizedData: BackupSnapshotData = {
      customers: d.customers.map(sanitizeEntity),
      businessDays: d.businessDays.map(sanitizeEntity),
      orders: d.orders.map(sanitizeEntity),
      orderItems: d.orderItems.map(sanitizeEntity),
      financialLedger: (d.financialLedger || []).map(sanitizeEntity),
      payments: (d.payments || []).map(sanitizeEntity),
      paymentAllocations: (d.paymentAllocations || []).map(sanitizeEntity),
      deviceTypes: (d.deviceTypes || []).map(sanitizeEntity),
      qrTokens: (d.qrTokens || []).map(sanitizeEntity),
      orderNumberReservations: (d.orderNumberReservations || []).map(sanitizeEntity),
      syncState: d.syncState ? sanitizeEntity(d.syncState) : null,
      consolidationMetadata: d.consolidationMetadata ? sanitizeEntity(d.consolidationMetadata) : undefined,
    };

    // Checksum verification
    const computedChecksum = computeSnapshotChecksum(sanitizedData);
    const expectedChecksum = parsed.metadata.checksum;
    if (expectedChecksum && expectedChecksum !== computedChecksum) {
      return {
        valid: false,
        error: `Integrity check failed: checksum mismatch. File checksum "${expectedChecksum}" does not match computed data checksum "${computedChecksum}". Data may be corrupted or tampered.`,
        errorCode: 'CHECKSUM_MISMATCH',
      };
    }

    // Structural & Referential integrity checks (prevents orphaned foreign key references)
    const validCustomerIds = new Set(sanitizedData.customers.map((c) => c.id));
    const validDayIds = new Set(sanitizedData.businessDays.map((d) => d.id));
    const validOrderIds = new Set(sanitizedData.orders.map((o) => o.id));
    const validDeviceTypeIds = new Set(sanitizedData.deviceTypes.map((d) => d.id));

    for (const order of sanitizedData.orders) {
      if (!order.id || !order.dayId || !order.customerId) {
        return { valid: false, error: 'Order record missing required "id", "dayId", or "customerId"', errorCode: 'STRUCTURAL_INVALID' };
      }
      if (!validCustomerIds.has(order.customerId)) {
        return {
          valid: false,
          error: `Referential Integrity Error: Order ${order.id} references non-existent customer ${order.customerId}`,
          errorCode: 'REFERENTIAL_INTEGRITY_VIOLATION',
        };
      }
      if (!validDayIds.has(order.dayId)) {
        return {
          valid: false,
          error: `Referential Integrity Error: Order ${order.id} references non-existent business day ${order.dayId}`,
          errorCode: 'REFERENTIAL_INTEGRITY_VIOLATION',
        };
      }
    }

    for (const item of sanitizedData.orderItems) {
      if (!item.id || !item.orderId) {
        return { valid: false, error: 'OrderItem record missing required "id" or "orderId"', errorCode: 'STRUCTURAL_INVALID' };
      }
      if (!validOrderIds.has(item.orderId)) {
        return {
          valid: false,
          error: `Referential Integrity Error: OrderItem ${item.id} references non-existent order ${item.orderId}`,
          errorCode: 'REFERENTIAL_INTEGRITY_VIOLATION',
        };
      }
      const devId = item.deviceTypeId || (item as any).device_type_id;
      if (devId && !validDeviceTypeIds.has(devId)) {
        return {
          valid: false,
          error: `Referential Integrity Error: OrderItem ${item.id} references non-existent device type ${devId}`,
          errorCode: 'REFERENTIAL_INTEGRITY_VIOLATION',
        };
      }
    }

    const checkpointSequence = parsed.checkpointSequence ?? parsed.metadata?.checkpointSequence ?? 1;

    const portableFile: PortableBackupFile = {
      formatIdentifier: PORTABLE_BACKUP_FORMAT_IDENTIFIER,
      formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
      schemaVersion,
      snapshotVersion,
      snapshotId: parsed.snapshotId,
      snapshotName: parsed.snapshotName,
      createdAt: parsed.createdAt,
      sourceType: (parsed.sourceType as BackupSourceType) || 'IMPORTED',
      checkpointSequence,
      createdBy: parsed.createdBy ? sanitizeEntity(parsed.createdBy) : undefined,
      metadata: {
        recordCounts: parsed.metadata.recordCounts || {
          customers: sanitizedData.customers.length,
          businessDays: sanitizedData.businessDays.length,
          orders: sanitizedData.orders.length,
          orderItems: sanitizedData.orderItems.length,
          financialLedger: sanitizedData.financialLedger.length,
          payments: sanitizedData.payments.length,
          paymentAllocations: sanitizedData.paymentAllocations.length,
          deviceTypes: sanitizedData.deviceTypes.length,
        },
        totalEntities: parsed.metadata.totalEntities ?? (
          sanitizedData.customers.length +
          sanitizedData.businessDays.length +
          sanitizedData.orders.length +
          sanitizedData.orderItems.length +
          sanitizedData.financialLedger.length +
          sanitizedData.payments.length +
          sanitizedData.paymentAllocations.length +
          sanitizedData.deviceTypes.length
        ),
        checksum: computedChecksum,
        description: parsed.metadata.description,
      },
      data: sanitizedData,
    };

    return { valid: true, portableFile };
  }

  /**
   * Imports a validated portable backup into local IndexedDB backupSnapshots without touching live business data.
   */
  async importPortableBackup(
    portableFile: PortableBackupFile,
    options?: { importAsCopy?: boolean; overwriteDuplicate?: boolean }
  ): Promise<{ snapshot: BackupSnapshotRecord; isDuplicate: boolean; snapshotId: ID }> {
    const existing = await localDb.getSnapshot(portableFile.snapshotId);

    if (existing && !options?.importAsCopy && !options?.overwriteDuplicate) {
      return {
        snapshot: existing,
        isDuplicate: true,
        snapshotId: existing.snapshotId,
      };
    }

    const now = new Date();
    let targetSnapshotId = portableFile.snapshotId;
    let targetSnapshotName = portableFile.snapshotName;

    if (options?.importAsCopy) {
      targetSnapshotId = `snap_${now.getTime()}_import_${Math.random().toString(36).substring(2, 7)}`;
      targetSnapshotName = `${portableFile.snapshotName} (Imported)`;
    }

    const sanitizedData = portableFile.data;
    const checksum = computeSnapshotChecksum(sanitizedData);

    const record: BackupSnapshotRecord = {
      snapshotId: targetSnapshotId,
      snapshotName: targetSnapshotName,
      createdAt: portableFile.createdAt || now.toISOString(),
      sourceType: 'IMPORTED',
      schemaVersion: portableFile.schemaVersion || 1,
      snapshotVersion: portableFile.snapshotVersion || 1,
      createdBy: portableFile.createdBy,
      status: 'COMPLETED',
      metadata: {
        recordCounts: portableFile.metadata.recordCounts,
        totalEntities: portableFile.metadata.totalEntities,
        checksum: checksum,
        description: `Imported on ${now.toISOString().slice(0, 19).replace('T', ' ')}`,
      },
      data: sanitizedData,
    };

    await localDb.saveSnapshot(record);

    return {
      snapshot: record,
      isDuplicate: false,
      snapshotId: record.snapshotId,
    };
  }
}

export const backupService = new BackupService();
