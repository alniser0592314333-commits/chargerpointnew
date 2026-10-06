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

const BACKUP_LOCAL_PREFERENCE_KEYS = [
  'sys_theme',
  'sys_locale',
  'app_qr_design_config_CUSTOMER',
  'app_qr_design_config_ORDER',
  'app_application_logos_v1',
  'app_active_logo_id_v1',
  'app_global_identity_cache_v1',
];

function captureLocalPreferences(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  const out: Record<string, string> = {};
  for (const key of BACKUP_LOCAL_PREFERENCE_KEYS) {
    try {
      const value = localStorage.getItem(key);
      if (value !== null) out[key] = value;
    } catch {}
  }
  return out;
}

function restoreLocalPreferences(values?: Record<string, string>): void {
  if (!values || typeof localStorage === 'undefined') return;
  for (const key of BACKUP_LOCAL_PREFERENCE_KEYS) {
    try {
      if (Object.prototype.hasOwnProperty.call(values, key)) localStorage.setItem(key, values[key]);
    } catch {}
  }
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
    ...c,
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
    ...b,
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
  const chargerApplicable = d.chargerFeeApplicable ?? d.charger_fee_applicable ?? chargerVal;
  const basePrice =
    d.basePriceMinor ??
    d.base_price_minor ??
    d.defaultPriceMinor ??
    d.default_price_minor ??
    d.servicePriceMinor ??
    d.service_price_minor ??
    0;
  return {
    ...d,
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
    chargerFeeApplicable: Boolean(chargerApplicable),
    charger_fee_applicable: Boolean(chargerApplicable),
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
    ...o,
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
    i.operationalStatus?.toLowerCase() ||
    i.operational_status?.toLowerCase() ||
    i.deliveryStatus ||
    i.delivery_status ||
    'charging'
  );
  const normalizedStatus = (rawStatus === 'delivered' || rawStatus === 'cancelled' || rawStatus === 'pending')
    ? rawStatus
    : 'charging';
  const opStatus = i.operationalStatus || i.operational_status || (normalizedStatus === 'delivered' ? 'DELIVERED' : normalizedStatus === 'cancelled' ? 'CANCELLED' : 'CHARGING');
  const finStatus = i.financialStatus || i.financial_status || (normalizedStatus === 'delivered' ? 'RECOGNIZED' : 'UNRECOGNIZED');
  const payStatus = i.paymentStatus || i.payment_status || 'UNPAID';

  return {
    ...i,
    id: i.id,
    orderId,
    order_id: orderId,
    deviceTypeId,
    device_type_id: deviceTypeId,
    itemSequence: seq,
    item_sequence: seq,
    status: normalizedStatus,
    operationalStatus: opStatus,
    operational_status: opStatus,
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
    ...l,
    id: l.id,
    eventType:
      l.eventType ||
      l.event_type ||
      l.entryType ||
      l.entry_type ||
      'ORDER_ITEM_CHARGE',
    amountMinor: l.amountMinor ?? l.amount_minor ?? 0,
    orderId: l.orderId || l.order_id,
    orderItemId: l.orderItemId || l.order_item_id,
    customerId: l.customerId || l.customer_id,
    actorAdminId: l.actorAdminId || l.actor_admin_id,
    referenceId: l.referenceId || l.reference_id,
    metadata: l.metadata,
    createdAt: l.createdAt || l.created_at || new Date().toISOString(),
  };
}

export function normalizePaymentEntity(p: any): any {
  if (!p) return p;
  return {
    ...p,
    id: p.id,
    customerId: p.customerId || p.customer_id,
    amountMinor: p.amountMinor ?? p.amount_minor ?? 0,
    paymentMethod: p.paymentMethod || p.payment_method || 'CASH',
    notes: p.notes || '',
    createdAt: p.createdAt || p.created_at || new Date().toISOString(),
  };
}

export function normalizePaymentAllocationEntity(a: any): any {
  if (!a) return a;
  return {
    ...a,
    id: a.id,
    paymentId: a.paymentId || a.payment_id,
    orderId: a.orderId || a.order_id,
    allocatedAmountMinor: a.allocatedAmountMinor ?? a.allocated_amount_minor ?? 0,
    createdAt: a.createdAt || a.created_at || new Date().toISOString(),
  };
}

