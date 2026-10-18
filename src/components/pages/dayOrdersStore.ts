import { useState, useEffect } from 'react';
import { FinalUseCases, RepositoryContext } from '../../application/useCases';
import { AuthorizationContext, BinVerifierFn } from '../../application/authContext';
import { calculateItemPrice, calculateOrderProjection, validateOrderTransition } from '../../domain/rules';
import {
  CustomerEntity,
  DeviceTypeEntity,
  OrderEntity,
  OrderStatus,
  OrderItemEntity,
  ItemStatus,
  ItemOperationalStatus,
  ItemFinancialStatus,
  ItemPaymentStatus,
  BusinessDayEntity,
  FinancialLedgerEntity,
  QrTokenEntity,
  PaymentEntity,
  PaymentAllocationEntity,
  OrderNumberReservationEntity,
  GoalEntity,
  GoalRequestEntity,
} from '../../domain/models';
import { ClosedDayError, InactiveCustomerError, NotFoundError, ConflictError, OrderNumberReservationExhaustedError, presentError } from '../../domain/errors';
import { localDb, OutboxRecord, OptimisticOverlayRecord } from '../../infrastructure/localDb/localDb';
import { generateSecurePublicToken, computeTokenHash } from '../../services/supabase/qrSecurity';
import {
  rpcResolveCustomerQr,
  rpcResolveOrderQr,
  rpcGetOrCreateCustomerQr,
  rpcAdoptLegacyCustomerQrToken,
  rpcRotateCustomerQr,
  rpcGetOrCreateOrderQr,
  rpcVerifyAdminBin,
  getSupabaseStatus,
  invokeSupabaseRestGet,
  invokeSupabaseRpc,
  invokeSupabaseRestUpsert,
  getStoredSupabaseAuthSession,
} from '../../services/supabase/client';
import { SyncEngine, syncEventEmitter } from '../../infrastructure/sync/syncEngine';
import { SupabaseSyncTransport } from '../../infrastructure/sync/SupabaseSyncTransport';

import { Locale } from '../../i18n/translations';
import { getLocalBusinessDateStr } from '../../utils/dateFormatter';
import { groupCustomerFinancialHistoryByOrder, groupHomeFinancialActivitiesByOrder } from '../../domain/financialPresentation';
import { QRDesignConfig, QRDesignType } from '../qr/types';
import { setActiveQrDesign } from '../qr/defaultDesigns';

const isBrowserOffline = (): boolean =>
  typeof navigator !== 'undefined' && navigator.onLine === false;

const cloneForTransactionRollback = <T>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
};

export interface UIOrderDeviceItem {
  id: string;
  deviceName: string;
  priceMinor: number;
  hasCharger?: boolean;
}

export interface UIDayOrderDetail {
  id: string;
  orderNumber: number;
  customerName: string;
  customerId: string;
  chargerFeeExempt?: boolean;
  createdAt: string;
  items: UIOrderDeviceItem[];
  note?: string;
  status?: string;
  paymentStatus?: 'PAID' | 'PARTIAL' | 'UNPAID';
}

export interface UICustomerItem {
  id: string;
  name: string;
  code: string;
  phone: string;
  debtLimitMinor: number;
  chargerFeeExempt: boolean;
}

export interface UIDeviceTypeOption {
  id: string;
  name: string;
  nameAr?: string;
  nameEn?: string;
  priceMinor: number;
  supportsCharger: boolean;
  chargerFeeMinor: number;
}

// Presentation-only device localization dictionaries (Domain remains untouched)
export const UI_DEVICE_LOCALIZATIONS: Record<string, { ar: string; en: string }> = {
  'dev-1': { ar: 'شاشة آيفون 13 برو', en: 'iPhone 13 Pro Screen' },
  'dev-2': { ar: 'بطارية آيفون 13', en: 'iPhone 13 Battery' },
  'dev-3': { ar: 'سامسونج A52 - صيانة مدخل شحن', en: 'Samsung A52 Charging Port Repair' },
  'dev-4': { ar: 'شاحن سريع 25W', en: 'Fast Charger 25W' },
  'dev-5': { ar: 'آيباد اير - تغيير زجاج', en: 'iPad Air Glass Replacement' },
  'dev-6': { ar: 'ماك بوك - صيانة لوحة المفاتيح', en: 'MacBook Keyboard Repair' },
  'dev-7': { ar: 'ساعة أبل - تبديل سير', en: 'Apple Watch Band Replacement' },
};

export const UI_DEVICE_NAME_MAP: Record<string, { ar: string; en: string }> = {
  'شاشة آيفون 13 برو': { ar: 'شاشة آيفون 13 برو', en: 'iPhone 13 Pro Screen' },
  'iPhone 13 Pro Screen': { ar: 'شاشة آيفون 13 برو', en: 'iPhone 13 Pro Screen' },
  'بطارية آيفون 13': { ar: 'بطارية آيفون 13', en: 'iPhone 13 Battery' },
  'iPhone 13 Battery': { ar: 'بطارية آيفون 13', en: 'iPhone 13 Battery' },
  'سامسونج A52 - صيانة مدخل شحن': { ar: 'سامسونج A52 - صيانة مدخل شحن', en: 'Samsung A52 Charging Port Repair' },
  'Samsung A52 Charging Port Repair': { ar: 'سامسونج A52 - صيانة مدخل شحن', en: 'Samsung A52 Charging Port Repair' },
  'شاحن سريع 25W': { ar: 'شاحن سريع 25W', en: 'Fast Charger 25W' },
  'Fast Charger 25W': { ar: 'شاحن سريع 25W', en: 'Fast Charger 25W' },
  'آيباد اير - تغيير زجاج': { ar: 'آيباد اير - تغيير زجاج', en: 'iPad Air Glass Replacement' },
  'iPad Air Glass Replacement': { ar: 'آيباد اير - تغيير زجاج', en: 'iPad Air Glass Replacement' },
  'ماك بوك - صيانة لوحة المفاتيح': { ar: 'ماك بوك - صيانة لوحة المفاتيح', en: 'MacBook Keyboard Repair' },
  'MacBook Keyboard Repair': { ar: 'ماك بوك - صيانة لوحة المفاتيح', en: 'MacBook Keyboard Repair' },
  'ساعة أبل - تبديل سير': { ar: 'ساعة أبل - تبديل سير', en: 'Apple Watch Band Replacement' },
  'Apple Watch Band Replacement': { ar: 'ساعة أبل - تبديل سير', en: 'Apple Watch Band Replacement' },
};

export const getItemLocalizedDeviceName = (
  deviceTypeIdOrName?: string,
  locale: Locale = 'ar',
  fallbackSnapshot?: string
): string => {
  if (!deviceTypeIdOrName && !fallbackSnapshot) return locale === 'en' ? 'Device' : 'جهاز';
  
  if (deviceTypeIdOrName) {
    const dev = devicesMap.get(deviceTypeIdOrName);
    if (dev) {
      if (locale === 'en') {
        return dev.nameEn?.trim() || UI_DEVICE_LOCALIZATIONS[dev.id]?.en || UI_DEVICE_NAME_MAP[dev.name]?.en || dev.name;
      }
      return dev.nameAr?.trim() || UI_DEVICE_LOCALIZATIONS[dev.id]?.ar || UI_DEVICE_NAME_MAP[dev.name]?.ar || dev.name;
    }
    const byId = UI_DEVICE_LOCALIZATIONS[deviceTypeIdOrName];
    if (byId) return locale === 'en' ? byId.en : byId.ar;
    const byName = UI_DEVICE_NAME_MAP[deviceTypeIdOrName];
    if (byName) return locale === 'en' ? byName.en : byName.ar;
  }

  if (fallbackSnapshot) {
    const byName = UI_DEVICE_NAME_MAP[fallbackSnapshot];
    if (byName) return locale === 'en' ? byName.en : byName.ar;
    return fallbackSnapshot;
  }

  return deviceTypeIdOrName || (locale === 'en' ? 'Device' : 'جهاز');
};

// Global local Database initialization
let isLocalDbInitialized = false;

const initDbIfNeeded = async () => {
  if (!isLocalDbInitialized) {
    try {
      await localDb.init();
      isLocalDbInitialized = true;
    } catch (e) {
      console.warn('LocalDB initialization fallback to in-memory', e);
    }
  }
};

// In-Memory Repositories initialized with Phase 5 Entities
const ordersMap = new Map<string, OrderEntity>();
const itemsMap = new Map<string, OrderItemEntity>();
const customersMap = new Map<string, CustomerEntity>();
const devicesMap = new Map<string, DeviceTypeEntity>();
const daysMap = new Map<string, BusinessDayEntity>();
const commandsMap = new Map<string, { type: string; payload: unknown }>();
const ledgerList: FinancialLedgerEntity[] = [];
const paymentsMap = new Map<string, PaymentEntity>();
const allocationsList: PaymentAllocationEntity[] = [];
const reservationsMap = new Map<string, OrderNumberReservationEntity>();
const goalsMap = new Map<string, GoalEntity>();
const goalRequestsMap = new Map<string, GoalRequestEntity>();

/**
 * Builds the effective local-first order read model from persisted entities plus
 * pending optimistic overlays. Overlay sequence is authoritative: hydration order
 * is not guaranteed, and applying a stale CREATE after a later PATCH can resurrect
 * removed devices or hide the current order state.
 */