export function normalizeQrTokenEntity(q: any): any {
  if (!q) return q;
  // Never persist an ephemeral raw auth token under the generic `token` key.
  // Persistent QR identity is represented by public_token/token_hash and can
  // therefore survive an exact business-data backup/restore.
  const publicToken = q.publicToken || q.public_token || q.token;
  return {
    ...q,
    id: q.id,
    publicToken,
    public_token: publicToken,
    tokenHash: q.tokenHash || q.token_hash,
    token_hash: q.tokenHash || q.token_hash,
    entityType: q.entityType || q.entity_type || q.tokenType || q.token_type,
    entityId: q.entityId || q.entity_id || q.targetId || q.target_id,
    createdAt: q.createdAt || q.created_at || new Date().toISOString(),
  };
}

export interface CreateSnapshotOptions {
  name?: string;
  bin?: string;
  customOnlineData?: Partial<BackupSnapshotData>;
}

export class BackupService {
  /**
   * Captures current offline business data from IndexedDB kvStore.
   */
  async captureOfflineData(): Promise<BackupSnapshotData> {
    // One synchronous clone of the hydrated in-memory cache prevents a multi-table
    // backup from observing different moments between sequential IndexedDB reads.
    const recovery = await localDb.captureRecoverySnapshot();
    const t = recovery.tables;
    const customers = t.customers.map(sanitizeEntity);
    const businessDays = t.businessDays.map(sanitizeEntity);
    const orders = t.orders.map(sanitizeEntity);
    const orderItems = t.orderItems.map(sanitizeEntity);
    const financialLedger = t.financialLedger.map(sanitizeEntity);
    const payments = t.payments.map(sanitizeEntity);
    const paymentAllocations = t.paymentAllocations.map(sanitizeEntity);
    const deviceTypes = t.deviceTypes.map(sanitizeEntity);
    const goals = t.goals.map(sanitizeEntity);
    const goalRequests = t.goalRequests.map(sanitizeEntity);
    const qrTokens = (t.qr_tokens.length ? t.qr_tokens : t.qrTokens).map(sanitizeEntity);
    const orderNumberReservations = t.orderNumberReservations.map(sanitizeEntity);
    const deletedDeviceTypeMarkers = t.deletedDeviceTypeMarkers.map(sanitizeEntity);
    const changeLog = t.changeLog.map(sanitizeEntity);

    return {
      customers,
      businessDays,
      orders,
      orderItems,
      financialLedger,
      payments,
      paymentAllocations,
      deviceTypes,
      goals,
      goalRequests,
      qrTokens,
      orderNumberReservations,
      deletedDeviceTypeMarkers,
      mutationSnapshots: recovery.mutationSnapshots.map(sanitizeEntity),
      changeLog,
      outbox: recovery.outbox.map(sanitizeEntity),
      syncHistory: recovery.syncHistory.map(sanitizeEntity),
      syncState: recovery.syncState,
      systemSettings: [],
      localPreferences: captureLocalPreferences(),
    };
  }

  /**
   * Captures an atomic, server-side point-in-time backup for an ONLINE snapshot.
   * This is intentionally separate from the general REST reader used by previews.
   */
  async captureAuthoritativeOnlineData(bin: string): Promise<BackupSnapshotData> {
    if (!bin?.trim()) throw new AuthorizationError('BIN is required for authoritative online backup.');
    const { data, error } = await invokeSupabaseRpc<any>('create_authoritative_backup_checkpoint_v2', {
      p_entered_bin: bin.trim(),
      p_notes: 'MANUAL_V2',
    });
    if (error || !data?.success || !data.snapshotData) {
      throw new Error(error || 'Authoritative online backup failed. Migration 00116 must be applied before taking an Online snapshot.');
    }
    const d = data.snapshotData;
    const normalizeArray = (key: string) => Array.isArray(d[key]) ? d[key].map(sanitizeEntity) : [];
    return {
      systemSettings: normalizeArray('systemSettings'),
      authoritativeCheckpoint: {
        checkpointId: data.checkpointId,
        checkpointSequence: data.checkpointSequence,
        integrityHash: data.integrityHash,
        authoritativeMaxSequence: data.manifest?.authoritativeMaxSequence,
      },
      customers: normalizeArray('customers').map(normalizeCustomerEntity),
      businessDays: normalizeArray('businessDays').map(normalizeBusinessDayEntity),
      orders: normalizeArray('orders').map(normalizeOrderEntity),
      orderItems: normalizeArray('orderItems').map(normalizeOrderItemEntity),
      financialLedger: normalizeArray('financialLedger').map(normalizeFinancialLedgerEntity),
      payments: normalizeArray('payments').map(normalizePaymentEntity),
      paymentAllocations: normalizeArray('paymentAllocations').map(normalizePaymentAllocationEntity),
      deviceTypes: normalizeArray('deviceTypes').map(normalizeDeviceTypeEntity),
      goals: normalizeArray('goals'),
      goalRequests: normalizeArray('goalRequests'),
      qrTokens: normalizeArray('qrTokens').map(normalizeQrTokenEntity),
      orderNumberReservations: [],
      deletedDeviceTypeMarkers: [],
      mutationSnapshots: [],
      changeLog: [],
      outbox: [],
      syncHistory: [],
      syncState: null,
      localPreferences: captureLocalPreferences(),
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
        goals: (customOnlineData.goals || []).map(sanitizeEntity),
        goalRequests: (customOnlineData.goalRequests || []).map(sanitizeEntity),
        qrTokens: (customOnlineData.qrTokens || []).map(sanitizeEntity),
        orderNumberReservations: (customOnlineData.orderNumberReservations || []).map(sanitizeEntity),
        deletedDeviceTypeMarkers: (customOnlineData.deletedDeviceTypeMarkers || []).map(sanitizeEntity),
        mutationSnapshots: (customOnlineData.mutationSnapshots || []).map(sanitizeEntity),
        changeLog: (customOnlineData.changeLog || []).map(sanitizeEntity),
        outbox: (customOnlineData.outbox || []).map(sanitizeEntity),
        syncHistory: (customOnlineData.syncHistory || []).map(sanitizeEntity),
        syncState: customOnlineData.syncState || null,
        systemSettings: (customOnlineData.systemSettings || []).map(sanitizeEntity),
        authoritativeCheckpoint: customOnlineData.authoritativeCheckpoint ? sanitizeEntity(customOnlineData.authoritativeCheckpoint) : undefined,
        localPreferences: customOnlineData.localPreferences ? sanitizeEntity(customOnlineData.localPreferences) : captureLocalPreferences(),
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
      goals,
      goalRequests,
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
      fetchTable('goals'),
      fetchTable('goal_requests'),
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
      goals,
      goalRequests,
      qrTokens,
      orderNumberReservations: [],
      deletedDeviceTypeMarkers: [],
      mutationSnapshots: [],
      changeLog: [],
      outbox: [],
      syncHistory: [],
      syncState: null,
      systemSettings: [],
      authoritativeCheckpoint: undefined,
      localPreferences: captureLocalPreferences(),
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
        data.deviceTypes.length +
        (data.goals || []).length +
        (data.goalRequests || []).length
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
      goals: offline.goals || online.goals || [],
      goalRequests: offline.goalRequests || online.goalRequests || [],
      qrTokens: offline.qrTokens || online.qrTokens || [],
      orderNumberReservations: offline.orderNumberReservations || [],
      deletedDeviceTypeMarkers: (offline.deletedDeviceTypeMarkers || []).map(sanitizeEntity),
      mutationSnapshots: (offline.mutationSnapshots || []).map(sanitizeEntity),
      changeLog: (offline.changeLog || []).map(sanitizeEntity),
      outbox: pendingOutbox.map(sanitizeEntity),
      syncHistory: (offline.syncHistory || []).map(sanitizeEntity),
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
      rawData = options?.customOnlineData
        ? await this.captureOnlineData(options.customOnlineData)
        : await this.captureAuthoritativeOnlineData(options?.bin || '');
    } else if (sourceType === 'CONSOLIDATED') {
      const [online, offline, outbox] = await Promise.all([
        options?.customOnlineData
          ? this.captureOnlineData(options.customOnlineData)
          : this.captureAuthoritativeOnlineData(options?.bin || ''),
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
      goals: (rawData.goals || []).map(sanitizeEntity),
      goalRequests: (rawData.goalRequests || []).map(sanitizeEntity),
      qrTokens: (rawData.qrTokens || []).map(sanitizeEntity),
      orderNumberReservations: (rawData.orderNumberReservations || []).map(sanitizeEntity),
      deletedDeviceTypeMarkers: (rawData.deletedDeviceTypeMarkers || []).map(sanitizeEntity),
      mutationSnapshots: (rawData.mutationSnapshots || []).map(sanitizeEntity),
      changeLog: (rawData.changeLog || []).map(sanitizeEntity),
      outbox: (rawData.outbox || []).map(sanitizeEntity),
      syncHistory: (rawData.syncHistory || []).map(sanitizeEntity),
      syncState: rawData.syncState ? sanitizeEntity(rawData.syncState) : null,
      systemSettings: (rawData.systemSettings || []).map(sanitizeEntity),
      authoritativeCheckpoint: rawData.authoritativeCheckpoint ? sanitizeEntity(rawData.authoritativeCheckpoint) : undefined,
      localPreferences: rawData.localPreferences ? sanitizeEntity(rawData.localPreferences) : captureLocalPreferences(),
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
      goals: (sanitizedData.goals || []).length,
      goalRequests: (sanitizedData.goalRequests || []).length,
      qrTokens: (sanitizedData.qrTokens || []).length,
      orderNumberReservations: (sanitizedData.orderNumberReservations || []).length,
      deletedDeviceTypeMarkers: (sanitizedData.deletedDeviceTypeMarkers || []).length,
      mutationSnapshots: (sanitizedData.mutationSnapshots || []).length,
      outbox: (sanitizedData.outbox || []).length,
      syncHistory: (sanitizedData.syncHistory || []).length,
      changeLog: (sanitizedData.changeLog || []).length,
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

  private validateSnapshotDataStructure(data: BackupSnapshotData): void {
    if (!data || !Array.isArray(data.customers) || !Array.isArray(data.businessDays) || !Array.isArray(data.orders) || !Array.isArray(data.orderItems)) {
      throw new SnapshotFormatError('Invalid snapshot entity collections structure');
    }
    const customerIds = new Set(data.customers.map((x: any) => x?.id).filter(Boolean));
    const dayIds = new Set(data.businessDays.map((x: any) => x?.id).filter(Boolean));
    const orderIds = new Set(data.orders.map((x: any) => x?.id).filter(Boolean));
    const paymentIds = new Set((data.payments || []).map((x: any) => x?.id).filter(Boolean));
    const deviceIds = new Set((data.deviceTypes || []).map((x: any) => x?.id).filter(Boolean));

    for (const o of data.orders) {
      if (!o?.id || !o?.dayId || !o?.customerId || !dayIds.has(o.dayId) || !customerIds.has(o.customerId)) {
        throw new SnapshotFormatError(`Invalid order reference: ${o?.id || 'unknown'}`);
      }
    }
    for (const i of data.orderItems) {
      const deviceId = i?.deviceTypeId || i?.device_type_id;
      if (!i?.id || !i?.orderId || !orderIds.has(i.orderId) || (deviceId && !deviceIds.has(deviceId))) {
        throw new SnapshotFormatError(`Invalid order item reference: ${i?.id || 'unknown'}`);
      }
    }
    for (const p of data.payments || []) {
      if (!p?.id || !p?.customerId || !customerIds.has(p.customerId)) throw new SnapshotFormatError(`Invalid payment reference: ${p?.id || 'unknown'}`);
    }
    for (const a of data.paymentAllocations || []) {
      const paymentId = a?.paymentId || a?.payment_id;
      const orderId = a?.orderId || a?.order_id;
      if (!a?.id || !paymentId || !orderId || !paymentIds.has(paymentId) || !orderIds.has(orderId)) {
        throw new SnapshotFormatError(`Invalid payment allocation reference: ${a?.id || 'unknown'}`);
      }
    }
    for (const l of data.financialLedger || []) {
      const customerId = l?.customerId || l?.customer_id;
      const orderId = l?.orderId || l?.order_id;
      const itemId = l?.orderItemId || l?.order_item_id;
      if (customerId && !customerIds.has(customerId)) throw new SnapshotFormatError(`Invalid ledger customer reference: ${l?.id || 'unknown'}`);
      if (orderId && !orderIds.has(orderId)) throw new SnapshotFormatError(`Invalid ledger order reference: ${l?.id || 'unknown'}`);
      if (itemId && !data.orderItems.some((i: any) => i?.id === itemId)) throw new SnapshotFormatError(`Invalid ledger item reference: ${l?.id || 'unknown'}`);
    }
    for (const g of data.goals || []) {
      const customerId = g?.customerId || g?.customer_id;
      if (customerId && !customerIds.has(customerId)) throw new SnapshotFormatError(`Invalid goal customer reference: ${g?.id || 'unknown'}`);
    }
    for (const g of data.goalRequests || []) {
      const customerId = g?.customerId || g?.customer_id;
      if (customerId && !customerIds.has(customerId)) throw new SnapshotFormatError(`Invalid goal request customer reference: ${g?.id || 'unknown'}`);
    }
    for (const q of data.qrTokens || []) {
      const targetId = q?.targetId || q?.target_id || q?.entityId || q?.entity_id;
      if (targetId && !customerIds.has(targetId) && !orderIds.has(targetId)) {
        throw new SnapshotFormatError(`Invalid QR target reference: ${q?.id || 'unknown'}`);
      }
    }
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

    // 3. Validate Entity Structure + foreign-key references before any destructive write.
    const d = snapshot.data;
    this.validateSnapshotDataStructure(d);

    // 4. Staged Transactional Replacement of Business Data inside atomic runTransaction
    // Notice: backupSnapshots is explicitly PRESERVED and protected!
    await localDb.runTransaction(
      ['kvStore', 'outbox', 'syncState', 'syncHistory'],
      'readwrite',
      (tx) => {
        localDb.clearOperationalTablesWithTx(tx);
        localDb.clearOutboxWithTx(tx);
        // A snapshot is authoritative for its captured sync cursor; never retain a newer stale cursor.
        try { tx.objectStore('syncState').clear(); } catch {}
        try { tx.objectStore('mutationSnapshots').clear(); } catch {}


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
        for (const goal of d.goals || []) localDb.setWithTx(tx, 'goals', goal.id, goal);
        for (const request of d.goalRequests || []) localDb.setWithTx(tx, 'goalRequests', request.id, request);
        for (const q of d.qrTokens || []) localDb.setWithTx(tx, 'qr_tokens', q.id, q);
        for (const r of d.orderNumberReservations || []) localDb.setWithTx(tx, 'orderNumberReservations', r.id, r);
        for (const marker of d.deletedDeviceTypeMarkers || []) localDb.setWithTx(tx, 'deletedDeviceTypeMarkers', marker.id, marker);
        for (const change of d.changeLog || []) localDb.setWithTx(tx, 'changeLog', change.id || String(change.sequenceId ?? `change_${Date.now()}`), change);
        for (const mutation of d.mutationSnapshots || []) {
          if (mutation && mutation.commandId) localDb.saveMutationSnapshotWithTx(tx, mutation as any);
        }

        for (const cmd of d.outbox || []) {
          if (cmd && cmd.commandId) localDb.saveOutboxWithTx(tx, cmd as any);
        }
        for (const history of d.syncHistory || []) {
          if (history && history.historyId) localDb.saveHistoryWithTx(tx, history as any);
        }

        if (d.syncState) {
          localDb.setSyncStateWithTx(tx, {
            ...d.syncState,
            reconciliationRequired: true,
            status: 'RECONCILIATION_REQUIRED',
          });
        }
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

    restoreLocalPreferences(d.localPreferences);

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

    // Staged clean and populate inside atomic runTransaction
    await localDb.runTransaction(
      ['kvStore', 'outbox', 'syncState', 'syncHistory'],
      'readwrite',
      (tx) => {
        localDb.clearOperationalTablesWithTx(tx);
        localDb.clearOutboxWithTx(tx);
        // A snapshot is authoritative for its captured sync cursor; never retain a newer stale cursor.
        try { tx.objectStore('syncState').clear(); } catch {}
        try { tx.objectStore('mutationSnapshots').clear(); } catch {}


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
        for (const goal of onlineData.goals || []) localDb.setWithTx(tx, 'goals', goal.id, goal);
        for (const request of onlineData.goalRequests || []) localDb.setWithTx(tx, 'goalRequests', request.id, request);
        for (const q of onlineData.qrTokens || []) localDb.setWithTx(tx, 'qr_tokens', q.id, q);
        for (const r of onlineData.orderNumberReservations || []) localDb.setWithTx(tx, 'orderNumberReservations', r.id, r);

        if (onlineData.syncState) {
          localDb.setSyncStateWithTx(tx, {
            ...onlineData.syncState,
            reconciliationRequired: true,
            status: 'RECONCILIATION_REQUIRED',
          });
        }
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

    restoreLocalPreferences(onlineData.localPreferences);
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

    if (!bin || !bin.trim()) {
      throw new AuthorizationError('BIN is required for Local -> Online Replacement.');
    }

    // 1. Gather Local Business Data
    const localData = options?.customLocalData
      ? { ...(await this.captureLocalData()), ...options.customLocalData }
      : await this.captureLocalData();

    // Local -> Online replacement is a destructive authority transfer. It is only
    // safe when the local state is settled: pending commands or rollback snapshots
    // mean the local state is still optimistic and must never be promoted wholesale.
    const pendingOutbox = (localData.outbox || []).filter((c: any) => !['SUCCESS','accepted','COMPLETED'].includes(String(c.status || '')));
    const pendingMutations = localData.mutationSnapshots || [];
    if (pendingOutbox.length > 0 || pendingMutations.length > 0) {
      throw new Error(`LOCAL_NOT_SETTLED: cannot replace online data while ${pendingOutbox.length} outbox command(s) or ${pendingMutations.length} rollback snapshot(s) remain pending`);
    }
    if (localData.syncState?.reconciliationRequired || localData.syncState?.status === 'RECONCILIATION_REQUIRED') {
      throw new Error('LOCAL_NOT_SETTLED: local synchronization requires reconciliation before online replacement');
    }

    // 2. Strict Pre-Validation of payment_allocations
    const allocations = localData.paymentAllocations || [];
    for (const alloc of allocations) {
      if (!alloc.id || !alloc.id.trim()) {
        throw new Error('Invalid allocation ID: ID cannot be null, empty, or whitespace');
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alloc.id)) {
        throw new Error(`Invalid allocation ID ${alloc.id}: malformed UUID format`);
      }
      const paymentId = (alloc as any).paymentId || (alloc as any).payment_id;
      if (!paymentId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paymentId)) {
        throw new Error(`Invalid paymentId ${paymentId} in allocation ${alloc.id}`);
      }
      const orderId = (alloc as any).orderId || (alloc as any).order_id;
      if (!orderId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
        throw new Error(`Invalid orderId ${orderId} in allocation ${alloc.id}`);
      }
      const amount = (alloc as any).allocatedAmountMinor ?? (alloc as any).allocated_amount_minor;
      if (typeof amount !== 'number' || amount <= 0) {
        throw new Error(`Invalid allocatedAmountMinor ${amount} in allocation ${alloc.id}: must be positive`);
      }
    }

    // 3. Authoritative Online Safety Snapshot before mutation
    const onlineSafetyData = options?.customOnlineSafetyData
      ? await this.captureOnlineData(options.customOnlineSafetyData)
      : await this.captureAuthoritativeOnlineData(bin.trim());
    const safetySnapshot = await this.createSnapshot(
      'ONLINE',
      auth,
      {
        name: options?.safetySnapshotName || `Pre-Replacement Safety Snapshot ${new Date().toISOString()}`,
        bin: bin.trim(),
        customOnlineData: onlineSafetyData,
      }
    );

    // 4. Build replacement payload with exact DB naming and robust fallbacks
    const payload = {
      device_types: (localData.deviceTypes || []).map((d) => ({
        id: d.id,
        name: d.name,
        name_ar: d.nameAr || (d as any).name_ar || d.name,
        name_en: d.nameEn || (d as any).name_en || d.name,
        icon: d.icon || 'smartphone',
        base_price_minor: d.basePriceMinor ?? (d as any).base_price_minor ?? 0,
        charger_fee_enabled: d.chargerFeeEnabled ?? (d as any).charger_fee_enabled ?? true,
        is_active: d.isActive ?? (d as any).is_active ?? true,
        sort_order: d.sortOrder ?? (d as any).sort_order ?? 0,
      })),
      business_days: (localData.businessDays || []).map((b) => ({
        id: b.id,
        business_date: b.businessDate || (b as any).business_date || '',
        is_closed: b.isClosed ?? (b as any).is_closed ?? false,
      })),
      customers: (localData.customers || []).map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone || (c as any).phone_number || (c as any).phoneNumber || '',
        debt_limit_minor: c.debtLimitMinor ?? (c as any).debt_limit_minor ?? 0,
        charger_fee_exempt: c.chargerFeeExempt ?? (c as any).charger_fee_exempt ?? false,
        is_active: c.isActive ?? (c as any).is_active ?? true,
      })),
      qr_tokens: (localData.qrTokens || []).map((q) => ({
        id: q.id,
        token_hash: q.tokenHash || (q as any).token_hash || q.publicToken || (q as any).public_token,
        public_token: q.publicToken || (q as any).public_token,
        token_type: q.tokenType || (q as any).token_type || 'CUSTOMER',
        target_id: q.targetId || (q as any).target_id,
        is_active: q.isActive ?? (q as any).is_active ?? true,
      })),
      orders: (localData.orders || []).map((o) => ({
        id: o.id,
        day_id: o.dayId || (o as any).day_id,
        customer_id: o.customerId || (o as any).customer_id,
        display_number: o.displayNumber ?? (o as any).display_number ?? 1,
        internal_sequence: o.internalSequence ?? (o as any).internal_sequence ?? 0,
        status: o.status || 'pending',
        notes: o.notes || '',
        created_at: o.createdAt || (o as any).created_at,
      })),
      order_items: (localData.orderItems || []).map((i) => ({
        id: i.id,
        order_id: i.orderId || (i as any).order_id,
        device_type_id: i.deviceTypeId || (i as any).device_type_id,
        item_sequence: i.itemSequence ?? (i as any).item_sequence ?? 1,
        status: i.status || 'charging',
        device_name_snapshot: i.deviceNameSnapshot || (i as any).device_name_snapshot || '',
        device_icon_snapshot: i.deviceIconSnapshot || (i as any).device_icon_snapshot || 'smartphone',
        base_price_snapshot_minor: i.basePriceSnapshotMinor ?? (i as any).base_price_snapshot_minor ?? 0,
        charger_fee_enabled_snapshot: i.chargerFeeEnabledSnapshot ?? (i as any).charger_fee_enabled_snapshot ?? false,
        customer_charger_fee_exempt_snapshot: i.customerChargerFeeExemptSnapshot ?? (i as any).customer_charger_fee_exempt_snapshot ?? false,
        charger_fee_snapshot_minor: i.chargerFeeSnapshotMinor ?? (i as any).charger_fee_snapshot_minor ?? 0,
        has_charger: i.hasCharger ?? (i as any).has_charger ?? false,
        unit_price_minor: i.unitPriceMinor ?? (i as any).unit_price_minor ?? 0,
        total_price_minor: i.totalPriceMinor ?? (i as any).total_price_minor ?? 0,
        created_at: i.createdAt || (i as any).created_at,
      })),
      payments: (localData.payments || []).map((p) => ({
        id: p.id,
        customer_id: p.customerId || (p as any).customer_id,
        amount_minor: p.amountMinor ?? (p as any).amount_minor ?? 0,
        payment_method: p.paymentMethod || (p as any).payment_method || 'CASH',
        reference: p.reference || '',
        actor_admin_id: p.actorAdminId || (p as any).actor_admin_id,
        command_id: p.commandId || (p as any).command_id,
        created_at: p.createdAt || (p as any).created_at,
      })),
      financial_ledger: (localData.financialLedger || []).map((l) => ({
        id: l.id,
        event_type: l.eventType || (l as any).event_type,
        amount_minor: l.amountMinor ?? (l as any).amount_minor ?? 0,
        order_id: l.orderId || (l as any).order_id,
        order_item_id: l.orderItemId || (l as any).order_item_id,
        customer_id: l.customerId || (l as any).customer_id,
        actor_admin_id: l.actorAdminId || (l as any).actor_admin_id,
        reference_id: l.referenceId || (l as any).reference_id,
        metadata: l.metadata,
        created_at: l.createdAt || (l as any).created_at,
      })),
      payment_allocations: allocations.map((a: any) => ({
        id: a.id,
        payment_id: a.paymentId || a.payment_id,
        order_id: a.orderId || a.order_id,
        allocated_amount_minor: a.allocatedAmountMinor ?? a.allocated_amount_minor,
        created_at: a.createdAt || a.created_at,
      })),
      goals: (localData.goals || []).map((g: any) => ({
        id: g.id,
        customer_id: g.customerId || g.customer_id,
        target_quantity: g.targetQuantity ?? g.target_quantity,
        current_progress: g.currentProgress ?? g.current_progress ?? 0,
        bonus_amount_minor: g.bonusAmountMinor ?? g.bonus_amount_minor ?? 0,
        duration_days: g.durationDays ?? g.duration_days ?? 7,
        status: g.status || 'ACTIVE',
        started_at: g.startedAt || g.started_at,
        expires_at: g.expiresAt || g.expires_at,
        completed_at: g.completedAt || g.completed_at,
        bonus_ledger_id: g.bonusLedgerId || g.bonus_ledger_id,
        version: g.version ?? 1,
        created_at: g.createdAt || g.created_at,
        updated_at: g.updatedAt || g.updated_at,
      })),
      goal_requests: (localData.goalRequests || []).map((g: any) => ({
        id: g.id,
        customer_id: g.customerId || g.customer_id,
        requested_target: g.requestedTarget ?? g.requested_target,
        status: g.status || 'PENDING',
        reviewed_by: g.reviewedBy || g.reviewed_by,
        reviewed_at: g.reviewedAt || g.reviewed_at,
        rejection_reason: g.rejectionReason || g.rejection_reason,
        resulting_goal_id: g.resultingGoalId || g.resulting_goal_id,
        version: g.version ?? 1,
        created_at: g.createdAt || g.created_at,
        updated_at: g.updatedAt || g.updated_at,
      })),
    };

    // 5. Invoke atomic server RPC
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
      deletedDeviceTypeMarkers: (snapshot.data.deletedDeviceTypeMarkers || []).map(sanitizeEntity),
      mutationSnapshots: (snapshot.data.mutationSnapshots || []).map(sanitizeEntity),
      changeLog: (snapshot.data.changeLog || []).map(sanitizeEntity),
      outbox: (snapshot.data.outbox || []).map(sanitizeEntity),
      syncHistory: (snapshot.data.syncHistory || []).map(sanitizeEntity),
      systemSettings: (snapshot.data.systemSettings || []).map(sanitizeEntity),
      authoritativeCheckpoint: snapshot.data.authoritativeCheckpoint ? sanitizeEntity(snapshot.data.authoritativeCheckpoint) : undefined,
      localPreferences: snapshot.data.localPreferences ? sanitizeEntity(snapshot.data.localPreferences) : {},
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
    if (d.localPreferences && (typeof d.localPreferences !== 'object' || Array.isArray(d.localPreferences))) {
      return { valid: false, error: 'Collection "localPreferences" must be an object if present', errorCode: 'INVALID_DATA_COLLECTION' };
    }

    for (const col of ['qrTokens','deletedDeviceTypeMarkers','mutationSnapshots','changeLog','systemSettings']) {
      if (d[col] && !Array.isArray(d[col])) {
        return { valid: false, error: `Collection "${col}" must be an array if present`, errorCode: 'INVALID_DATA_COLLECTION' };
      }
    }
    if (d.goals && !Array.isArray(d.goals)) {
      return { valid: false, error: 'Collection "goals" must be an array if present', errorCode: 'INVALID_DATA_COLLECTION' };
    }
    if (d.goalRequests && !Array.isArray(d.goalRequests)) {
      return { valid: false, error: 'Collection "goalRequests" must be an array if present', errorCode: 'INVALID_DATA_COLLECTION' };
    }
    if (d.outbox && !Array.isArray(d.outbox)) {
      return { valid: false, error: 'Collection "outbox" must be an array if present', errorCode: 'INVALID_DATA_COLLECTION' };
    }
    if (d.syncHistory && !Array.isArray(d.syncHistory)) {
      return { valid: false, error: 'Collection "syncHistory" must be an array if present', errorCode: 'INVALID_DATA_COLLECTION' };
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
      deletedDeviceTypeMarkers: (d.deletedDeviceTypeMarkers || []).map(sanitizeEntity),
      mutationSnapshots: (d.mutationSnapshots || []).map(sanitizeEntity),
      changeLog: (d.changeLog || []).map(sanitizeEntity),
      outbox: (d.outbox || []).map(sanitizeEntity),
      syncHistory: (d.syncHistory || []).map(sanitizeEntity),
      systemSettings: (d.systemSettings || []).map(sanitizeEntity),
      authoritativeCheckpoint: d.authoritativeCheckpoint ? sanitizeEntity(d.authoritativeCheckpoint) : undefined,
      localPreferences: d.localPreferences ? sanitizeEntity(d.localPreferences) : {},
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

    const actualCounts: Record<string, number> = {
      customers: sanitizedData.customers.length, businessDays: sanitizedData.businessDays.length,
      orders: sanitizedData.orders.length, orderItems: sanitizedData.orderItems.length,
      financialLedger: sanitizedData.financialLedger.length, payments: sanitizedData.payments.length,
      paymentAllocations: sanitizedData.paymentAllocations.length, deviceTypes: sanitizedData.deviceTypes.length,
      goals: (sanitizedData.goals || []).length, goalRequests: (sanitizedData.goalRequests || []).length,
      qrTokens: (sanitizedData.qrTokens || []).length, orderNumberReservations: (sanitizedData.orderNumberReservations || []).length,
      outbox: (sanitizedData.outbox || []).length, syncHistory: (sanitizedData.syncHistory || []).length,
      mutationSnapshots: (sanitizedData.mutationSnapshots || []).length, changeLog: (sanitizedData.changeLog || []).length,
    };
    for (const [key, count] of Object.entries(actualCounts)) {
      const declared = parsed.metadata.recordCounts?.[key];
      if (declared !== undefined && Number(declared) !== count) {
        return { valid: false, error: `Backup metadata count mismatch for ${key}: declared ${declared}, actual ${count}`, errorCode: 'METADATA_MISMATCH' };
      }
    }
    const actualTotal = Object.values(actualCounts).reduce((a, b) => a + b, 0);
    if (parsed.metadata.totalEntities !== undefined && Number(parsed.metadata.totalEntities) !== actualTotal) {
      return { valid: false, error: `Backup metadata totalEntities mismatch: declared ${parsed.metadata.totalEntities}, actual ${actualTotal}`, errorCode: 'METADATA_MISMATCH' };
    }
    try { this.validateSnapshotDataStructure(sanitizedData); } catch (e: any) {
      return { valid: false, error: e?.message || 'Referential integrity validation failed', errorCode: 'REFERENTIAL_INTEGRITY_VIOLATION' };
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
    if (portableFile.metadata?.checksum && portableFile.metadata.checksum !== checksum) {
      throw new SnapshotIntegrityError('Portable backup checksum mismatch.');
    }
    this.validateSnapshotDataStructure(sanitizedData);

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