export const buildEffectiveOrderItemReadModel = (
  baseOrders: Iterable<OrderEntity>,
  baseItems: Iterable<OrderItemEntity>,
  overlays: readonly OptimisticOverlayRecord[]
): { orders: Map<string, OrderEntity>; items: Map<string, OrderItemEntity> } => {
  const orders = new Map<string, OrderEntity>(Array.from(baseOrders, (order) => [order.id, order] as const));
  const items = new Map<string, OrderItemEntity>(Array.from(baseItems, (item) => [item.id, item] as const));

  const orderedOverlays = overlays
    .filter((overlay) => overlay.status === 'PENDING')
    .slice()
    .sort((a, b) => {
      const seqA = Number(a.sequence ?? 0);
      const seqB = Number(b.sequence ?? 0);
      if (seqA !== seqB) return seqA - seqB;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  for (const overlay of orderedOverlays) {
    const isOrder = overlay.entityType === 'orders' || overlay.entityType === 'order';
    const isItem = overlay.entityType === 'order_items' || overlay.entityType === 'orderItems';
    if (!isOrder && !isItem) continue;

    const target = isOrder ? orders : items;
    const base = target.get(overlay.entityId);
    if (overlay.operation === 'DELETE') {
      target.delete(overlay.entityId);
      continue;
    }

    const payload = (overlay.patch || overlay.entityPayload || {}) as Record<string, unknown>;
    // A PATCH without a base is only valid when a preceding pending CREATE
    // supplied that entity; otherwise do not fabricate an incomplete record.
    if (!base && overlay.operation === 'PATCH') continue;
    target.set(overlay.entityId, {
      ...(base || {}),
      ...payload,
      id: overlay.entityId,
    } as OrderEntity & OrderItemEntity);
  }

  return { orders, items };
};

const getEffectiveOrderItemReadModel = () =>
  buildEffectiveOrderItemReadModel(ordersMap.values(), itemsMap.values(), localDb.listOverlaysSync());

// Runtime Identity Resolver (No fake fallback in production)
export function getAuthenticatedIdentity(): { actorAdminId: string; deviceId: string } {
  const storage = typeof localStorage !== 'undefined' ? localStorage : null;
  const storedAuth = getStoredSupabaseAuthSession();
  
  let appSessionUserId: string | null = null;
  const appSessionRaw = storage?.getItem('app_auth_session');
  if (appSessionRaw) {
    try {
      const parsed = JSON.parse(appSessionRaw);
      appSessionUserId = parsed.userId || null;
    } catch {}
  }

  const actorAdminId = appSessionUserId || storedAuth?.user?.id;

  let deviceId = storage?.getItem('app_device_id');
  if (!deviceId) {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      deviceId = `dev_${crypto.randomUUID()}`;
    } else {
      deviceId = `dev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    }
    try {
      storage?.setItem('app_device_id', deviceId);
    } catch {}
  }

  if (!actorAdminId) {
    const isTestEnv =
      (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || Boolean(process.env?.VITEST))) ||
      (typeof import.meta !== 'undefined' && (import.meta as any).env?.MODE === 'test');
    if (isTestEnv) {
      return { actorAdminId: 'admin_test_session', deviceId };
    }
    throw new Error('AUTH_REQUIRED: Operation requires an authenticated admin session.');
  }

  return { actorAdminId, deviceId };
}

// Targeted Reactive Store Subscription API
export type StoreScope =
  | 'businessDays'
  | 'customers'
  | 'deviceTypes'
  | 'orders'
  | 'orderItems'
  | 'financialLedger'
  | 'payments'
  | 'paymentAllocations'
  | 'orderNumberReservations'
  | 'goals'
  | 'goalRequests'
  | 'all';

export type StoreChangeListener = (scope: StoreScope, entityId?: string) => void;

const storeListeners = new Set<StoreChangeListener>();

export const subscribeStore = (listener: StoreChangeListener): (() => void) => {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
};

export const notifyStore = (scope: StoreScope, entityId?: string): void => {
  storeListeners.forEach((l) => {
    try {
      l(scope, entityId);
    } catch (err) {
      console.warn('Store listener error:', err);
    }
  });
};

/**
 * Maps optimistic/outbox command types to the external-store scopes that must
 * be invalidated after the local transaction commits. Overlay-backed mutations
 * intentionally do not mutate the base entity maps, so without this signal a
 * mounted page can remain visually stale until a remote delta or manual reload
 * happens. The notification is local-only; it does not alter sync semantics.
 */
const getCommandNotificationScopes = (commandType: string): StoreScope[] => {
  switch (commandType) {
    case 'CREATE_ORDER':
    case 'UPDATE_ORDER':
    case 'RENUMBER_DAY_ORDERS':
      return ['orders'];
    case 'CANCEL_ORDER':
      return ['orders', 'orderItems'];
    case 'ADD_ORDER_ITEM':
    case 'UPDATE_ORDER_ITEM':
    case 'CANCEL_ORDER_ITEM':
      return ['orderItems'];
    case 'DELIVER_ORDER_ITEM':
      return ['orderItems', 'financialLedger'];
    case 'CREATE_PAYMENT':
    case 'CREATE_CUSTOMER_CREDIT':
      return ['payments', 'financialLedger'];
    default:
      return [];
  }
};

export function useStoreSubscription(scope?: StoreScope | StoreScope[]): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const unsub = subscribeStore((changedScope) => {
      if (!scope || scope === 'all' || changedScope === 'all') {
        setVersion((v) => v + 1);
        return;
      }
      if (Array.isArray(scope)) {
        if (scope.includes(changedScope)) {
          setVersion((v) => v + 1);
        }
      } else if (scope === changedScope) {
        setVersion((v) => v + 1);
      }
    });
    return unsub;
  }, [scope]);

  return version;
}

// Delta Dispatcher: Normalizes remote payload, updates localDb & in-memory maps, notifies subscribers
const remoteTransactionRollbackSnapshots = new WeakMap<object, Map<string, () => void>>();
const initializedRemoteRollbackTransactions = new WeakSet<object>();

const registerRemoteRollbackSnapshot = (
  tx: IDBTransaction | undefined,
  key: string,
  restore: () => void
): void => {
  const transaction = tx as any;
  if (!transaction || typeof transaction.addEventListener !== 'function') return;

  let snapshots = remoteTransactionRollbackSnapshots.get(transaction);
  if (!snapshots) {
    snapshots = new Map<string, () => void>();
    remoteTransactionRollbackSnapshots.set(transaction, snapshots);
  }
  if (!snapshots.has(key)) snapshots.set(key, restore);

  if (initializedRemoteRollbackTransactions.has(transaction)) return;
  initializedRemoteRollbackTransactions.add(transaction);
  transaction.addEventListener('abort', () => {
    const pending = remoteTransactionRollbackSnapshots.get(transaction);
    if (pending) {
      [...pending.values()].reverse().forEach((undo) => undo());
    }
    remoteTransactionRollbackSnapshots.delete(transaction);
    initializedRemoteRollbackTransactions.delete(transaction);
  }, { once: true });
  transaction.addEventListener('complete', () => {
    remoteTransactionRollbackSnapshots.delete(transaction);
    initializedRemoteRollbackTransactions.delete(transaction);
  }, { once: true });
};

const snapshotRemoteMapEntry = <K, V>(
  tx: IDBTransaction | undefined,
  scope: string,
  map: Map<K, V>,
  id: K
): void => {
  const existed = map.has(id);
  const previous = map.get(id);
  registerRemoteRollbackSnapshot(tx, `map:${scope}:${String(id)}`, () => {
    if (existed) map.set(id, previous as V);
    else map.delete(id);
  });
};

const snapshotRemoteArray = <T>(
  tx: IDBTransaction | undefined,
  scope: string,
  list: T[]
): void => {
  const transaction = tx as any;
  const key = `array:${scope}`;
  if (!transaction || typeof transaction.addEventListener !== 'function') return;
  if (remoteTransactionRollbackSnapshots.get(transaction)?.has(key)) return;

  const previous = [...list];
  registerRemoteRollbackSnapshot(tx, key, () => {
    list.splice(0, list.length, ...previous);
  });
};

const notifyStoreAfterTransaction = (
  scope: StoreScope,
  id?: string,
  tx?: IDBTransaction
): void => {
  const transaction = tx as any;
  if (transaction && typeof transaction.addEventListener === 'function') {
    transaction.addEventListener('complete', () => notifyStore(scope, id), { once: true });
    return;
  }
  notifyStore(scope, id);
};

export const applyRemoteChange = (change: {
  sequenceId: number;
  entityType: string;
  entityId: string;
  action: 'INSERT' | 'UPDATE' | 'DELETE' | 'TOMBSTONE';
  payload: any;
  version?: number;
  changedAt: string;
}, tx?: IDBTransaction): void => {
  const p = change.payload || {};
  const entityType = change.entityType;
  const isDelete = change.action === 'DELETE' || change.action === 'TOMBSTONE';

  if (entityType === 'system_settings') {
    const key = String(p.key || '');
    const designType: QRDesignType | null =
      key === 'app_qr_design_config_CUSTOMER' ? 'CUSTOMER' :
      key === 'app_qr_design_config_ORDER' ? 'ORDER' : null;
    if (!designType) {
      localDb.setWithTx(tx, 'system_settings', key || change.entityId, p);
      notifyStoreAfterTransaction('all', key || change.entityId, tx);
      return;
    }
    if (isDelete) {
      // QR design settings are not deleted by normal sync commands; ignore tombstones
      // rather than silently resetting a design that may have been changed locally.
      return;
    }
    const incoming = p.valueJson ?? p.value_json;
    if (!incoming || typeof incoming !== 'object' || incoming.designType !== designType) {
      console.warn('Ignoring malformed remote QR design setting:', key);
      return;
    }
    localDb.setWithTx(tx, 'system_settings', key, p);
    const applyDesign = () => setActiveQrDesign(designType, incoming as QRDesignConfig, 'remote');
    if (tx && typeof tx.addEventListener === 'function') {
      tx.addEventListener('complete', applyDesign, { once: true });
    } else {
      applyDesign();
    }
    notifyStoreAfterTransaction('all', key, tx);
    return;
  }

  if (entityType === 'business_days' || entityType === 'businessDays') {
    if (isDelete) {
      snapshotRemoteMapEntry(tx, 'businessDays', daysMap, change.entityId);
      daysMap.delete(change.entityId);
      localDb.removeWithTx(tx as any, 'businessDays', change.entityId);
      notifyStoreAfterTransaction('businessDays', change.entityId, tx);
      return;
    }
    const resolvedDate =
      p.businessDate ||
      p.business_date ||
      p.date ||
      (p.id?.startsWith('day-') ? p.id.slice(4) : p.id) ||
      (change.entityId?.startsWith('day-') ? change.entityId.slice(4) : change.entityId) ||
      getLocalBusinessDateStr();
    const entity: BusinessDayEntity = {
      id: p.id || change.entityId,
      businessDate: resolvedDate,
      isClosed: p.isClosed ?? p.is_closed ?? false,
      closedAt: p.closedAt || p.closed_at || undefined,
      closedBy: p.closedBy || p.closed_by || undefined,
      createdAt: p.createdAt || p.created_at || new Date().toISOString(),
      updatedAt: p.updatedAt || p.updated_at || new Date().toISOString(),
      version: p.version || 1,
    };
    localDb.setWithTx(tx, 'businessDays', entity.id, entity);
    snapshotRemoteMapEntry(tx, 'businessDays', daysMap, entity.id);
    daysMap.set(entity.id, entity);
    notifyStoreAfterTransaction('businessDays', entity.id, tx);
  } else if (entityType === 'customers') {
    if (isDelete) {
      snapshotRemoteMapEntry(tx, 'customers', customersMap, change.entityId);
      customersMap.delete(change.entityId);
      localDb.removeWithTx(tx as any, 'customers', change.entityId);
      notifyStoreAfterTransaction('customers', change.entityId, tx);
      return;
    }
    const entity: CustomerEntity = {
      id: p.id || change.entityId,
      name: p.name,
      phone: p.phone || '',
      isActive: p.isActive ?? p.is_active ?? true,
      notes: p.notes ?? undefined,
      debtLimitMinor: p.debtLimitMinor ?? p.debt_limit_minor ?? 0,
      chargerFeeExempt: p.chargerFeeExempt ?? p.charger_fee_exempt ?? false,
      createdAt: p.createdAt || p.created_at || new Date().toISOString(),
      updatedAt: p.updatedAt || p.updated_at || new Date().toISOString(),
      version: p.version || 1,
    };
    localDb.setWithTx(tx, 'customers', entity.id, entity);
    snapshotRemoteMapEntry(tx, 'customers', customersMap, entity.id);
    customersMap.set(entity.id, entity);
    notifyStoreAfterTransaction('customers', entity.id, tx);
  } else if (entityType === 'device_types' || entityType === 'deviceTypes') {
    if (isDelete) {
      snapshotRemoteMapEntry(tx, 'deviceTypes', devicesMap, change.entityId);
      devicesMap.delete(change.entityId);
      localDb.removeWithTx(tx as any, 'deviceTypes', change.entityId);
      notifyStoreAfterTransaction('deviceTypes', change.entityId, tx);
      return;
    }
    const entity: DeviceTypeEntity = {
      id: p.id || change.entityId,
      name: p.name,
      nameAr: p.nameAr ?? p.name_ar ?? undefined,
      nameEn: p.nameEn ?? p.name_en ?? undefined,
      icon: p.icon || 'smartphone',
      basePriceMinor: p.basePriceMinor ?? p.base_price_minor ?? 0,
      chargerFeeEnabled: p.chargerFeeEnabled ?? p.charger_fee_enabled ?? true,
      status: p.status ?? undefined,
      isActive: p.isActive ?? p.is_active ?? true,
      sortOrder: p.sortOrder ?? p.sort_order ?? 0,
      createdAt: p.createdAt || p.created_at || new Date().toISOString(),
      updatedAt: p.updatedAt || p.updated_at || new Date().toISOString(),
      deletedAt: p.deletedAt || p.deleted_at || undefined,
      version: p.version || 1,
    };
    localDb.setWithTx(tx, 'deviceTypes', entity.id, entity);
    snapshotRemoteMapEntry(tx, 'deviceTypes', devicesMap, entity.id);
    devicesMap.set(entity.id, entity);
    notifyStoreAfterTransaction('deviceTypes', entity.id, tx);
  } else if (entityType === 'orders') {
    if (isDelete) {
      snapshotRemoteMapEntry(tx, 'orders', ordersMap, change.entityId);
      ordersMap.delete(change.entityId);
      localDb.removeWithTx(tx as any, 'orders', change.entityId);
      notifyStoreAfterTransaction('orders', change.entityId, tx);
      return;
    }
    const previousOrder = ordersMap.get(change.entityId);
    const incomingOrderVersion = Number(p.version ?? 1);
    if (
      previousOrder &&
      localDb.hasCachedRecord('orders', change.entityId) &&
      change.action !== 'INSERT' &&
      Number(previousOrder.version ?? 0) >= incomingOrderVersion
    ) {
      return;
    }
    const rawStatus = (p.status || p.order_status || previousOrder?.status || 'pending').toLowerCase();
    const resolvedStatus: OrderStatus =
      rawStatus === 'delivered' || rawStatus === 'cancelled' || rawStatus === 'pending' || rawStatus === 'charging'
        ? (rawStatus as OrderStatus)
        : previousOrder?.status || 'pending';

    const entity: OrderEntity = {
      id: p.id || change.entityId,
      dayId: p.dayId || p.day_id || previousOrder?.dayId,
      customerId: p.customerId || p.customer_id || previousOrder?.customerId,
      displayNumber: p.displayNumber ?? p.display_number ?? previousOrder?.displayNumber ?? 0,
      internalSequence: p.internalSequence ?? p.internal_sequence ?? previousOrder?.internalSequence ?? 0,
      status: resolvedStatus,
      notes: p.notes ?? previousOrder?.notes ?? undefined,
      qrTokenId: p.qrTokenId || p.qr_token_id || previousOrder?.qrTokenId || undefined,
      chargingAt: p.chargingAt || p.charging_at || previousOrder?.chargingAt || undefined,
      deliveredAt: p.deliveredAt || p.delivered_at || previousOrder?.deliveredAt || undefined,
      cancelledAt: p.cancelledAt || p.cancelled_at || previousOrder?.cancelledAt || undefined,
      customerBalanceSnapshotMinor: p.customerBalanceSnapshotMinor ?? p.customer_balance_snapshot_minor ?? previousOrder?.customerBalanceSnapshotMinor ?? 0,
      createdAt: p.createdAt || p.created_at || previousOrder?.createdAt || new Date().toISOString(),
      updatedAt: p.updatedAt || p.updated_at || new Date().toISOString(),
      deletedAt: p.deletedAt || p.deleted_at || previousOrder?.deletedAt || undefined,
      version: p.version || previousOrder?.version || 1,
    };
    localDb.setWithTx(tx, 'orders', entity.id, entity);
    snapshotRemoteMapEntry(tx, 'orders', ordersMap, entity.id);
    ordersMap.set(entity.id, entity);
    notifyStoreAfterTransaction('orders', entity.id, tx);
  } else if (entityType === 'order_items' || entityType === 'orderItems') {
    if (isDelete) {
      snapshotRemoteMapEntry(tx, 'orderItems', itemsMap, change.entityId);
      itemsMap.delete(change.entityId);
      localDb.removeWithTx(tx as any, 'orderItems', change.entityId);
      notifyStoreAfterTransaction('orderItems', change.entityId, tx);
      return;
    }
    const previousItem = itemsMap.get(change.entityId);
    const incomingItemVersion = Number(change.version ?? p.version ?? (previousItem ? Number(previousItem.version ?? 0) + 1 : 1));
    if (
      previousItem &&
      localDb.hasCachedRecord('orderItems', change.entityId) &&
      change.action !== 'INSERT' &&
      Number(previousItem.version ?? 0) >= incomingItemVersion
    ) {
      return;
    }
    const rawStatus = String(
      p.status ||
      p.item_status ||
      p.deliveryStatus ||
      p.delivery_status ||
      (String(p.financialStatus || p.financial_status || '').toUpperCase() === 'RECOGNIZED' ? 'delivered' : '') ||
      previousItem?.status ||
      'charging'
    ).toLowerCase();
    const normalizedStatus: ItemStatus =
      rawStatus === 'delivered' || rawStatus === 'cancelled' || rawStatus === 'pending' || rawStatus === 'charging'
        ? (rawStatus as ItemStatus)
        : (previousItem?.status || 'charging');

    const entity: OrderItemEntity = {
      ...p,
      id: p.id || change.entityId,
      orderId: p.orderId || p.order_id || previousItem?.orderId,
      deviceTypeId: p.deviceTypeId || p.device_type_id || previousItem?.deviceTypeId,
      itemSequence: p.itemSequence ?? p.item_sequence ?? previousItem?.itemSequence ?? 1,
      status: normalizedStatus,
      financialStatus: p.financialStatus || p.financial_status || previousItem?.financialStatus || (normalizedStatus === 'delivered' ? 'RECOGNIZED' : 'UNRECOGNIZED'),
      paymentStatus: p.paymentStatus || p.payment_status || previousItem?.paymentStatus || 'UNPAID',
      deviceNameSnapshot: p.deviceNameSnapshot || p.device_name_snapshot || '',
      deviceIconSnapshot: p.deviceIconSnapshot || p.device_icon_snapshot || 'smartphone',
      basePriceSnapshotMinor: p.basePriceSnapshotMinor ?? p.base_price_snapshot_minor ?? 0,
      chargerFeeEnabledSnapshot: p.chargerFeeEnabledSnapshot ?? p.charger_fee_enabled_snapshot ?? true,
      customerChargerFeeExemptSnapshot: p.customerChargerFeeExemptSnapshot ?? p.customer_charger_fee_exempt_snapshot ?? false,
      chargerFeeSnapshotMinor: p.chargerFeeSnapshotMinor ?? p.charger_fee_snapshot_minor ?? 0,
      hasCharger: p.hasCharger ?? p.has_charger ?? false,
      unitPriceMinor: p.unitPriceMinor ?? p.unit_price_minor ?? 0,
      totalPriceMinor: p.totalPriceMinor ?? p.total_price_minor ?? 0,
      replacementOfItemId: p.replacementOfItemId || p.replacement_of_item_id || undefined,
      createdAt: p.createdAt || p.created_at || new Date().toISOString(),
      updatedAt: p.updatedAt || p.updated_at || new Date().toISOString(),
      deliveredAt: p.deliveredAt || p.delivered_at || undefined,
      financiallyRecognizedAt: p.financiallyRecognizedAt || p.financially_recognized_at || undefined,
      cancelledAt: p.cancelledAt || p.cancelled_at || undefined,
      deletedAt: p.deletedAt || p.deleted_at || undefined,
      version: incomingItemVersion,
    };
    localDb.setWithTx(tx, 'orderItems', entity.id, entity);
    snapshotRemoteMapEntry(tx, 'orderItems', itemsMap, entity.id);
    itemsMap.set(entity.id, entity);
    notifyStoreAfterTransaction('orderItems', entity.id, tx);
  } else if (entityType === 'goals') {
    if (isDelete) {
      snapshotRemoteMapEntry(tx, 'goals', goalsMap, change.entityId);
      goalsMap.delete(change.entityId);
      localDb.removeWithTx(tx as any, 'goals', change.entityId);
      notifyStoreAfterTransaction('goals', change.entityId, tx);
      return;
    }
    const previousGoal = goalsMap.get(change.entityId);
    const incomingGoalVersion = Number(change.version ?? p.version ?? 1);
    if (previousGoal && change.action !== 'INSERT' && Number(previousGoal.version ?? 0) >= incomingGoalVersion) {
      return;
    }
    const entity: GoalEntity = {
      id: p.id || change.entityId,
      customerId: p.customerId || p.customer_id,
      targetQuantity: Number(p.targetQuantity ?? p.target_quantity ?? 0),
      currentProgress: Number(p.currentProgress ?? p.current_progress ?? 0),
      bonusAmountMinor: Number(p.bonusAmountMinor ?? p.bonus_amount_minor ?? 0),
      durationDays: Number(p.durationDays ?? p.duration_days ?? 0),
      status: String(p.status || previousGoal?.status || 'ACTIVE').toUpperCase() as GoalEntity['status'],
      startedAt: p.startedAt || p.started_at || previousGoal?.startedAt || new Date().toISOString(),
      expiresAt: p.expiresAt || p.expires_at || previousGoal?.expiresAt || new Date().toISOString(),
      completedAt: p.completedAt || p.completed_at || undefined,
      bonusLedgerId: p.bonusLedgerId || p.bonus_ledger_id || undefined,
      createdAt: p.createdAt || p.created_at || previousGoal?.createdAt || new Date().toISOString(),
      updatedAt: p.updatedAt || p.updated_at || new Date().toISOString(),
      version: incomingGoalVersion,
    };
    localDb.setWithTx(tx, 'goals', entity.id, entity);
    snapshotRemoteMapEntry(tx, 'goals', goalsMap, entity.id);
    goalsMap.set(entity.id, entity);
    notifyStoreAfterTransaction('goals', entity.id, tx);
  } else if (entityType === 'goal_requests' || entityType === 'goalRequests') {
    if (isDelete) {
      snapshotRemoteMapEntry(tx, 'goalRequests', goalRequestsMap, change.entityId);
      goalRequestsMap.delete(change.entityId);
      localDb.removeWithTx(tx as any, 'goalRequests', change.entityId);
      notifyStoreAfterTransaction('goalRequests', change.entityId, tx);
      return;
    }
    const previousRequest = goalRequestsMap.get(change.entityId);
    const incomingRequestVersion = Number(change.version ?? p.version ?? 1);
    if (previousRequest && change.action !== 'INSERT' && Number(previousRequest.version ?? 0) >= incomingRequestVersion) {
      return;
    }
    const entity: GoalRequestEntity = {
      id: p.id || change.entityId,
      customerId: p.customerId || p.customer_id,
      requestedTarget: p.requestedTarget ?? p.requested_target ?? undefined,
      status: String(p.status || previousRequest?.status || 'PENDING').toUpperCase() as GoalRequestEntity['status'],
      reviewedBy: p.reviewedBy || p.reviewed_by || undefined,
      reviewedAt: p.reviewedAt || p.reviewed_at || undefined,
      rejectionReason: p.rejectionReason || p.rejection_reason || undefined,
      resultingGoalId: p.resultingGoalId || p.resulting_goal_id || undefined,
      createdAt: p.createdAt || p.created_at || previousRequest?.createdAt || new Date().toISOString(),
      updatedAt: p.updatedAt || p.updated_at || new Date().toISOString(),
      version: incomingRequestVersion,
    };
    localDb.setWithTx(tx, 'goalRequests', entity.id, entity);
    snapshotRemoteMapEntry(tx, 'goalRequests', goalRequestsMap, entity.id);
    goalRequestsMap.set(entity.id, entity);
    notifyStoreAfterTransaction('goalRequests', entity.id, tx);
  } else if (entityType === 'financial_ledger' || entityType === 'financialLedger') {
    if (isDelete) {
      const idx = ledgerList.findIndex((item) => item.id === change.entityId);
      if (idx >= 0) {
        snapshotRemoteArray(tx, 'financialLedger', ledgerList);
        ledgerList.splice(idx, 1);
      }
      localDb.removeWithTx(tx as any, 'financialLedger', change.entityId);
      notifyStoreAfterTransaction('financialLedger', change.entityId, tx);
      return;
    }
    const ledgerEventType = p.eventType || p.event_type;
    const ledgerOrderId = p.orderId || p.order_id || undefined;
    const ledgerOrderItemId = p.orderItemId || p.order_item_id || undefined;
    const derivedOrder = ledgerOrderId ? ordersMap.get(ledgerOrderId) : undefined;
    const derivedItem = ledgerOrderItemId ? itemsMap.get(ledgerOrderItemId) : undefined;
    const rawLedgerAmount = Number(p.amountMinor ?? p.amount_minor ?? 0);
    const normalizedLedgerAmount =
      (ledgerEventType === 'CHARGE' || ledgerEventType === 'ORDER_ITEM_CHARGE') && rawLedgerAmount > 0
        ? -rawLedgerAmount
        : rawLedgerAmount;

    // Goal bonus ledger rows are linked to their goal through reference_id/metadata.
    // Some change-log payloads may omit customer_id even though the completed goal
    // already exists locally; resolve the owner from that canonical relationship.
    const ledgerReferenceId = p.referenceId || p.reference_id || undefined;
    const goalReferenceId =
      ledgerEventType === 'BONUS'
        ? (p.metadata?.goalId || p.metadata?.goal_id || ledgerReferenceId)
        : undefined;
    const referencedGoal = goalReferenceId ? goalsMap.get(String(goalReferenceId)) : undefined;
    const derivedCustomerId =
      p.customerId ||
      p.customer_id ||
      derivedOrder?.customerId ||
      (derivedItem ? ordersMap.get(derivedItem.orderId)?.customerId : undefined) ||
      referencedGoal?.customerId;
    if (!derivedCustomerId) {
      throw new Error(`Cannot apply financial ledger change ${change.entityId} without customer identity`);
    }

    const entity: FinancialLedgerEntity = {
      id: p.id || change.entityId,
      eventType: ledgerEventType,
      amountMinor: normalizedLedgerAmount,
      orderId: ledgerOrderId || derivedItem?.orderId,
      orderItemId: ledgerOrderItemId,
      customerId: derivedCustomerId,
      actorAdminId: p.actorAdminId || p.actor_admin_id || undefined,
      referenceId: p.referenceId || p.reference_id || undefined,
      metadata: p.metadata ?? undefined,
      createdAt: p.createdAt || p.created_at || new Date().toISOString(),
    };
    localDb.setWithTx(tx, 'financialLedger', entity.id, entity);
    snapshotRemoteArray(tx, 'financialLedger', ledgerList);
    const existingIdx = ledgerList.findIndex((item) => item.id === entity.id);
    if (existingIdx >= 0) {
      ledgerList[existingIdx] = entity;
    } else {
      ledgerList.push(entity);
    }
    notifyStoreAfterTransaction('financialLedger', entity.id, tx);
  } else if (entityType === 'payments') {
    if (isDelete) {
      snapshotRemoteMapEntry(tx, 'payments', paymentsMap, change.entityId);
      paymentsMap.delete(change.entityId);
      localDb.removeWithTx(tx as any, 'payments', change.entityId);
      notifyStoreAfterTransaction('payments', change.entityId, tx);
      return;
    }
    const entity: PaymentEntity = {
      id: p.id || change.entityId,
      customerId: p.customerId || p.customer_id,
      amountMinor: p.amountMinor ?? p.amount_minor ?? 0,
      paymentMethod: p.paymentMethod || p.payment_method,
      reference: p.reference ?? undefined,
      actorAdminId: p.actorAdminId || p.actor_admin_id,
      commandId: p.commandId || p.command_id,
      createdAt: p.createdAt || p.created_at || new Date().toISOString(),
    };
    localDb.setWithTx(tx, 'payments', entity.id, entity);
    snapshotRemoteMapEntry(tx, 'payments', paymentsMap, entity.id);
    paymentsMap.set(entity.id, entity);
    notifyStoreAfterTransaction('payments', entity.id, tx);
  } else if (entityType === 'payment_allocations' || entityType === 'paymentAllocations') {
    if (isDelete) {
      const idx = allocationsList.findIndex((item) => item.id === change.entityId);
      if (idx >= 0) {
        snapshotRemoteArray(tx, 'paymentAllocations', allocationsList);
        allocationsList.splice(idx, 1);
      }
      localDb.removeWithTx(tx as any, 'paymentAllocations', change.entityId);
      notifyStoreAfterTransaction('paymentAllocations', change.entityId, tx);
      return;
    }
    const entity: PaymentAllocationEntity = {
      id: p.id || change.entityId,
      paymentId: p.paymentId || p.payment_id,
      orderItemId: p.orderItemId || p.order_item_id,
      orderId: p.orderId || p.order_id,
      allocatedAmountMinor: p.allocatedAmountMinor ?? p.allocated_amount_minor ?? 0,
      createdAt: p.createdAt || p.created_at || new Date().toISOString(),
    };
    localDb.setWithTx(tx, 'paymentAllocations', entity.id, entity);
    snapshotRemoteArray(tx, 'paymentAllocations', allocationsList);
    const existingIdx = allocationsList.findIndex((item) => item.id === entity.id);
    if (existingIdx >= 0) {
      allocationsList[existingIdx] = entity;
    } else {
      allocationsList.push(entity);
    }
    notifyStoreAfterTransaction('paymentAllocations', entity.id, tx);
  } else {
    if (isDelete) {
      localDb.removeWithTx(tx as any, entityType, change.entityId);
      notifyStoreAfterTransaction('all', change.entityId, tx);
      return;
    }
    localDb.setWithTx(tx, entityType, change.entityId, p);
    notifyStoreAfterTransaction('all', change.entityId, tx);
  }
};

// Helper to derive or format a secure 4-character alphanumeric customer code
const getCustomerCode = (cust: CustomerEntity): string => {
  const codeMap: Record<string, string> = {
    'cust-1': 'A7K2',
    'cust-2': '9FQX',
    'cust-3': 'M4P8',
    'cust-4': 'K3P9',
    'cust-5': '7X82',
    'cust-6': 'R9W4',
  };

  // Canonical customer code: the same 4-character prefix used by the
  // PostgreSQL derive_customer_code() RPC. This prevents a customer from
  // receiving a different code depending on whether the UI or server
  // generated it.
  const compactUuid = String(cust.id || '').replace(/-/g, '');
  if (/^[0-9a-f]{32}$/i.test(compactUuid)) {
    return compactUuid.slice(0, 4).toUpperCase();
  }

  // Legacy/non-UUID records may still exist in old local snapshots.
  // Keep their historical stable mapping without affecting canonical UUID data.
  if (codeMap[cust.id]) return codeMap[cust.id];

  let hash = 0;
  for (let i = 0; i < cust.id.length; i++) {
    hash = (hash << 5) - hash + cust.id.charCodeAt(i);
    hash |= 0;
  }
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  let val = Math.abs(hash);
  for (let i = 0; i < 4; i++) {
    code += chars[val % chars.length];
    val = Math.floor(val / chars.length) || (i + 1) * 7;
  }
  return code;
};
export const getDefaultCustomers = (): CustomerEntity[] => [];

export const getDefaultDevices = (): DeviceTypeEntity[] => [];

export const getDefaultDays = (): BusinessDayEntity[] => [];

export const getDefaultOrders = (): OrderEntity[] => [];

export const getDefaultItems = (): OrderItemEntity[] => [];

export const getDefaultLedger = (): FinancialLedgerEntity[] => [];

// Helper for test suites to seed legacy mock operational dataset
export const seedDemoOperationalData = async (): Promise<void> => {
  const demoDevs: DeviceTypeEntity[] = [
    { id: 'dev-1', name: 'شاشة آيفون 13 برو', icon: 'smartphone', basePriceMinor: 4500, chargerFeeEnabled: true, isActive: true, sortOrder: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
    { id: 'dev-2', name: 'بطارية آيفون 13', icon: 'battery', basePriceMinor: 2000, chargerFeeEnabled: false, isActive: true, sortOrder: 2, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
    { id: 'dev-3', name: 'سامسونج A52 - صيانة مدخل شحن', icon: 'wrench', basePriceMinor: 2500, chargerFeeEnabled: true, isActive: true, sortOrder: 3, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
    { id: 'dev-4', name: 'شاحن سريع 25W', icon: 'zap', basePriceMinor: 1500, chargerFeeEnabled: false, isActive: true, sortOrder: 4, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
    { id: 'dev-5', name: 'آيباد اير - تغيير زجاج', icon: 'tablet', basePriceMinor: 8000, chargerFeeEnabled: true, isActive: true, sortOrder: 5, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
    { id: 'dev-6', name: 'ماك بوك - صيانة لوحة المفاتيح', icon: 'laptop', basePriceMinor: 7000, chargerFeeEnabled: true, isActive: true, sortOrder: 6, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
    { id: 'dev-7', name: 'ساعة أبل - تبديل سير', icon: 'watch', basePriceMinor: 4000, chargerFeeEnabled: false, isActive: true, sortOrder: 7, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
  ];
  for (const d of demoDevs) {
    devicesMap.set(d.id, d);
    await localDb.set('deviceTypes', d.id, d);
  }

  const custs: CustomerEntity[] = [
    { id: 'cust-1', name: 'محمد علي', phone: '0599123456', isActive: true, debtLimitMinor: -50000, chargerFeeExempt: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
    { id: 'cust-2', name: 'سارة خالد', phone: '0598765432', isActive: true, debtLimitMinor: -30000, chargerFeeExempt: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
    { id: 'cust-3', name: 'أحمد محمود', phone: '0597112233', isActive: true, debtLimitMinor: -20000, chargerFeeExempt: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
    { id: 'cust-4', name: 'طارق زياد', phone: '0596445566', isActive: true, debtLimitMinor: -15000, chargerFeeExempt: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
    { id: 'cust-5', name: 'ليلى حسن', phone: '0595778899', isActive: true, debtLimitMinor: -10000, chargerFeeExempt: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
    { id: 'cust-6', name: 'يوسف العمر', phone: '0594223344', isActive: true, debtLimitMinor: -50000, chargerFeeExempt: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', version: 1 },
  ];
  for (const c of custs) {
    customersMap.set(c.id, c);
    await localDb.set('customers', c.id, c);
  }

  const days: BusinessDayEntity[] = [
    { id: 'day-2026-09-25', businessDate: '2026-09-25', isClosed: false, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z', version: 1 },
    { id: 'day-2026-09-24', businessDate: '2026-09-24', isClosed: false, createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z', version: 1 },
    { id: 'day-2026-09-23', businessDate: '2026-09-23', isClosed: false, createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z', version: 1 },
  ];
  for (const d of days) {
    daysMap.set(d.id, d);
    await localDb.set('businessDays', d.id, d);
  }

  const orders: OrderEntity[] = [
    { id: 'ord-27', dayId: 'day-2026-09-25', customerId: 'cust-1', displayNumber: 27, internalSequence: 27, status: 'pending', customerBalanceSnapshotMinor: 1600, createdAt: '2026-09-25T14:30:00Z', updatedAt: '2026-09-25T14:30:00Z', version: 1 },
    { id: 'ord-26', dayId: 'day-2026-09-25', customerId: 'cust-2', displayNumber: 26, internalSequence: 26, status: 'pending', customerBalanceSnapshotMinor: 0, createdAt: '2026-09-25T12:15:00Z', updatedAt: '2026-09-25T12:15:00Z', version: 1 },
    { id: 'ord-25', dayId: 'day-2026-09-25', customerId: 'cust-3', displayNumber: 25, internalSequence: 25, status: 'pending', customerBalanceSnapshotMinor: 2500, createdAt: '2026-09-25T09:00:00Z', updatedAt: '2026-09-25T09:00:00Z', version: 1 },
    { id: 'ord-8-day-25', dayId: 'day-2026-09-25', customerId: 'cust-1', displayNumber: 8, internalSequence: 8, status: 'pending', customerBalanceSnapshotMinor: 1000, createdAt: '2026-09-25T11:00:00Z', updatedAt: '2026-09-25T11:00:00Z', version: 1 },
    { id: 'ord-8-day-24', dayId: 'day-2026-09-24', customerId: 'cust-2', displayNumber: 8, internalSequence: 8, status: 'delivered', customerBalanceSnapshotMinor: 0, createdAt: '2026-09-24T16:00:00Z', updatedAt: '2026-09-24T16:00:00Z', version: 1 },
    { id: 'ord-legacy-no-snap', dayId: 'day-2026-09-25', customerId: 'cust-4', displayNumber: 24, internalSequence: 24, status: 'pending', createdAt: '2026-09-25T08:00:00Z', updatedAt: '2026-09-25T08:00:00Z', version: 1 },
  ];
  for (const o of orders) {
    ordersMap.set(o.id, o);
    await localDb.set('orders', o.id, o);
  }

  const items: OrderItemEntity[] = [
    { id: 'dev-ord-8-25', orderId: 'ord-8-day-25', deviceTypeId: 'dev-1', itemSequence: 1, status: 'charging', deviceNameSnapshot: 'شاشة آيفون 13 برو', deviceIconSnapshot: 'smartphone', basePriceSnapshotMinor: 4500, chargerFeeEnabledSnapshot: true, customerChargerFeeExemptSnapshot: false, chargerFeeSnapshotMinor: 50, hasCharger: false, unitPriceMinor: 4550, totalPriceMinor: 4550, createdAt: '2026-09-25T11:00:00Z', updatedAt: '2026-09-25T11:00:00Z', version: 1 },
    { id: 'dev-ord-8-24', orderId: 'ord-8-day-24', deviceTypeId: 'dev-2', itemSequence: 1, status: 'delivered', deviceNameSnapshot: 'بطارية آيفون 13', deviceIconSnapshot: 'battery', basePriceSnapshotMinor: 2000, chargerFeeEnabledSnapshot: false, customerChargerFeeExemptSnapshot: false, chargerFeeSnapshotMinor: 0, hasCharger: false, unitPriceMinor: 2000, totalPriceMinor: 2000, createdAt: '2026-09-24T16:00:00Z', updatedAt: '2026-09-24T16:00:00Z', version: 1 },
    { id: 'dev-1', orderId: 'ord-27', deviceTypeId: 'dev-1', itemSequence: 1, status: 'charging', deviceNameSnapshot: 'شاشة آيفون 13 برو', deviceIconSnapshot: 'smartphone', basePriceSnapshotMinor: 4500, chargerFeeEnabledSnapshot: true, customerChargerFeeExemptSnapshot: false, chargerFeeSnapshotMinor: 50, hasCharger: false, unitPriceMinor: 4550, totalPriceMinor: 4550, createdAt: '2026-09-25T14:30:00Z', updatedAt: '2026-09-25T14:30:00Z', version: 1 },
    { id: 'dev-2', orderId: 'ord-27', deviceTypeId: 'dev-2', itemSequence: 2, status: 'charging', deviceNameSnapshot: 'بطارية آيفون 13', deviceIconSnapshot: 'battery', basePriceSnapshotMinor: 2000, chargerFeeEnabledSnapshot: false, customerChargerFeeExemptSnapshot: false, chargerFeeSnapshotMinor: 0, hasCharger: false, unitPriceMinor: 2000, totalPriceMinor: 2000, createdAt: '2026-09-25T14:30:00Z', updatedAt: '2026-09-25T14:30:00Z', version: 1 },
    { id: 'dev-3', orderId: 'ord-26', deviceTypeId: 'dev-3', itemSequence: 1, status: 'charging', deviceNameSnapshot: 'سامسونج A52 - صيانة مدخل شحن', deviceIconSnapshot: 'wrench', basePriceSnapshotMinor: 2500, chargerFeeEnabledSnapshot: true, customerChargerFeeExemptSnapshot: false, chargerFeeSnapshotMinor: 50, hasCharger: false, unitPriceMinor: 2550, totalPriceMinor: 2550, createdAt: '2026-09-25T12:15:00Z', updatedAt: '2026-09-25T12:15:00Z', version: 1 },
    { id: 'dev-4', orderId: 'ord-26', deviceTypeId: 'dev-4', itemSequence: 2, status: 'charging', deviceNameSnapshot: 'شاحن سريع 25W', deviceIconSnapshot: 'zap', basePriceSnapshotMinor: 1500, chargerFeeEnabledSnapshot: false, customerChargerFeeExemptSnapshot: false, chargerFeeSnapshotMinor: 0, hasCharger: false, unitPriceMinor: 1500, totalPriceMinor: 1500, createdAt: '2026-09-25T12:15:00Z', updatedAt: '2026-09-25T12:15:00Z', version: 1 },
    { id: 'dev-5', orderId: 'ord-25', deviceTypeId: 'dev-5', itemSequence: 1, status: 'charging', deviceNameSnapshot: 'آيباد اير - تغيير زجاج', deviceIconSnapshot: 'tablet', basePriceSnapshotMinor: 8000, chargerFeeEnabledSnapshot: true, customerChargerFeeExemptSnapshot: true, chargerFeeSnapshotMinor: 0, hasCharger: false, unitPriceMinor: 8000, totalPriceMinor: 8000, createdAt: '2026-09-25T09:00:00Z', updatedAt: '2026-09-25T09:00:00Z', version: 1 },
  ];
  for (const i of items) {
    itemsMap.set(i.id, i);
    await localDb.set('orderItems', i.id, i);
  }

  const ledger: FinancialLedgerEntity[] = [
    { id: 'ledg-2', customerId: 'cust-1', amountMinor: 8100, eventType: 'PAYMENT', createdAt: '2026-09-25T15:00:00Z' },
    { id: 'ledg-3', customerId: 'cust-4', orderId: 'ord-legacy-no-snap', amountMinor: -1000, eventType: 'ORDER_ITEM_CHARGE', createdAt: '2026-09-25T08:00:00Z' },
    { id: 'ledg-4', customerId: 'cust-4', amountMinor: 2000, eventType: 'PAYMENT', createdAt: '2026-09-25T09:30:00Z' },
    { id: 'ledg-5', customerId: 'cust-4', amountMinor: -500, eventType: 'ORDER_ITEM_CHARGE', createdAt: '2026-09-25T11:00:00Z' },
  ];
  ledgerList.length = 0;
  for (const l of ledger) {
    ledgerList.push(l);
    await localDb.set('financialLedger', l.id, l);
  }

  isStoreHydrated = true;
};

// Memory reset helper for tests to simulate app restart without wiping IndexedDB
/**
 * Clear only in-memory canonical projections before a full authoritative replay.
 * Keep listeners and hydration wiring alive; the replay repopulates these maps.
 */
export const resetCanonicalReadModelsForReplay = (): void => {
  ordersMap.clear();
  itemsMap.clear();
  customersMap.clear();
  devicesMap.clear();
  daysMap.clear();
  // The outbox survives authoritative replay, so its command identity cache
  // must survive too; clearing it would disable local idempotency checks.
  ledgerList.length = 0;
  paymentsMap.clear();
  allocationsList.length = 0;
  reservationsMap.clear();
  goalsMap.clear();
  goalRequestsMap.clear();
};

export const resetStoreMemory = () => {
  isStoreHydrated = false;
  hydrationPromise = null;
  ordersMap.clear();
  itemsMap.clear();
  customersMap.clear();
  devicesMap.clear();
  daysMap.clear();
  commandsMap.clear();
  ledgerList.length = 0;
  paymentsMap.clear();
  allocationsList.length = 0;
  reservationsMap.clear();
  goalsMap.clear();
  goalRequestsMap.clear();
  storeListeners.clear();
};

const getLocalStorage = () => {
  if (typeof localStorage !== 'undefined') return localStorage;
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  if (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) return (globalThis as any).localStorage;
  return null;
};

export const CURRENT_MIGRATION_VERSION = '6.10.5D';

const LEGACY_QR_MIGRATION_MARKER = 'legacy_qr_identity_migration_v2';

const persistQrTokenCanonical = async (token: QrTokenEntity, previousKey?: string): Promise<void> => {
  await localDb.set('qr_tokens', token.id, token);
  if (previousKey && previousKey !== token.id) {
    await localDb.remove('qr_tokens', previousKey);
  }
};

export const migrateLegacyQrTokenIdentities = async (): Promise<void> => {
  const storage = getLocalStorage();
  if (storage?.getItem(LEGACY_QR_MIGRATION_MARKER) === 'done') return;

  const tokens = await localDb.list<any>('qr_tokens');
  const legacyTokens = tokens.filter(
    (q) => typeof q?.id === 'string' && /:qr$/i.test(q.id),
  );

  // Repair the canonical token hash contract for every existing local QR.
  // Older offline customer QR creation stored the public token itself as tokenHash.
  for (const raw of tokens) {
    if (typeof raw?.id !== 'string' || /:qr$/i.test(raw.id)) continue;
    const publicToken = String(raw.publicToken ?? raw.public_token ?? raw.token ?? '').trim();
    if (!publicToken) {
      throw new Error(`QR ${raw.id} cannot be migrated: missing public token`);
    }
    const expectedHash = await computeTokenHash(publicToken);
    const currentHash = String(raw.tokenHash ?? raw.token_hash ?? '').trim();
    if (currentHash !== expectedHash) {
      await persistQrTokenCanonical(
        { ...raw, tokenHash: expectedHash, token_hash: expectedHash, publicToken, public_token: publicToken },
      );
    }
  }

  if (legacyTokens.length === 0) {
    storage?.setItem(LEGACY_QR_MIGRATION_MARKER, 'done');
    return;
  }

  const orders = await localDb.list<any>('orders');
  const canonicalByLegacyId = new Map<string, string>();

  for (const raw of legacyTokens) {
    const legacyId = String(raw.id);
    const targetFromId = legacyId.replace(/:qr$/i, '');
    const tokenType = String(raw.tokenType ?? raw.token_type ?? raw.entityType ?? raw.entity_type ?? 'ORDER').toUpperCase();
    const targetId = raw.targetId ?? raw.target_id ?? raw.entityId ?? raw.entity_id ?? targetFromId;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(targetId))) {
      throw new Error(`Legacy QR ${legacyId} cannot be migrated: invalid targetId ${targetId}`);
    }
    if (tokenType !== 'ORDER' && tokenType !== 'CUSTOMER') {
      throw new Error(`Legacy QR ${legacyId} cannot be migrated: invalid tokenType ${tokenType}`);
    }

    const publicToken = String(raw.publicToken ?? raw.public_token ?? raw.token ?? '').trim() || generateSecurePublicToken();
    const tokenHash = String(raw.tokenHash ?? raw.token_hash ?? '').trim() || await computeTokenHash(publicToken);
    const canonicalId = globalThis.crypto?.randomUUID?.();

    if (!canonicalId) {
      throw new Error(`Legacy QR ${legacyId} cannot be migrated: crypto.randomUUID is unavailable`);
    }

    const canonical: QrTokenEntity = {
      id: canonicalId,
      tokenHash,
      publicToken,
      tokenType: tokenType as QrTokenEntity['tokenType'],
      targetId: String(targetId),
      isActive: Boolean(raw.isActive ?? raw.is_active ?? true),
      expiresAt: raw.expiresAt ?? raw.expires_at,
      createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    };

    await persistQrTokenCanonical(canonical, legacyId);
    canonicalByLegacyId.set(legacyId, canonical.id);
  }

  for (const order of orders) {
    const oldId = order?.qrTokenId ?? order?.qr_token_id;
    const mappedId = typeof oldId === 'string' ? canonicalByLegacyId.get(oldId) : undefined;
    if (mappedId) {
      await localDb.set('orders', order.id, { ...order, qrTokenId: mappedId, qr_token_id: mappedId });
    }
  }

  storage?.setItem(LEGACY_QR_MIGRATION_MARKER, 'done');
};



// Clean Operational Reset helper (sets all operational data to ZERO while retaining device types & config)
export const clearAllOperationalData = async (): Promise<void> => {
  const storage = getLocalStorage();
  if (storage) {
    storage.setItem('sys_db_version', CURRENT_MIGRATION_VERSION);
    storage.removeItem('sys_operational_reset');
  }

  ordersMap.clear();
  itemsMap.clear();
  customersMap.clear();
  daysMap.clear();
  commandsMap.clear();
  ledgerList.length = 0;
  paymentsMap.clear();
  allocationsList.length = 0;
  devicesMap.clear();

  await localDb.clearOperationalTables({ clearOutbox: true, clearSyncState: true });
  await localDb.setLocalResetMarker(true);
  await localDb.setInitialHydrationCompleted(false);

  isStoreHydrated = true;
  notifyStore('all');
};

/**
 * runCleanBootMigrationIfNeeded
 * 
 * Part B Repair: Fixes the destructive "fresh client" detection.
 * 1. Checks current sys_db_version.
 * 2. If missing/old, checks if local database is ACTUALLY empty.
 * 3. Only performs clearAllOperationalData() if truly empty OR if a mandatory schema break is required.
 * 4. This prevents a page reload from wiping freshly restored backup data.
 */
export const runCleanBootMigrationIfNeeded = async (): Promise<boolean> => {
  const storage = getLocalStorage();
  const storedVersion = storage?.getItem('sys_db_version');

  if (storedVersion === CURRENT_MIGRATION_VERSION) {
    return false;
  }

  // Version mismatch or missing: Check if we have any business data or completed hydration before wiping
  await initDbIfNeeded();
  const isHydrated = await localDb.isInitialHydrationCompleted();
  if (isHydrated) {
    storage?.setItem('sys_db_version', CURRENT_MIGRATION_VERSION);
    return false;
  }

  const custs = await localDb.list('customers');
  const orders = await localDb.list('orders');
  const items = await localDb.list('orderItems');
  const allocs = await localDb.list('paymentAllocations');
  const payments = await localDb.list('payments');
  const days = await localDb.list('businessDays');
  const ledger = await localDb.list('financialLedger');
  const outbox = await localDb.listOutbox();
  const syncState = await localDb.getSyncState('global');
  const hasData =
    custs.length > 0 ||
    orders.length > 0 ||
    items.length > 0 ||
    allocs.length > 0 ||
    payments.length > 0 ||
    days.length > 0 ||
    ledger.length > 0 ||
    outbox.length > 0 ||
    (syncState && syncState.resetGeneration !== undefined && syncState.resetGeneration !== -1);

  if (hasData) {
    // Safety: We have data but an old version. Update version marker without wiping.
    storage?.setItem('sys_db_version', CURRENT_MIGRATION_VERSION);
    return false;
  }

  // A clean boot must not turn a brand-new browser into an intentional local reset.
  // clearAllOperationalData() sets local_reset_completed=true to prevent cloud data
  // from reappearing after a user-requested reset. That marker is wrong for a fresh
  // client because ensureStoreHydrated() uses it to skip the initial cloud snapshot.
  const resetWasAlreadyIntentional =
    (await localDb.isLocalResetCompleted()) ||
    storage?.getItem('sys_operational_reset') === 'true';

  await clearAllOperationalData();

  // Preserve the reset barrier only when the reset was explicitly requested before
  // this migration. A blank first-run client must remain eligible for cloud bootstrap.
  if (!resetWasAlreadyIntentional) {
    await localDb.clearLocalResetMarker();
  }

  return true;
};

export const reloadStoreFromLocal = async (): Promise<void> => {
  isStoreHydrated = false;
  hydrationPromise = null;
  ordersMap.clear();
  itemsMap.clear();
  customersMap.clear();
  devicesMap.clear();
  daysMap.clear();
  commandsMap.clear();
  ledgerList.length = 0;
  paymentsMap.clear();
  allocationsList.length = 0;
  reservationsMap.clear();

  await ensureStoreHydrated();
  notifyStore('all');
};

export const globalSyncTransport = new SupabaseSyncTransport();
export const globalSyncEngine = new SyncEngine(globalSyncTransport);
globalSyncEngine.onDeltaApplied = applyRemoteChange;

let onTransactionCommitted: (() => void) | null = null;
export const setTransactionCommittedHook = (hook: () => void) => {
  onTransactionCommitted = hook;
};

let isStoreHydrated = false;
let hydrationPromise: Promise<void> | null = null;

export interface StoreBootstrapProgress {
  phase: 'IDLE' | 'FETCHING' | 'INSTALLING' | 'READY' | 'FAILED';
  percent: number;
  completedRows: number;
  totalRows: number;
  message: string;
}

let currentStoreBootstrapProgress: StoreBootstrapProgress = {
  phase: 'IDLE', percent: 0, completedRows: 0, totalRows: 0, message: '',
};
const storeBootstrapProgressListeners = new Set<(progress: StoreBootstrapProgress) => void>();

const publishStoreBootstrapProgress = (progress: StoreBootstrapProgress): void => {
  currentStoreBootstrapProgress = progress;
  storeBootstrapProgressListeners.forEach((listener) => {
    try { listener(progress); } catch (error) { console.warn('Bootstrap progress listener failed:', error); }
  });
};

export const subscribeStoreBootstrapProgress = (
  listener: (progress: StoreBootstrapProgress) => void
): (() => void) => {
  storeBootstrapProgressListeners.add(listener);
  listener(currentStoreBootstrapProgress);
  return () => storeBootstrapProgressListeners.delete(listener);
};

/**
 * Authoritatively pulls all entities from Remote Supabase PostgREST tables,
 * mapping database columns to domain entities and synchronizing local IndexedDB.
 */
export const hydrateFromRemoteTables = async (): Promise<boolean> => {
  if (!getSupabaseStatus().isConfigured) return false;

  publishStoreBootstrapProgress({ phase: 'FETCHING', percent: 5, completedRows: 0, totalRows: 0, message: 'جارٍ جلب لقطة موحّدة من السحابة…' });

  // Before the first local mutation, read failures can safely fall back to a
  // previously persisted offline dataset. Once replacement starts, failures
  // must propagate so the boot gate never exposes a partially replaced store.
  let localMutationStarted = false;
  try {
    // One server-side statement captures every bootstrap collection and its
    // change-log high-water mark under the same PostgreSQL snapshot. Independent
    // REST reads cannot safely be paired with a cursor because rows can change
    // between requests.
    const { data: rawSnapshot, error: snapshotError } = await invokeSupabaseRpc<any>(
      'capture_sync_bootstrap_snapshot',
      {}
    );
    if (snapshotError) {
      console.warn('Authoritative bootstrap snapshot RPC failed:', snapshotError);
      publishStoreBootstrapProgress({ phase: 'FAILED', percent: 0, completedRows: 0, totalRows: 0, message: 'فشل الاتصال بقاعدة البيانات السحابية.' });
      return false;
    }
    const snapshot = (Array.isArray(rawSnapshot) ? rawSnapshot[0] : rawSnapshot) as any;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      console.warn('Authoritative bootstrap snapshot RPC returned an invalid response.');
      publishStoreBootstrapProgress({ phase: 'FAILED', percent: 0, completedRows: 0, totalRows: 0, message: 'استجابة قاعدة البيانات غير صالحة.' });
      return false;
    }

    const requiredCollections: Record<string, unknown> = {
      business_days: snapshot.business_days,
      customers: snapshot.customers,
      device_types: snapshot.device_types,
      orders: snapshot.orders,
      order_items: snapshot.order_items,
      financial_ledger: snapshot.financial_ledger,
      payments: snapshot.payments,
      payment_allocations: snapshot.payment_allocations,
      order_number_reservations: snapshot.order_number_reservations,
      qr_tokens: snapshot.qr_tokens,
      goals: snapshot.goals,
      goal_requests: snapshot.goal_requests,
    };
    const invalidCollection = Object.entries(requiredCollections).find(([, rows]) => !Array.isArray(rows));
    const snapshotGeneration = Number(snapshot.server_reset_generation);
    const snapshotSequence = Number(snapshot.max_change_sequence);
    if (
      Number(snapshot.schema_version) !== 1 ||
      invalidCollection ||
      !Number.isSafeInteger(snapshotGeneration) || snapshotGeneration < 0 ||
      !Number.isSafeInteger(snapshotSequence) || snapshotSequence < 0
    ) {
      console.warn('Authoritative bootstrap snapshot is incomplete or has an invalid checkpoint.', {
        invalidCollection: invalidCollection?.[0],
        snapshotGeneration,
        snapshotSequence,
      });
      publishStoreBootstrapProgress({ phase: 'FAILED', percent: 0, completedRows: 0, totalRows: 0, message: 'لقطة السحابة ناقصة أو غير صالحة.' });
      return false;
    }

    const totalRows = Object.values(requiredCollections).reduce<number>(
      (total, rows) => total + (rows as unknown[]).length,
      0
    );
    let installedRows = 0;
    let lastPublishedPercent = 10;
    publishStoreBootstrapProgress({
      phase: 'INSTALLING',
      percent: 10,
      completedRows: 0,
      totalRows,
      message: totalRows === 0 ? 'التحقق من قاعدة البيانات…' : 'جارٍ معالجة وتجهيز السجلات…',
    });
    const reportInstalledRow = (): void => {
      installedRows += 1;
      const percent = totalRows === 0 ? 80 : Math.min(80, 10 + Math.floor((installedRows / totalRows) * 70));
      if (percent !== lastPublishedPercent || installedRows === totalRows) {
        lastPublishedPercent = percent;
        publishStoreBootstrapProgress({
          phase: 'INSTALLING',
          percent,
          completedRows: installedRows,
          totalRows,
          message: 'جارٍ معالجة وتجهيز السجلات…',
        });
      }
    };

    const installWrites: Array<{ table: string; id: string; item: unknown }> = [];

    const daysRes = { data: snapshot.business_days as any[], error: null };
    const custRes = { data: snapshot.customers as any[], error: null };
    const devRes = { data: snapshot.device_types as any[], error: null };
    const ordRes = { data: snapshot.orders as any[], error: null };
    const itemRes = { data: snapshot.order_items as any[], error: null };
    const ledgRes = { data: snapshot.financial_ledger as any[], error: null };
    const payRes = { data: snapshot.payments as any[], error: null };
    const allocRes = { data: snapshot.payment_allocations as any[], error: null };
    const reservationsRes = { data: snapshot.order_number_reservations as any[], error: null };
    const qrTokensRes = { data: snapshot.qr_tokens as any[], error: null };
    const goalsRes = { data: snapshot.goals as any[], error: null };
    const goalRequestsRes = { data: snapshot.goal_requests as any[], error: null };
    const remoteReads = [
      daysRes, custRes, devRes, ordRes, itemRes, ledgRes, payRes, allocRes,
      reservationsRes, qrTokensRes, goalsRes, goalRequestsRes,
    ];
    const failedRemoteRead = remoteReads.find((result) => result.error || !Array.isArray(result.data));
    if (failedRemoteRead) {
      // Never clear a healthy local read model because one authoritative table
      // failed to load. The caller can retry the reconciliation later.
      console.warn('Authoritative hydration aborted because a required table failed to load:', failedRemoteRead.error);
      return false;
    }

    let updatedAny = false;

    // At this point every required authoritative collection and its checkpoint
    // have been validated from one server snapshot. The local install is guarded
    // by the initial-hydration marker: if installation fails or the tab closes,
    // the next boot retries instead of treating partial rows as a completed load.
    // A remote bootstrap is a read-model reconciliation. Preserve any local
    // aggregate that still has an outbox command so an online refresh cannot
    // erase work that has not yet reached the server.
    // Persist an installation barrier before replacing any local rows. If the
    // browser/tab is terminated mid-install, the next boot must not trust an old
    // READY checkpoint against a partially replaced dataset.
    const preBootstrapSyncState = await localDb.getSyncState('global');
    await localDb.setSyncState({
      ...(preBootstrapSyncState || {
        table: 'global',
        lastAppliedChangeSequence: 0,
        lastPulledAt: '',
      }),
      status: 'INITIALIZING',
      reconciliationRequired: true,
    });
    localMutationStarted = true;
    await localDb.clearOperationalData({
      clearOutbox: false,
      clearSyncState: false,
      preservePendingMutations: true,
    });
    customersMap.clear();
    devicesMap.clear();
    daysMap.clear();
    ordersMap.clear();
    itemsMap.clear();
    ledgerList.length = 0;
    paymentsMap.clear();
    allocationsList.length = 0;
    goalsMap.clear();
    goalRequestsMap.clear();
    reservationsMap.clear();

    // Only replace the local read model after the complete remote snapshot has
    // been fetched successfully. Partial table hydration is unsafe because it
    // can mix generations and silently delete one side of the local model.

    // 1. Business Days
    if (daysRes.data && Array.isArray(daysRes.data)) {
      for (const d of daysRes.data) {
        const resolvedDate =
          d.business_date ||
          d.businessDate ||
          d.date ||
          (d.id?.startsWith('day-') ? d.id.slice(4) : d.id) ||
          getLocalBusinessDateStr();
        const entity: BusinessDayEntity = {
          id: d.id,
          businessDate: resolvedDate,
          isClosed: d.is_closed ?? d.isClosed ?? false,
          closedAt: d.closed_at ?? d.closedAt ?? undefined,
          closedBy: d.closed_by ?? d.closedBy ?? undefined,
          createdAt: d.created_at || d.createdAt || new Date().toISOString(),
          updatedAt: d.updated_at || d.updatedAt || new Date().toISOString(),
          version: d.version || 1,
        };
        daysMap.set(entity.id, entity);
        installWrites.push({ table: 'businessDays', id: entity.id, item: entity });
        reportInstalledRow();
      }
      updatedAny = true;
    }

    // 2. Customers
    if (custRes.data && Array.isArray(custRes.data)) {
      for (const c of custRes.data) {
        const entity: CustomerEntity = {
          id: c.id,
          name: c.name,
          phone: c.phone || '',
          isActive: c.is_active ?? true,
          notes: c.notes ?? undefined,
          debtLimitMinor: c.debt_limit_minor ?? 0,
          chargerFeeExempt: c.charger_fee_exempt ?? false,
          createdAt: c.created_at,
          updatedAt: c.updated_at,
          version: c.version || 1,
        };
        customersMap.set(entity.id, entity);
        installWrites.push({ table: 'customers', id: entity.id, item: entity });
        reportInstalledRow();
      }
      updatedAny = true;
    }

    // 3. Device Types
    if (devRes.data && Array.isArray(devRes.data) && devRes.data.length > 0) {
      for (const dev of devRes.data) {
        const entity: DeviceTypeEntity = {
          id: dev.id,
          name: dev.name,
          nameAr: dev.name_ar || dev.name,
          nameEn: dev.name_en || undefined,
          icon: dev.icon || 'smartphone',
          basePriceMinor: dev.base_price_minor ?? 0,
          chargerFeeEnabled: dev.charger_fee_enabled ?? true,
          chargerFeeApplicable: dev.charger_fee_applicable ?? dev.charger_fee_enabled ?? true,
          isActive: dev.is_active ?? true,
          sortOrder: dev.sort_order ?? 0,
          createdAt: dev.created_at,
          updatedAt: dev.updated_at,
          deletedAt: dev.deleted_at ?? undefined,
          version: dev.version || 1,
        };
        devicesMap.set(entity.id, entity);
        installWrites.push({ table: 'deviceTypes', id: entity.id, item: entity });
        reportInstalledRow();
      }
      updatedAny = true;
    }

    // 4. Orders
    if (ordRes.data && Array.isArray(ordRes.data)) {
      for (const o of ordRes.data) {
        const entity: OrderEntity = {
          id: o.id,
          dayId: o.day_id,
          customerId: o.customer_id,
          displayNumber: o.display_number,
          internalSequence: o.internal_sequence,
          status: o.status,
          notes: o.notes ?? undefined,
          qrTokenId: o.qr_token_id ?? undefined,
          chargingAt: o.charging_at ?? undefined,
          deliveredAt: o.delivered_at ?? undefined,
          cancelledAt: o.cancelled_at ?? undefined,
          customerBalanceSnapshotMinor: 0,
          createdAt: o.created_at,
          updatedAt: o.updated_at,
          deletedAt: o.deleted_at ?? undefined,
          version: o.version || 1,
        };
        ordersMap.set(entity.id, entity);
        installWrites.push({ table: 'orders', id: entity.id, item: entity });
        reportInstalledRow();
      }
      updatedAny = true;
    }

    // 5. Order Items
    if (itemRes.data && Array.isArray(itemRes.data)) {
      for (const it of itemRes.data) {
        const entity: OrderItemEntity = {
          id: it.id,
          orderId: it.order_id,
          deviceTypeId: it.device_type_id,
          itemSequence: it.item_sequence,
          status: it.status,
          deviceNameSnapshot: it.device_name_snapshot,
          deviceIconSnapshot: it.device_icon_snapshot,
          basePriceSnapshotMinor: it.base_price_snapshot_minor,
          chargerFeeEnabledSnapshot: it.charger_fee_enabled_snapshot,
          customerChargerFeeExemptSnapshot: it.customer_charger_fee_exempt_snapshot,
          chargerFeeSnapshotMinor: it.charger_fee_snapshot_minor,
          hasCharger: it.has_charger,
          unitPriceMinor: it.unit_price_minor,
          totalPriceMinor: it.total_price_minor,
          replacementOfItemId: it.replacement_of_item_id ?? undefined,
          createdAt: it.created_at,
          updatedAt: it.updated_at,
          deliveredAt: it.delivered_at ?? undefined,
          deletedAt: it.deleted_at ?? undefined,
          version: it.version || 1,
        };
        itemsMap.set(entity.id, entity);
        installWrites.push({ table: 'orderItems', id: entity.id, item: entity });
        reportInstalledRow();
      }
      updatedAny = true;
    }

    // 6. Financial Ledger
    if (ledgRes.data && Array.isArray(ledgRes.data)) {
      ledgerList.length = 0;
      for (const l of ledgRes.data) {
        const entity: FinancialLedgerEntity = {
          id: l.id,
          eventType: l.event_type,
          amountMinor: l.amount_minor,
          orderId: l.order_id ?? undefined,
          orderItemId: l.order_item_id ?? undefined,
          customerId: l.customer_id,
          actorAdminId: l.actor_admin_id ?? undefined,
          referenceId: l.reference_id ?? undefined,
          metadata: l.metadata ?? undefined,
          createdAt: l.created_at,
        };
        ledgerList.push(entity);
        installWrites.push({ table: 'financialLedger', id: entity.id, item: entity });
        reportInstalledRow();
      }
      updatedAny = true;
    }

    // 7. Payments & Allocations
    if (payRes.data && Array.isArray(payRes.data)) {
      for (const p of payRes.data) {
        const entity: PaymentEntity = {
          id: p.id,
          customerId: p.customer_id,
          amountMinor: p.amount_minor,
          paymentMethod: p.payment_method,
          reference: p.reference ?? undefined,
          actorAdminId: p.actor_admin_id,
          commandId: p.command_id,
          createdAt: p.created_at,
        };
        paymentsMap.set(entity.id, entity);
        installWrites.push({ table: 'payments', id: entity.id, item: entity });
        reportInstalledRow();
      }
      updatedAny = true;
    }

    if (allocRes.data && Array.isArray(allocRes.data)) {
      allocationsList.length = 0;
      for (const a of allocRes.data) {
        const entity: PaymentAllocationEntity = {
          id: a.id,
          paymentId: a.payment_id,
          orderItemId: a.order_item_id,
          orderId: a.order_id,
          allocatedAmountMinor: a.allocated_amount_minor,
          createdAt: a.created_at,
        };
        allocationsList.push(entity);
        installWrites.push({ table: 'paymentAllocations', id: entity.id, item: entity });
        reportInstalledRow();
      }
      updatedAny = true;
    }

    // 8. Reservations and QR identities are required bootstrap collections too.
    for (const row of reservationsRes.data as any[]) {
      const entity: OrderNumberReservationEntity = {
        id: row.id,
        businessDayId: row.business_day_id ?? row.businessDayId,
        deviceId: row.device_id ?? row.deviceId,
        startNumber: Number(row.start_number ?? row.startNumber ?? 1),
        endNumber: Number(row.end_number ?? row.endNumber ?? 0),
        nextNumber: Number(row.next_number ?? row.nextNumber ?? 1),
        status: String(row.status || 'ACTIVE').toUpperCase() as OrderNumberReservationEntity['status'],
        commandId: row.command_id ?? row.commandId ?? undefined,
        createdAt: row.created_at ?? row.createdAt ?? new Date().toISOString(),
        updatedAt: row.updated_at ?? row.updatedAt ?? new Date().toISOString(),
        version: Number(row.version ?? 1),
      };
      reservationsMap.set(entity.id, entity);
      installWrites.push({ table: 'orderNumberReservations', id: entity.id, item: entity });
      reportInstalledRow();
    }

    for (const row of qrTokensRes.data as any[]) {
      const entity: QrTokenEntity = {
        id: row.id,
        tokenHash: row.token_hash ?? row.tokenHash,
        publicToken: row.public_token ?? row.publicToken,
        tokenType: String(row.token_type ?? row.tokenType).toUpperCase() as QrTokenEntity['tokenType'],
        targetId: row.target_id ?? row.targetId,
        isActive: Boolean(row.is_active ?? row.isActive),
        expiresAt: row.expires_at ?? row.expiresAt ?? undefined,
        createdAt: row.created_at ?? row.createdAt ?? new Date().toISOString(),
      };
      installWrites.push({ table: 'qr_tokens', id: entity.id, item: entity });
      reportInstalledRow();
    }

    // 8. Goals and goal requests are part of the same initial authoritative snapshot.
    // Keeping these tables out of bootstrap left fresh clients with an empty local goal model.
    for (const row of goalsRes.data as any[]) {
      const entity: GoalEntity = {
        id: row.id,
        customerId: row.customer_id,
        targetQuantity: Number(row.target_quantity ?? 0),
        currentProgress: Number(row.current_progress ?? 0),
        bonusAmountMinor: Number(row.bonus_amount_minor ?? 0),
        durationDays: Number(row.duration_days ?? 0),
        status: String(row.status || 'ACTIVE').toUpperCase() as GoalEntity['status'],
        startedAt: row.started_at,
        expiresAt: row.expires_at,
        completedAt: row.completed_at ?? undefined,
        bonusLedgerId: row.bonus_ledger_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: Number(row.version ?? 1),
      };
      goalsMap.set(entity.id, entity);
      installWrites.push({ table: 'goals', id: entity.id, item: entity });
      reportInstalledRow();
    }

    for (const row of goalRequestsRes.data as any[]) {
      const entity: GoalRequestEntity = {
        id: row.id,
        customerId: row.customer_id,
        requestedTarget: row.requested_target ?? undefined,
        status: String(row.status || 'PENDING').toUpperCase() as GoalRequestEntity['status'],
        reviewedBy: row.reviewed_by ?? undefined,
        reviewedAt: row.reviewed_at ?? undefined,
        rejectionReason: row.rejection_reason ?? undefined,
        resultingGoalId: row.resulting_goal_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: Number(row.version ?? 1),
      };
      goalRequestsMap.set(entity.id, entity);
      installWrites.push({ table: 'goalRequests', id: entity.id, item: entity });
      reportInstalledRow();
    }
    updatedAny = true;

    // Install the snapshot fence only after every required collection has
    // been persisted. The next incremental pull starts strictly after this
    // exact snapshot; it must not treat the new device as generation -1 and
    // clear the just-hydrated data for a redundant full change-log replay.
    const existingSyncState = await localDb.getSyncState('global');
    const snapshotSyncState = {
      ...(existingSyncState || {
        table: 'global',
        lastAppliedChangeSequence: 0,
        lastPulledAt: '',
      }),
      table: 'global',
      lastAppliedChangeSequence: snapshotSequence,
      lastPulledAt: snapshot.captured_at || new Date().toISOString(),
      resetGeneration: snapshotGeneration,
      status: 'READY' as const,
      reconciliationRequired: false,
    };

    publishStoreBootstrapProgress({
      phase: 'INSTALLING',
      percent: 85,
      completedRows: totalRows,
      totalRows,
      message: 'جارٍ حفظ اللقطة كاملة في القاعدة المحلية…',
    });
    // Commit every collection and its cursor in one IndexedDB transaction. If
    // any put fails, the transaction rolls back and the durable INITIALIZING
    // barrier remains in place for a safe retry on the next boot.
    await localDb.runTransaction(['kvStore', 'syncState'], 'readwrite', (tx) => {
      for (const write of installWrites) {
        localDb.setWithTx(tx, write.table, write.id, write.item);
      }
      localDb.setSyncStateWithTx(tx, snapshotSyncState);
    });

    publishStoreBootstrapProgress({
      phase: 'INSTALLING',
      percent: 95,
      completedRows: totalRows,
      totalRows,
      message: 'تم حفظ البيانات؛ جارٍ اعتماد اكتمال التهيئة…',
    });
    if (updatedAny) {
      await localDb.setInitialHydrationCompleted(true);
    }
    publishStoreBootstrapProgress({
      phase: 'READY',
      percent: 100,
      completedRows: totalRows,
      totalRows,
      message: 'اكتمل تحميل البيانات والتحقق منها.',
    });
    return updatedAny;
  } catch (err) {
    console.warn('Remote table hydration failed:', err);
    publishStoreBootstrapProgress({
      phase: 'FAILED',
      percent: currentStoreBootstrapProgress.percent,
      completedRows: currentStoreBootstrapProgress.completedRows,
      totalRows: currentStoreBootstrapProgress.totalRows,
      message: 'فشل تثبيت البيانات. أعد المحاولة؛ لم تُعلَن التهيئة مكتملة.',
    });
    // A failure before replacement begins is safe for an existing offline cache.
    // After replacement starts, fail closed: callers must not expose partial data.
    if (localMutationStarted) throw err;
    return false;
  }
};

export const refreshStoreFromRemote = async (): Promise<void> => {
  if (onTransactionCommitted) {
    await onTransactionCommitted();
  }
};

export const ensureStoreHydrated = async (): Promise<void> => {
  if (isStoreHydrated) return;
  if (hydrationPromise) return hydrationPromise;

  hydrationPromise = (async () => {
    // Part B Repair: Authoritative migration check before loading local data
    await runCleanBootMigrationIfNeeded();
    
    await initDbIfNeeded();
    await migrateLegacyQrTokenIdentities();

    const storage = getLocalStorage();
    const isResetPending = storage?.getItem('sys_operational_reset') === 'true';

    if (isResetPending) {
      // Execute one-time requested operational reset
      ordersMap.clear();
      itemsMap.clear();
      customersMap.clear();
      daysMap.clear();
      commandsMap.clear();
      ledgerList.length = 0;
      paymentsMap.clear();
      allocationsList.length = 0;
      goalsMap.clear();
      goalRequestsMap.clear();
      await localDb.clearOperationalTables({ clearOutbox: true, clearSyncState: true });
      await localDb.setInitialHydrationCompleted(false);

      // Immediately clear flag so it never poisons future boots
      storage?.removeItem('sys_operational_reset');
      storage?.setItem('sys_db_version', CURRENT_MIGRATION_VERSION);
    }

    const [
      persistedCustomers,
      persistedDevices,
      persistedDays,
      persistedOrders,
      persistedItems,
      persistedLedger,
      persistedPayments,
      persistedAllocations,
      persistedReservations,
      persistedQrTokens,
      persistedGoals,
      persistedGoalRequests,
      persistedOutbox,
    ] = await Promise.all([
      localDb.list<CustomerEntity>('customers'),
      localDb.list<DeviceTypeEntity>('deviceTypes'),
      localDb.list<BusinessDayEntity>('businessDays'),
      localDb.list<OrderEntity>('orders'),
      localDb.list<OrderItemEntity>('orderItems'),
      localDb.list<FinancialLedgerEntity>('financialLedger'),
      localDb.list<PaymentEntity>('payments'),
      localDb.list<PaymentAllocationEntity>('paymentAllocations'),
      localDb.list<OrderNumberReservationEntity>('orderNumberReservations'),
      localDb.list<any>('qr_tokens'),
      localDb.list<GoalEntity>('goals'),
      localDb.list<GoalRequestEntity>('goalRequests'),
      localDb.listOutbox(),
    ]);

    // Rehydrate command identity state from the durable outbox. Without this,
    // retries after a memory reset bypass local idempotency/conflict checks.
    commandsMap.clear();
    persistedOutbox.forEach((command) => {
      commandsMap.set(command.commandId, { type: command.commandType, payload: command.payload });
    });

    reservationsMap.clear();
    persistedReservations.forEach((r) => {
      reservationsMap.set(r.id, r);
    });
    goalsMap.clear();
    persistedGoals.forEach((g) => goalsMap.set(g.id, g));
    goalRequestsMap.clear();
    persistedGoalRequests.forEach((g) => goalRequestsMap.set(g.id, g));

    // 1. Customers Hydration (always read persisted data and auto-heal active status)
    customersMap.clear();
    persistedCustomers.forEach((c) => {
      const isRawActive = c.isActive ?? (c as any).is_active ?? true;
      // Auto-heal customers if deletedAt is absent (so glitch from past backup import is cured instantly)
      const healedActive = c.deletedAt ? false : Boolean(isRawActive);

      const normCustomer: CustomerEntity = {
        ...c,
        id: c.id,
        name: c.name,
        phone: c.phone || (c as any).phone_number || (c as any).phoneNumber || '',
        isActive: healedActive,
        notes: c.notes || '',
        debtLimitMinor:
          c.debtLimitMinor ??
          (c as any).debt_limit_minor ??
          (c as any).balanceMinor ??
          (c as any).balance_minor ??
          0,
        chargerFeeExempt: Boolean(c.chargerFeeExempt ?? (c as any).charger_fee_exempt ?? false),
        createdAt: c.createdAt || (c as any).created_at || new Date().toISOString(),
        updatedAt: c.updatedAt || (c as any).updated_at || new Date().toISOString(),
        version: c.version || 1,
      };

      customersMap.set(normCustomer.id, normCustomer);
      // Healed customer state is synced back to IndexedDB so future reads are clean
      if (normCustomer.isActive !== c.isActive) {
        localDb.set('customers', normCustomer.id, normCustomer).catch(() => {});
      }
    });

    // 2. Devices Hydration
    devicesMap.clear();
    const deletedMarkers = await localDb.listIntentionalDeviceTypeDeletions();
    const deletedSet = new Set(deletedMarkers.map((m) => m.id));

    if (persistedDevices.length > 0) {
      persistedDevices.forEach((d) => {
        if (!deletedSet.has(d.id)) {
          const isDevActive = d.isActive ?? (d as any).is_active ?? true;
          devicesMap.set(d.id, {
            ...d,
            nameAr: d.nameAr || (d as any).name_ar || d.name,
            nameEn: d.nameEn || (d as any).name_en || d.name,
            isActive: Boolean(isDevActive),
            chargerFeeEnabled: Boolean(d.chargerFeeEnabled ?? (d as any).charger_fee_enabled ?? true),
            basePriceMinor:
              d.basePriceMinor ??
              (d as any).base_price_minor ??
              (d as any).defaultPriceMinor ??
              (d as any).default_price_minor ??
              (d as any).servicePriceMinor ??
              (d as any).service_price_minor ??
              0,
          });
        }
      });
    }

    // 3. Days Hydration (always read persisted data)
    daysMap.clear();
    persistedDays.forEach((d) => {
      const resolvedDate =
        d.businessDate ||
        (d as any).business_date ||
        (d as any).date ||
        (d.id?.startsWith('day-') ? d.id.slice(4) : d.id) ||
        getLocalBusinessDateStr();
      daysMap.set(d.id, {
        ...d,
        businessDate: resolvedDate,
        isClosed: d.isClosed ?? (d as any).is_closed ?? false,
      });
    });

    // 4. Orders Hydration (always read persisted data)
    ordersMap.clear();
    persistedOrders.forEach((o) => {
      const explicitNum =
        o.displayNumber ??
        (o as any).display_number;

      ordersMap.set(o.id, {
        ...o,
        dayId: o.dayId || (o as any).day_id,
        customerId: o.customerId || (o as any).customer_id,
        // Missing/invalid numbers remain explicitly invalid (0); hydration must never invent or resequence them.
        displayNumber: typeof explicitNum === 'number' && Number.isInteger(explicitNum) && explicitNum > 0 ? explicitNum : 0,
        status: o.status ?? (o as any).status ?? (o as any).order_status ?? 'pending',
        customerBalanceSnapshotMinor:
          o.customerBalanceSnapshotMinor ??
          (o as any).customer_balance_snapshot_minor ??
          0,
      });
    });

    // Never mutate order numbers during hydration. Existing conflicts are diagnostic state,
    // not permission to rewrite identifiers shown on printed cards or QR views.

    // 5. Items Hydration (always read persisted data)
    itemsMap.clear();
    persistedItems.forEach((i) => {
      const unitPrice =
        i.unitPriceMinor ??
        (i as any).unit_price_minor ??
        (i as any).servicePriceMinor ??
        (i as any).service_price_minor ??
        i.basePriceSnapshotMinor ??
        (i as any).base_price_snapshot_minor ??
        0;
      const totalPrice =
        i.totalPriceMinor ??
        (i as any).total_price_minor ??
        unitPrice;

      const itemStatusVal = i.status ?? (i as any).status ?? (i as any).item_status ?? 'charging';
      const rawStatus: string = String(itemStatusVal);
      const normalizedStatus: ItemStatus =
        rawStatus === 'delivered' || rawStatus === 'cancelled' || rawStatus === 'charging' || rawStatus === 'pending'
          ? (rawStatus as ItemStatus)
          : 'charging';

      const finStatus: ItemFinancialStatus =
        i.financialStatus ||
        (i as any).financial_status ||
        (normalizedStatus === 'delivered' ? 'RECOGNIZED' : 'UNRECOGNIZED');

      const payStatus: ItemPaymentStatus =
        i.paymentStatus ||
        (i as any).payment_status ||
        'UNPAID';

      const itemEntity: OrderItemEntity = {
        ...i,
        id: i.id,
        orderId: i.orderId || (i as any).order_id,
        deviceTypeId: i.deviceTypeId || (i as any).device_type_id,
        itemSequence: i.itemSequence ?? (i as any).item_sequence ?? 1,
        unitPriceMinor: unitPrice,
        totalPriceMinor: totalPrice,
        status: normalizedStatus,
        financialStatus: finStatus,
        paymentStatus: payStatus,
        deviceNameSnapshot: i.deviceNameSnapshot || (i as any).device_name_snapshot || '',
        deviceIconSnapshot: i.deviceIconSnapshot || (i as any).device_icon_snapshot || 'smartphone',
        basePriceSnapshotMinor: i.basePriceSnapshotMinor ?? (i as any).base_price_snapshot_minor ?? unitPrice,
        chargerFeeEnabledSnapshot: Boolean(i.chargerFeeEnabledSnapshot ?? (i as any).charger_fee_enabled_snapshot ?? false),
        customerChargerFeeExemptSnapshot: Boolean(i.customerChargerFeeExemptSnapshot ?? (i as any).customer_charger_fee_exempt_snapshot ?? false),
        chargerFeeSnapshotMinor: i.chargerFeeSnapshotMinor ?? (i as any).charger_fee_snapshot_minor ?? 0,
        hasCharger: Boolean(i.hasCharger ?? (i as any).has_charger ?? false),
        replacementOfItemId: i.replacementOfItemId || (i as any).replacement_of_item_id || undefined,
        deliveredAt: i.deliveredAt || (i as any).delivered_at || undefined,
        financiallyRecognizedAt: i.financiallyRecognizedAt || (i as any).financially_recognized_at || undefined,
        deletedAt: i.deletedAt || (i as any).deleted_at || undefined,
        createdAt: i.createdAt || (i as any).created_at || new Date().toISOString(),
        updatedAt: i.updatedAt || (i as any).updated_at || new Date().toISOString(),
        version: i.version || 1,
      };

      itemsMap.set(itemEntity.id, itemEntity);
    });

    // 6. Financial Ledger Hydration (always read persisted data)
    ledgerList.length = 0;
    persistedLedger.forEach((l) => {
      ledgerList.push({
        ...l,
        eventType:
          l.eventType ||
          (l as any).event_type ||
          (l as any).entryType ||
          (l as any).entry_type ||
          'ORDER_ITEM_CHARGE',
        amountMinor: l.amountMinor ?? (l as any).amount_minor ?? 0,
        referenceId: l.referenceId || (l as any).reference_id,
        customerId: l.customerId || (l as any).customer_id,
      });
    });

    // 7. Payments & Allocations Hydration (always read persisted data)
    paymentsMap.clear();
    persistedPayments.forEach((p) => {
      paymentsMap.set(p.id, {
        ...p,
        customerId: p.customerId || (p as any).customer_id,
        amountMinor: p.amountMinor ?? (p as any).amount_minor ?? 0,
        paymentMethod: p.paymentMethod || (p as any).payment_method || 'CASH',
      });
    });

    allocationsList.length = 0;
    persistedAllocations.forEach((a) => {
      allocationsList.push({
        ...a,
        paymentId: a.paymentId || (a as any).payment_id,
        orderId: a.orderId || (a as any).order_id,
        allocatedAmountMinor: a.allocatedAmountMinor ?? (a as any).allocated_amount_minor ?? 0,
      });
    });

    // Initial bootstrap for fresh / empty local database ONLY
    // Respects intentional local reset marker to prevent old server data from reappearing
    if (getSupabaseStatus().isConfigured) {
      const isResetCompleted = await localDb.isLocalResetCompleted();
      const isInitialHydrationDone = await localDb.isInitialHydrationCompleted();

      if (!isResetCompleted && !isInitialHydrationDone) {
        // Initial bootstrap is required for a truly empty client. If the remote
        // read fails before local replacement, an existing persisted cache may
        // still be used offline; a fresh client must not enter with an empty model.
        const hasLocalOperationalData = [
          persistedCustomers, persistedDevices, persistedDays, persistedOrders,
          persistedItems, persistedLedger, persistedPayments, persistedAllocations,
          persistedReservations, persistedQrTokens, persistedGoals, persistedGoalRequests,
        ].some((records) => records.length > 0);
        const priorSyncState = await localDb.getSyncState('global');
        const hasTrustedLocalCheckpoint = Boolean(
          priorSyncState &&
          Number.isSafeInteger(priorSyncState.resetGeneration) &&
          (priorSyncState.resetGeneration as number) >= 0 &&
          (priorSyncState.status === 'READY' || priorSyncState.status === 'STALE') &&
          priorSyncState.reconciliationRequired !== true
        );
        const pendingLocalCommands = (await localDb.listOutbox()).filter((item) =>
          ['pending', 'PENDING_RECONCILIATION', 'READY', 'syncing', 'accepted', 'blocked', 'conflict'].includes(item.status)
        );

        if (hasLocalOperationalData && hasTrustedLocalCheckpoint) {
          // This is an existing, checkpointed local replica. Do not replace it
          // with a full snapshot: catch it up incrementally and preserve local
          // optimistic state/outbox semantics.
          await localDb.setInitialHydrationCompleted(true);
        } else {
          // Only an interrupted bootstrap (durable INITIALIZING marker) may
          // replace existing uncheckpointed rows automatically. Any other local
          // dataset could contain legacy/offline-only data; fail closed instead
          // of guessing that the cloud copy is safe to overwrite it with.
          if (hasLocalOperationalData && priorSyncState?.status !== 'INITIALIZING') {
            throw new Error('LOCAL_RECONCILIATION_REQUIRED: existing local records have no trusted checkpoint; refusing automatic replacement to protect data.');
          }
          if (hasLocalOperationalData && pendingLocalCommands.length > 0) {
            throw new Error('LOCAL_RECONCILIATION_REQUIRED: interrupted bootstrap has pending local commands; refusing automatic replacement to protect them.');
          }
          const bootstrapped = await hydrateFromRemoteTables();
          if (!bootstrapped) {
            throw new Error('INITIAL_BOOTSTRAP_FAILED: cloud snapshot unavailable; local data was not declared ready. Retry when connected.');
          }
        }
      }
      if (!isResetCompleted) {
        // Populated client: background delta sync only (never full-table refresh) via SyncBridge
        if (onTransactionCommitted) {
          onTransactionCommitted();
        }
      }
    }

    isStoreHydrated = true;
  })().catch((error) => {
    // A failed boot must be retryable; never cache a rejected hydration promise
    // or mark the in-memory store ready after a partial bootstrap.
    isStoreHydrated = false;
    hydrationPromise = null;
    throw error;
  });

  return hydrationPromise;
};

// Wire Reconnect & Visibility Synchronization Coordinator (Uses central SyncBridge coordinator)
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (onTransactionCommitted) {
      onTransactionCommitted();
    }
  });
  // Visibility refresh is pull-only and coordinated by App.tsx. Do not start a full
  // push+pull synchronization cycle merely because the user returns to this tab.
}

// Helper utilities for day ID canonicalization and order numbering
export const getCanonicalDayKey = (dayId: string): string => {
  if (!dayId) return 'unknown';
  const day =
    daysMap.get(dayId) ||
    Array.from(daysMap.values()).find(
      (d) =>
        d.id === dayId ||
        d.businessDate === (dayId.startsWith('day-') ? dayId.slice(4) : dayId)
    );
  if (day && day.businessDate) return day.businessDate;
  return dayId.startsWith('day-') ? dayId.slice(4) : dayId;
};

export const isSameDayId = (id1?: string, id2?: string): boolean => {
  if (!id1 || !id2) return false;
  if (id1 === id2) return true;
  return getCanonicalDayKey(id1) === getCanonicalDayKey(id2);
};

const hasPendingOrderChangesForDay = (dayId: string): boolean => {
  for (const overlay of localDb.listOverlaysSync()) {
    if (overlay.status !== 'PENDING' || overlay.entityType !== 'orders') continue;
    const patch = (overlay.patch || overlay.entityPayload || {}) as Partial<OrderEntity>;
    const baseOrder = ordersMap.get(overlay.entityId);
    const effectiveDayId = patch.dayId ?? baseOrder?.dayId;
    if (effectiveDayId && isSameDayId(effectiveDayId, dayId)) return true;
  }
  return false;
};

/**
 * Compatibility name retained for older callers. This is deliberately read-only:
 * number conflicts must be repaired only through the authorized Settings workflow.
 */
export const sanitizeAndResequenceOrderNumbers = async (): Promise<void> => {
  // No mutation by design. Use getOrderNumberingDiagnostics() to inspect conflicts.
};

export interface OrderNumberingDiagnostic {
  dayKey: string;
  dayId: string;
  orderId: string;
  displayNumber: number;
  issue: 'MISSING_OR_INVALID' | 'DUPLICATE';
}

/** Read-only diagnostics; never rewrites numbers and can be called on every view load. */
export const analyzeOrderNumbering = (orders: OrderEntity[]): OrderNumberingDiagnostic[] => {
  const seenByDay = new Map<string, Map<number, OrderEntity[]>>();
  const diagnostics: OrderNumberingDiagnostic[] = [];
  for (const order of orders) {
    const dayKey = getCanonicalDayKey(order.dayId);
    if (!Number.isInteger(order.displayNumber) || order.displayNumber <= 0) {
      diagnostics.push({
        dayKey,
        dayId: order.dayId,
        orderId: order.id,
        displayNumber: order.displayNumber,
        issue: 'MISSING_OR_INVALID',
      });
      continue;
    }
    let numbers = seenByDay.get(dayKey);
    if (!numbers) {
      numbers = new Map<number, OrderEntity[]>();
      seenByDay.set(dayKey, numbers);
    }
    const sameNumber = numbers.get(order.displayNumber) ?? [];
    sameNumber.push(order);
    numbers.set(order.displayNumber, sameNumber);
  }
  for (const [dayKey, numbers] of seenByDay) {
    for (const [displayNumber, sameNumber] of numbers) {
      if (sameNumber.length < 2) continue;
      for (const order of sameNumber) {
        diagnostics.push({
          dayKey,
          dayId: order.dayId,
          orderId: order.id,
          displayNumber,
          issue: 'DUPLICATE',
        });
      }
    }
  }
  return diagnostics.sort((a, b) =>
    a.dayKey.localeCompare(b.dayKey) ||
    a.displayNumber - b.displayNumber ||
    a.orderId.localeCompare(b.orderId)
  );
};

export const getOrderNumberingDiagnostics = (): OrderNumberingDiagnostic[] =>
  analyzeOrderNumbering(Array.from(ordersMap.values()));

function getCurrentSyncGeneration(): number {
  const syncState = localDb.getSyncStateSync('global');
  if (
    !syncState ||
    syncState.status === 'RECONCILIATION_REQUIRED' ||
    syncState.reconciliationRequired ||
    syncState.resetGeneration === undefined ||
    syncState.resetGeneration < 0
  ) {
    return -1;
  }
  return syncState.resetGeneration;
}

// Phase 5 TransactionalRepositoryContext Implementation
function createTransactionalRepoContext(
  tx: IDBTransaction,
  postCommitActions: (() => void)[]
): any {
  return {
    overlayRepo: {
      saveWithTx: (overlay: OptimisticOverlayRecord) => {
        localDb.saveOverlayWithTx(tx, overlay);
      },
      hasPendingOrderChangesForDaySync: (dayId: string) => hasPendingOrderChangesForDay(dayId),
      hasPendingRenumberForDaySync: (dayId: string) => {
        const renumberCommands = localDb.listOutboxSync().filter((item) => {
          const payload = (item.payload || {}) as Record<string, unknown>;
          return item.commandType === 'RENUMBER_DAY_ORDERS' && (payload.dayId === dayId || payload.id === dayId);
        });
        if (renumberCommands.some((item) => ['pending', 'syncing', 'blocked', 'PENDING_RECONCILIATION'].includes(String(item.status)))) return true;
        const hasWatermark = Array.from(reservationsMap.values()).some((reservation) =>
          reservation.businessDayId === dayId && reservation.deviceId === '__renumber_watermark__'
        );
        if (!hasWatermark) return false;
        const numbers = Array.from(getEffectiveOrderItemReadModel().orders.values())
          .filter((order) => isSameDayId(order.dayId, dayId))
          .map((order) => Number(order.displayNumber) || 0)
          .sort((a, b) => a - b);
        return numbers.some((number, index) => number !== index + 1);
      },
    },
    orderRepo: {
      findById: (id: string) => ordersMap.get(id) || null,
      save: (o: OrderEntity) => {
        ordersMap.set(o.id, o);
        localDb.setWithTx(tx, 'orders', o.id, o);
        postCommitActions.push(() => notifyStore('orders', o.id));
      },
      countForDay: (dayId: string) => {
        let maxNum = 0;
        getEffectiveOrderItemReadModel().orders.forEach((o) => {
          if (isSameDayId(o.dayId, dayId)) maxNum = Math.max(maxNum, Number(o.displayNumber) || 0);
        });
        return maxNum;
      },
      maxInternalSequence: () => {
        let maxSequence = 0;
        getEffectiveOrderItemReadModel().orders.forEach((order) => {
          maxSequence = Math.max(maxSequence, Number(order.internalSequence) || 0);
        });
        return maxSequence;
      },
      // A true row list is required for day-wide repairs. countForDay intentionally
      // returns the current maximum number for sequential allocation, not row count.
      findByDay: (dayId: string) => Array.from(getEffectiveOrderItemReadModel().orders.values()).filter((o) => isSameDayId(o.dayId, dayId)),
    },
    itemRepo: {
      findByOrderId: (orderId: string) => {
        const effective = new Map<string, OrderItemEntity>();
        itemsMap.forEach((it) => {
          if (it.orderId === orderId) effective.set(it.id, it);
        });

        // Repository reads must include the same pending projections used by
        // the UI; otherwise sequential offline adds can reuse itemSequence.
        for (const overlay of localDb.listOverlaysSync()) {
          if (overlay.status !== 'PENDING' || overlay.entityType !== 'order_items') continue;
          const patch = (overlay.patch || overlay.entityPayload || {}) as Partial<OrderItemEntity>;
          const base = effective.get(overlay.entityId);
          const candidate = {
            ...(base || {}),
            ...(overlay.operation === 'CREATE' ? patch : patch),
            id: overlay.entityId,
          } as OrderItemEntity;
          if (candidate.orderId !== orderId) continue;
          if (overlay.operation === 'DELETE') {
            effective.delete(overlay.entityId);
          } else {
            effective.set(overlay.entityId, candidate);
          }
        }

        return Array.from(effective.values());
      },
      save: (it: OrderItemEntity) => {
        itemsMap.set(it.id, it);
        localDb.setWithTx(tx, 'orderItems', it.id, it);
        postCommitActions.push(() => notifyStore('orderItems', it.id));
      },
      findById: (id: string) => {
        // Delivery must be able to read an item that was just added locally
        // and still exists only as a pending CREATE overlay. Otherwise
        // deliverOrderItem() cannot create the DELIVER_ORDER_ITEM command,
        // so the newly added device never reaches authoritative financial
        // recognition.
        let effective = itemsMap.get(id) || null;

        const overlays = localDb.listOverlaysSync()
          .filter((overlay) =>
            overlay.status === 'PENDING' &&
            overlay.entityType === 'order_items' &&
            overlay.entityId === id
          )
          .sort((a, b) => {
            if (a.sequence !== b.sequence) return a.sequence - b.sequence;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          });

        for (const overlay of overlays) {
          if (overlay.operation === 'DELETE') {
            effective = null;
            continue;
          }

          const patch = (overlay.patch || overlay.entityPayload || {}) as Partial<OrderItemEntity>;
          if (overlay.operation === 'CREATE') {
            effective = { ...patch, id } as OrderItemEntity;
          } else {
            effective = effective
              ? ({ ...effective, ...patch, id } as OrderItemEntity)
              : ({ ...patch, id } as OrderItemEntity);
          }
        }

        return effective;
      },
      isDeviceTypeInUse: (deviceTypeId: string) => {
        for (const it of itemsMap.values()) {
          if (it.deviceTypeId === deviceTypeId) return true;
        }
        return false;
      },
    },
    customerRepo: {
      findById: (id: string) => customersMap.get(id) || null,
      save: (c: CustomerEntity) => {
        customersMap.set(c.id, c);
        localDb.setWithTx(tx, 'customers', c.id, c);
        postCommitActions.push(() => notifyStore('customers', c.id));
      },
      getBalance: (id: string) => {
        let bal = 0;
        ledgerList.forEach((l) => {
          if (l.customerId === id) bal += l.amountMinor;
        });
        return bal;
      },
    },
    deviceRepo: {
      findById: (id: string) => devicesMap.get(id) || null,
      save: (d: DeviceTypeEntity) => {
        devicesMap.set(d.id, d);
        localDb.setWithTx(tx, 'deviceTypes', d.id, d);
        postCommitActions.push(() => notifyStore('deviceTypes', d.id));
      },
      delete: (id: string) => {
        devicesMap.delete(id);
        localDb.removeWithTx(tx, 'deviceTypes', id);
        localDb.recordIntentionalDeviceTypeDeletionWithTx(tx, id);
        postCommitActions.push(() => notifyStore('deviceTypes', id));
      },
      findAll: () => Array.from(devicesMap.values()),
    },
    ledgerRepo: {
      append: (record: FinancialLedgerEntity) => {
        const finalRecord: FinancialLedgerEntity = {
          ...record,
          createdAt: record.createdAt || new Date().toISOString(),
        };
        ledgerList.push(finalRecord);
        localDb.setWithTx(tx, 'financialLedger', finalRecord.id, finalRecord);
        postCommitActions.push(() => notifyStore('financialLedger', finalRecord.id));
      },
      findByCustomer: (customerId: string) => ledgerList.filter((l) => l.customerId === customerId),
      findAll: () => [...ledgerList],
    },
    dayRepo: {
      findById: (id: string) => daysMap.get(id) || null,
      save: (d: BusinessDayEntity) => {
        daysMap.set(d.id, d);
        localDb.setWithTx(tx, 'businessDays', d.id, d);
        postCommitActions.push(() => notifyStore('businessDays', d.id));
      },
      isClosed: (dayId: string) => {
        const d = daysMap.get(dayId);
        return d ? d.isClosed : false;
      },
    },
    paymentRepo: {
      save: (p: PaymentEntity) => {
        paymentsMap.set(p.id, p);
        localDb.setWithTx(tx, 'payments', p.id, p);
        postCommitActions.push(() => notifyStore('payments', p.id));
      },
      saveAllocation: (a: PaymentAllocationEntity) => {
        allocationsList.push(a);
        localDb.setWithTx(tx, 'paymentAllocations', a.id, a);
        postCommitActions.push(() => notifyStore('paymentAllocations', a.id));
      },
      findByCustomer: (customerId: string) => Array.from(paymentsMap.values()).filter((p) => p.customerId === customerId),
      findAllAllocations: () => [...allocationsList],
    },
    mutationSnapshotRepo: {
      capture: (commandId: string, records: Array<{ table: string; id: string; existed: boolean; data?: unknown }>) => {
        localDb.saveMutationSnapshotWithTx(tx, {
          commandId,
          createdAt: new Date().toISOString(),
          records: records.map((record) => ({ ...record, data: record.existed ? cloneForTransactionRollback(record.data) : undefined })),
        });
      },
      clear: (commandId: string) => {
        localDb.deleteMutationSnapshotWithTx(tx, commandId);
      },
    },
    commandRepo: {
      get: (cmdId: string) => commandsMap.get(cmdId) || null,
      record: (cmdId: string, type: string, payload: any, expectedVersion?: number) => {
        const existingCommand = commandsMap.get(cmdId);
        if (existingCommand) {
          const sameType = existingCommand.type === type;
          const samePayload = JSON.stringify(existingCommand.payload) === JSON.stringify(payload);
          if (!sameType || !samePayload) {
            throw new ConflictError('Command id is already associated with a different operation');
          }
          // Idempotent local retry: do not create a second outbox record.
          return;
        }

        const { actorAdminId, deviceId } = getAuthenticatedIdentity();
        const currentGen = getCurrentSyncGeneration();
        const payloadRecord = (payload && typeof payload === 'object') ? (payload as any) : {};
        const aggregateId =
          payloadRecord.aggregateId ||
          ((type === 'ADD_ORDER_ITEM' || type === 'UPDATE_ORDER_ITEM' || type === 'DELIVER_ORDER_ITEM' || type === 'CANCEL_ORDER_ITEM')
            ? payloadRecord.orderId
            : type === 'PAYMENT' || type === 'POST_PAYMENT' || type === 'CREATE_PAYMENT' || type === 'CREATE_CUSTOMER_CREDIT' || type === 'CONSUME_CUSTOMER_CREDIT' || type === 'CREATE_REFUND'
              ? payloadRecord.customerId
              : payloadRecord.entityId || payloadRecord.deviceTypeId || payloadRecord.orderId || payloadRecord.customerId || payloadRecord.dayId || payloadRecord.id || cmdId);

        const record: OutboxRecord = {
          commandId: cmdId,
          commandType: type,
          aggregateType:
            type === 'CREATE_ORDER' || type === 'UPDATE_ORDER' || type === 'CANCEL_ORDER' || type === 'RENUMBER_DAY_ORDERS'
              ? 'orders'
              : type === 'ADD_ORDER_ITEM' || type === 'UPDATE_ORDER_ITEM' || type === 'DELIVER_ORDER_ITEM' || type === 'CANCEL_ORDER_ITEM'
              ? 'order_items'
              : type === 'OPEN_DAY' || type === 'CLOSE_DAY'
              ? 'business_days'
              : type === 'CREATE_CUSTOMER' || type === 'UPDATE_CUSTOMER'
              ? 'customers'
              : type === 'CREATE_DEVICE_TYPE' || type === 'UPDATE_DEVICE_TYPE' || type === 'DELETE_DEVICE_TYPE'
              ? 'device_types'
              : type === 'CREATE_GOAL' || type === 'UPDATE_GOAL_CONFIG' || type === 'UPDATE_GOAL_PROGRESS'
              ? 'goals'
              : type === 'RECORD_GOAL_REQUEST' || type === 'APPROVE_GOAL_REQUEST' || type === 'REJECT_GOAL_REQUEST'
              ? 'goal_requests'
              : type === 'CREATE_CUSTOMER_CREDIT' || type === 'CONSUME_CUSTOMER_CREDIT' || type === 'CREATE_REFUND'
              ? 'financial_ledger'
              : 'COMMAND',
          aggregateId,
          mutationKey:
            type === 'RENUMBER_DAY_ORDERS'
              ? `renumber-day:${payloadRecord.dayId || aggregateId}`
              : type === 'ADD_ORDER_ITEM' || type === 'UPDATE_ORDER_ITEM' || type === 'DELIVER_ORDER_ITEM' || type === 'CANCEL_ORDER_ITEM' || type === 'CANCEL_ORDER' || type === 'UPDATE_ORDER'
                ? `order:${payloadRecord.orderId || aggregateId}`
                : type === 'CREATE_PAYMENT' || type === 'POST_PAYMENT' || type === 'PAYMENT' || type === 'CREATE_CUSTOMER_CREDIT' || type === 'CONSUME_CUSTOMER_CREDIT' || type === 'CREATE_REFUND'
                  ? `customer:${payloadRecord.customerId || aggregateId}`
                  : type.includes('DEVICE_TYPE') ? `deviceType:${payloadRecord.deviceTypeId || aggregateId}` : undefined,
          payload: { ...(payload || {}), resetGeneration: currentGen },
          expectedVersion,
          createdAt: localDb.getNextOutboxTimestamp(),
          deviceId,
          actorAdminId,
          status: currentGen === -1 ? 'PENDING_RECONCILIATION' : 'pending',
          retryCount: 0,
          groupId: (payload as any)?.groupId,
          dependencyCommandId: payloadRecord.dependencyCommandId,
          dependencyCommandIds: Array.isArray(payloadRecord.dependencyCommandIds) ? payloadRecord.dependencyCommandIds : undefined,
          dependencies: Array.isArray(payloadRecord.dependencies) ? payloadRecord.dependencies : undefined,
          resetGeneration: currentGen,
        };
        localDb.saveOutboxWithTx(tx, record);
        // Keep the command identity cache in the same transaction boundary.
        // It is used by idempotency checks before another optimistic overlay is created.
        commandsMap.set(cmdId, { type, payload: record.payload });
        postCommitActions.push(() => {
          syncEventEmitter.emit({
            type: 'command_status_changed',
            commandId: cmdId,
            groupId: record.groupId,
            newState: currentGen === -1 ? 'PENDING_RECONCILIATION' : 'PENDING',
            timestamp: new Date().toISOString(),
          });

          // Overlay-backed local mutations are the effective read model while
          // pending. Notify mounted pages only after the transaction commits.
          const notificationScopes = getCommandNotificationScopes(type);
          for (const scope of notificationScopes) {
            notifyStore(scope, aggregateId);
          }
        });
      },
    },
    goalRepo: {
      findById: (id: string) => goalsMap.get(id) || null,
      findActiveByCustomerId: (customerId: string) => {
        for (const goal of goalsMap.values()) {
          if (goal.customerId === customerId && goal.status === 'ACTIVE') return goal;
        }
        return null;
      },
      findAllByCustomerId: (customerId: string) => Array.from(goalsMap.values()).filter(g => g.customerId === customerId),
      save: (goal: GoalEntity) => {
        goalsMap.set(goal.id, goal);
        localDb.setWithTx(tx, 'goals', goal.id, goal);
        postCommitActions.push(() => notifyStore('goals', goal.id));
      },
    },
    goalRequestRepo: {
      findById: (id: string) => goalRequestsMap.get(id) || null,
      findAllByCustomerId: (customerId: string) => Array.from(goalRequestsMap.values()).filter(r => r.customerId === customerId),
      save: (request: GoalRequestEntity) => {
        goalRequestsMap.set(request.id, request);
        localDb.setWithTx(tx, 'goalRequests', request.id, request);
        postCommitActions.push(() => notifyStore('goalRequests', request.id));
      },
    },
  reservationRepo: {
      findActiveByDayAndDevice: (dayId: string, deviceId: string) => {
        let found: OrderNumberReservationEntity | null = null;
        reservationsMap.forEach(r => {
          if (r.businessDayId === dayId && r.deviceId === deviceId && r.status === 'ACTIVE' && r.nextNumber <= r.endNumber) {
            found = r;
          }
        });
        return found;
      },
      save: (r: OrderNumberReservationEntity) => {
        reservationsMap.set(r.id, r);
        localDb.setWithTx(tx, 'orderNumberReservations', r.id, r);
        postCommitActions.push(() => notifyStore('orderNumberReservations', r.id));
      },
      getLastAssignedNumberForDay: (dayId: string) => {
        let highWater = 0;
        reservationsMap.forEach((reservation) => {
          if (reservation.businessDayId !== dayId) return;
          // An ACTIVE range has not consumed numbers at or beyond its cursor.
          // EXHAUSTED sequence/watermark rows retain their last actually issued number.
          const consumedThrough = reservation.status === 'ACTIVE' && reservation.nextNumber <= reservation.endNumber
            ? Math.max(0, Number(reservation.nextNumber) - 1)
            : Number(reservation.endNumber) || 0;
          highWater = Math.max(highWater, consumedThrough);
        });
        return highWater;
      },
      saveLastAssignedNumberForDay: (dayId: string, assignedNumber: number) => {
        const now = new Date().toISOString();
        let sequence = Array.from(reservationsMap.values()).find((reservation) =>
          reservation.businessDayId === dayId && reservation.deviceId === '__order_number_sequence__'
        );
        if (sequence) {
          sequence = {
            ...sequence,
            startNumber: 1,
            endNumber: Math.max(Number(sequence.endNumber) || 0, assignedNumber),
            nextNumber: Math.max(Number(sequence.endNumber) || 0, assignedNumber) + 1,
            status: 'EXHAUSTED',
            updatedAt: now,
            version: (sequence.version || 0) + 1,
          };
        } else {
          sequence = {
            id: crypto.randomUUID(),
            businessDayId: dayId,
            deviceId: '__order_number_sequence__',
            startNumber: 1,
            endNumber: assignedNumber,
            nextNumber: assignedNumber + 1,
            status: 'EXHAUSTED',
            commandId: `order-number-sequence:${dayId}`,
            createdAt: now,
            updatedAt: now,
            version: 1,
          };
        }
        reservationsMap.set(sequence.id, sequence);
        localDb.setWithTx(tx, 'orderNumberReservations', sequence.id, sequence);
        postCommitActions.push(() => notifyStore('orderNumberReservations', sequence!.id));
      },
      resetForDay: (dayId: string, nextNumber: number) => {
        const now = new Date().toISOString();
        // A successful explicit renumber invalidates all prior ranges. Do not
        // carry their obsolete high-water values into the new contiguous numbering.
        const highWater = Math.max(0, nextNumber - 1);
        const nextHighWaterNumber = highWater + 1;
        let watermarkFound = false;
        reservationsMap.forEach((reservation) => {
          if (reservation.businessDayId !== dayId) return;
          const isWatermark = reservation.deviceId === '__renumber_watermark__';
          const reset: OrderNumberReservationEntity = {
            ...reservation,
            deviceId: isWatermark ? '__renumber_watermark__' : reservation.deviceId,
            startNumber: reservation.startNumber || 1,
            endNumber: highWater,
            nextNumber: nextHighWaterNumber,
            status: 'EXHAUSTED',
            updatedAt: now,
            version: (reservation.version || 0) + 1,
          };
          if (isWatermark) watermarkFound = true;
          reservationsMap.set(reset.id, reset);
          localDb.setWithTx(tx, 'orderNumberReservations', reset.id, reset);
          postCommitActions.push(() => notifyStore('orderNumberReservations', reset.id));
        });
        // The watermark must preserve the highest number ever issued. Renumbering
        // visible rows never lowers this counter or makes an old number reusable.
        if (!watermarkFound) {
          const watermark: OrderNumberReservationEntity = {
            id: crypto.randomUUID(),
            businessDayId: dayId,
            deviceId: '__renumber_watermark__',
            startNumber: 1,
            endNumber: highWater,
            nextNumber: nextHighWaterNumber,
            status: 'EXHAUSTED',
            commandId: `renumber-watermark:${dayId}:${now}`,
            createdAt: now,
            updatedAt: now,
            version: 1,
          };
          reservationsMap.set(watermark.id, watermark);
          localDb.setWithTx(tx, 'orderNumberReservations', watermark.id, watermark);
          postCommitActions.push(() => notifyStore('orderNumberReservations', watermark.id));
        }
      },
      needsResetForDay: (dayId: string, deviceId: string, expectedNextNumber: number) => {
        const active = Array.from(reservationsMap.values()).find((reservation) =>
          reservation.businessDayId === dayId &&
          reservation.deviceId === deviceId &&
          reservation.status === 'ACTIVE' &&
          reservation.nextNumber <= reservation.endNumber
        );
        if (active) {
          const laterRangeExists = Array.from(reservationsMap.values()).some((reservation) =>
            reservation.businessDayId === dayId &&
            reservation.id !== active.id &&
            reservation.endNumber > active.endNumber
          );
          return active.nextNumber !== expectedNextNumber || laterRangeExists;
        }
        let maxReservedEnd = 0;
        reservationsMap.forEach((reservation) => {
          if (reservation.businessDayId === dayId) maxReservedEnd = Math.max(maxReservedEnd, reservation.endNumber);
        });
        return maxReservedEnd !== expectedNextNumber - 1;
      },
      reserveRange: (dayId: string, deviceId: string, commandId?: string, rangeSize: number = 20) => {
        if (commandId) {
          for (const r of reservationsMap.values()) {
            if (r.commandId === commandId) return r;
          }
        }
        // Preserve all outstanding local reservation ranges. A manual renumber must not
        // reuse numbers already reserved by another local device/context.
        let maxEnd = 0;
        reservationsMap.forEach((r) => {
          if (r.businessDayId === dayId && r.endNumber > maxEnd) maxEnd = r.endNumber;
        });
        getEffectiveOrderItemReadModel().orders.forEach((order) => {
          if (isSameDayId(order.dayId, dayId) && (order.displayNumber || 0) > maxEnd) maxEnd = order.displayNumber;
        });
        const startNumber = maxEnd + 1;
        const endNumber = startNumber + rangeSize - 1;
        const res: OrderNumberReservationEntity = {
          id: crypto.randomUUID(),
          businessDayId: dayId,
          deviceId,
          startNumber,
          endNumber,
          nextNumber: startNumber,
          status: 'ACTIVE',
          commandId: commandId || crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1,
        };
        reservationsMap.set(res.id, res);
        localDb.setWithTx(tx, 'orderNumberReservations', res.id, res);
        postCommitActions.push(() => notifyStore('orderNumberReservations', res.id));
        return res;
      },
    },
  };
}

export const repoContext: RepositoryContext = {
  orderRepo: {
    findById: async (id) => {
      await ensureStoreHydrated();
      let effective = ordersMap.get(id) || null;
      const overlays = localDb.listOverlaysSync()
        .filter((overlay) => overlay.status === 'PENDING' && overlay.entityType === 'orders' && overlay.entityId === id)
        .sort((a, b) => a.sequence !== b.sequence ? a.sequence - b.sequence : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      for (const overlay of overlays) {
        if (overlay.operation === 'DELETE') {
          effective = null;
          continue;
        }
        const patch = (overlay.patch || overlay.entityPayload || {}) as Partial<OrderEntity>;
        effective = overlay.operation === 'CREATE'
          ? ({ ...patch, id } as OrderEntity)
          : effective
            ? ({ ...effective, ...patch, id } as OrderEntity)
            : ({ ...patch, id } as OrderEntity);
      }
      return effective;
    },
    save: async (o) => {
      await ensureStoreHydrated();
      const existed = ordersMap.has(o.id);
      await repoContext.transactionManager.runInTransaction((ctx) => {
        ctx.orderRepo.save(o);
        const commandId = existed ? crypto.randomUUID() : o.id;
        ctx.commandRepo.record(commandId, existed ? 'UPDATE_ORDER' : 'CREATE_ORDER', {
          ...o,
          id: o.id,
          aggregateId: o.id,
        });
      });
    },
    countForDay: async (dayId) => {
      await ensureStoreHydrated();
      let maxNum = 0;
      getEffectiveOrderItemReadModel().orders.forEach((o) => {
        if (isSameDayId(o.dayId, dayId)) maxNum = Math.max(maxNum, Number(o.displayNumber) || 0);
      });
      return maxNum;
    },
    maxInternalSequence: () => {
      let maxSequence = 0;
      getEffectiveOrderItemReadModel().orders.forEach((order) => {
        maxSequence = Math.max(maxSequence, Number(order.internalSequence) || 0);
      });
      return maxSequence;
    },
  },
  itemRepo: {
    findByOrderId: async (orderId) => {
      await ensureStoreHydrated();

      // Return the effective local item set, not only base IndexedDB rows.
      // An item added to an already-delivered order can exist only as a pending
      // CREATE overlay. deliverEntireOrder() and deliverAllOrdersInDay() use this
      // repository method to decide which items to deliver; ignoring overlays
      // makes the new device appear in the UI but silently skips its delivery.
      const effective = new Map<string, OrderItemEntity>();

      itemsMap.forEach((it) => {
        if (it.orderId === orderId) effective.set(it.id, it);
      });

      for (const overlay of localDb.listOverlaysSync()) {
        if (overlay.status !== 'PENDING' || overlay.entityType !== 'order_items') continue;

        const patch = (overlay.patch || overlay.entityPayload || {}) as Partial<OrderItemEntity>;
        const base = effective.get(overlay.entityId);
        const candidate = {
          ...(base || {}),
          ...patch,
          id: overlay.entityId,
        } as OrderItemEntity;

        if (candidate.orderId !== orderId) continue;

        if (overlay.operation === 'DELETE') {
          effective.delete(overlay.entityId);
        } else {
          effective.set(overlay.entityId, candidate);
        }
      }

      return Array.from(effective.values());
    },
    save: async (it) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx) => {
        ctx.itemRepo.save(it);
        ctx.commandRepo.record(it.id, 'ADD_ORDER_ITEM', it);
      });
    },
    findById: async (id) => {
      await ensureStoreHydrated();

      // Use the same effective local read model as the transactional repository.
      // Delivery is executed through this (non-transactional) repoContext, so a
      // newly added item that exists only as a pending CREATE overlay must still
      // be resolvable here. Otherwise deliverOrderItem() exits with "Item not found"
      // and never records the DELIVER_ORDER_ITEM command.
      let effective = itemsMap.get(id) || null;

      const overlays = localDb.listOverlaysSync()
        .filter((overlay) =>
          overlay.status === 'PENDING' &&
          overlay.entityType === 'order_items' &&
          overlay.entityId === id
        )
        .sort((a, b) => {
          if (a.sequence !== b.sequence) return a.sequence - b.sequence;
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });

      for (const overlay of overlays) {
        if (overlay.operation === 'DELETE') {
          effective = null;
          continue;
        }

        const patch = (overlay.patch || overlay.entityPayload || {}) as Partial<OrderItemEntity>;
        if (overlay.operation === 'CREATE') {
          effective = { ...patch, id } as OrderItemEntity;
        } else {
          effective = effective
            ? ({ ...effective, ...patch, id } as OrderItemEntity)
            : ({ ...patch, id } as OrderItemEntity);
        }
      }

      return effective;
    },
    isDeviceTypeInUse: async (deviceTypeId) => {
      await ensureStoreHydrated();
      for (const it of itemsMap.values()) {
        if (it.deviceTypeId === deviceTypeId) return true;
      }
      return false;
    },
  },
  customerRepo: {
    findById: async (id) => {
      await ensureStoreHydrated();
      return customersMap.get(id) || null;
    },
    save: async (c) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx) => {
        ctx.customerRepo.save(c);
        ctx.commandRepo.record(c.id, 'CREATE_CUSTOMER', c);
      });
    },
    getBalance: async (id) => {
      await ensureStoreHydrated();
      let bal = 0;

      // Start from authoritative ledger rows.
      ledgerList.forEach((l) => {
        if (l.customerId === id) bal += l.amountMinor;
      });

      // Then project pending local financial commands until their authoritative
      // ledger rows arrive. This keeps debt-limit checks and customer balances
      // consistent across offline, online, and reconciliation paths.
      const overlays = await localDb.listOverlays();
      const authoritativeChargeItems = new Set(
        ledgerList
          .filter((l) => l.customerId === id && (l.eventType === 'CHARGE' || l.eventType === 'ORDER_ITEM_CHARGE') && l.orderItemId)
          .map((l) => l.orderItemId as string)
      );

      const effectiveItems = new Map<string, OrderItemEntity>(itemsMap);
      for (const overlay of overlays) {
        if (overlay.status !== 'PENDING' || overlay.entityType !== 'order_items') continue;
        const patch = (overlay.patch || overlay.entityPayload || {}) as Partial<OrderItemEntity>;
        const base = effectiveItems.get(overlay.entityId);
        const candidate = {
          ...(base || {}),
          ...patch,
          id: overlay.entityId,
        } as OrderItemEntity;
        if (overlay.operation === 'DELETE') {
          effectiveItems.delete(overlay.entityId);
        } else {
          effectiveItems.set(overlay.entityId, candidate);
        }
      }

      for (const overlay of overlays) {
        if (overlay.status !== 'PENDING') continue;

        if (overlay.entityType === 'ledger' || overlay.entityType === 'financial_ledger') {
          const payload = (overlay.entityPayload || overlay.patch || {}) as any;
          if (payload.customerId === id || payload.customer_id === id) {
            bal += Number(payload.amountMinor ?? payload.amount_minor ?? 0);
          }
          continue;
        }

        if (overlay.entityType === 'order_items' && overlay.operation === 'PATCH') {
          const payload = (overlay.patch || {}) as any;
          const itemId = overlay.entityId;
          if (
            String(payload.status || '').toLowerCase() === 'delivered' ||
            String(payload.financialStatus || payload.financial_status || '').toUpperCase() === 'RECOGNIZED'
          ) {
            if (authoritativeChargeItems.has(itemId)) continue;
            const item = effectiveItems.get(itemId);
            if (!item) continue;
            const order = ordersMap.get(item.orderId);
            if (!order || order.customerId !== id) continue;
            bal -= Number(
              item.finalChargeSnapshotMinor ??
              item.totalPriceMinor ??
              payload.finalChargeSnapshotMinor ??
              payload.totalPriceMinor ??
              0
            );
          }
        }
      }

      return bal;
    },
  },
  deviceRepo: {
    findById: async (id) => {
      await ensureStoreHydrated();
      return devicesMap.get(id) || null;
    },
    save: async (d) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx) => {
        ctx.deviceRepo.save(d);
      });
    },
    delete: async (id) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx) => {
        if (ctx.deviceRepo.delete) {
          ctx.deviceRepo.delete(id);
        }
        ctx.commandRepo.record(id, 'DELETE_DEVICE_TYPE', { id });
      });
    },
    findAll: async () => {
      await ensureStoreHydrated();
      return Array.from(devicesMap.values());
    },
  },
  ledgerRepo: {
    append: async (ev) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx) => {
        const isStandardUuid = (ev as any).id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((ev as any).id);
        const recordId = isStandardUuid ? (ev as any).id : crypto.randomUUID();
        const createdAt = (ev as any).createdAt || new Date().toISOString();
        const evWithId: FinancialLedgerEntity = { createdAt, ...ev, id: recordId };
        // Ledger entries are authoritative side-effects of explicit business commands
        // (delivery, payment, refund, credit, goal completion). They must not be
        // emitted as independent FINANCIAL_LEDGER sync commands because the server
        // owns creation of those ledger rows and no generic ledger mutation RPC exists.
        ctx.ledgerRepo.append(evWithId);
      });
    },
    findByCustomer: async (customerId) => {
      await ensureStoreHydrated();
      return ledgerList.filter((l) => l.customerId === customerId);
    },
    findAll: async () => {
      await ensureStoreHydrated();
      return [...ledgerList];
    },
  },
  dayRepo: {
    findById: async (id) => {
      await ensureStoreHydrated();
      return daysMap.get(id) || null;
    },
    save: async (d) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx) => {
        ctx.dayRepo.save(d);
        ctx.commandRepo.record(d.id, 'OPEN_DAY', d);
      });
    },
    isClosed: async (dayId) => {
      await ensureStoreHydrated();
      const d = daysMap.get(dayId);
      return d ? d.isClosed : false;
    },
  },
  paymentRepo: {
    save: async (p) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx) => {
        ctx.paymentRepo.save(p);
        // Payment synchronization is owned by CREATE_PAYMENT, which atomically
        // creates the payment, ledger event and allocations on the server.
        // Never enqueue the legacy PAYMENT command.
      });
    },
    saveAllocation: async (a) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx) => {
        ctx.paymentRepo.saveAllocation(a);
      });
    },
    findByCustomer: async (customerId) => {
      await ensureStoreHydrated();
      return Array.from(paymentsMap.values()).filter((p) => p.customerId === customerId);
    },
    findAllAllocations: async () => {
      await ensureStoreHydrated();
      return [...allocationsList];
    },
  },
  commandRepo: {
    get: async (cmdId) => {
      await ensureStoreHydrated();
      return commandsMap.get(cmdId) || null;
    },
    record: async (cmdId, type, payload) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx) => {
        ctx.commandRepo.record(cmdId, type, payload);
      });
    },
  },
  overlayRepo: {
    save: async (o) => {
      await ensureStoreHydrated();
      await localDb.saveOverlay(o);
    },
    remove: async (id) => {
      await ensureStoreHydrated();
      await localDb.removeOverlay(id);
    },
    get: async (id) => {
      await ensureStoreHydrated();
      return await localDb.getOverlay(id);
    },
    getNextSequence: async () => {
      await ensureStoreHydrated();
      return await localDb.getNextSequence();
    },
    hasPendingOrderChangesForDay: async (dayId) => {
      await ensureStoreHydrated();
      return hasPendingOrderChangesForDay(dayId);
    },
    hasPendingRenumberForDay: async (dayId) => {
      await ensureStoreHydrated();
      const renumberCommands = localDb.listOutboxSync().filter((item) => {
        const payload = (item.payload || {}) as Record<string, unknown>;
        return item.commandType === 'RENUMBER_DAY_ORDERS' && (payload.dayId === dayId || payload.id === dayId);
      });
      if (renumberCommands.some((item) => ['pending', 'syncing', 'blocked', 'PENDING_RECONCILIATION'].includes(String(item.status)))) return true;
      const hasWatermark = Array.from(reservationsMap.values()).some((reservation) =>
        reservation.businessDayId === dayId && reservation.deviceId === '__renumber_watermark__'
      );
      if (!hasWatermark) return false;
      const numbers = Array.from(getEffectiveOrderItemReadModel().orders.values())
        .filter((order) => isSameDayId(order.dayId, dayId))
        .map((order) => Number(order.displayNumber) || 0)
        .sort((a, b) => a - b);
      return numbers.some((number, index) => number !== index + 1);
    },
  },
  reservationRepo: {
    getLastAssignedNumberForDay: (dayId) => {
      let highWater = 0;
      reservationsMap.forEach((reservation) => {
        if (reservation.businessDayId !== dayId) return;
        const consumedThrough = reservation.status === 'ACTIVE' && reservation.nextNumber <= reservation.endNumber
          ? Math.max(0, Number(reservation.nextNumber) - 1)
          : Number(reservation.endNumber) || 0;
        highWater = Math.max(highWater, consumedThrough);
      });
      return highWater;
    },
    findActiveByDayAndDevice: async (dayId, deviceId) => {
      await ensureStoreHydrated();
      let found: OrderNumberReservationEntity | null = null;
      reservationsMap.forEach(r => {
        if (r.businessDayId === dayId && r.deviceId === deviceId && r.status === 'ACTIVE' && r.nextNumber <= r.endNumber) {
          found = r;
        }
      });
      return found;
    },
    save: async (r) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx: any) => {
        ctx.reservationRepo.save(r);
      });
    },
    reserveRange: async (dayId, deviceId, commandId, rangeSize = 20) => {
      await ensureStoreHydrated();
      let res: OrderNumberReservationEntity;
      await repoContext.transactionManager.runInTransaction((ctx: any) => {
        res = ctx.reservationRepo.reserveRange(dayId, deviceId, commandId, rangeSize);
      });
      return res!;
    },
    resetForDay: async (dayId, nextNumber) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx: any) => {
        ctx.reservationRepo.resetForDay(dayId, nextNumber);
      });
    },
    needsResetForDay: (dayId, deviceId, expectedNextNumber) => {
      const active = Array.from(reservationsMap.values()).find((reservation) =>
        reservation.businessDayId === dayId &&
        reservation.deviceId === deviceId &&
        reservation.status === 'ACTIVE' &&
        reservation.nextNumber <= reservation.endNumber
      );
      if (active) {
        const laterRangeExists = Array.from(reservationsMap.values()).some((reservation) =>
          reservation.businessDayId === dayId &&
          reservation.id !== active.id &&
          reservation.endNumber > active.endNumber
        );
        return active.nextNumber !== expectedNextNumber || laterRangeExists;
      }
      let maxReservedEnd = 0;
      reservationsMap.forEach((reservation) => {
        if (reservation.businessDayId === dayId) maxReservedEnd = Math.max(maxReservedEnd, reservation.endNumber);
      });
      return maxReservedEnd !== expectedNextNumber - 1;
    },
  },
  goalRepo: {
    findById: async (id) => {
      await ensureStoreHydrated();
      return goalsMap.get(id) || null;
    },
    findActiveByCustomerId: async (customerId) => {
      await ensureStoreHydrated();
      for (const goal of goalsMap.values()) {
        if (goal.customerId === customerId && goal.status === 'ACTIVE') return goal;
      }
      return null;
    },
    findAllByCustomerId: async (customerId) => {
      await ensureStoreHydrated();
      return Array.from(goalsMap.values()).filter((goal) => goal.customerId === customerId);
    },
    save: async (goal) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx) => {
        ctx.goalRepo!.save(goal);
      });
    },
  },
  goalRequestRepo: {
    findById: async (id) => {
      await ensureStoreHydrated();
      return goalRequestsMap.get(id) || null;
    },
    findAllByCustomerId: async (customerId) => {
      await ensureStoreHydrated();
      return Array.from(goalRequestsMap.values()).filter((request) => request.customerId === customerId);
    },
    save: async (request) => {
      await ensureStoreHydrated();
      await repoContext.transactionManager.runInTransaction((ctx) => {
        ctx.goalRequestRepo!.save(request);
      });
    },
  },
  transactionManager: {
    runInTransaction: async <T>(work: (ctx: RepositoryContext) => T extends Promise<any> ? never : T): Promise<T> => {
      await ensureStoreHydrated();
      await initDbIfNeeded();

      // Snapshot in-memory maps before transaction for rollback
      const snapOrders = cloneForTransactionRollback(new Map(ordersMap));
      const snapItems = cloneForTransactionRollback(new Map(itemsMap));
      const snapCustomers = cloneForTransactionRollback(new Map(customersMap));
      const snapDays = cloneForTransactionRollback(new Map(daysMap));
      const snapCommands = cloneForTransactionRollback(new Map(commandsMap));
      const snapDevices = cloneForTransactionRollback(new Map(devicesMap));
      const snapPayments = cloneForTransactionRollback(new Map(paymentsMap));
      const snapReservations = cloneForTransactionRollback(new Map(reservationsMap));
      const snapGoals = cloneForTransactionRollback(new Map(goalsMap));
      const snapGoalRequests = cloneForTransactionRollback(new Map(goalRequestsMap));
      const snapLedger = cloneForTransactionRollback(ledgerList);
      const snapAllocations = cloneForTransactionRollback(allocationsList);

      const rollbackMemory = () => {
        ordersMap.clear(); for (const [k, v] of snapOrders) ordersMap.set(k, cloneForTransactionRollback(v));
        itemsMap.clear(); for (const [k, v] of snapItems) itemsMap.set(k, cloneForTransactionRollback(v));
        customersMap.clear(); for (const [k, v] of snapCustomers) customersMap.set(k, cloneForTransactionRollback(v));
        daysMap.clear(); for (const [k, v] of snapDays) daysMap.set(k, cloneForTransactionRollback(v));
        commandsMap.clear(); for (const [k, v] of snapCommands) commandsMap.set(k, cloneForTransactionRollback(v));
        devicesMap.clear(); for (const [k, v] of snapDevices) devicesMap.set(k, cloneForTransactionRollback(v));
        paymentsMap.clear(); for (const [k, v] of snapPayments) paymentsMap.set(k, cloneForTransactionRollback(v));
        reservationsMap.clear(); for (const [k, v] of snapReservations) reservationsMap.set(k, cloneForTransactionRollback(v));
        goalsMap.clear(); for (const [k, v] of snapGoals) goalsMap.set(k, cloneForTransactionRollback(v));
        goalRequestsMap.clear(); for (const [k, v] of snapGoalRequests) goalRequestsMap.set(k, cloneForTransactionRollback(v));
        ledgerList.length = 0; ledgerList.push(...cloneForTransactionRollback(snapLedger));
        allocationsList.length = 0; allocationsList.push(...cloneForTransactionRollback(snapAllocations));
      };

      try {
        const postCommitActions: (() => void)[] = [];

        const result = await localDb.runTransaction(
          ['kvStore', 'outbox', 'mutationSnapshots', 'optimisticOverlays', 'orderNumberReservations'],
          'readwrite',
          (tx) => {
            const txCtx = createTransactionalRepoContext(tx, postCommitActions);
            return work(txCtx);
          }
        );

        // Execute post-commit notifications
        for (const action of postCommitActions) {
          try {
            action();
          } catch (e) {
            console.warn('Post-commit action error:', e);
          }
        }

        // Trigger non-blocking background sync after successful local transaction commit
        if (onTransactionCommitted) {
          onTransactionCommitted();
        }

        return result;
      } catch (err) {
        rollbackMemory();
        throw err;
      }
    },
  },
};

// Instantiate Authoritative Phase 5 UseCases
export const phase5UseCases = new FinalUseCases(repoContext);

/**
 * Queues a QR design as a canonical system-setting command. The active design is
 * committed by the caller only after the local command/outbox transaction succeeds.
 */
export const queueQrDesignSetting = async (type: QRDesignType, design: QRDesignConfig): Promise<void> => {
  if (design.designType !== type) {
    throw new Error(`Design type mismatch: expected ${type}, got ${design.designType}`);
  }
  await ensureStoreHydrated();
  const key = `app_qr_design_config_${type}`;
  const commandId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `qr-design-${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await repoContext.transactionManager.runInTransaction((ctx) => {
    ctx.commandRepo.record(commandId, 'SET_SYSTEM_SETTING', {
      key,
      valueType: 'json',
      valueJson: JSON.parse(JSON.stringify(design)),
      entityId: key,
    });
  });
};

// Runtime credential verifier hook for custom environment / test harness
let runtimeBinVerifier: ((bin: string, actor: any) => boolean | Promise<boolean>) | null = null;

export const setRuntimeBinVerifier = (verifier: ((bin: string, actor: any) => boolean | Promise<boolean>) | null): void => {
  runtimeBinVerifier = verifier;
};

export const getAuthoritativeBinVerifier = (): BinVerifierFn | undefined => {
  if (runtimeBinVerifier) {
    return runtimeBinVerifier;
  }
  if (getSupabaseStatus().isConfigured) {
    return async (bin: string) => {
      return await rpcVerifyAdminBin(bin);
    };
  }
  // When Supabase is not configured and no runtime verifier is set, return undefined to FAIL CLOSED!
  return undefined;
};

export const getCurrentAdminAuthorizationContext = (): AuthorizationContext => {
  return getAuthorizedAdminContext();
};

/**
 * Goal-page read model. All reads come from the hydrated local store; mutations
 * below go through FinalUseCases and the existing transactional outbox.
 */
export const getGoalsPageData = async (access: {
  canViewGoals: boolean;
  canViewRequests: boolean;
}) => {
  await ensureStoreHydrated();
  return {
    goals: access.canViewGoals
      ? Array.from(goalsMap.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : [],
    requests: access.canViewRequests
      ? Array.from(goalRequestsMap.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : [],
    customers: (access.canViewGoals || access.canViewRequests)
      ? Array.from(customersMap.values()).sort((a, b) => a.name.localeCompare(b.name))
      : [],
  };
};

export const generateCustomerGoalProposalForAdmin = async (customerId: string) => {
  await ensureStoreHydrated();
  const now = Date.now();
  const profile = Array.from({ length: 28 }, () => 0);
  for (const item of itemsMap.values()) {
    if (item.deletedAt || item.status !== 'delivered' || item.financialStatus !== 'RECOGNIZED' ||
        item.replacementOfItemId) continue;
    const order = ordersMap.get(item.orderId);
    if (!order || order.customerId !== customerId || order.deletedAt || order.cancelledAt || order.status === 'cancelled') continue;
    const deliveryTimestamp = item.deliveredAt || order.deliveredAt;
    if (!deliveryTimestamp) continue;
    const deliveredAt = new Date(deliveryTimestamp).getTime();
    if (!Number.isFinite(deliveredAt)) continue;
    const ageDays = Math.floor((now - deliveredAt) / (24 * 60 * 60 * 1000));
    if (ageDays < 0 || ageDays >= 28) continue;
    profile[27 - ageDays] += 1;
  }
  return phase5UseCases.generateCustomerGoalProposal(getAuthorizedAdminContext(), customerId, profile);
};

export const createGoalForAdmin = async (
  customerId: string,
  targetQuantity: number,
  durationDays: number,
  bonusAmountMinor: number
) => {
  await ensureStoreHydrated();
  return phase5UseCases.createGoal(
    getAuthorizedAdminContext(),
    crypto.randomUUID(),
    customerId,
    targetQuantity,
    durationDays,
    bonusAmountMinor
  );
};

export const updateGoalConfigForAdmin = async (
  goalId: string,
  params: { targetQuantity?: number; durationDays?: number; bonusAmountMinor?: number }
) => {
  await ensureStoreHydrated();
  return phase5UseCases.updateGoalConfig(getAuthorizedAdminContext(), goalId, params);
};

export const approveGoalRequestForAdmin = async (
  requestId: string,
  durationDays?: number,
  bonusAmountMinor?: number
) => {
  await ensureStoreHydrated();
  return phase5UseCases.approveGoalRequest(
    getAuthorizedAdminContext(),
    requestId,
    bonusAmountMinor,
    durationDays
  );
};

export const rejectGoalRequestForAdmin = async (requestId: string, rejectionReason: string) => {
  await ensureStoreHydrated();
  return phase5UseCases.rejectGoalRequest(getAuthorizedAdminContext(), requestId, rejectionReason);
};

// Test-only compatibility actor. It is deliberately unauthorised in production.
const isTestRuntime = () =>
  (typeof process !== 'undefined' && (process.env?.NODE_ENV === 'test' || Boolean(process.env?.VITEST))) ||
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.MODE === 'test');

export const defaultAdminAuth = new AuthorizationContext(
  isTestRuntime()
    ? {
        id: 'admin_test_session',
        username: 'test-admin',
        fullName: 'Test Admin',
        role: 'ADMIN',
        permissions: [
          'orders:view', 'orders:create', 'orders:edit', 'orders:deliver', 'orders:cancel',
          'customers:view', 'customers:create', 'customers:edit', 'customers:deactivate',
          'customers:debt-limit', 'customers:charger-exemption', 'customers:financial-view',
          'finance:view', 'finance:create-payment', 'finance:approve-payment', 'finance:refund',
          'finance:correction', 'finance:credit-adjustment', 'devices:view', 'devices:manage',
          'devices:pricing', 'devices:charger-policy', 'settings:manage',
        ],
        isSuperAdmin: false,
      }
    : null,
  getAuthoritativeBinVerifier()
);

export const getAuthorizedAdminContext = (bin?: string): AuthorizationContext => {
  const { actorAdminId } = getAuthenticatedIdentity();
  let storedSession: any = null;
  try {
    const storage = getLocalStorage();
    const raw = storage?.getItem('app_auth_session');
    storedSession = raw ? JSON.parse(raw) : null;
  } catch {
    storedSession = null;
  }

  // Never invent an ADMIN actor or default permissions. Offline authorization must
  // be derived from the authenticated session cached after a successful server login.
  if (!storedSession?.userId || !storedSession?.role || !Array.isArray(storedSession.permissions)) {
    return new AuthorizationContext(null, getAuthoritativeBinVerifier());
  }

  const role = storedSession.role;
  const permissions = storedSession.permissions;

  return new AuthorizationContext(
    {
      id: storedSession.userId,
      username: storedSession.username || storedSession.email?.split('@')[0] || 'admin',
      fullName: storedSession.fullName || 'مدير المنظومة',
      role,
      permissions,
      isSuperAdmin: role === 'SUPER_ADMIN',
    },
    getAuthoritativeBinVerifier()
  );
};

// ==========================================
// AUTHORITATIVE PUBLIC API FOR UI COMPONENTS
// ==========================================

export const getDeviceDisplayName = (
  dev: { id?: string; name: string; nameAr?: string; nameEn?: string } | string,
  locale: Locale = 'ar'
): string => {
  if (typeof dev === 'string') {
    return getItemLocalizedDeviceName(dev, locale);
  }
  if (dev.id && UI_DEVICE_LOCALIZATIONS[dev.id]) {
    return locale === 'en' ? UI_DEVICE_LOCALIZATIONS[dev.id].en : UI_DEVICE_LOCALIZATIONS[dev.id].ar;
  }
  if (dev.name && UI_DEVICE_NAME_MAP[dev.name]) {
    return locale === 'en' ? UI_DEVICE_NAME_MAP[dev.name].en : UI_DEVICE_NAME_MAP[dev.name].ar;
  }
  return locale === 'en' ? (dev.nameEn || dev.name) : (dev.nameAr || dev.name);
};

/**
 * Computes FIFO payment allocations for all orders of a customer.
 * - Oldest non-cancelled orders are paid first.
 * - Total available customer credits (PAYMENT / positive CREDIT_ADJUSTMENT) are allocated sequentially.
 * - Orders with remaining unpaid balance are marked PARTIAL (if partially covered) or UNPAID (if 0 covered).
 * - Fully covered orders are marked PAID.
 */
export type PaymentProjectionIndexes = {
  recognizedItems: Array<{ itemId: string; orderId: string; totalMinor: number; createdAt: string; createdSequence?: number }>;
  recognizedItemsByOrder: Map<
    string,
    Array<{ itemId: string; orderId: string; totalMinor: number; createdAt: string; createdSequence?: number }>
  >;
  allocatedByItem: Map<string, number>;
  pendingPaymentsByCustomer: Map<string, Array<{ createdAt: string; amountMinor: number; sequence?: number }>>;
  ordersByCustomer: Map<string, OrderEntity[]>;
  itemsByOrder: Map<string, OrderItemEntity[]>;
};

const buildPaymentProjectionIndexes = (
  effectiveOrdersMap: Map<string, OrderEntity>,
  effectiveItemsMap: Map<string, OrderItemEntity>
): PaymentProjectionIndexes => {
  const recognizedItems: Array<{ itemId: string; orderId: string; totalMinor: number; createdAt: string; createdSequence?: number }> = [];
  const recognizedItemsByOrder = new Map<
    string,
    Array<{ itemId: string; orderId: string; totalMinor: number; createdAt: string; createdSequence?: number }>
  >();
  const allocatedByItem = new Map<string, number>();
  const pendingPaymentsByCustomer = new Map<string, Array<{ createdAt: string; amountMinor: number; sequence?: number }>>();
  const ordersByCustomer = new Map<string, OrderEntity[]>();
  const itemsByOrder = new Map<string, OrderItemEntity[]>();
  const pendingOverlays = localDb.listOverlaysSync().filter((overlay) => overlay.status === 'PENDING');
  // Overlay sequence is a monotonic local transaction order. Use it when timestamps
  // collide at millisecond precision so a payment cannot pay an item created later.
  const itemCreateSequenceById = new Map<string, number>();
  for (const overlay of pendingOverlays) {
    if (
      (overlay.entityType === 'order_items' || overlay.entityType === 'orderItems') &&
      overlay.operation === 'CREATE'
    ) {
      itemCreateSequenceById.set(overlay.entityId, Number(overlay.sequence ?? 0));
    }
  }

  for (const item of effectiveItemsMap.values()) {
    let orderItems = itemsByOrder.get(item.orderId);
    if (!orderItems) {
      orderItems = [];
      itemsByOrder.set(item.orderId, orderItems);
    }
    orderItems.push(item);

    if (item.status === 'cancelled') continue;
    const financialStatus = String(
      (item as any).financialStatus || (item as any).financial_status || ''
    ).toUpperCase();
    if (financialStatus !== 'RECOGNIZED' && item.status !== 'delivered') continue;

    const totalMinor = Number(
      (item as any).finalChargeSnapshotMinor ??
      (item as any).final_charge_snapshot_minor ??
      item.totalPriceMinor ??
      0
    );
    if (totalMinor <= 0) continue;

    const recognized = {
      itemId: item.id,
      orderId: item.orderId,
      totalMinor,
      createdAt: item.createdAt,
      createdSequence: itemCreateSequenceById.get(item.id),
    };

    recognizedItems.push(recognized);

    let orderList = recognizedItemsByOrder.get(item.orderId);
    if (!orderList) {
      orderList = [];
      recognizedItemsByOrder.set(item.orderId, orderList);
    }
    orderList.push(recognized);
  }

  const orderSequenceById = new Map<string, number>();
  for (const order of effectiveOrdersMap.values()) {
    orderSequenceById.set(order.id, Number(order.internalSequence ?? 0));
  }
  const itemSequenceById = new Map<string, number>();
  for (const item of effectiveItemsMap.values()) {
    itemSequenceById.set(item.id, Number(item.itemSequence ?? 0));
  }

  recognizedItems.sort((a, b) => {
    const orderSeqA = orderSequenceById.get(a.orderId) ?? 0;
    const orderSeqB = orderSequenceById.get(b.orderId) ?? 0;
    if (orderSeqA !== orderSeqB) return orderSeqA - orderSeqB;
    const itemSeqA = itemSequenceById.get(a.itemId) ?? 0;
    const itemSeqB = itemSequenceById.get(b.itemId) ?? 0;
    if (itemSeqA !== itemSeqB) return itemSeqA - itemSeqB;
    return a.itemId.localeCompare(b.itemId);
  });
  for (const list of recognizedItemsByOrder.values()) {
    list.sort((a, b) => {
      const itemSeqA = itemSequenceById.get(a.itemId) ?? 0;
      const itemSeqB = itemSequenceById.get(b.itemId) ?? 0;
      if (itemSeqA !== itemSeqB) return itemSeqA - itemSeqB;
      return a.itemId.localeCompare(b.itemId);
    });
  }

  // Apply authoritative item-level allocations first. Older local snapshots may
  // contain allocation rows created before orderItemId was persisted locally.
  // Those legacy rows are reconstructed deterministically at order-item level
  // using the same canonical FIFO ordering used by the server.
  const legacyAllocations: PaymentAllocationEntity[] = [];
  for (const allocation of allocationsList) {
    if (allocation.orderItemId) {
      allocatedByItem.set(
        allocation.orderItemId,
        (allocatedByItem.get(allocation.orderItemId) || 0) +
          Number(allocation.allocatedAmountMinor || 0)
      );
    } else {
      legacyAllocations.push(allocation);
    }
  }

  legacyAllocations.sort((a, b) => {
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    if (timeA !== timeB) return timeA - timeB;
    return a.id.localeCompare(b.id);
  });

  for (const allocation of legacyAllocations) {
    if (!allocation.orderId) continue;

    let remaining = Number(allocation.allocatedAmountMinor || 0);
    if (remaining <= 0) continue;

    const orderItems = recognizedItemsByOrder.get(allocation.orderId) || [];
    for (const item of orderItems) {
      if (remaining <= 0) break;

      const alreadyAllocated = allocatedByItem.get(item.itemId) || 0;
      const outstanding = Math.max(0, item.totalMinor - alreadyAllocated);
      if (outstanding <= 0) continue;

      const amount = Math.min(remaining, outstanding);
      allocatedByItem.set(item.itemId, alreadyAllocated + amount);
      remaining -= amount;
    }
  }

  for (const overlay of pendingOverlays) {
    if (
      overlay.entityType !== 'payments' ||
      overlay.operation !== 'CREATE'
    ) {
      continue;
    }
    const payload = (overlay.entityPayload || overlay.patch || {}) as any;
    const customerId = payload.customerId || payload.customer_id;
    const amountMinor = Number(payload.amountMinor ?? payload.amount_minor ?? 0);
    if (!customerId || amountMinor <= 0) continue;

    let list = pendingPaymentsByCustomer.get(customerId);
    if (!list) {
      list = [];
      pendingPaymentsByCustomer.set(customerId, list);
    }
    list.push({
      createdAt: overlay.createdAt,
      amountMinor,
      sequence: Number(overlay.sequence ?? 0),
    });
  }

  for (const list of pendingPaymentsByCustomer.values()) {
    list.sort((a, b) => {
      const timeDifference = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (timeDifference !== 0) return timeDifference;
      return Number(a.sequence ?? 0) - Number(b.sequence ?? 0);
    });
  }

  for (const order of effectiveOrdersMap.values()) {
    let list = ordersByCustomer.get(order.customerId);
    if (!list) {
      list = [];
      ordersByCustomer.set(order.customerId, list);
    }
    list.push(order);
  }

  return {
    recognizedItems,
    recognizedItemsByOrder,
    allocatedByItem,
    pendingPaymentsByCustomer,
    ordersByCustomer,
    itemsByOrder,
  };
};

export const computeCustomerOrderPaymentStatuses = (
  customerId: string,
  suppliedOrdersMap?: Map<string, OrderEntity>,
  suppliedItemsMap?: Map<string, OrderItemEntity>,
  indexes?: PaymentProjectionIndexes
): Map<string, { paymentStatus: 'PAID' | 'PARTIAL' | 'UNPAID'; allocatedAmountMinor: number; totalMinor: number }> => {
  const result = new Map<string, { paymentStatus: 'PAID' | 'PARTIAL' | 'UNPAID'; allocatedAmountMinor: number; totalMinor: number }>();
  // By default, compute from the effective read model, including pending overlays.
  // UI reads must not omit an order/item merely because its server command is pending.
  const effectiveReadModel = (!suppliedOrdersMap || !suppliedItemsMap)
    ? getEffectiveOrderItemReadModel()
    : null;
  const effectiveOrdersMap = suppliedOrdersMap ?? effectiveReadModel!.orders;
  const effectiveItemsMap = suppliedItemsMap ?? effectiveReadModel!.items;
  const projection = indexes || buildPaymentProjectionIndexes(effectiveOrdersMap, effectiveItemsMap);

  const recognizedItems = projection.recognizedItems;
  const allocatedByItem = new Map(projection.allocatedByItem);

  // Project pending local CREATE_PAYMENT commands exactly as the server will.
  // The unallocated remainder is wallet credit and does not pay an order.
  for (const payment of projection.pendingPaymentsByCustomer.get(customerId) || []) {
    let remaining = payment.amountMinor;
    for (const item of recognizedItems) {
      if (remaining <= 0) break;
      // The server can only allocate a payment against debt that existed
      // when that payment transaction executed. Never retroactively project
      // an earlier pending payment onto an order/item created afterward.
      const itemCreatedAt = new Date(item.createdAt).getTime();
      const paymentCreatedAt = new Date(payment.createdAt).getTime();
      const hasSequenceOrder =
        item.createdSequence !== undefined &&
        payment.sequence !== undefined &&
        item.createdSequence > 0 &&
        payment.sequence > 0;
      if (hasSequenceOrder) {
        if (item.createdSequence! > payment.sequence!) continue;
      } else if (itemCreatedAt > paymentCreatedAt) {
        continue;
      }
      const alreadyAllocated = allocatedByItem.get(item.itemId) || 0;
      const outstanding = Math.max(0, item.totalMinor - alreadyAllocated);
      if (outstanding <= 0) continue;
      const amount = Math.min(remaining, outstanding);
      allocatedByItem.set(item.itemId, alreadyAllocated + amount);
      remaining -= amount;
    }
  }

  const custOrders = (projection.ordersByCustomer.get(customerId) || [])
    .filter((order) => order.status !== 'cancelled')
    .sort((a, b) => {
      const seqA = Number(a.internalSequence ?? 0);
      const seqB = Number(b.internalSequence ?? 0);
      if (seqA !== seqB) return seqA - seqB;
      return a.id.localeCompare(b.id);
    });

  for (const order of custOrders) {
    const orderItems = (projection.itemsByOrder.get(order.id) || [])
      .filter((item) => item.status !== 'cancelled');

    const displayTotalMinor = orderItems.reduce(
      (sum, item) => sum + Number(item.totalPriceMinor || 0),
      0
    );

    if (displayTotalMinor <= 0) {
      result.set(order.id, { paymentStatus: 'PAID', allocatedAmountMinor: 0, totalMinor: 0 });
      continue;
    }

    const recognizedForOrder = projection.recognizedItemsByOrder.get(order.id) || [];
    const recognizedTotalMinor = recognizedForOrder.reduce((sum, item) => sum + item.totalMinor, 0);
    const allocatedMinor = recognizedForOrder.reduce(
      (sum, item) => sum + Math.min(item.totalMinor, allocatedByItem.get(item.itemId) || 0),
      0
    );

    if (recognizedTotalMinor <= 0) {
      result.set(order.id, {
        paymentStatus: 'UNPAID',
        allocatedAmountMinor: 0,
        totalMinor: displayTotalMinor,
      });
      continue;
    }

    const boundedAllocated = Math.min(allocatedMinor, recognizedTotalMinor);
    result.set(order.id, {
      paymentStatus:
        boundedAllocated >= recognizedTotalMinor
          ? 'PAID'
          : boundedAllocated > 0
            ? 'PARTIAL'
            : 'UNPAID',
      allocatedAmountMinor: boundedAllocated,
      totalMinor: recognizedTotalMinor,
    });
  }

  return result;
};

export const getOrdersForDay = async (
  dayId: string,
  locale: Locale = 'ar'
): Promise<UIDayOrderDetail[]> => {
  await ensureStoreHydrated();

  // Number integrity is read-only here. Hydration and page rendering must never repair numbering.
  const { orders: effectiveOrdersMap, items: effectiveItemsMap } = getEffectiveOrderItemReadModel();

  const allOrders = Array.from(effectiveOrdersMap.values()).filter((o) => isSameDayId(o.dayId, dayId));
  const indexes = buildPaymentProjectionIndexes(effectiveOrdersMap, effectiveItemsMap);
  const customerAllocationMaps = new Map<
    string,
    Map<string, { paymentStatus: 'PAID' | 'PARTIAL' | 'UNPAID'; allocatedAmountMinor: number; totalMinor: number }>
  >();

  const res: UIDayOrderDetail[] = [];
  for (const ord of allOrders) {
    const cust = customersMap.get(ord.customerId);
    if (cust && !customerAllocationMaps.has(cust.id)) {
      customerAllocationMaps.set(
        cust.id,
        computeCustomerOrderPaymentStatuses(cust.id, effectiveOrdersMap, effectiveItemsMap, indexes)
      );
    }

    const alloc = cust ? customerAllocationMaps.get(cust.id)?.get(ord.id) : undefined;
    const paymentStatus: 'PAID' | 'PARTIAL' | 'UNPAID' =
      ord.status === 'cancelled'
        ? 'UNPAID'
        : (alloc?.paymentStatus || 'UNPAID');

    const allOrderItems = indexes.itemsByOrder.get(ord.id) || [];
    const orderItems = allOrderItems.filter((i) => i.status !== 'cancelled');
    const projectedStatus = calculateOrderProjection(allOrderItems, ord.status);

    const uiItems: UIOrderDeviceItem[] = orderItems.map((i) => {
      const devName = getItemLocalizedDeviceName(i.deviceTypeId, locale, i.deviceNameSnapshot);

      return {
        id: i.id,
        deviceName: devName,
        priceMinor: i.totalPriceMinor,
        hasCharger: i.hasCharger,
      };
    });

    const custCode = cust ? getCustomerCode(cust) : 'A7K2';
    const isExempt = cust ? Boolean(cust.chargerFeeExempt) : false;

    res.push({
      id: ord.id,
      orderNumber: ord.displayNumber,
      customerName: cust ? cust.name : locale === 'ar' ? 'عميل غير معروف' : 'Unknown Customer',
      customerId: custCode,
      chargerFeeExempt: isExempt,
      createdAt: ord.createdAt,
      items: uiItems,
      note: ord.notes,
      status: projectedStatus,
      paymentStatus,
    });
  }

  return res.sort((a, b) => {
    const numA = a.orderNumber || 0;
    const numB = b.orderNumber || 0;
    if (numA > 0 && numB > 0 && numA !== numB) {
      return numB - numA;
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
};

export const getNextOrderNumberForDay = async (dayId: string): Promise<number> => {
  await ensureStoreHydrated();
  // The preview uses the same effective orders and durable high-water mark as
  // the local creation transaction. Legacy reserved ranges are never consumed.
  let maxNumber = 0;
  getEffectiveOrderItemReadModel().orders.forEach((order) => {
    if (isSameDayId(order.dayId, dayId)) maxNumber = Math.max(maxNumber, Number(order.displayNumber) || 0);
  });
  const lastAssigned = repoContext.reservationRepo?.getLastAssignedNumberForDay?.(dayId) ?? 0;
  return Math.max(maxNumber, lastAssigned) + 1;
};

export const searchCustomers = async (query: string): Promise<UICustomerItem[]> => {
  if (!query || !query.trim()) return [];
  const q = query.trim().toLowerCase();
  const all = Array.from(customersMap.values()).filter((c) => c.isActive);

  return all
    .filter((c) => {
      const code = getCustomerCode(c).toLowerCase();
      const phone = c.phone || '';
      const id = c.id.toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        phone.includes(q) ||
        code.includes(q) ||
        id.includes(q)
      );
    })
    .map((c) => ({
      id: c.id,
      name: c.name,
      code: getCustomerCode(c),
      phone: c.phone || '',
      debtLimitMinor: c.debtLimitMinor,
      chargerFeeExempt: c.chargerFeeExempt,
    }));
};

export const getDeviceTypesOptions = async (
  locale: Locale = 'ar'
): Promise<UIDeviceTypeOption[]> => {
  await ensureStoreHydrated();
  const allDevices = await repoContext.deviceRepo.findAll();

  if (!allDevices || allDevices.length === 0) {
    return [];
  }

  return allDevices
    .filter((d) => d.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => {
      const nameAr = d.nameAr || UI_DEVICE_LOCALIZATIONS[d.id]?.ar || UI_DEVICE_NAME_MAP[d.name]?.ar || d.name;
      const nameEn = d.nameEn || UI_DEVICE_LOCALIZATIONS[d.id]?.en || UI_DEVICE_NAME_MAP[d.name]?.en || d.name;
      const name = locale === 'en' ? nameEn : nameAr;
      return {
        id: d.id,
        name,
        nameAr,
        nameEn,
        priceMinor: d.basePriceMinor,
        supportsCharger: d.chargerFeeEnabled,
        chargerFeeMinor: 50,
      };
    });
};

export interface UIOrderSearchResult {
  orderId: string;
  orderNumber: number;
  dayId: string;
  businessDate: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  customerPhone?: string;
  createdAt: string;
  status: string;
  totalMinor: number;
}

export interface SearchCustomersAndOrdersResult {
  customers: UICustomerListItem[];
  orders: UIOrderSearchResult[];
  isOrderSearch: boolean;
  totalStoreCustomersCount?: number;
  totalMatchingCount?: number;
}

export const searchCustomersAndOrders = async (
  query?: string,
  limit?: number
): Promise<SearchCustomersAndOrdersResult> => {
  await ensureStoreHydrated();
  const { orders: effectiveOrdersMap, items: effectiveItemsMap } = getEffectiveOrderItemReadModel();
  const q = query ? query.trim() : '';
  const totalStoreCustomersCount = Array.from(customersMap.values()).filter((c) => c.isActive).length;

  // 1. If query is empty, return customers list (all or bounded if explicit limit passed)
  if (!q) {
    const defaultCusts = await getCustomersList('', limit);
    return {
      customers: defaultCusts,
      orders: [],
      isOrderSearch: false,
      totalStoreCustomersCount,
      totalMatchingCount: defaultCusts.length,
    };
  }

  // 2. Check if searching by Order Number (e.g. "8", "#8", "27")
  const cleanOrderNum = q.startsWith('#') ? q.slice(1).trim() : q.trim();
  const isNumeric = /^\d+$/.test(cleanOrderNum);

  if (isNumeric) {
    const targetOrderNum = parseInt(cleanOrderNum, 10);
    const matchingOrders: UIOrderSearchResult[] = [];

    for (const ord of effectiveOrdersMap.values()) {
      if (ord.displayNumber === targetOrderNum) {
        const cust = customersMap.get(ord.customerId);
        const day = daysMap.get(ord.dayId);
        const items = Array.from(effectiveItemsMap.values()).filter((i) => i.orderId === ord.id && i.status !== 'cancelled');
        const totalMinor = items.reduce((sum, it) => sum + it.totalPriceMinor, 0);

        matchingOrders.push({
          orderId: ord.id,
          orderNumber: ord.displayNumber,
          dayId: ord.dayId,
          businessDate: day ? day.businessDate : ord.createdAt.split('T')[0],
          customerId: ord.customerId,
          customerName: cust ? cust.name : 'عميل غير معروف',
          customerCode: cust ? getCustomerCode(cust) : '----',
          customerPhone: cust?.phone,
          createdAt: ord.createdAt,
          status: ord.status,
          totalMinor,
        });
      }
    }

    matchingOrders.sort(
      (a, b) => new Date(b.businessDate).getTime() - new Date(a.businessDate).getTime()
    );

    if (matchingOrders.length > 0) {
      const targetOrders = limit && limit > 0 ? matchingOrders.slice(0, limit) : matchingOrders;
      return {
        customers: [],
        orders: targetOrders,
        isOrderSearch: true,
        totalStoreCustomersCount,
        totalMatchingCount: matchingOrders.length,
      };
    }
  }

  // 3. Search customers by Name, Phone, or Customer Code across ALL active customers in store
  const qLower = q.toLowerCase();
  const matchingCusts: CustomerEntity[] = [];

  for (const cust of customersMap.values()) {
    if (!cust.isActive) continue;
    const code = getCustomerCode(cust).toLowerCase();
    const phone = (cust.phone || '').toLowerCase();
    const name = cust.name.toLowerCase();

    if (name.includes(qLower) || phone.includes(qLower) || code.includes(qLower)) {
      matchingCusts.push(cust);
    }
  }

  matchingCusts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const targetCusts = limit && limit > 0 ? matchingCusts.slice(0, limit) : matchingCusts;

  const customerResults: UICustomerListItem[] = [];
  for (const cust of targetCusts) {
    const balanceMinor = await repoContext.customerRepo.getBalance(cust.id);
    customerResults.push({
      id: cust.id,
      name: cust.name,
      phone: cust.phone || '',
      code: getCustomerCode(cust),
      currentBalanceMinor: balanceMinor,
      isActive: cust.isActive,
      createdAt: cust.createdAt,
    });
  }

  return {
    customers: customerResults,
    orders: [],
    isOrderSearch: false,
    totalStoreCustomersCount,
    totalMatchingCount: matchingCusts.length,
  };
};

export const calculateDeviceItemPreviewPrice = (
  deviceTypeId: string,
  hasCharger: boolean,
  customerExempt: boolean = false
): number => {
  const dev = devicesMap.get(deviceTypeId);
  if (!dev) return 0;

  const result = calculateItemPrice({
    basePriceMinor: dev.basePriceMinor,
    chargerFeeEnabled: dev.chargerFeeEnabled,
    customerExempt,
    hasCharger,
  });

  return result.totalPriceMinor;
};

export const findExistingCustomerOrderOnDay = async (
  dayId: string,
  customerId: string
): Promise<UIDayOrderDetail | undefined> => {
  await ensureStoreHydrated();

  // UIDayOrderDetail.customerId is a display code, not the canonical customer UUID.
  // Match against the effective order entities so pending local-first orders are included
  // and orders from any other business day can never be reused.
  const effectiveOrders = getEffectiveOrderItemReadModel().orders;
  const matchingOrderIds = new Set(
    Array.from(effectiveOrders.values())
      .filter((order) =>
        isSameDayId(order.dayId, dayId) &&
        order.customerId === customerId &&
        order.status !== 'cancelled'
      )
      .map((order) => order.id)
  );

  if (matchingOrderIds.size === 0) return undefined;

  // getOrdersForDay already sorts newest/highest-numbered orders first and projects
  // pending device changes; return the first reusable order from that same day.
  const dayOrders = await getOrdersForDay(dayId);
  return dayOrders.find((order) =>
    matchingOrderIds.has(order.id) && order.status !== 'cancelled'
  );
};

export interface UICustomerListItem {
  id: string;
  name: string;
  phone: string;
  code: string;
  currentBalanceMinor: number;
  isActive: boolean;
  createdAt: string;
}

export const getCustomersList = async (
  query?: string,
  limit?: number
): Promise<UICustomerListItem[]> => {
  await ensureStoreHydrated();
  const q = query ? query.trim().toLowerCase() : '';

  const matchingCusts: CustomerEntity[] = [];
  for (const cust of customersMap.values()) {
    if (!cust.isActive) continue;

    if (q) {
      const code = getCustomerCode(cust).toLowerCase();
      const phone = (cust.phone || '').toLowerCase();
      const name = cust.name.toLowerCase();
      if (!name.includes(q) && !phone.includes(q) && !code.includes(q)) {
        continue;
      }
    }

    matchingCusts.push(cust);
  }

  matchingCusts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // If explicit limit passed, slice results; otherwise return all matching customers
  const targetCusts = limit && limit > 0 ? matchingCusts.slice(0, limit) : matchingCusts;

  const result: UICustomerListItem[] = [];
  for (const cust of targetCusts) {
    const balanceMinor = await repoContext.customerRepo.getBalance(cust.id);
    result.push({
      id: cust.id,
      name: cust.name,
      phone: cust.phone || '',
      code: getCustomerCode(cust),
      currentBalanceMinor: balanceMinor,
      isActive: cust.isActive,
      createdAt: cust.createdAt,
    });
  }

  return result;
};

export interface UICustomerDetail {
  id: string;
  name: string;
  phone: string;
  code: string;
  currentBalanceMinor: number;
  debtLimitMinor: number;
  isActive: boolean;
  chargerFeeExempt?: boolean;
  createdAt: string;
}

export interface UICustomerOrderItemSummary {
  id: string;
  deviceName: string;
  priceMinor: number;
  hasCharger: boolean;
}

export interface UICustomerOrderSummary {
  id: string;
  orderNumber: number;
  dayId: string;
  /** Business-day date (YYYY-MM-DD), distinct from the creation timestamp. */
  businessDate: string;
  createdAt: string;
  status: string;
  paymentStatus: 'PAID' | 'PARTIAL' | 'UNPAID';
  totalMinor: number;
  itemCount: number;
  items: UICustomerOrderItemSummary[];
}

export const getCustomerDetail = async (customerId: string): Promise<UICustomerDetail | null> => {
  await ensureStoreHydrated();

  let cust = await repoContext.customerRepo.findById(customerId);
  if (!cust) {
    const all = Array.from(customersMap.values());
    cust = all.find((c) => c.id === customerId || getCustomerCode(c) === customerId) || null;
  }

  if (!cust) return null;

  const currentBalanceMinor = await repoContext.customerRepo.getBalance(cust.id);

  return {
    id: cust.id,
    name: cust.name,
    phone: cust.phone || '',
    code: getCustomerCode(cust),
    currentBalanceMinor,
    debtLimitMinor: cust.debtLimitMinor,
    isActive: cust.isActive,
    chargerFeeExempt: !!cust.chargerFeeExempt,
    createdAt: cust.createdAt,
  };
};

export const getCustomerOrders = async (
  customerId: string,
  locale: Locale = 'ar'
): Promise<UICustomerOrderSummary[]> => {
  await ensureStoreHydrated();

  let cust = await repoContext.customerRepo.findById(customerId);
  if (!cust) {
    const all = Array.from(customersMap.values());
    cust = all.find((c) => c.id === customerId || getCustomerCode(c) === customerId) || null;
  }

  if (!cust) return [];

  const targetId = cust.id;
  const effective = getEffectiveOrderItemReadModel();
  const effectiveOrdersMap = effective.orders;
  const effectiveItemsMap = effective.items;
  const custOrders = Array.from(effectiveOrdersMap.values()).filter((o) => o.customerId === targetId);

  const summaries: UICustomerOrderSummary[] = [];
  const allocMap = computeCustomerOrderPaymentStatuses(targetId, effectiveOrdersMap, effectiveItemsMap);

  for (const ord of custOrders) {
    const items = Array.from(effectiveItemsMap.values()).filter((i) => i.orderId === ord.id && i.status !== 'cancelled');
    const totalMinor = items.reduce((sum, i) => sum + i.totalPriceMinor, 0);

    const alloc = allocMap.get(ord.id);
    const paymentStatus: 'PAID' | 'PARTIAL' | 'UNPAID' =
      ord.status === 'cancelled'
        ? 'UNPAID'
        : (alloc?.paymentStatus || 'UNPAID');

    const itemSummaries: UICustomerOrderItemSummary[] = items.map((i, iIdx) => {
      const devName = getItemLocalizedDeviceName(i.deviceTypeId || i.deviceNameSnapshot, locale);
      return {
        id: i.id || (i as any).order_item_id || `item-${iIdx}-${ord.id}`,
        deviceName: devName,
        priceMinor: i.totalPriceMinor,
        hasCharger: i.hasCharger,
      };
    });

    summaries.push({
      id: ord.id || (ord as any).order_id || `order-${ord.displayNumber}-${summaries.length}`,
      orderNumber: ord.displayNumber,
      dayId: ord.dayId,
      businessDate: getCanonicalDayKey(ord.dayId),
      createdAt: ord.createdAt,
      status: ord.status,
      paymentStatus,
      totalMinor,
      itemCount: items.length,
      items: itemSummaries,
    });
  }

  return summaries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
};

export interface UICustomerFinancialItem {
  id: string;
  eventType: string;
  amountMinor: number;
  postBalanceMinor: number;
  createdAt: string;
  /** Business date inherited from the linked order, not ledger event time. */
  businessDate?: string;
  orderId?: string;
  orderItemId?: string;
  orderDisplayNumber?: number;
  description: string;
  shortTitle: string;
  note?: string;
  orderItems?: UICustomerOrderItemSummary[];
  orderTotalMinor?: number;
}

export const getCustomerFinancialHistory = async (
  customerId: string,
  locale: Locale = 'ar'
): Promise<UICustomerFinancialItem[]> => {
  await ensureStoreHydrated();

  let cust = await repoContext.customerRepo.findById(customerId);
  if (!cust) {
    const all = Array.from(customersMap.values());
    cust = all.find((c) => c.id === customerId || getCustomerCode(c) === customerId) || null;
  }

  if (!cust) return [];

  const targetId = cust.id;
  const effective = getEffectiveOrderItemReadModel();
  const effectiveOrdersMap = effective.orders;
  const effectiveItemsMap = effective.items;
  const authoritativeEvents = await repoContext.ledgerRepo.findByCustomer(targetId);
  const rawEvents: FinancialLedgerEntity[] = [...authoritativeEvents];
  const overlays = await localDb.listOverlays();
  const pendingProjectionEvents: Array<FinancialLedgerEntity & { __projectionSequence?: number }> = [];

  // Include pending ledger overlays in the visible history until the server's
  // canonical ledger row arrives. Deduplicate by event/reference identity to
  // avoid showing the same payment twice during the pull/overlay transition.
  for (const overlay of overlays) {
    if (
      overlay.status !== 'PENDING' ||
      (overlay.entityType !== 'ledger' && overlay.entityType !== 'financial_ledger') ||
      overlay.operation !== 'CREATE'
    ) {
      continue;
    }
    const payload = (overlay.entityPayload || overlay.patch || {}) as Record<string, unknown>;
    const eventCustomerId = String(payload.customerId ?? payload.customer_id ?? '');
    const eventType = String(payload.eventType ?? payload.event_type ?? '');
    const amountMinor = Number(payload.amountMinor ?? payload.amount_minor ?? 0);
    if (eventCustomerId !== targetId || !eventType || !Number.isFinite(amountMinor)) continue;

    const referenceId = String(payload.referenceId ?? payload.reference_id ?? '');
    const pendingPaymentOverlay = referenceId
      ? overlays.find((candidate) =>
          candidate.status === 'PENDING' &&
          candidate.entityType === 'payments' &&
          candidate.entityId === referenceId
        )
      : undefined;
    const pendingPaymentPayload = (pendingPaymentOverlay?.entityPayload || pendingPaymentOverlay?.patch || {}) as Record<string, unknown>;
    const noteText = payload.reference ?? payload.note ?? pendingPaymentPayload.reference ?? pendingPaymentPayload.note;
    const alreadyAuthoritative = rawEvents.some((event) =>
      event.eventType === eventType &&
      ((referenceId && event.referenceId === referenceId) || event.id === overlay.entityId)
    );
    if (alreadyAuthoritative) continue;

    pendingProjectionEvents.push({
      ...(payload as unknown as FinancialLedgerEntity),
      id: String(payload.id ?? `pending-ledger:${overlay.commandId}`),
      customerId: targetId,
      eventType: eventType as FinancialLedgerEntity['eventType'],
      amountMinor,
      referenceId: referenceId || undefined,
      createdAt: String(payload.createdAt ?? overlay.createdAt),
      metadata: {
        ...((payload.metadata || {}) as Record<string, unknown>),
        ...(noteText ? { note: String(noteText) } : {}),
      },
      __projectionSequence: Number(overlay.sequence ?? 0),
    });
  }

  // A delivered item has a pending financial effect before the server writes
  // its canonical ledger row. Project that charge into history using the same
  // recognition/amount fields as the balance projection.
  const authoritativeChargeItemIds = new Set(
    rawEvents
      .filter((event) => event.eventType === 'ORDER_ITEM_CHARGE')
      .flatMap((event) => [event.orderItemId, event.referenceId].filter((id): id is string => Boolean(id)))
  );
  // Legacy order-level charges do not identify an item. Do not synthesize a
  // second charge for every delivered item in an order that already has one.
  const legacyOrderChargeIds = new Set(
    rawEvents
      .filter((event) => event.eventType === 'ORDER_ITEM_CHARGE' && !event.orderItemId && event.orderId)
      .map((event) => event.orderId as string)
  );
  for (const item of effectiveItemsMap.values()) {
    if (item.status === 'cancelled') continue;
    const financialStatus = String(item.financialStatus || '').toUpperCase();
    if (item.status !== 'delivered' && financialStatus !== 'RECOGNIZED') continue;
    if (authoritativeChargeItemIds.has(item.id) || legacyOrderChargeIds.has(item.orderId)) continue;
    const order = effectiveOrdersMap.get(item.orderId);
    if (!order || order.customerId !== targetId) continue;
    const amountMinor = Number(item.finalChargeSnapshotMinor ?? item.totalPriceMinor ?? 0);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) continue;
    const alreadyProjected = pendingProjectionEvents.some(
      (event) => event.eventType === 'ORDER_ITEM_CHARGE' && event.orderItemId === item.id
    );
    if (alreadyProjected) continue;
    const recognizedAt = item.financiallyRecognizedAt || item.deliveredAt || item.updatedAt || item.createdAt;
    pendingProjectionEvents.push({
      id: `pending-delivery:${item.id}`,
      eventType: 'ORDER_ITEM_CHARGE',
      amountMinor: -amountMinor,
      customerId: targetId,
      orderId: order.id,
      orderItemId: item.id,
      referenceId: item.id,
      actorAdminId: '',
      createdAt: recognizedAt,
      metadata: {},
      __projectionSequence: overlays.find(
        (overlay) => overlay.status === 'PENDING' && overlay.entityType === 'order_items' && overlay.entityId === item.id
      )?.sequence ?? 0,
    } as FinancialLedgerEntity & { __projectionSequence?: number });
  }

  rawEvents.push(...pendingProjectionEvents);

  // Sort ascending by time (oldest first) to compute running post-transaction balances.
  // Overlay sequence breaks same-millisecond ties deterministically.
  const sortedAsc = [...rawEvents].sort((a, b) => {
    const timeDifference = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (timeDifference !== 0) return timeDifference;
    return Number((a as any).__projectionSequence ?? 0) - Number((b as any).__projectionSequence ?? 0);
  });

  let runningBalance = 0;
  const items: UICustomerFinancialItem[] = [];

  for (const ev of sortedAsc) {
    runningBalance += ev.amountMinor;

    let orderDisplayNumber: number | undefined;
    let orderItems: UICustomerOrderItemSummary[] | undefined;
    let orderTotalMinor: number | undefined;

    if (ev.orderId) {
      const ord = effectiveOrdersMap.get(ev.orderId);
      if (ord) {
        orderDisplayNumber = ord.displayNumber;
      }
      if (ev.eventType === 'ORDER_ITEM_CHARGE' && ev.orderItemId) {
        const targetItem = effectiveItemsMap.get(ev.orderItemId);
        if (targetItem) {
          const devName = getItemLocalizedDeviceName(targetItem.deviceTypeId || targetItem.deviceNameSnapshot, locale);
          orderItems = [
            {
              id: targetItem.id || `orderitem-${ev.orderItemId}`,
              deviceName: devName,
              priceMinor: targetItem.totalPriceMinor,
              hasCharger: targetItem.hasCharger,
            },
          ];
          orderTotalMinor = targetItem.totalPriceMinor;
        }
      }
      if (!orderItems) {
        const rawItems = Array.from(effectiveItemsMap.values()).filter((i) => i.orderId === ev.orderId && i.status !== 'cancelled');
        if (rawItems.length > 0) {
          orderItems = rawItems.map((i, rawIdx) => {
            const devName = getItemLocalizedDeviceName(i.deviceTypeId || i.deviceNameSnapshot, locale);
            return {
              id: i.id || `orderitem-${rawIdx}-${ev.id || ev.orderId}`,
              deviceName: devName,
              priceMinor: i.totalPriceMinor,
              hasCharger: i.hasCharger,
            };
          });
          orderTotalMinor = rawItems.reduce((sum, i) => sum + i.totalPriceMinor, 0);
        }
      }
    }

    let description = '';
    let shortTitle = '';

    if (ev.eventType === 'ORDER_ITEM_CHARGE') {
      const singleDevName = orderItems && orderItems.length === 1 ? orderItems[0].deviceName : undefined;
      shortTitle =
        locale === 'ar'
          ? orderDisplayNumber
            ? `طلب #${orderDisplayNumber}`
            : 'طلب'
          : orderDisplayNumber
          ? `Order #${orderDisplayNumber}`
          : 'Order';
      description = singleDevName
        ? locale === 'ar'
          ? `تسليم جهاز (${singleDevName})`
          : `Device Delivered (${singleDevName})`
        : locale === 'ar'
        ? orderDisplayNumber
          ? `خصم قيمة الطلب رقم #${orderDisplayNumber}`
          : 'خصم قيمة الطلب من رصيد العميل'
        : orderDisplayNumber
        ? `Order charge deducted for order #${orderDisplayNumber}`
        : 'Order charge deducted from balance';
    } else if (ev.eventType === 'PAYMENT' || ev.eventType === 'CREDIT_ADJUSTMENT') {
      shortTitle = locale === 'ar' ? 'إضافة رصيد' : 'Balance added';
      description = locale === 'ar' ? 'إضافة مبلغ مالي لرصيد العميل' : 'Payment added to balance';
    } else if (ev.eventType === 'REFUND' || ev.eventType === 'REVERSAL') {
      shortTitle =
        locale === 'ar'
          ? orderDisplayNumber
            ? `استرداد الطلب #${orderDisplayNumber}`
            : 'استرداد مالي'
          : orderDisplayNumber
          ? `Order #${orderDisplayNumber} refund`
          : 'Refund';
      description =
        locale === 'ar'
          ? orderDisplayNumber
            ? `استرداد قيمة الطلب رقم #${orderDisplayNumber}`
            : 'استرداد مبلغ مالي للعميل'
          : orderDisplayNumber
          ? `Refund for order #${orderDisplayNumber}`
          : 'Customer refund';
    } else if (ev.eventType === 'CREDIT_USED') {
      shortTitle =
        locale === 'ar'
          ? orderDisplayNumber
            ? `رصيد لطلب #${orderDisplayNumber}`
            : 'استخدام رصيد'
          : orderDisplayNumber
          ? `Order #${orderDisplayNumber} credit applied`
          : 'Credit applied';
      description =
        locale === 'ar'
          ? orderDisplayNumber
            ? `استخدام الرصيد لسداد الطلب رقم #${orderDisplayNumber}`
            : 'استخدام الرصيد المالي'
          : orderDisplayNumber
          ? `Credit applied towards order #${orderDisplayNumber}`
          : 'Used credit balance';
    } else if (ev.eventType === 'BONUS') {
      shortTitle = locale === 'ar' ? 'مكافأة إتمام الهدف' : 'Goal completion bonus';
      description =
        locale === 'ar'
          ? 'إضافة مكافأة مالية إلى رصيد العميل لإتمام الهدف'
          : 'Reward credited to the customer balance for completing a goal';
    } else {
      shortTitle = ev.eventType;
      description = ev.eventType;
    }

    let note: string | undefined;
    if (ev.referenceId) {
      const p = paymentsMap.get(ev.referenceId);
      if (p?.reference) {
        note = p.reference;
      }
    }
    if (!note && ev.metadata?.note) {
      note = String(ev.metadata.note);
    } else if (!note && ev.metadata?.description) {
      note = String(ev.metadata.description);
    }

    items.push({
      id: ev.id || `ledger-${ev.createdAt}-${items.length}`,
      eventType: ev.eventType,
      amountMinor: ev.amountMinor,
      postBalanceMinor: runningBalance,
      createdAt: ev.createdAt,
      ...(ev.orderId && effectiveOrdersMap.get(ev.orderId)
        ? { businessDate: getCanonicalDayKey(effectiveOrdersMap.get(ev.orderId)!.dayId) }
        : {}),
      orderId: ev.orderId,
      orderItemId: ev.orderItemId,
      orderDisplayNumber,
      description,
      shortTitle,
      note,
      orderItems,
      orderTotalMinor,
    });
  }

  // Presentation-only projection: combine item-level charge events into one order row.
  // The underlying ledger events and balance calculations remain unchanged.
  return groupCustomerFinancialHistoryByOrder(items, locale);
};

export const updateCustomer = async (
  customerId: string,
  data: {
    name?: string;
    phone?: string;
    debtLimitMinor?: number;
    isActive?: boolean;
  },
  bin?: string
): Promise<UICustomerDetail> => {
  await ensureStoreHydrated();
  let cust = customersMap.get(customerId);
  if (!cust) {
    const all = Array.from(customersMap.values());
    cust = all.find((c) => c.id === customerId || getCustomerCode(c) === customerId);
  }

  if (!cust) {
    throw new Error('Customer not found');
  }

  const updated: CustomerEntity = {
    ...cust,
    name: data.name !== undefined ? data.name : cust.name,
    phone: data.phone !== undefined ? data.phone : cust.phone,
    debtLimitMinor: data.debtLimitMinor !== undefined ? data.debtLimitMinor : cust.debtLimitMinor,
    isActive: data.isActive !== undefined ? data.isActive : cust.isActive,
    updatedAt: new Date().toISOString(),
    version: cust.version + 1,
  };

  const customerAuth = getAuthorizedAdminContext();
  const customerUpdates: Partial<CustomerEntity> = {
    ...(data.name !== undefined ? { name: updated.name } : {}),
    ...(data.phone !== undefined ? { phone: updated.phone } : {}),
    ...(data.debtLimitMinor !== undefined ? { debtLimitMinor: updated.debtLimitMinor } : {}),
    ...(data.isActive !== undefined ? { isActive: updated.isActive } : {}),
  };
  const updateResult = await phase5UseCases.updateCustomer(
    customerAuth,
    updated.id,
    customerUpdates,
    data.debtLimitMinor !== undefined ? bin : undefined
  );
  if (!updateResult.success) {
    throw new Error(('error' in updateResult ? updateResult.error : undefined) || 'فشل تحديث بيانات العميل');
  }
  const currentBalanceMinor = await repoContext.customerRepo.getBalance(updated.id);

  return {
    id: updated.id,
    name: updated.name,
    phone: updated.phone || '',
    code: getCustomerCode(updated),
    currentBalanceMinor,
    debtLimitMinor: updated.debtLimitMinor,
    isActive: updated.isActive,
    createdAt: updated.createdAt,
  };
};

export const addNewCustomer = async (
  name: string,
  phone: string,
  debtLimitMinor: number = 2000
): Promise<UICustomerItem> => {
  const result = await phase5UseCases.createCustomer(
    getAuthorizedAdminContext(),
    name,
    phone,
    debtLimitMinor,
    false
  );
  if (!result.success) {
    throw new Error(presentError(('error' in result ? result.error : undefined) || 'فشل إنشاء العميل'));
  }

  const newCust = result.data;
  return {
    id: newCust.id,
    name: newCust.name,
    code: getCustomerCode(newCust),
    phone: newCust.phone || '',
    debtLimitMinor: newCust.debtLimitMinor,
    chargerFeeExempt: newCust.chargerFeeExempt,
  };
};

export interface UIEditOrderItem {
  id: string;
  deviceTypeId: string;
  deviceName: string;
  priceMinor: number;
  hasCharger: boolean;
  discountSnapshotMinor?: number;
  status: 'charging' | 'delivered' | 'cancelled';
  isExisting: boolean;
}

export interface UIEditOrderDetail {
  id: string;
  dayId: string;
  orderNumber: number;
  customerName: string;
  customerId: string;
  customerPhone: string;
  debtLimitMinor: number;
  customerBalanceSnapshotMinor?: number;
  status: 'pending' | 'charging' | 'delivered' | 'cancelled';
  createdAt: string;
  notes?: string;
  items: UIEditOrderItem[];
  customerChargerFeeExempt: boolean;
}

export const getOrderForEdit = async (
  orderId: string,
  locale: Locale = 'ar'
): Promise<UIEditOrderDetail | null> => {
  await ensureStoreHydrated();
  const order = await repoContext.orderRepo.findById(orderId);
  if (!order) return null;

  const cust = await repoContext.customerRepo.findById(order.customerId);
  const orderItems = await repoContext.itemRepo.findByOrderId(orderId);

  // Authoritative Historical Reconstruction for Legacy Orders missing snapshot (DISPLAY ONLY - READ-ONLY)
  let snapshotMinor = order.customerBalanceSnapshotMinor;
  if (snapshotMinor === undefined && cust) {
    const customerLedger = await repoContext.ledgerRepo.findByCustomer(cust.id);
    const orderCreatedAtTime = new Date(order.createdAt).getTime();

    // Find ledger entries created strictly before this order's creation time
    const priorLedger = customerLedger.filter(
      (l) => new Date(l.createdAt).getTime() < orderCreatedAtTime
    );

    if (priorLedger.length > 0) {
      snapshotMinor = priorLedger.reduce((sum, l) => sum + l.amountMinor, 0);
    }
  }

  const uiItems: UIEditOrderItem[] = await Promise.all(
    orderItems.map(async (i) => {
      let devName = i.deviceNameSnapshot;
      if (i.deviceTypeId) {
        const dev = await repoContext.deviceRepo.findById(i.deviceTypeId);
        if (dev) {
          const loc = UI_DEVICE_LOCALIZATIONS[dev.id] || UI_DEVICE_NAME_MAP[dev.name] || { ar: dev.name, en: dev.name };
          devName = locale === 'en' ? loc.en : loc.ar;
        }
      }
      if (!devName) {
        devName = getItemLocalizedDeviceName(i.deviceNameSnapshot || i.deviceTypeId, locale);
      }

      return {
        id: i.id,
        deviceTypeId: i.deviceTypeId,
        deviceName: devName,
        priceMinor: i.totalPriceMinor,
        hasCharger: i.hasCharger,
        discountSnapshotMinor: i.discountSnapshotMinor ?? 0,
        status: i.status,
        isExisting: true,
      };
    })
  );

  return {
    id: order.id,
    dayId: order.dayId,
    orderNumber: order.displayNumber,
    customerName: cust ? cust.name : locale === 'ar' ? 'عميل غير معروف' : 'Unknown Customer',
    customerId: cust ? getCustomerCode(cust) : 'A7K2',
    customerPhone: cust ? cust.phone || '' : '',
    debtLimitMinor: cust ? cust.debtLimitMinor : -2000,
    customerBalanceSnapshotMinor: snapshotMinor,
    customerChargerFeeExempt: cust?.chargerFeeExempt ?? false,
    status: calculateOrderProjection(orderItems, order.status),
    createdAt: order.createdAt,
    notes: order.notes,
    items: uiItems,
  };
};

export const deliverSingleOrderItem = async (
  orderItemId: string,
  bin: string = ''
): Promise<{ success: boolean; item?: OrderItemEntity; error?: string }> => {
  await ensureStoreHydrated();
  try {
    const offline = isBrowserOffline();
    const auth = getAuthorizedAdminContext(bin);
    if (!offline) await auth.verifyBin(bin);
    const result = await phase5UseCases.deliverOrderItem(auth, orderItemId, bin, { deferBinVerification: offline });
    if (result.success) {
      const item = result.data;
      notifyStore('all');
      return { success: true, item: result.data };
    }
    return { success: false, error: 'فشل تسليم الجهاز' };
  } catch (err: any) {
    return { success: false, error: presentError(err) };
  }
};

export const deliverEntireOrder = async (
  orderId: string,
  bin: string = '',
  options?: { binAlreadyVerified?: boolean }
): Promise<{ success: boolean; deliveredCount?: number; error?: string }> => {
  await ensureStoreHydrated();
  try {
    const offline = isBrowserOffline();
    const auth = getAuthorizedAdminContext(bin);
    if (!offline && !options?.binAlreadyVerified) await auth.verifyBin(bin);
    const orderEntity = await repoContext.orderRepo.findById(orderId);
    if (!orderEntity) return { success: false, error: 'الطلب غير موجود' };
    if (orderEntity.status === 'cancelled') return { success: false, error: 'الطلب ملغى' };

    const items = await repoContext.itemRepo.findByOrderId(orderId);
    const activeItems = items.filter((i) => i.status !== 'cancelled');
    if (activeItems.length === 0) return { success: false, error: 'لا يمكن تسليم طلب فارغ' };

    let count = 0;
    for (const item of items) {
      if (item.status !== 'delivered' && item.status !== 'cancelled') {
        await phase5UseCases.deliverOrderItem(auth, item.id, bin, { deferBinVerification: offline, binAlreadyVerified: !offline });
        count++;
      }
    }

    notifyStore('all');
    return { success: true, deliveredCount: count };
  } catch (err: any) {
    return { success: false, error: presentError(err) };
  }
};

export const updateOrderWithPhase5Engine = async (
  orderId: string,
  newNotes: string,
  newStatus: 'pending' | 'charging' | 'delivered' | 'cancelled',
  newItemsToAdd: { deviceTypeId: string; hasCharger: boolean }[],
  existingItemIdsToRemove: string[],
  bin?: string,
  existingItemEdits: { itemId: string; deviceTypeId: string; hasCharger: boolean }[] = []
): Promise<{ success: boolean; error?: string }> => {
  try {
    const order = await repoContext.orderRepo.findById(orderId);
    if (!order) return { success: false, error: 'الطلب غير موجود' };

    const offline = isBrowserOffline();
    const auth = getAuthorizedAdminContext(bin);
    const initialItems = await repoContext.itemRepo.findByOrderId(orderId);
    const removeIds = new Set(existingItemIdsToRemove);
    const itemsById = new Map(initialItems.map((item) => [item.id, item]));
    const editIds = new Set(existingItemEdits.map((edit) => edit.itemId));
    if (editIds.size !== existingItemEdits.length || existingItemEdits.some((edit) =>
      !itemsById.has(edit.itemId) || removeIds.has(edit.itemId) || itemsById.get(edit.itemId)?.status !== 'charging'
    )) {
      return { success: false, error: 'لا يمكن تعديل جهاز تم تسليمه أو إلغاؤه، أو تغيّرت بيانات الطلب. أعد فتح الطلب وحاول مرة أخرى.' };
    }
    for (const edit of existingItemEdits) {
      const device = await repoContext.deviceRepo.findById(edit.deviceTypeId);
      if (!device || !device.isActive) return { success: false, error: 'نوع الجهاز المحدد غير متاح. حدّث الصفحة واختر نوعاً فعالاً.' };
    }

    // Validate the complete requested edit before queueing any local command.
    // This prevents a missing/invalid BIN or an impossible status transition from
    // leaving notes/additions queued while the requested removal is rejected.
    if (removeIds.size !== existingItemIdsToRemove.length ||
        existingItemIdsToRemove.some((id) => !itemsById.has(id))) {
      return { success: false, error: 'تغيّرت عناصر الطلب. أعد فتح الطلب وراجع الأجهزة قبل الحفظ.' };
    }

    const hasAnyEdit =
      newNotes !== (order.notes || '') ||
      newItemsToAdd.length > 0 ||
      existingItemEdits.length > 0 ||
      existingItemIdsToRemove.length > 0 ||
      newStatus !== order.status;

    if (order.status === 'cancelled' && hasAnyEdit) {
      return { success: false, error: 'لا يمكن تعديل طلب ملغي.' };
    }

    const predictedItems = [
      ...initialItems
        .filter((item) => !removeIds.has(item.id))
        .map((item) => ({ status: item.status })),
      ...newItemsToAdd.map(() => ({ status: 'charging' })),
    ];
    const predictedStatus = calculateOrderProjection(predictedItems, order.status);

    // Revalidate projection only when the caller is actually changing the order
    // status. A note-only edit passes the current status back from the UI; rejecting
    // that edit because item-level statuses project differently would block ordinary
    // note edits on existing orders.
    if (newStatus !== order.status) {
      if (newStatus === 'pending' && predictedStatus !== 'pending') {
        throw new ConflictError(`Invalid order status transition from '${predictedStatus}' to 'pending'`);
      }
      if (newStatus === 'charging' && predictedStatus !== 'charging') {
        throw new ConflictError(`Invalid order status transition from '${predictedStatus}' to 'charging'`);
      }
    }
    if (newStatus === 'cancelled' && order.status !== 'cancelled') {
      validateOrderTransition(order.status, 'cancelled');
    }
    if (newStatus === 'delivered' && order.status === 'cancelled') {
      throw new ConflictError("A cancelled order cannot be delivered");
    }

    const hasUndeliveredActiveItemAfterEdits = predictedItems.some(
      (item) => item.status !== 'delivered' && item.status !== 'cancelled'
    );

    // Preflight every permission boundary before queueing any part of this edit.
    if (newNotes !== (order.notes || '') || newItemsToAdd.length > 0 || existingItemEdits.length > 0) {
      auth.assertPermission('orders:edit');
    }
    if (existingItemIdsToRemove.length > 0 ||
        (newStatus === 'cancelled' && newStatus !== order.status)) {
      auth.assertPermission('orders:cancel');
    }
    if (newStatus === 'delivered' &&
        (newStatus !== order.status || hasUndeliveredActiveItemAfterEdits)) {
      auth.assertPermission('orders:deliver');
    }

    const requiresBin =
      existingItemIdsToRemove.length > 0 ||
      (newStatus === 'delivered' &&
        (newStatus !== order.status || hasUndeliveredActiveItemAfterEdits)) ||
      (newStatus === 'cancelled' && newStatus !== order.status);

    if (!offline && requiresBin) {
      await auth.verifyBin(bin || '');
    }
    const binAlreadyVerified = !offline && requiresBin;

    // 1. Update Order Notes if changed (after all local preflight checks).
    if (newNotes !== (order.notes || '')) {
      await phase5UseCases.editOrderNotes(auth, orderId, newNotes);
    }

    // 2. Removing an existing device is a cancellation, not a physical delete.
    // The canonical command preserves the item and lets the server reverse any
    // recognized charge exactly once.
    for (const itemId of existingItemIdsToRemove) {
      await phase5UseCases.removeOrderItemDuringEdit(auth, itemId, bin || '', {
        deferBinVerification: offline,
        binAlreadyVerified,
      });
    }

    // 3. Update existing charging items through the canonical command boundary.
    for (const edit of existingItemEdits) {
      const result = await phase5UseCases.updateOrderItem(auth, edit.itemId, edit.deviceTypeId, edit.hasCharger);
      if (!result.success) return { success: false, error: (result as any).error || 'فشل تعديل الجهاز. لم يتم تجاهل الخطأ.' };
    }

    // 4. Add new items using the existing application boundary.
    for (const item of newItemsToAdd) {
      const itemRes = await phase5UseCases.addOrderItem(
        auth,
        orderId,
        item.deviceTypeId,
        item.hasCharger
      );
      if (!itemRes.success) {
        const err = (itemRes as any).error || 'فشل إضافة الجهاز للطلب';
        return { success: false, error: err };
      }
    }

    // 4. Resolve status against the effective item state AFTER edits.
    const effectiveItemsAfterEdits = await repoContext.itemRepo.findByOrderId(orderId);
    const hasUndeliveredActiveItem = effectiveItemsAfterEdits.some(
      (item) => item.status !== 'delivered' && item.status !== 'cancelled'
    );

    // Revalidate the order projection only for a requested status transition.
    // A note-only edit passes the unchanged status and must not be rejected just
    // because item-level projection differs from the persisted aggregate status.
    if (newStatus === 'pending' && newStatus !== order.status) {
      const currentProjectedStatus = calculateOrderProjection(effectiveItemsAfterEdits, order.status);
      if (currentProjectedStatus !== 'pending') {
        throw new ConflictError(`Invalid order status transition from '${currentProjectedStatus}' to 'pending'`);
      }
    } else if (newStatus === 'charging' && newStatus !== order.status) {
      const currentProjectedStatus = calculateOrderProjection(effectiveItemsAfterEdits, order.status);
      if (currentProjectedStatus !== 'charging') {
        throw new ConflictError(`Invalid order status transition from '${currentProjectedStatus}' to 'charging'`);
      }
    } else if (newStatus === 'delivered') {
      // Only undelivered active items are delivered/recognized. Already-delivered
      // items remain immutable and are never charged a second time.
      if (hasUndeliveredActiveItem) {
        const deliverRes = await deliverEntireOrder(orderId, bin || '', { binAlreadyVerified });
        if (!deliverRes.success) {
          return { success: false, error: deliverRes.error || 'فشل تسليم الطلب' };
        }
      }
    } else if (newStatus === 'cancelled' && order.status !== 'cancelled') {
      await phase5UseCases.cancelOrder(auth, orderId, bin || '', {
        deferBinVerification: offline,
        binAlreadyVerified,
      });
    }

    return { success: true };
  } catch (err: any) {
    if (err instanceof ClosedDayError) {
      return { success: false, error: 'اليوم التشغيلي مغلق. لا يمكن تعديل الطلب.' };
    }
    if (err instanceof NotFoundError) {
      return { success: false, error: 'السجل المطلوب غير موجود.' };
    }
    if (err instanceof ConflictError) {
      return { success: false, error: 'تعارض في بيانات السجل. يرجى المحاولة مرة أخرى.' };
    }
    return { success: false, error: presentError(err) };
  }
};

export const deliverAllOrdersInDay = async (
  dayId: string,
  bin: string = ''
): Promise<{ success: boolean; deliveredCount?: number; error?: string }> => {
  await ensureStoreHydrated();
  try {
    const offline = isBrowserOffline();
    const auth = getAuthorizedAdminContext(bin);
    if (!offline) await auth.verifyBin(bin);
    const dayOrders = await getOrdersForDay(dayId);
    let count = 0;

    for (const ord of dayOrders) {
      if (ord.status === 'cancelled') continue;

      const orderEntity = await repoContext.orderRepo.findById(ord.id);
      if (!orderEntity) continue;

      const items = await repoContext.itemRepo.findByOrderId(ord.id);
      const activeItems = items.filter((i) => i.status !== 'cancelled');
      if (activeItems.length === 0) continue;

      let deliveredInThisOrder = false;
      for (const item of items) {
        if (item.status !== 'delivered' && item.status !== 'cancelled') {
          await phase5UseCases.deliverOrderItem(auth, item.id, bin, { deferBinVerification: offline, binAlreadyVerified: !offline });
          deliveredInThisOrder = true;
        }
      }

      if (deliveredInThisOrder) count++;
    }

    return { success: true, deliveredCount: count };
  } catch (err: any) {
    return { success: false, error: presentError(err) };
  }
};

const inFlightOrderQrTokens = new Map<string, Promise<string>>();

export const getOrCreateOrderQrToken = async (orderId: string): Promise<string> => {
  if (inFlightOrderQrTokens.has(orderId)) {
    return inFlightOrderQrTokens.get(orderId)!;
  }

  const promise = (async () => {
    await ensureStoreHydrated();
    await initDbIfNeeded();

    try {
      const centralToken = await rpcGetOrCreateOrderQr(orderId);
      if (centralToken) {
        return centralToken;
      }
    } catch (err) {
      console.info('Supabase central order QR lookup deferred or offline:', err);
    }

    const allTokens = await localDb.list<QrTokenEntity>('qr_tokens');
    const existingActive = allTokens.find(
      (t) => t.targetId === orderId && t.tokenType === 'ORDER' && t.isActive
    );
    if (existingActive) {
      return existingActive.publicToken;
    }

    const publicToken = generateSecurePublicToken();
    const tokenHash = await computeTokenHash(publicToken);

    const newToken: QrTokenEntity = {
      id: crypto.randomUUID(),
      tokenHash,
      publicToken,
      tokenType: 'ORDER',
      targetId: orderId,
      isActive: true,
      createdAt: new Date().toISOString(),
    };

    await persistQrTokenCanonical(newToken);
    return publicToken;
  })();

  inFlightOrderQrTokens.set(orderId, promise);
  try {
    return await promise;
  } finally {
    inFlightOrderQrTokens.delete(orderId);
  }
};

export interface UIOrderQrCardData {
  orderId: string;
  orderNumber: number;
  customerName: string;
  customerId: string;
  dayId: string;
  token: string;
  publicUrl: string;
}

export const getOrderQrCardData = async (
  dayId: string,
  orderId: string
): Promise<UIOrderQrCardData | null> => {
  await ensureStoreHydrated();
  await initDbIfNeeded();

  const order = ordersMap.get(orderId) || (await localDb.get<OrderEntity>('orders', orderId));
  if (!order) return null;
  // Never mint a QR card/token with a fabricated or invalid display number.
  if (!Number.isInteger(order.displayNumber) || order.displayNumber <= 0) {
    throw new Error('ORDER_NUMBER_UNAVAILABLE');
  }

  const customer = customersMap.get(order.customerId) || (await localDb.get<CustomerEntity>('customers', order.customerId));
  const customerName = customer ? customer.name : order.customerId;

  const publicToken = await getOrCreateOrderQrToken(orderId);
  const origin =
    typeof window !== 'undefined' && window.location.origin
      ? window.location.origin
      : '';
  const publicUrl = `${origin}/o/${publicToken}`;

  return {
    orderId: order.id,
    orderNumber: order.displayNumber,
    customerName,
    customerId: order.customerId,
    dayId,
    token: publicToken,
    publicUrl,
  };
};

export const getBusinessDay = async (dayId: string): Promise<BusinessDayEntity | null> => {
  await ensureStoreHydrated();
  return daysMap.get(dayId) || null;
};

export const ensureBusinessDayEntityExists = async (dayId: string): Promise<BusinessDayEntity> => {
  await ensureStoreHydrated();
  let day = daysMap.get(dayId);
  if (!day) {
    let businessDate = dayId.startsWith('day-') ? dayId.slice(4) : dayId;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      businessDate = getLocalBusinessDateStr();
    }
    day = {
      id: dayId,
      businessDate,
      isClosed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    // Recovery/read-model repair only: an orphaned order reference must not
    // manufacture an OPEN_DAY command and mutate the authoritative server.
    daysMap.set(day.id, day);
    await localDb.set('businessDays', day.id, day);
  }
  return day;
};

export const createOrderWithPhase5Engine = async (
  dayId: string,
  customerId: string,
  items: { deviceTypeId: string; hasCharger: boolean }[],
  notes?: string
): Promise<{ success: boolean; error?: string; errorCode?: string; order?: UIDayOrderDetail }> => {
  if (!items || items.length === 0) {
    return { success: false, error: 'يجب اختيار جهاز واحد على الأقل للطلب' };
  }

  await ensureBusinessDayEntityExists(dayId);
  const commandId = crypto.randomUUID();

  try {
    // One transaction owns the complete aggregate creation:
    // order + every item + outbox commands + initial ledger entries.
    const result = await phase5UseCases.createOrderWithItems(
      getAuthorizedAdminContext(),
      commandId,
      dayId,
      customerId,
      items,
      notes
    );

    if (!result.success) {
      return { success: false, error: presentError(('error' in result ? result.error : undefined) || 'فشل إنشاء الطلب'), errorCode: 'code' in result ? result.code : undefined };
    }

    const orderEntity = result.data.order;
    const dayOrders = await getOrdersForDay(dayId);
    const createdUIOrder = dayOrders.find((o) => o.id === orderEntity.id);

    return { success: true, order: createdUIOrder };
  } catch (err: any) {
    if (err instanceof ClosedDayError) {
      return { success: false, error: 'اليوم التشغيلي مغلق. لا يمكن إضافة طلبات جديدة.' };
    }
    if (err instanceof InactiveCustomerError) {
      return { success: false, error: 'العميل غير نشط. يرجى تفعيل العميل قبل تقديم الطلب.' };
    }
    if (err instanceof NotFoundError) {
      return { success: false, error: 'السجل المطلوب غير موجود.' };
    }
    if (err instanceof ConflictError) {
      return { success: false, error: 'تعارض في بيانات السجل. يرجى المحاولة مرة أخرى.' };
    }

    return { success: false, error: presentError(err) };
  }
};

// ==========================================
// PHASE 6.5.2B: PERSISTENT RANDOM PUBLIC CAPABILITY HANDLE (OPTION C)
// Aligned with 00007_persistent_qr_identity.sql
// ==========================================

export interface UICustomerQrCardData {
  customerId: string;
  customerName: string;
  customerCode: string;
  token: string;
  publicUrl: string;
}

export interface PublicCustomerQrData {
  customerName: string;
  customerCode: string;
  token: string;
}

// Concurrency lock to prevent race conditions during simultaneous token requests
const inFlightCustomerQrTokens = new Map<string, Promise<string>>();

/**
 * Cache the authoritative server token locally for offline reads. This is a
 * cache of an already-persisted identity, never a locally-created identity.
 */
const cacheCanonicalCustomerQrToken = async (
  customerId: string,
  publicToken: string
): Promise<void> => {
  const localTokens = await localDb.list<QrTokenEntity>('qr_tokens');

  for (const token of localTokens) {
    if (
      token.targetId === customerId &&
      token.tokenType === 'CUSTOMER' &&
      token.isActive &&
      token.publicToken !== publicToken
    ) {
      await persistQrTokenCanonical({ ...token, isActive: false });
    }
  }

  const existing = localTokens.find(
    (token) =>
      token.targetId === customerId &&
      token.tokenType === 'CUSTOMER' &&
      token.publicToken === publicToken
  );

  if (existing) {
    await persistQrTokenCanonical({
      ...existing,
      tokenHash: await computeTokenHash(publicToken),
      publicToken,
      expiresAt: undefined,
      isActive: true,
    });
    return;
  }

  const id = globalThis.crypto?.randomUUID?.();
  if (!id) {
    throw new Error('CUSTOMER_QR_LOCAL_CACHE_FAILED: crypto.randomUUID is unavailable.');
  }

  await persistQrTokenCanonical({
    id,
    publicToken,
    tokenHash: await computeTokenHash(publicToken),
    tokenType: 'CUSTOMER',
    targetId: customerId,
    isActive: true,
    createdAt: new Date().toISOString(),
  });
};

/**
 * Returns the canonical, server-persisted customer QR capability.
 *
 * Customer QR links are public links intended to open on other devices, so a
 * browser-local token is not a valid substitute for a server token. Never mint
 * or return a local-only token when central persistence is unavailable.
 */
export const getOrCreateCustomerQrToken = async (customerId: string): Promise<string> => {
  if (inFlightCustomerQrTokens.has(customerId)) {
    return inFlightCustomerQrTokens.get(customerId)!;
  }

  const promise = (async () => {
    if (isBrowserOffline()) {
      throw new Error('CUSTOMER_QR_REQUIRES_ONLINE: Connect to the internet to create a shareable customer QR code.');
    }

    if (!getSupabaseStatus().isConfigured) {
      throw new Error('CUSTOMER_QR_REQUIRES_SUPABASE: Central QR storage is not configured.');
    }

    await ensureStoreHydrated();
    await initDbIfNeeded();

    // Preserve a previously shared local-only URL when it has not already been
    // superseded centrally. The adoption RPC returns the existing central token
    // if one already exists, so a current server identity is never overwritten.
    const localTokens = await localDb.list<QrTokenEntity>('qr_tokens');
    const existingLocal = localTokens.find(
      (t) => t.targetId === customerId && t.tokenType === 'CUSTOMER' && t.isActive
    );
    const legacyPublicToken = existingLocal?.publicToken?.trim();

    if (legacyPublicToken && /^[A-Za-z0-9_-]{24,64}$/.test(legacyPublicToken)) {
      const adoptedToken = await rpcAdoptLegacyCustomerQrToken(customerId, legacyPublicToken);
      await cacheCanonicalCustomerQrToken(customerId, adoptedToken);
      return adoptedToken;
    }

    const centralToken = await rpcGetOrCreateCustomerQr(customerId);
    if (!centralToken || !/^[A-Za-z0-9_-]{24,64}$/.test(centralToken)) {
      throw new Error('CUSTOMER_QR_CENTRAL_PERSISTENCE_FAILED: Supabase did not return a valid persisted customer QR token.');
    }

    await cacheCanonicalCustomerQrToken(customerId, centralToken);
    return centralToken;
  })();

  inFlightCustomerQrTokens.set(customerId, promise);
  try {
    return await promise;
  } finally {
    inFlightCustomerQrTokens.delete(customerId);
  }
};

/**
 * Rotates a customer QR only through the authoritative server RPC.
 * Local-only rotation would invalidate a server token or issue an unresolvable public URL.
 */
export const rotateCustomerQrToken = async (customerId: string): Promise<string> => {
  if (isBrowserOffline()) {
    throw new Error('CUSTOMER_QR_REQUIRES_ONLINE: Connect to the internet to rotate a shareable customer QR code.');
  }

  if (!getSupabaseStatus().isConfigured) {
    throw new Error('CUSTOMER_QR_REQUIRES_SUPABASE: Central QR storage is not configured.');
  }

  const rotated = await rpcRotateCustomerQr(customerId);
  if (!rotated || !/^[A-Za-z0-9_-]{24,64}$/.test(rotated)) {
    throw new Error('CUSTOMER_QR_CENTRAL_ROTATION_FAILED: Supabase did not return a valid persisted customer QR token.');
  }

  return rotated;
};

export const getCustomerQrCardData = async (
  customerId: string
): Promise<UICustomerQrCardData | null> => {
  await ensureStoreHydrated();
  await initDbIfNeeded();

  const customer =
    customersMap.get(customerId) || (await localDb.get<CustomerEntity>('customers', customerId));
  if (!customer) return null;

  const publicToken = await getOrCreateCustomerQrToken(customerId);
  const origin =
    typeof window !== 'undefined' && window.location.origin
      ? window.location.origin
      : '';
  const publicUrl = `${origin}/c/${publicToken}`;

  return {
    customerId: customer.id,
    customerName: customer.name,
    customerCode: getCustomerCode(customer),
    token: publicToken,
    publicUrl,
  };
};

/**
 * Resolves a customer QR through the authoritative public RPC whenever online.
 * Device-local lookup is strictly an offline-only fallback; a server failure must
 * never be misreported as an invalid token or masked by stale local data.
 * Returns only the public customer name and code.
 */
export const getPublicCustomerByToken = async (
  publicToken: string
): Promise<PublicCustomerQrData | null> => {
  if (!publicToken || typeof publicToken !== 'string') {
    return null;
  }

  // Public capability routes are online-only: never hydrate or read the admin's local business store.
  if (isBrowserOffline()) return null;
  if (!getSupabaseStatus().isConfigured) {
    throw new Error('CUSTOMER_QR_SUPABASE_NOT_CONFIGURED: Cannot resolve a public customer QR without the central service.');
  }

  const supabaseResult = await rpcResolveCustomerQr(publicToken);
  if (!supabaseResult) return null;

  return {
    customerName: supabaseResult.customerName,
    customerCode: supabaseResult.customerCode,
    token: publicToken,
  };
};

export interface PublicOrderQrData {
  orderId: string;
  orderNumber: number;
  customerName: string;
  customerCode?: string;
  status: string;
  createdAt: string;
  itemsCount: number;
  orderTotalMinor?: number;
  orderDueMinor?: number;
  orderPaidMinor?: number;
  customerHasPositiveCredit?: boolean;
  orderQrSubmissionLimitReached?: boolean;
  items?: Array<{
    name: string;
    name_ar?: string;
    name_en?: string;
    device_type_id?: string;
    status: string;
    operational_status?: string;
    payment_status?: string;
    has_charger: boolean;
    quantity?: number;
    unit_price_minor?: number;
    total_price_minor?: number;
    paid_minor?: number;
    due_minor?: number;
    charger_fee_exempt?: boolean;
  }>;
  token: string;
}

/**
 * getPublicOrderByToken
 * Resolves order details from public QR token without authentication.
 * 
 * 1. Checks Supabase central database RPC `public_resolve_order_qr`.
 * 2. In offline/foundation mode, checks `localDb` `qr_tokens` and in-memory maps.
 * 3. STRICT PRIVACY BOUNDARY:
 *    Returns public order details plus a boolean indicating whether positive customer credit exists.
 *    NEVER returns the exact customer balance, phone, debt limit, credentials, or administrative details.
 */
export const getPublicOrderByToken = async (
  publicToken: string
): Promise<PublicOrderQrData | null> => {
  if (!publicToken || typeof publicToken !== 'string') {
    return null;
  }

  // Public QR links never bootstrap, inspect, or fall back to administrator-local business data.
  // They fail closed while offline instead of displaying a stale local snapshot as current.
  if (isBrowserOffline()) return null;
  if (!getSupabaseStatus().isConfigured) {
    throw new Error('ORDER_QR_SUPABASE_NOT_CONFIGURED: Cannot resolve a public order QR without the central service.');
  }

  const supabaseResult = await rpcResolveOrderQr(publicToken);
  if (!supabaseResult) return null;

  return {
    orderId: supabaseResult.order_id,
    orderNumber: supabaseResult.order_number,
    customerName: supabaseResult.customer_name,
    customerCode: supabaseResult.customer_code,
    status: supabaseResult.status,
    createdAt: supabaseResult.created_at,
    itemsCount: supabaseResult.items_count,
    orderTotalMinor: supabaseResult.order_total_minor,
    orderDueMinor: supabaseResult.order_due_minor,
    orderPaidMinor: supabaseResult.order_paid_minor,
    customerHasPositiveCredit: typeof supabaseResult.customer_has_positive_credit === 'boolean'
      ? supabaseResult.customer_has_positive_credit : undefined,
    orderQrSubmissionLimitReached: typeof supabaseResult.order_qr_submission_limit_reached === 'boolean'
      ? supabaseResult.order_qr_submission_limit_reached : undefined,
    items: supabaseResult.items?.map((it) => {
      const dev = it.device_type_id ? devicesMap.get(it.device_type_id) : undefined;
      const foundBySnapshot = !dev
        ? Array.from(devicesMap.values()).find(
            (d) => d.name === it.name || d.nameAr === it.name
          )
        : undefined;
      const activeDev = dev || foundBySnapshot;

      const resolvedNameEn =
        it.name_en ||
        activeDev?.nameEn ||
        (it.device_type_id ? UI_DEVICE_LOCALIZATIONS[it.device_type_id]?.en : undefined) ||
        UI_DEVICE_NAME_MAP[it.name]?.en;

      const resolvedNameAr =
        it.name_ar ||
        activeDev?.nameAr ||
        activeDev?.name ||
        (it.device_type_id ? UI_DEVICE_LOCALIZATIONS[it.device_type_id]?.ar : undefined) ||
        UI_DEVICE_NAME_MAP[it.name]?.ar ||
        it.name;

      return {
        ...it,
        name_ar: resolvedNameAr,
        name_en: resolvedNameEn,
        device_type_id: it.device_type_id || activeDev?.id,
      };
    }),
    token: publicToken,
  };
};

export interface UIRecentFinancialActivityItem {
  id: string;
  eventType: string;
  customerName: string; // strictly RAW
  customerId: string;
  amountMinor: number;
  displayTitle: string;
  description: string;
  createdAt: string;
  /** Business date for order-linked events; payments keep their actual event date. */
  businessDate?: string;
  orderId?: string;
  orderItemId?: string;
  orderNumber?: number;
}

export interface UIHomeDashboardData {
  currentDateStr: string;
  todayDay: {
    id: string;
    businessDate: string;
    isClosed: boolean;
    orderCount: number;
    totalOrderValueMinor: number;
  } | null;
  totalDebtMinor: number;
  totalCollectedMinor: number;
  totalOrdersCount: number;
  totalOrdersValueMinor: number;
  recentFinancialActivities: UIRecentFinancialActivityItem[];
}

export const getTodayHomeData = async (
  locale: Locale = 'ar'
): Promise<UIHomeDashboardData> => {
  await ensureStoreHydrated();

  // 1. Exact current calendar date from device / system runtime
  const todayStr = getLocalBusinessDateStr();

  // 2. Look for business day matching the EXACT current calendar date (do NOT fallback to previous days)
  const existingTodayDay = Array.from(daysMap.values()).find(
    (day) => day.businessDate === todayStr
  );

  let todayDay: UIHomeDashboardData['todayDay'] = null;

  if (existingTodayDay) {
    const orders = await getOrdersForDay(existingTodayDay.id, locale);
    let todayVal = 0;
    for (const ord of orders) {
      for (const itm of ord.items) {
        todayVal += itm.priceMinor;
      }
    }
    todayDay = {
      id: existingTodayDay.id,
      businessDate: existingTodayDay.businessDate,
      isClosed: existingTodayDay.isClosed,
      orderCount: orders.length,
      totalOrderValueMinor: todayVal,
    };
  }

  // 3. Authoritative Total Debt Calculation:
  // Sum of negative balances across active customers (positive debt)
  let totalDebtMinor = 0;
  for (const cust of customersMap.values()) {
    if (!cust.isActive) continue;
    const balanceMinor = await repoContext.customerRepo.getBalance(cust.id);
    if (balanceMinor < 0) {
      totalDebtMinor += Math.abs(balanceMinor);
    }
  }

  // 4. Authoritative Total Collected Calculation:
  // Sum of all actual PAYMENT transactions in the ledger
  let totalCollectedMinor = 0;
  for (const ev of ledgerList) {
    if (ev.eventType === 'PAYMENT' && ev.amountMinor > 0) {
      totalCollectedMinor += ev.amountMinor;
    }
  }

  // 5. Total Orders and Total Order Value across system
  const totalOrdersCount = ordersMap.size;
  let totalOrdersValueMinor = 0;
  for (const itm of itemsMap.values()) {
    totalOrdersValueMinor += itm.totalPriceMinor;
  }

  // 6. Recent 5 Financial Activities from Authoritative Ledger
  // Resolve order labels from the same effective local-first order read model as customer history.
  const effectiveOrdersMap = getEffectiveOrderItemReadModel().orders;
  const sortedLedger = [...ledgerList].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const recentFinancialActivitiesRaw: UIRecentFinancialActivityItem[] = sortedLedger.map((ev) => {
    const cust = customersMap.get(ev.customerId);
    const rawCustName = cust ? cust.name : ev.customerId;

    let displayTitle = '';
    let description = '';

    if (ev.eventType === 'PAYMENT') {
      displayTitle =
        locale === 'ar' ? `دفع من ${rawCustName}` : `Payment from ${rawCustName}`;
      description =
        locale === 'ar' ? 'سداد مالي / إضافة رصيد' : 'Payment received / credit';
    } else if (ev.eventType === 'ORDER_ITEM_CHARGE') {
      let ordNumStr = '';
      if (ev.orderId) {
        const ord = effectiveOrdersMap.get(ev.orderId);
        if (ord) ordNumStr = `#${ord.displayNumber}`;
      }
      displayTitle =
        locale === 'ar'
          ? `خصم طلب ${ordNumStr}`.trim()
          : `Order charge ${ordNumStr}`.trim();
      description =
        locale === 'ar' ? `خصم من رصيد ${rawCustName}` : `Charged to ${rawCustName}`;
    } else if (ev.eventType === 'REFUND') {
      displayTitle = locale === 'ar' ? 'استرداد مالي' : 'Refund';
      description =
        locale === 'ar' ? `استرداد لـ ${rawCustName}` : `Refunded to ${rawCustName}`;
    } else if (ev.eventType === 'REVERSAL') {
      displayTitle = locale === 'ar' ? 'عكس حركة مالية' : 'Reversal';
      description =
        locale === 'ar' ? `عكس حركة لـ ${rawCustName}` : `Reversal for ${rawCustName}`;
    } else if (ev.eventType === 'CREDIT_ADJUSTMENT') {
      displayTitle = locale === 'ar' ? 'تعديل رصيد' : 'Credit Adjustment';
      description =
        locale === 'ar' ? `تسوية حساب ${rawCustName}` : `Adjustment for ${rawCustName}`;
    } else if (ev.eventType === 'CREDIT_USED') {
      displayTitle = locale === 'ar' ? 'استخدام رصيد' : 'Credit Applied';
      description =
        locale === 'ar' ? `سداد من الرصيد لـ ${rawCustName}` : `Credit used by ${rawCustName}`;
    } else {
      displayTitle = locale === 'ar' ? 'عملية مالية' : 'Financial Transaction';
      description = rawCustName;
    }

    const order = ev.orderId ? effectiveOrdersMap.get(ev.orderId) : undefined;
    return {
      id: ev.id,
      eventType: ev.eventType,
      customerName: rawCustName,
      customerId: ev.customerId,
      amountMinor: ev.amountMinor,
      displayTitle,
      description,
      createdAt: ev.createdAt,
      ...(order ? { businessDate: getCanonicalDayKey(order.dayId) } : {}),
      ...(ev.orderId ? { orderId: ev.orderId } : {}),
      ...(ev.orderItemId ? { orderItemId: ev.orderItemId } : {}),
      ...(order ? { orderNumber: order.displayNumber } : {}),
    };
  });

  // Group all ledger item charges before limiting the dashboard to five visible rows,
  // so a multi-device order is not truncated and its displayed total stays complete.
  const recentFinancialActivities = groupHomeFinancialActivitiesByOrder(
    recentFinancialActivitiesRaw,
    locale === 'en' ? 'en' : 'ar'
  ).slice(0, 5);

  return {
    currentDateStr: todayStr,
    todayDay,
    totalDebtMinor,
    totalCollectedMinor,
    totalOrdersCount,
    totalOrdersValueMinor,
    recentFinancialActivities,
  };
};

export const createTodayBusinessDay = async (dateStr: string): Promise<string> => {
  await ensureStoreHydrated();

  const result = await phase5UseCases.createBusinessDay(
    getAuthorizedAdminContext(),
    dateStr,
    crypto.randomUUID()
  );
  if (!result.success) {
    throw new Error(presentError(('error' in result ? result.error : undefined) || 'فشل إنشاء اليوم'));
  }
  return result.data.id;
};

export interface UIDaySummary {
  id: string;
  date: string; // YYYY-MM-DD
  isClosed: boolean;
  orderCount: number;
  totalOrderValueMinor: number;
  allOrdersDelivered: boolean;
}

/**
 * Derives delivery completion exclusively from the existing local-first order/item
 * read model. Cancelled/deleted records do not count as outstanding work; an active
 * order with no active items is conservatively not considered delivered.
 */
export const getFullyDeliveredDayIds = (
  orders: Iterable<Pick<OrderEntity, 'id' | 'dayId' | 'status' | 'deletedAt'>>,
  items: Iterable<Pick<OrderItemEntity, 'orderId' | 'status' | 'deletedAt'>>
): Set<string> => {
  const activeOrders = new Map<string, { dayId: string; activeItemCount: number; allItemsDelivered: boolean }>();
  const orderIdsByDay = new Map<string, string[]>();

  for (const order of orders) {
    if (!order.dayId || order.deletedAt || String(order.status || '').toLowerCase() === 'cancelled') continue;
    activeOrders.set(order.id, { dayId: order.dayId, activeItemCount: 0, allItemsDelivered: true });
    const dayOrders = orderIdsByDay.get(order.dayId) || [];
    dayOrders.push(order.id);
    orderIdsByDay.set(order.dayId, dayOrders);
  }

  for (const item of items) {
    if (item.deletedAt || String(item.status || '').toLowerCase() === 'cancelled') continue;
    const order = activeOrders.get(item.orderId);
    if (!order) continue;
    order.activeItemCount += 1;
    if (String(item.status || '').toLowerCase() !== 'delivered') {
      order.allItemsDelivered = false;
    }
  }

  const fullyDeliveredDays = new Set<string>();
  for (const [dayId, orderIds] of orderIdsByDay) {
    if (orderIds.length > 0 && orderIds.every((orderId) => {
      const order = activeOrders.get(orderId)!;
      return order.activeItemCount > 0 && order.allItemsDelivered;
    })) {
      fullyDeliveredDays.add(dayId);
    }
  }

  return fullyDeliveredDays;
};

export const getDaysList = async (): Promise<UIDaySummary[]> => {
  await ensureStoreHydrated();

  // The Days screen is a summary/read-only view. Do not call getOrdersForDay()
  // here: that function intentionally performs the full per-order payment/status
  // projection needed by the selected day's detail screen. Calling it for every
  // day turns opening the Days screen into a full historical read.
  //
  // Build the summary from the already-hydrated local maps in a single pass.
  // Pending order/item overlays are included so the summary remains consistent
  // with the local-first UI while offline.
  for (const ord of ordersMap.values()) {
    if (ord.dayId && !daysMap.has(ord.dayId)) {
      await ensureBusinessDayEntityExists(ord.dayId);
    }
  }

  const { orders: effectiveOrdersMap, items: effectiveItemsMap } = getEffectiveOrderItemReadModel();
  const fullyDeliveredDayIds = getFullyDeliveredDayIds(effectiveOrdersMap.values(), effectiveItemsMap.values());

  const orderCountByDay = new Map<string, number>();
  for (const order of effectiveOrdersMap.values()) {
    if (!order.dayId || order.status === 'cancelled') continue;
    orderCountByDay.set(order.dayId, (orderCountByDay.get(order.dayId) || 0) + 1);
  }

  const totalValueByDay = new Map<string, number>();
  for (const item of effectiveItemsMap.values()) {
    if (item.status === 'cancelled') continue;

    const order = effectiveOrdersMap.get(item.orderId);
    if (!order?.dayId || order.status === 'cancelled') continue;

    totalValueByDay.set(
      order.dayId,
      (totalValueByDay.get(order.dayId) || 0) + Number(item.totalPriceMinor || 0)
    );
  }

  const result: UIDaySummary[] = [];

  for (const day of daysMap.values()) {
    const resolvedDate =
      day.businessDate ||
      (day as any).business_date ||
      (day as any).date ||
      (day.id?.startsWith('day-') ? day.id.slice(4) : day.id) ||
      '';

    result.push({
      id: day.id,
      date: resolvedDate,
      isClosed: day.isClosed ?? (day as any).is_closed ?? false,
      orderCount: orderCountByDay.get(day.id) || 0,
      totalOrderValueMinor: totalValueByDay.get(day.id) || 0,
      allOrdersDelivered: fullyDeliveredDayIds.has(day.id),
    });
  }

  return result.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
};

export const createNewBusinessDay = async (
  dateStr: string
): Promise<{ success: boolean; dayId?: string; error?: string }> => {
  await ensureStoreHydrated();

  const existing = Array.from(daysMap.values()).find((d) => d.businessDate === dateStr);
  if (existing) {
    return { success: false, error: 'اليوم موجود بالفعل بهذا التاريخ' };
  }

  try {
    const result = await phase5UseCases.createBusinessDay(
      getAuthorizedAdminContext(),
      dateStr,
      crypto.randomUUID()
    );
    if (!result.success) {
      return {
        success: false,
        error: presentError(('error' in result ? result.error : undefined) || 'فشل إنشاء اليوم'),
      };
    }
    return { success: true, dayId: result.data.id };
  } catch (err: any) {
    console.error('Failed to create business day:', err);
    return { success: false, error: err?.message || 'Failed to create business day' };
  }
};

export interface UIFinancialsOverviewData {
  totalDebtMinor: number;
  totalCreditMinor: number;
  totalCollectedMinor: number;
  totalOrdersValueMinor: number;
}

export const getFinancialsOverviewData = async (): Promise<UIFinancialsOverviewData> => {
  await ensureStoreHydrated();

  let totalDebtMinor = 0;
  let totalCreditMinor = 0;
  for (const cust of customersMap.values()) {
    if (!cust.isActive) continue;
    const balanceMinor = await repoContext.customerRepo.getBalance(cust.id);
    if (balanceMinor < 0) {
      totalDebtMinor += Math.abs(balanceMinor);
    } else if (balanceMinor > 0) {
      totalCreditMinor += balanceMinor;
    }
  }

  let totalCollectedMinor = 0;
  for (const ev of ledgerList) {
    if (ev.eventType === 'PAYMENT' && ev.amountMinor > 0) {
      totalCollectedMinor += ev.amountMinor;
    }
  }

  let totalOrdersValueMinor = 0;
  for (const itm of itemsMap.values()) {
    totalOrdersValueMinor += itm.totalPriceMinor;
  }

  return {
    totalDebtMinor,
    totalCreditMinor,
    totalCollectedMinor,
    totalOrdersValueMinor,
  };
};

export interface UIFinancialCustomerItem {
  id: string;
  name: string; // RAW
  code: string;
  currentBalanceMinor: number;
  isActive: boolean;
}

export const getFinancialCustomersByFilter = async (
  filter: 'all' | 'credit' | 'debt',
  limit: number = 20
): Promise<UIFinancialCustomerItem[]> => {
  await ensureStoreHydrated();

  const allCusts: CustomerEntity[] = Array.from(customersMap.values()).filter((c) => c.isActive);
  const items: UIFinancialCustomerItem[] = [];

  for (const cust of allCusts) {
    const balanceMinor = await repoContext.customerRepo.getBalance(cust.id);

    // Rule: Balance == 0 appears in "all", but NEVER in "credit" (> 0) or "debt" (< 0)
    if (filter === 'credit' && balanceMinor <= 0) continue;
    if (filter === 'debt' && balanceMinor >= 0) continue;

    items.push({
      id: cust.id,
      name: cust.name,
      code: getCustomerCode(cust),
      currentBalanceMinor: balanceMinor,
      isActive: cust.isActive,
    });
  }

  items.sort((a, b) => {
    if (filter === 'debt') {
      return a.currentBalanceMinor - b.currentBalanceMinor; // Most negative first
    }
    if (filter === 'credit') {
      return b.currentBalanceMinor - a.currentBalanceMinor; // Highest credit first
    }
    const aNonZero = a.currentBalanceMinor !== 0;
    const bNonZero = b.currentBalanceMinor !== 0;
    if (aNonZero && !bNonZero) return -1;
    if (!aNonZero && bNonZero) return 1;
    if (a.currentBalanceMinor !== b.currentBalanceMinor) {
      return a.currentBalanceMinor - b.currentBalanceMinor;
    }
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });

  return items.slice(0, limit);
};

export const getAllFinancialCustomers = async (): Promise<UIFinancialCustomerItem[]> => {
  return getFinancialCustomersByFilter('all', 50);
};

export const searchFinancialCustomers = async (
  query: string
): Promise<UIFinancialCustomerItem[]> => {
  await ensureStoreHydrated();
  if (!query || !query.trim()) return [];
  const items = await searchCustomers(query);
  const results: UIFinancialCustomerItem[] = [];
  for (const c of items) {
    const balanceMinor = await repoContext.customerRepo.getBalance(c.id);
    results.push({
      id: c.id,
      name: c.name,
      code: c.code,
      currentBalanceMinor: balanceMinor,
      isActive: true,
    });
  }
  return results;
};

export interface TopUpCustomerBalanceParams {
  customerId: string;
  amountMinor: number;
  bin: string;
  note?: string;
  idempotencyKey?: string;
}

export interface TopUpCustomerBalanceResult {
  success: boolean;
  newBalanceMinor: number;
  transactionId?: string;
  error?: string;
}

/**
 * UI & Store Format Validation for Admin Authorization BIN
 * (UX/Format validation only: checks completeness and 4-digit requirement)
 */
export interface ValidateBinFormatResult {
  valid: boolean;
  error?: string;
}

export const validateBinFormat = (
  bin: string,
  locale: 'ar' | 'en' = 'ar'
): ValidateBinFormatResult => {
  if (!bin || bin.trim().length === 0) {
    return {
      valid: false,
      error: locale === 'en' ? 'Please enter authorization BIN' : 'يرجى إدخال رمز التحقق (BIN)',
    };
  }

  const trimmed = bin.trim();
  if (trimmed.length < 4 || !/^\d{4,}$/.test(trimmed)) {
    return {
      valid: false,
      error: locale === 'en' ? 'Invalid or incomplete BIN (minimum 4 digits)' : 'رمز BIN غير مكتمل (4 أرقام على الأقل)',
    };
  }

  return { valid: true };
};

export const topUpCustomerBalance = async (
  params: TopUpCustomerBalanceParams
): Promise<TopUpCustomerBalanceResult> => {
  await ensureStoreHydrated();
  const { customerId, amountMinor, bin, note, idempotencyKey } = params;

  const offline = isBrowserOffline();
  const binValidation = offline ? { valid: true } : validateBinFormat(bin);
  if (!binValidation.valid) {
    return {
      success: false,
      newBalanceMinor: 0,
      error: binValidation.error,
    };
  }

  if (!amountMinor || amountMinor <= 0) {
    return {
      success: false,
      newBalanceMinor: 0,
      error: 'يرجى إدخال مبلغ شحن صحيح أكبر من صفر',
    };
  }

  let cust = await repoContext.customerRepo.findById(customerId);
  if (!cust) {
    const all = Array.from(customersMap.values());
    cust = all.find((c) => c.id === customerId || getCustomerCode(c) === customerId) || null;
  }

  if (!cust) {
    return {
      success: false,
      newBalanceMinor: 0,
      error: 'العميل غير موجود في النظام',
    };
  }

  const isUUID = (str?: string): boolean =>
    Boolean(str && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str));

  if (idempotencyKey && !isUUID(idempotencyKey)) {
    return {
      success: false,
      newBalanceMinor: await repoContext.customerRepo.getBalance(cust.id),
      error: 'Invalid idempotency key: expected UUID',
    };
  }

  const commandId = idempotencyKey || crypto.randomUUID();

  // Idempotency check: if already processed, return previous transaction result
  if (idempotencyKey) {
    const existingCmd = await repoContext.commandRepo.get(commandId);
    if (existingCmd) {
      const existingPayload = (existingCmd.payload || {}) as Record<string, unknown>;
      const requestedNote = note?.trim() || undefined;
      const existingNote = String(existingPayload.reference ?? '').trim() || undefined;
      const isSamePayment =
        existingCmd.type === 'CREATE_PAYMENT' &&
        String(existingPayload.customerId ?? '') === cust.id &&
        Number(existingPayload.amountMinor) === amountMinor &&
        String(existingPayload.paymentMethod ?? 'CASH').toUpperCase() === 'CASH' &&
        existingNote === requestedNote;
      const custBalance = await repoContext.customerRepo.getBalance(cust.id);
      if (!isSamePayment) {
        return {
          success: false,
          transactionId: commandId,
          newBalanceMinor: custBalance,
          error: 'IDEMPOTENCY_CONFLICT: this key was already used for a different payment request',
        };
      }
      return {
        success: true,
        transactionId: (existingPayload as any)?.transactionId || commandId,
        newBalanceMinor: custBalance,
      };
    }
  }

  // Use the authenticated actor and server-backed permissions for offline/local projection.
  const authContext = getAuthorizedAdminContext(bin);

  try {
    // Authoritative verifyBin (rejects if verifier missing, invalid, or fails)
    if (!offline) await authContext.verifyBin(bin);

    // A customer payment is a real payment, not an administrative credit adjustment.
    // Keep the existing credit-adjustment command reserved for explicit credit operations.
    const result = await phase5UseCases.recordPayment(
      authContext,
      commandId,
      cust.id,
      amountMinor,
      'CASH',
      note?.trim() || undefined,
      undefined,
      bin
    );

    if (!result.success) {
      return {
        success: false,
        newBalanceMinor: 0,
        error: presentError(('error' in result ? result.error : undefined) || 'فشلت عملية شحن الرصيد'),
      };
    }

    // The use case owns both the ledger/payment optimistic projections and the
    // single outbox command. Do not write a second local payment or command here.
    // Authoritative fresh balance
    const newBalanceMinor = await repoContext.customerRepo.getBalance(cust.id);

    return {
      success: true,
      newBalanceMinor,
      transactionId: result.data?.id,
    };
  } catch (err: unknown) {
    const msg = presentError(err);
    return {
      success: false,
      newBalanceMinor: 0,
      error: msg,
    };
  }
};

// ==========================================
// PHASE 6.9: DEVICE TYPES MANAGEMENT
// ==========================================

export interface UIDeviceTypeItem {
  id: string;
  name: string;
  nameAr?: string;
  nameEn?: string;
  basePriceMinor: number;
  chargerFeeEnabled: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  hasHistoricalOrders: boolean;
}


export const getAllDeviceTypes = async (): Promise<UIDeviceTypeItem[]> => {
  await ensureStoreHydrated();
  const allDevices = await repoContext.deviceRepo.findAll();

  // Determine which device types have been used in historical order items
  const usedDeviceTypeIds = new Set<string>();
  itemsMap.forEach((it) => {
    if (it.deviceTypeId) usedDeviceTypeIds.add(it.deviceTypeId);
  });

  return allDevices
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((d) => ({
      id: d.id,
      name: d.name,
      nameAr: d.nameAr,
      nameEn: d.nameEn,
      basePriceMinor: d.basePriceMinor,
      chargerFeeEnabled: d.chargerFeeEnabled ?? true,
      isActive: d.isActive,
      sortOrder: d.sortOrder,
      createdAt: d.createdAt,
      hasHistoricalOrders: usedDeviceTypeIds.has(d.id),
    }));
};

export const addDeviceTypeWithPhase5 = async (
  name: string,
  priceMinor: number,
  isActive: boolean = true,
  sortOrder?: number,
  chargerFeeEnabled: boolean = true,
  nameEn?: string,
  nameAr?: string
): Promise<{ success: boolean; data?: DeviceTypeEntity; error?: string }> => {
  await ensureStoreHydrated();
  const trimmedAr = nameAr?.trim() || name?.trim() || '';
  const trimmedEn = nameEn?.trim() || undefined;

  if (!trimmedAr) {
    return { success: false, error: 'يرجى إدخال اسم نوع الجهاز' };
  }
  if (typeof priceMinor !== 'number' || priceMinor < 0 || isNaN(priceMinor)) {
    return { success: false, error: 'يرجى إدخال سعر خدمة صحيح وغير سالب' };
  }

  try {
    const all = await repoContext.deviceRepo.findAll();
    const maxOrder = all.reduce((max, d) => Math.max(max, d.sortOrder ?? 0), 0);
    const targetOrder = (sortOrder !== undefined && sortOrder > 0) ? Math.floor(sortOrder) : maxOrder + 1;

    const res = await phase5UseCases.createDeviceType(
      getAuthorizedAdminContext(),
      trimmedAr,
      'smartphone',
      priceMinor,
      chargerFeeEnabled,
      trimmedAr,
      trimmedEn,
      targetOrder,
      isActive
    );

    if (!res.success) {
      return { success: false, error: (res as any).error || 'فشل إضافة نوع الجهاز' };
    }

    return { success: true, data: res.data };
  } catch (err: any) {
    return { success: false, error: presentError(err) };
  }
};

export const updateDeviceTypeWithPhase5 = async (
  id: string,
  updates: {
    name?: string;
    nameAr?: string;
    nameEn?: string;
    priceMinor?: number;
    chargerFeeEnabled?: boolean;
    isActive?: boolean;
    sortOrder?: number;
  }
): Promise<{ success: boolean; data?: DeviceTypeEntity; error?: string }> => {
  await ensureStoreHydrated();
  const nameToValidate = updates.nameAr !== undefined ? updates.nameAr : updates.name;
  if (nameToValidate !== undefined && !nameToValidate.trim()) {
    return { success: false, error: 'يرجى إدخال اسم نوع الجهاز' };
  }
  if (
    updates.priceMinor !== undefined &&
    (typeof updates.priceMinor !== 'number' || updates.priceMinor < 0 || isNaN(updates.priceMinor))
  ) {
    return { success: false, error: 'يرجى إدخال سعر خدمة صحيح وغير سالب' };
  }

  try {
    const patch: Partial<DeviceTypeEntity> = {};
    if (updates.nameAr !== undefined) {
      patch.nameAr = updates.nameAr.trim();
      patch.name = updates.nameAr.trim();
    } else if (updates.name !== undefined) {
      patch.name = updates.name.trim();
      patch.nameAr = updates.name.trim();
    }
    if (updates.nameEn !== undefined) {
      patch.nameEn = updates.nameEn.trim() || undefined;
    }
    if (updates.priceMinor !== undefined) patch.basePriceMinor = updates.priceMinor;
    if (updates.chargerFeeEnabled !== undefined) patch.chargerFeeEnabled = updates.chargerFeeEnabled;
    if (updates.isActive !== undefined) patch.isActive = updates.isActive;
    if (updates.sortOrder !== undefined) patch.sortOrder = updates.sortOrder;

    const res = await phase5UseCases.updateDeviceType(getAuthorizedAdminContext(), id, patch);
    if (!res.success) {
      return { success: false, error: (res as any).error || 'فشل تحديث نوع الجهاز' };
    }
    return { success: true, data: res.data };
  } catch (err: any) {
    return { success: false, error: presentError(err) };
  }
};

export const updateCustomerChargerFeeExemptionWithPhase5 = async (
  customerId: string,
  exempt: boolean,
  bin: string
): Promise<{ success: boolean; error?: string }> => {
  await ensureStoreHydrated();
  try {
    const auth = getAuthorizedAdminContext(bin);
    await phase5UseCases.updateCustomerChargerFeeExemption(auth, customerId, exempt, bin);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: presentError(err) };
  }
};

export const reorderDeviceTypesWithPhase5 = async (
  ordering: { id: string; sortOrder: number }[]
): Promise<{ success: boolean; error?: string }> => {
  await ensureStoreHydrated();
  try {
    await phase5UseCases.reorderDeviceTypes(getAuthorizedAdminContext(), ordering);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: presentError(err) };
  }
};

export const deleteDeviceTypeWithPhase5 = async (
  id: string
): Promise<{ success: boolean; error?: string }> => {
  await ensureStoreHydrated();
  try {
    const isUsed = await isDeviceTypeUsedHistorically(id);
    if (isUsed) {
      return {
        success: false,
        error: 'لا يمكن حذف نوع الجهاز لأنه مرتبط بطلبات مسجلة في النظام. يمكنك تعطيله بدلاً من حذفه.',
      };
    }

    const res = await phase5UseCases.deleteDeviceType(getAuthorizedAdminContext(), id);
    if (!res.success) {
      return { success: false, error: (res as any).error || 'فشل حذف نوع الجهاز' };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: presentError(err) };
  }
};

export const isDeviceTypeUsedHistorically = async (deviceTypeId: string): Promise<boolean> => {
  await ensureStoreHydrated();
  for (const it of itemsMap.values()) {
    if (it.deviceTypeId === deviceTypeId) return true;
  }
  return false;
};

export const getCustomersCount = async (): Promise<number> => {
  await ensureStoreHydrated();
  return customersMap.size;
};

export const getOrdersCount = async (): Promise<number> => {
  await ensureStoreHydrated();
  return ordersMap.size;
};

export const getBusinessDaysCount = async (): Promise<number> => {
  await ensureStoreHydrated();
  return daysMap.size;
};

export const getLedgerCount = async (): Promise<number> => {
  await ensureStoreHydrated();
  return ledgerList.length;
};






