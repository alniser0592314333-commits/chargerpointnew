import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { useToast } from '../ui/Toast';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { localDb, OutboxRecord, SyncHistoryRecord } from '../../infrastructure/localDb/localDb';
import { syncEventEmitter } from '../../infrastructure/sync/syncEngine';
import { globalSyncBridge } from '../../infrastructure/sync/syncBridge';
import { authService } from '../../services/auth/authService';
import {
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Lock,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
  Activity,
  Terminal,
  Trash2,
  ExternalLink,
  Users,
  Calendar,
  Layers,
  Search,
  Filter,
  Info,
  Sliders,
  Sparkles,
  Unlock,
  Play,
} from 'lucide-react';

export type MainSyncState =
  | 'SYNCED'
  | 'SYNCING'
  | 'PENDING'
  | 'BLOCKED'
  | 'FAILED'
  | 'OFFLINE'
  | 'AUTH_REQUIRED';

// Session start timestamp helper
const getSessionStartTime = (): number => {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    let stored = window.sessionStorage.getItem('app_session_start_time');
    if (!stored) {
      stored = String(Date.now());
      window.sessionStorage.setItem('app_session_start_time', stored);
    }
    return Number(stored);
  }
  return Date.now();
};

export const SyncCenter: React.FC = () => {
  const { locale, isRTL } = useI18n();
  const { showToast } = useToast();

  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [outboxRecords, setOutboxRecords] = useState<OutboxRecord[]>([]);
  const [historyRecords, setHistoryRecords] = useState<SyncHistoryRecord[]>([]);
  const [lastPulledAt, setLastPulledAt] = useState<string | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean>(false);

  // Modal & Tab States
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'SESSION' | 'DIAGNOSTICS'>('SESSION');
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<'ALL' | 'SYNCED' | 'PENDING' | 'BLOCKED' | 'FAILED'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedBinCommandIds, setSelectedBinCommandIds] = useState<string[]>([]);
  const [isBinModalOpen, setIsBinModalOpen] = useState<boolean>(false);
  const [binInput, setBinInput] = useState<string>('');

  const sessionStartTime = useMemo(() => getSessionStartTime(), []);

  // Load active session to determine Super Admin diagnostic authorization
  useEffect(() => {
    authService.getCurrentSession().then((s) => {
      setIsSuperAdmin(s?.role === 'SUPER_ADMIN' || Boolean((s as any)?.isSuperAdmin));
    });
  }, []);

  // Monitor network connectivity
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      }
    };
  }, []);

  // Fetch sync records & status from localDb
  const refreshSyncData = useCallback(async () => {
    try {
      const [outbox, history, syncState] = await Promise.all([
        localDb.listOutbox(),
        localDb.listHistory(),
        localDb.getSyncState('global'),
      ]);

      setOutboxRecords(outbox);

      // Sort history newest first
      const sortedHist = [...history].sort(
        (a, b) =>
          new Date(b.updatedAt || b.createdAt || 0).getTime() -
          new Date(a.updatedAt || a.createdAt || 0).getTime()
      );
      setHistoryRecords(sortedHist);

      if (syncState?.lastPulledAt) {
        setLastPulledAt(syncState.lastPulledAt);
      }
    } catch (err) {
      console.warn('SyncCenter failed to load sync data:', err);
    }
  }, []);

  // Initial load and reactive subscription to syncEventEmitter
  useEffect(() => {
    refreshSyncData();

    const unsubscribe = syncEventEmitter.subscribe((evt) => {
      if (evt.type === 'sync_started') {
        setIsSyncing(true);
      } else if (evt.type === 'sync_finished') {
        setIsSyncing(false);
        refreshSyncData();
      } else {
        refreshSyncData();
      }
    });

    return () => {
      unsubscribe();
    };
  }, [refreshSyncData]);

  // Derived Metrics
  const pendingCount = outboxRecords.filter(
    (i) => i.status === 'pending' || i.status === 'syncing'
  ).length;

  const blockedCount = outboxRecords.filter((i) => i.status === 'blocked').length;

  const activeFailedCount = outboxRecords.filter(
    (i) => i.status === 'rejected' || i.status === 'conflict'
  ).length;

  const failedCount = activeFailedCount;

  // Sensitive commands that require an admin BIN before the server can execute them.
  // This also recognizes older queued commands that reached the server without the
  // deferred-BIN marker, so they can be recovered safely from the Sync Center.
  const isBinRequiredCommand = (item: OutboxRecord): boolean => {
    const binCommands = new Set(['DELIVER_ORDER_ITEM', 'CANCEL_ORDER', 'CANCEL_ORDER_ITEM', 'CREATE_CUSTOMER_CREDIT']);
    if (!binCommands.has(item.commandType)) return false;

    const payload = (item.payload || {}) as any;
    const bin = String(payload?.bin || '').trim();
    if (bin.length >= 4 && payload?.deferBinVerification !== true) return false;

    const error = String(item.lastError || '');
    return (
      payload?.deferBinVerification === true ||
      error === 'BIN_REQUIRED' ||
      /BIN is required/i.test(error) ||
      /Authorization required:\s*BIN/i.test(error)
    );
  };

  const binRequiredItems = useMemo(
    () => outboxRecords.filter(isBinRequiredCommand),
    [outboxRecords]
  );
  const binRequiredCount = binRequiredItems.length;

  // Determine Primary Sync State
  const deriveMainState = (): MainSyncState => {
    if (!isOnline) return 'OFFLINE';
    if (isSyncing) return 'SYNCING';
    if (blockedCount > 0) return 'BLOCKED';
    if (activeFailedCount > 0) return 'FAILED';
    if (pendingCount > 0) {
      const sortedHistory = [...historyRecords].sort(
        (a, b) =>
          new Date(b.updatedAt || b.createdAt || 0).getTime() -
          new Date(a.updatedAt || a.createdAt || 0).getTime()
      );
      const latestFailed = sortedHistory[0];
      if (
        latestFailed?.errorClass === 'AUTHENTICATION' ||
        latestFailed?.errorClass === 'AUTHORIZATION'
      ) {
        return 'AUTH_REQUIRED';
      }
      return 'PENDING';
    }

    return 'SYNCED';
  };

  const currentState = deriveMainState();

  // Handle Manual Sync
  const handleManualSync = async () => {
    try {
      setIsSyncing(true);
      await globalSyncBridge.requestManualSync();
      showToast(
        locale === 'ar' ? 'تمت المزامنة بنجاح مع الخادم' : 'Sync completed successfully with server',
        'success'
      );
    } catch (err: any) {
      if (err?.message?.includes('already in progress')) {
        setIsSyncing(true);
      } else {
        console.error('Manual sync error:', err);
        showToast(
          err.message || (locale === 'ar' ? 'تعذر استكمال المزامنة' : 'Sync cycle encountered an error'),
          'error'
        );
      }
    } finally {
      await refreshSyncData();
      setIsSyncing(false);
    }
  };

  // Unblock & Retry single outbox item
  const handleUnblockSingle = async (commandId: string) => {
    try {
      const outbox = await localDb.listOutbox();
      const target = outbox.find((o) => o.commandId === commandId);
      if (target) {
        target.status = 'pending';
        target.retryCount = 0;
        await localDb.saveOutbox(target);
        await refreshSyncData();
        showToast(
          locale === 'ar' ? 'تم تحرير العملية بنجاح، جاري إعادة المزامنة...' : 'Command unblocked. Starting sync...',
          'success'
        );
        handleManualSync();
      }
    } catch (err: any) {
      console.error('Failed to unblock command:', err);
    }
  };

  // Apply one BIN to an explicitly selected batch. The BIN is never stored in React
  // state and is sent separately with every command, where the server validates it.
  const handleProvideBinForCommands = async (commandIds: string[]) => {
    if (commandIds.length === 0) {
      showToast(locale === 'ar' ? 'حدد عملية واحدة على الأقل' : 'Select at least one operation', 'error');
      return;
    }

    setSelectedBinCommandIds(commandIds);
    setBinInput('');
    setIsBinModalOpen(true);
  };

  const handleConfirmBin = async () => {
    const commandIds = selectedBinCommandIds;
    const normalizedBin = binInput.trim();

    if (commandIds.length === 0) {
      setIsBinModalOpen(false);
      showToast(locale === 'ar' ? 'حدد عملية واحدة على الأقل' : 'Select at least one operation', 'error');
      return;
    }

    if (!/^\d{4,}$/.test(normalizedBin)) {
      showToast(locale === 'ar' ? 'BIN غير صالح: يجب أن يحتوي على 4 أرقام على الأقل' : 'Invalid BIN: enter at least 4 digits', 'error');
      return;
    }

    setIsBinModalOpen(false);

    try {
      const outbox = await localDb.listOutbox();
      const selected = outbox.filter((o) => commandIds.includes(o.commandId) && isBinRequiredCommand(o));

      for (const target of selected) {
        const payload = ((target.payload || {}) as any);
        target.payload = { ...payload, bin: normalizedBin, deferBinVerification: false };
        target.status = 'pending';
        target.retryCount = 0;
        target.lastError = undefined;
        await localDb.saveOutbox(target);

        const hist = await localDb.getHistoryByCommandId(target.commandId);
        if (hist) {
          hist.state = 'PENDING';
          hist.errorClass = undefined;
          hist.errorMessage = undefined;
          hist.retryEligible = undefined;
          hist.updatedAt = new Date().toISOString();
          await localDb.saveHistory(hist);
        }
      }

      setSelectedBinCommandIds([]);
      setBinInput('');
      await refreshSyncData();
      await handleManualSync();
    } catch (err: any) {
      showToast(
        err?.message ||
          (locale === 'ar' ? 'تعذر تجهيز العمليات للمزامنة' : 'Failed to authorize queued operations'),
        'error'
      );
    }
  };

  // Supply BIN for one sensitive command.
  const handleProvideBinForBlockedCommand = async (commandId: string) => {
    await handleProvideBinForCommands([commandId]);
  };

  // Remove single outbox item from queue
  const handleRemoveSingleOutbox = async (commandId: string) => {
    try {
      await localDb.deleteOutbox(commandId);
      await refreshSyncData();
      showToast(
        locale === 'ar' ? 'تم حذف العملية من طابور الانتظار' : 'Operation removed from queue',
        'info'
      );
    } catch (err: any) {
      console.error('Failed to remove outbox item:', err);
    }
  };

  // Unblock ALL blocked outbox items
  const handleUnblockAll = async () => {
    try {
      setIsSyncing(true);
      const outbox = await localDb.listOutbox();
      let count = 0;
      for (const item of outbox) {
        if (item.status === 'blocked') {
          item.status = 'pending';
          item.retryCount = 0;
          await localDb.saveOutbox(item);
          count++;
        }
      }
      await refreshSyncData();
      if (count > 0) {
        showToast(
          locale === 'ar'
            ? `تم تحرير وإعادة تقييم ${count} عمليات محجوزة. جاري إرسالها للخدم الآن...`
            : `Unblocked ${count} operations. Starting sync now...`,
          'success'
        );
        await handleManualSync();
      } else {
        showToast(
          locale === 'ar' ? 'لا توجد عمليات محجوزة حالياً' : 'No blocked operations found',
          'info'
        );
        setIsSyncing(false);
      }
    } catch (err: any) {
      console.error('Failed to unblock all commands:', err);
      setIsSyncing(false);
    }
  };

  // Handle Manual Pull-only Reload
  const handleReloadLatestData = async () => {
    try {
      setIsSyncing(true);
      const res = await globalSyncBridge.requestLatestDataReload();
      showToast(
        locale === 'ar'
          ? `تم تحديث البيانات بنجاح. جلب ${res.pulled} تعديل.`
          : `Data reloaded successfully. Fetched ${res.pulled} changes.`,
        'success'
      );
    } catch (err: any) {
      console.error('Reload latest data error:', err);
      showToast(
        err.message || (locale === 'ar' ? 'تعذر جلب التحديثات الجديدة' : 'Failed to fetch latest updates'),
        'error'
      );
    } finally {
      await refreshSyncData();
      setIsSyncing(false);
    }
  };

  // Handle Clear Diagnostics History
  const handleClearDiagnostics = async () => {
    try {
      await localDb.clearSyncHistory();
      syncEventEmitter.emit({ type: 'sync_history_cleared', timestamp: new Date().toISOString() });
      await refreshSyncData();
      showToast(
        locale === 'ar' ? 'تم تفريغ سجل تشخيصات المزامنة بنجاح' : 'Sync diagnostic log cleared successfully',
        'success'
      );
    } catch (err: any) {
      console.warn('Failed to clear sync diagnostics:', err);
      showToast(
        locale === 'ar' ? 'فشل تفريغ سجل التشخيصات' : 'Failed to clear sync diagnostics',
        'error'
      );
    }
  };

  // Open modal filtered to specific metric
  const handleOpenMetricFilter = (filterType: 'ALL' | 'SYNCED' | 'PENDING' | 'BLOCKED' | 'FAILED') => {
    setSessionFilter(filterType);
    setActiveTab('SESSION');
    setIsModalOpen(true);
  };

  // Date Formatting Helper
  const formatDate = (isoString?: string) => {
    if (!isoString) return locale === 'ar' ? 'غير متوفر' : 'Not available';
    try {
      const d = new Date(isoString);
      return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        day: 'numeric',
        month: 'short',
      }).format(d);
    } catch {
      return isoString;
    }
  };

  // Human-readable command translation
  const translateCommandType = (type: string, payload?: any): string => {
    switch (type) {
      case 'CREATE_CUSTOMER':
        return locale === 'ar' ? `إنشاء العميل (${payload?.name || 'جديد'})` : `Register Customer (${payload?.name || 'New'})`;
      case 'UPDATE_CUSTOMER':
        return locale === 'ar' ? `تعديل العميل (${payload?.name || 'بيانات العميل'})` : `Update Customer (${payload?.name || 'Details'})`;
      case 'CREATE_ORDER':
        return locale === 'ar' ? `إنشاء طلب جديد` : `Create New Order`;
      case 'UPDATE_ORDER':
        return locale === 'ar' ? `تعديل الطلب` : `Update Order`;
      case 'ADD_ORDER_ITEM':
        return locale === 'ar' ? `إضافة جهاز/عنصر للطلب` : `Add Order Item`;
      case 'RECORD_PAYMENT':
      case 'CREATE_LEDGER_ENTRY':
        return locale === 'ar' ? `تسجيل دفعة مالية (${payload?.amount || 0} شيكل)` : `Record Payment (${payload?.amount || 0})`;
      case 'OPEN_DAY':
      case 'CREATE_DAY':
        return locale === 'ar' ? `فتح يوم جديد` : `Open New Day`;
      case 'CLOSE_DAY':
        return locale === 'ar' ? `إغلاق اليوم` : `Close Day`;
      default:
        return type;
    }
  };

  // Status Badge Config for Concise Card
  const renderStatusCard = () => {
    switch (currentState) {
      case 'SYNCED':
        return {
          title: locale === 'ar' ? 'متزامن بالكامل' : 'Fully Synchronized',
          desc: locale === 'ar'
            ? 'جميع البيانات المحلية متطابقة ومتزامنة بالكامل مع الخادم السحابي.'
            : 'All local data is fully in sync with the remote cloud server.',
          badgeBg: 'bg-emerald-500/10 text-emerald-700 dark:text-[#8eb698]',
          icon: <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-[#8eb698]" />,
        };
      case 'SYNCING':
        return {
          title: locale === 'ar' ? 'جاري المزامنة الآن...' : 'Syncing in Progress...',
          desc: locale === 'ar'
            ? 'جاري إرسال التغييرات المحلية واستقبال التحديثات من الخادم.'
            : 'Sending local commands and fetching remote change updates.',
          badgeBg: 'bg-purple-500/10 text-purple-700 dark:text-purple-300',
          icon: <RefreshCw className="w-5 h-5 text-purple-600 dark:text-purple-400 animate-spin" />,
        };
      case 'PENDING':
        return {
          title: locale === 'ar' ? 'تغييرات بانتظار المزامنة' : 'Pending Operations',
          desc: locale === 'ar'
            ? `${pendingCount} عمليات محفوظة محلياً وبانتظار الإرسال تلقائياً.`
            : `${pendingCount} local operations queued in outbox waiting for sync.`,
          badgeBg: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
          icon: <Clock className="w-5 h-5 text-blue-600 dark:text-blue-400" />,
        };
      case 'BLOCKED':
        return {
          title: locale === 'ar' ? 'عمليات محجوزة (تعتمد على أمر)' : 'Blocked Operations (Dependency)',
          desc: locale === 'ar'
            ? `توجد ${blockedCount} عمليات محجوزة بانتظار المزامنة. يمكن تحريرها ومزامنتها الآن.`
            : `${blockedCount} operations blocked pending prerequisite commands.`,
          badgeBg: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
          icon: <Lock className="w-5 h-5 text-amber-600 dark:text-amber-400" />,
        };
      case 'FAILED':
        return {
          title: locale === 'ar' ? 'تعذرت مزامنة بعض العمليات' : 'Sync Error Encountered',
          desc: locale === 'ar'
            ? 'حدث تعثر في بعض العمليات، البيانات المحلية محفوظة ويمكن إعادة المحاولة.'
            : 'Some operations encountered errors. Local data is safely preserved.',
          badgeBg: 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
          icon: <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400" />,
        };
      case 'OFFLINE':
        return {
          title: locale === 'ar' ? 'يعمل دون إنترنت (Offline)' : 'Offline Mode Active',
          desc: locale === 'ar'
            ? 'التطبيق يعمل دون اتصال. البيانات محفوظة محلياً وستتزامن فور إعادة الاتصال.'
            : 'Working offline. Local data is preserved and will sync upon reconnection.',
          badgeBg: 'bg-gray-500/10 text-gray-700 dark:text-gray-300',
          icon: <Activity className="w-5 h-5 text-gray-500" />,
        };
      case 'AUTH_REQUIRED':
        return {
          title: locale === 'ar' ? 'الجلسة تحتاج إلى إعادة تحقق' : 'Auth Required',
          desc: locale === 'ar'
            ? 'انتهت صلاحية الجلسة السحابية أو تتطلب إعادة إثبات الهوية.'
            : 'Cloud session is unauthenticated or expired.',
          badgeBg: 'bg-orange-500/10 text-orange-700 dark:text-orange-300',
          icon: <ShieldAlert className="w-5 h-5 text-orange-600 dark:text-orange-400" />,
        };
    }
  };

  const statusCard = renderStatusCard();

  // ---------------------------------------------------------------------------
  // OUTBOX QUEUE & SESSION EVENT AGGREGATION (Always includes ALL active outbox items)
  // ---------------------------------------------------------------------------
  const sessionEvents = useMemo(() => {
    const combinedMap = new Map<string, {
      commandId: string;
      commandType: string;
      aggregateType: string;
      aggregateId: string;
      payload: any;
      status: 'SYNCED' | 'PENDING' | 'BLOCKED' | 'FAILED';
      createdAt: string;
      updatedAt?: string;
      errorMsg?: string;
      customerName?: string;
      customerId?: string;
      dayId?: string;
      isOutboxActive: boolean;
    }>();

    // 1. ALL Active Outbox items currently in IndexedDB queue (MUST ALWAYS BE VISIBLE!)
    for (const item of outboxRecords) {
      const p = (item.payload as any) || {};
      let st: 'PENDING' | 'BLOCKED' | 'FAILED' = 'PENDING';
      if (item.status === 'blocked') st = 'BLOCKED';
      else if (item.status === 'rejected' || item.status === 'conflict') st = 'FAILED';

      combinedMap.set(item.commandId, {
        commandId: item.commandId,
        commandType: item.commandType,
        aggregateType: item.aggregateType,
        aggregateId: item.aggregateId,
        payload: p,
        status: st,
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
        errorMsg: item.lastError || (st === 'BLOCKED' ? (locale === 'ar' ? 'عملية محجوزة بانتظار إعادة تقييم التبعيات والمزامنة' : 'Blocked operation waiting for dependency sync') : undefined),
        customerName: p.customerName || p.name || p.customer_name,
        customerId: p.customerId || (item.aggregateType === 'customers' ? item.aggregateId : undefined),
        dayId: p.dayId,
        isOutboxActive: true,
      });
    }

    // 2. History items (Already completed syncs)
    for (const h of historyRecords) {
      const p = (h as any).payload || {};
      let st: 'SYNCED' | 'PENDING' | 'BLOCKED' | 'FAILED' = 'SYNCED';
      if (h.state === 'BLOCKED' || h.state === 'WAITING_DEPENDENCY') st = 'BLOCKED';
      else if (h.state === 'FAILED' || h.state === 'FAILED_PERMANENT') st = 'FAILED';
      else if (h.state === 'PENDING' || h.state === 'READY') st = 'PENDING';

      const existing = combinedMap.get(h.commandId);
      // Only add history if it's not already active in outbox OR if it succeeded
      if (!existing || st === 'SYNCED') {
        combinedMap.set(h.commandId, {
          commandId: h.commandId,
          commandType: h.commandType,
          aggregateType: h.entityType || h.commandType,
          aggregateId: h.entityId || h.commandId,
          payload: existing?.payload || p,
          status: st,
          createdAt: h.createdAt || existing?.createdAt || new Date().toISOString(),
          updatedAt: h.updatedAt,
          errorMsg: h.errorMessage || existing?.errorMsg,
          customerName: p.customerName || p.name || existing?.customerName,
          customerId: p.customerId || existing?.customerId,
          dayId: p.dayId || existing?.dayId,
          isOutboxActive: existing?.isOutboxActive || false,
        });
      }
    }

    const list = Array.from(combinedMap.values());
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return list;
  }, [outboxRecords, historyRecords, locale]);

  // Group Events by Entity (Customer / Day / System)
  const groupedSessionEvents = useMemo(() => {
    const groups = new Map<string, {
      groupTitle: string;
      groupType: 'CUSTOMER' | 'DAY' | 'SYSTEM';
      entityId?: string;
      events: typeof sessionEvents;
    }>();

    for (const evt of sessionEvents) {
      // Filter by status filter
      if (sessionFilter !== 'ALL' && evt.status !== sessionFilter) {
        continue;
      }
      // Search query filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const cmdTitle = translateCommandType(evt.commandType, evt.payload).toLowerCase();
        const cust = (evt.customerName || '').toLowerCase();
        if (!cmdTitle.includes(q) && !cust.includes(q) && !evt.commandId.includes(q)) {
          continue;
        }
      }

      let key = 'system';
      let title = locale === 'ar' ? 'عمليات النظام والعام' : 'General & System Operations';
      let type: 'CUSTOMER' | 'DAY' | 'SYSTEM' = 'SYSTEM';

      if (evt.customerName || evt.customerId) {
        key = `cust_${evt.customerId || evt.customerName}`;
        title = locale === 'ar' ? `العميل: ${evt.customerName || 'عميل محلي'}` : `Customer: ${evt.customerName || 'Local Customer'}`;
        type = 'CUSTOMER';
      } else if (evt.dayId || evt.commandType.includes('DAY')) {
        key = `day_${evt.dayId || 'current'}`;
        title = locale === 'ar' ? `إدارة تاريخ اليوم (${evt.dayId || 'اليوم الحقيقي'})` : `Business Day (${evt.dayId || 'Current'})`;
        type = 'DAY';
      }

      if (!groups.has(key)) {
        groups.set(key, { groupTitle: title, groupType: type, entityId: key, events: [] });
      }
      groups.get(key)!.events.push(evt);
    }

    return Array.from(groups.values());
  }, [sessionEvents, sessionFilter, searchQuery, locale]);

  return (
    <div className="space-y-3">
      {/* Section Header Label */}
      <div className="px-0.5 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-[#8eb698]">
        {locale === 'ar' ? 'المزامنة وحالة النظام' : 'Synchronization & System Status'}
      </div>

      {/* CONCISE COMPACT SYNC CARD (Short & Clean) */}
      <div className="p-4 rounded-2xl border border-gray-200/80 dark:border-[#123832] bg-white dark:bg-[#06201c] shadow-sm hover:border-emerald-500/50 transition-all">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          
          {/* Status Title & Icon */}
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 border border-transparent dark:border-[#14423b] ${statusCard.badgeBg}`}>
              {statusCard.icon}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                  {statusCard.title}
                </h4>
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border bg-gray-50 dark:bg-[#041714] border-gray-200 dark:border-[#123832]">
                  {isOnline ? (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      <span className="text-emerald-700 dark:text-[#8eb698]">Online</span>
                    </>
                  ) : (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                      <span className="text-amber-700 dark:text-amber-300">Offline</span>
                    </>
                  )}
                </span>
              </div>
              <p className="text-xs text-gray-500 dark:text-[#8eb698] mt-0.5">
                {statusCard.desc}
              </p>
            </div>
          </div>

          {/* Action to Open Details Modal */}
          <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsModalOpen(true)}
              className="text-xs h-9 px-4 cursor-pointer font-medium bg-gray-50 dark:bg-[#0c312b] border-gray-200 dark:border-[#14423b] hover:bg-emerald-50 dark:hover:bg-[#123832] hover:text-emerald-700 dark:hover:text-[#daf1de] transition-colors"
            >
              <Activity className={`w-4 h-4 ${isRTL ? 'ml-1.5' : 'mr-1.5'} text-emerald-600 dark:text-[#8eb698]`} />
              <span>{locale === 'ar' ? 'إدارة وتفاصيل المزامنة' : 'Manage & Sync Details'}</span>
            </Button>
          </div>
        </div>
      </div>

      {/* FULL MODAL DIALOG FOR SYNC CENTER & SESSION EVENT LOG */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={locale === 'ar' ? 'مركز المزامنة وتشخيص الجلسة الحالية' : 'Sync Center & Session Diagnostics'}
        className="max-w-4xl max-h-[90vh] flex flex-col p-0 overflow-hidden rounded-3xl"
      >
        <div className="p-5 space-y-4 overflow-y-auto max-h-[calc(90vh-80px)]">
          
          {/* Top Control Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-2xl bg-gray-50 dark:bg-[#041714] border border-gray-200/80 dark:border-[#123832]">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-gray-700 dark:text-[#daf1de]">
                {locale === 'ar' ? 'إجراءات المزامنة السريعة:' : 'Quick Sync Actions:'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleClearDiagnostics}
                disabled={isSyncing}
                className="text-xs h-8 px-3 cursor-pointer text-gray-700 dark:text-[#8eb698] hover:text-rose-600 dark:hover:text-rose-400 border-rose-200 dark:border-rose-900/60"
              >
                <Trash2 className={`w-3.5 h-3.5 ${isRTL ? 'ml-1.5' : 'mr-1.5'}`} />
                <span>{locale === 'ar' ? 'تفريغ السجل' : 'Clear Log'}</span>
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleReloadLatestData}
                disabled={isSyncing || !isOnline}
                className="text-xs h-8 px-3 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRTL ? 'ml-1.5' : 'mr-1.5'} ${isSyncing ? 'animate-spin' : ''}`} />
                <span>{locale === 'ar' ? 'تحديث السحابة' : 'Reload Latest'}</span>
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleManualSync}
                disabled={isSyncing || !isOnline}
                className="text-xs h-8 px-3 cursor-pointer bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRTL ? 'ml-1.5' : 'mr-1.5'} ${isSyncing ? 'animate-spin' : ''}`} />
                <span>{locale === 'ar' ? 'مزامنة الآن' : 'Sync Now'}</span>
              </Button>
            </div>
          </div>

          {/* Interactive Metric Cards (Clicking opens/filters to that metric) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            
            {/* Pending Card */}
            <div
              onClick={() => handleOpenMetricFilter('PENDING')}
              className={`p-3 rounded-xl border cursor-pointer transition-all hover:scale-[1.02] ${
                sessionFilter === 'PENDING'
                  ? 'bg-blue-50 dark:bg-blue-950/50 border-blue-500 shadow-sm'
                  : 'bg-white dark:bg-[#06201c] border-gray-200/80 dark:border-[#123832]'
              }`}
            >
              <span className="text-[11px] text-gray-500 dark:text-[#8eb698] block">
                {locale === 'ar' ? 'بانتظار المزامنة' : 'Pending Queue'}
              </span>
              <div className="flex items-center justify-between mt-1">
                <span className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">{pendingCount}</span>
                <Clock className="w-4 h-4 text-blue-500" />
              </div>
            </div>

            {/* Blocked Card (Clicking switches to BLOCKED filter) */}
            <div
              onClick={() => handleOpenMetricFilter('BLOCKED')}
              className={`p-3 rounded-xl border cursor-pointer transition-all hover:scale-[1.02] ${
                sessionFilter === 'BLOCKED'
                  ? 'bg-amber-50 dark:bg-amber-950/50 border-amber-500 shadow-sm'
                  : 'bg-white dark:bg-[#06201c] border-gray-200/80 dark:border-[#123832]'
              }`}
            >
              <span className="text-[11px] text-gray-500 dark:text-[#8eb698] block font-semibold text-amber-700 dark:text-amber-400">
                {locale === 'ar' ? 'محجوزة (تعتمد على أمر)' : 'Blocked Deps'}
              </span>
              <div className="flex items-center justify-between mt-1">
                <span className="text-base font-extrabold text-amber-700 dark:text-amber-300">{blockedCount}</span>
                <Lock className="w-4 h-4 text-amber-500 animate-bounce" />
              </div>
            </div>

            {/* Failed Card */}
            <div
              onClick={() => handleOpenMetricFilter('FAILED')}
              className={`p-3 rounded-xl border cursor-pointer transition-all hover:scale-[1.02] ${
                sessionFilter === 'FAILED'
                  ? 'bg-rose-50 dark:bg-rose-950/50 border-rose-500 shadow-sm'
                  : 'bg-white dark:bg-[#06201c] border-gray-200/80 dark:border-[#123832]'
              }`}
            >
              <span className="text-[11px] text-gray-500 dark:text-[#8eb698] block">
                {locale === 'ar' ? 'أخطاء موثقة' : 'Failed Count'}
              </span>
              <div className="flex items-center justify-between mt-1">
                <span className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">{failedCount}</span>
                <AlertTriangle className="w-4 h-4 text-rose-500" />
              </div>
            </div>

            {/* Last Sync */}
            <div className="p-3 rounded-xl bg-white dark:bg-[#06201c] border border-gray-200/80 dark:border-[#123832]">
              <span className="text-[11px] text-gray-500 dark:text-[#8eb698] block">
                {locale === 'ar' ? 'آخر مزامنة' : 'Last Sync'}
              </span>
              <span className="text-[11px] font-semibold text-gray-800 dark:text-[#daf1de] block mt-1 truncate">
                {lastPulledAt ? formatDate(lastPulledAt) : (locale === 'ar' ? 'غير متوفر' : 'Not available')}
              </span>
            </div>
          </div>

          {/* Dedicated BIN authorization queue. This is independent from dependency-blocked items. */}
          {binRequiredCount > 0 && (
            <div className="p-3.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-800/80 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 text-emerald-900 dark:text-emerald-200 text-xs">
                  <ShieldAlert className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <div>
                    <div className="font-bold">
                      {locale === 'ar' ? `عمليات تحتاج BIN (${binRequiredCount})` : `Operations requiring BIN (${binRequiredCount})`}
                    </div>
                    <div className="text-[11px] opacity-80">
                      {locale === 'ar'
                        ? 'حدد العمليات التي تريد اعتمادها، ثم أدخل BIN مرة واحدة. الخادم يتحقق من كل عملية بشكل مستقل.'
                        : 'Select the operations to authorize, then enter BIN once. The server validates each command independently.'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedBinCommandIds(
                        selectedBinCommandIds.length === binRequiredItems.length
                          ? []
                          : binRequiredItems.map((o) => o.commandId)
                      )
                    }
                    className="px-2.5 py-1 rounded-lg text-[10px] font-bold border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
                  >
                    {selectedBinCommandIds.length === binRequiredItems.length
                      ? (locale === 'ar' ? 'إلغاء تحديد الكل' : 'Clear all')
                      : (locale === 'ar' ? 'تحديد الكل' : 'Select all')}
                  </button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleProvideBinForCommands(selectedBinCommandIds)}
                    disabled={isSyncing || !isOnline || selectedBinCommandIds.length === 0}
                    className="text-xs h-8 px-4 cursor-pointer font-bold bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    {locale === 'ar'
                      ? `إدخال BIN (${selectedBinCommandIds.length})`
                      : `Enter BIN (${selectedBinCommandIds.length})`}
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                {binRequiredItems.map((item) => {
                  const payload = (item.payload || {}) as any;
                  const checked = selectedBinCommandIds.includes(item.commandId);
                  return (
                    <label
                      key={item.commandId}
                      className="flex items-center gap-2.5 p-2 rounded-xl bg-white/70 dark:bg-[#06201c]/70 border border-emerald-200/70 dark:border-[#123832] cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedBinCommandIds((prev) =>
                            checked
                              ? prev.filter((id) => id !== item.commandId)
                              : [...prev, item.commandId]
                          )
                        }
                        className="w-4 h-4 accent-emerald-600"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] truncate">
                          {translateCommandType(item.commandType, payload)}
                        </div>
                        <div className="text-[10px] text-gray-500 dark:text-[#8eb698] truncate">
                          {payload?.customerName || payload?.customer_name || payload?.name || item.aggregateId}
                          {item.lastError ? ` — ${item.lastError}` : ''}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}


          <Modal
            isOpen={isBinModalOpen}
            onClose={() => {
              setIsBinModalOpen(false);
              setBinInput('');
            }}
            title={locale === 'ar' ? 'إدخال BIN' : 'Enter BIN'}
            className="max-w-md"
          >
            <div className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-[#8eb698]">
                {locale === 'ar'
                  ? `أدخل BIN مرة واحدة لاعتماد ${selectedBinCommandIds.length} عمليات محددة. سيتم التحقق من كل عملية من الخادم.`
                  : `Enter BIN once to authorize ${selectedBinCommandIds.length} selected operations. The server will validate each command.`}
              </p>
              <input
                type="password"
                value={binInput}
                onChange={(e) => setBinInput(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleConfirmBin();
                  }
                }}
                inputMode="numeric"
                autoFocus
                autoComplete="off"
                maxLength={32}
                placeholder={locale === 'ar' ? 'أدخل BIN هنا' : 'Enter BIN here'}
                className="w-full h-11 px-3 rounded-xl border border-gray-300 dark:border-[#14423b] bg-white dark:bg-[#041714] text-gray-900 dark:text-[#daf1de] outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setIsBinModalOpen(false);
                    setBinInput('');
                  }}
                >
                  {locale === 'ar' ? 'إلغاء' : 'Cancel'}
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleConfirmBin()}
                  disabled={!/^\d{4,}$/.test(binInput.trim()) || isSyncing || !isOnline}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {locale === 'ar' ? 'اعتماد ومزامنة' : 'Authorize & Sync'}
                </Button>
              </div>
            </div>
          </Modal>

          {/* Prominent Action Banner when Blocked Items Exist */}
          {blockedCount > 0 && (
            <div className="p-3.5 rounded-2xl bg-amber-50 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800/80 flex flex-col sm:flex-row items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-amber-900 dark:text-amber-200 text-xs">
                <Lock className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <span>
                  {locale === 'ar'
                    ? `توجد ${blockedCount} عمليات محجوزة في طابور الانتظار. انقر للتحرير والمزامنة الآن.`
                    : `${blockedCount} operations are currently blocked in queue.`}
                </span>
              </div>

              <Button
                type="button"
                size="sm"
                onClick={handleUnblockAll}
                disabled={isSyncing}
                className="text-xs h-8 px-4 cursor-pointer font-bold bg-amber-600 hover:bg-amber-700 text-white shrink-0 shadow-sm"
              >
                <Unlock className={`w-3.5 h-3.5 ${isRTL ? 'ml-1.5' : 'mr-1.5'} ${isSyncing ? 'animate-spin' : ''}`} />
                <span>{locale === 'ar' ? `إعادة تقييم ومزامنة الـ (${blockedCount}) الآن` : `Unblock & Sync (${blockedCount})`}</span>
              </Button>
            </div>
          )}

          {/* Modal Tab Navigation Header */}
          <div className="flex items-center border-b border-gray-200 dark:border-[#123832] pt-2">
            <button
              type="button"
              onClick={() => setActiveTab('SESSION')}
              className={`pb-2.5 px-4 text-xs font-bold transition-all border-b-2 cursor-pointer flex items-center gap-2 ${
                activeTab === 'SESSION'
                  ? 'border-emerald-600 text-emerald-700 dark:text-[#daf1de]'
                  : 'border-transparent text-gray-500 dark:text-[#8eb698] hover:text-gray-900'
              }`}
            >
              <Activity className="w-4 h-4" />
              <span>{locale === 'ar' ? 'طابور الانتظار وسجل الأحداث' : 'Outbox Queue & Event Log'}</span>
              <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-500/20 text-emerald-700 dark:text-[#8eb698]">
                {sessionEvents.length}
              </span>
            </button>

            {isSuperAdmin && (
              <button
                type="button"
                onClick={() => setActiveTab('DIAGNOSTICS')}
                className={`pb-2.5 px-4 text-xs font-bold transition-all border-b-2 cursor-pointer flex items-center gap-2 ${
                  activeTab === 'DIAGNOSTICS'
                    ? 'border-emerald-600 text-emerald-700 dark:text-[#daf1de]'
                    : 'border-transparent text-gray-500 dark:text-[#8eb698] hover:text-gray-900'
                }`}
              >
                <Terminal className="w-4 h-4" />
                <span>{locale === 'ar' ? 'تشخيصات المطورين' : 'Developer Diagnostics'}</span>
              </button>
            )}
          </div>

          {/* TAB 1: OUTBOX QUEUE & SESSION EVENT LOG */}
          {activeTab === 'SESSION' && (
            <div className="space-y-4">
              
              {/* Filter Controls Bar */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                
                {/* Search Box */}
                <div className="relative w-full sm:w-64">
                  <Search className={`w-3.5 h-3.5 absolute top-2.5 ${isRTL ? 'right-3' : 'left-3'} text-gray-400`} />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={locale === 'ar' ? 'بحث بالعميل أو العملية...' : 'Filter by customer/operation...'}
                    className={`w-full h-8 text-xs rounded-xl bg-gray-50 dark:bg-[#041714] border border-gray-200 dark:border-[#123832] ${
                      isRTL ? 'pr-8 pl-3' : 'pl-8 pr-3'
                    } text-gray-900 dark:text-[#daf1de] focus:outline-none focus:border-emerald-500`}
                  />
                </div>

                {/* Status Filter Buttons */}
                <div className="flex items-center gap-1 overflow-x-auto w-full sm:w-auto">
                  {(['ALL', 'SYNCED', 'PENDING', 'BLOCKED', 'FAILED'] as const).map((filterVal) => (
                    <button
                      key={filterVal}
                      type="button"
                      onClick={() => setSessionFilter(filterVal)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer transition-colors whitespace-nowrap ${
                        sessionFilter === filterVal
                          ? 'bg-emerald-600 text-white shadow-sm'
                          : 'bg-gray-100 dark:bg-[#0c312b] text-gray-600 dark:text-[#8eb698] hover:bg-gray-200'
                      }`}
                    >
                      {filterVal === 'ALL' && (locale === 'ar' ? 'الكل' : 'All')}
                      {filterVal === 'SYNCED' && (locale === 'ar' ? 'تمت المزامنة' : 'Synced')}
                      {filterVal === 'PENDING' && (locale === 'ar' ? 'بانتظار المزامنة' : 'Pending')}
                      {filterVal === 'BLOCKED' && (locale === 'ar' ? `محجوزة (${blockedCount})` : `Blocked (${blockedCount})`)}
                      {filterVal === 'FAILED' && (locale === 'ar' ? 'تعثرت' : 'Failed')}
                    </button>
                  ))}
                </div>
              </div>

              {/* Event Groups List */}
              {groupedSessionEvents.length === 0 ? (
                <div className="p-8 text-center rounded-2xl bg-gray-50 dark:bg-[#041714] border border-dashed border-gray-200 dark:border-[#123832]">
                  <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto mb-2 opacity-80" />
                  <p className="text-xs font-semibold text-gray-700 dark:text-[#daf1de]">
                    {locale === 'ar' ? 'لا توجد عمليات بهذا الفلتر في طابور الانتظار' : 'No operations matching filter in queue.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {groupedSessionEvents.map((group) => (
                    <div
                      key={group.entityId}
                      className="rounded-2xl border border-gray-200/80 dark:border-[#123832] bg-white dark:bg-[#06201c] overflow-hidden"
                    >
                      {/* Group Header */}
                      <div className="px-4 py-2.5 bg-gray-50/80 dark:bg-[#041714] border-b border-gray-200/60 dark:border-[#123832] flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {group.groupType === 'CUSTOMER' && <Users className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />}
                          {group.groupType === 'DAY' && <Calendar className="w-4 h-4 text-blue-600 dark:text-blue-400" />}
                          {group.groupType === 'SYSTEM' && <Layers className="w-4 h-4 text-purple-600 dark:text-purple-400" />}
                          <span className="text-xs font-bold text-gray-900 dark:text-[#daf1de]">
                            {group.groupTitle}
                          </span>
                        </div>
                        <span className="text-[10px] font-semibold text-gray-500 dark:text-[#8eb698]">
                          {group.events.length} {locale === 'ar' ? 'عمليات' : 'events'}
                        </span>
                      </div>

                      {/* Group Items Timeline */}
                      <div className="divide-y divide-gray-100 dark:divide-[#0f302b]">
                        {group.events.map((evt) => {
                          const isSelected = selectedRecordId === evt.commandId;
                          return (
                            <div
                              key={evt.commandId}
                              className={`p-3 transition-colors cursor-pointer hover:bg-gray-50/60 dark:hover:bg-[#082823] ${
                                isSelected ? 'bg-emerald-50/30 dark:bg-[#0c312b]/40' : ''
                              }`}
                              onClick={() => setSelectedRecordId(isSelected ? null : evt.commandId)}
                            >
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                                <div className="flex items-center gap-2.5">
                                  {evt.status === 'SYNCED' && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
                                  {evt.status === 'PENDING' && <Clock className="w-4 h-4 text-blue-500 shrink-0" />}
                                  {evt.status === 'BLOCKED' && <Lock className="w-4 h-4 text-amber-500 shrink-0" />}
                                  {evt.status === 'FAILED' && <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />}

                                  <div>
                                    <span className="text-xs font-semibold text-gray-900 dark:text-[#daf1de] block">
                                      {translateCommandType(evt.commandType, evt.payload)}
                                    </span>
                                    <span className="text-[10px] text-gray-400 block mt-0.5">
                                      {formatDate(evt.createdAt)}
                                    </span>
                                  </div>
                                </div>

                                <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                                  {/* Individual Action Buttons for Blocked/Pending items */}
                                  {evt.isOutboxActive && evt.status === 'BLOCKED' && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleUnblockSingle(evt.commandId);
                                      }}
                                      className="px-2 py-1 rounded-lg text-[10px] font-bold bg-amber-500 hover:bg-amber-600 text-white cursor-pointer transition-colors shadow-sm"
                                    >
                                      {locale === 'ar' ? 'إلغاء الحجز ومزامنة' : 'Unblock & Sync'}
                                    </button>
                                  )}

                                  {evt.isOutboxActive && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleRemoveSingleOutbox(evt.commandId);
                                      }}
                                      className="px-2 py-1 rounded-lg text-[10px] font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer transition-colors border border-rose-200/80 dark:border-rose-900/60"
                                      title={locale === 'ar' ? 'حذف العملية من طابور المزامنة' : 'Remove from queue'}
                                    >
                                      {locale === 'ar' ? 'حذف' : 'Remove'}
                                    </button>
                                  )}

                                  <span
                                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                      evt.status === 'SYNCED'
                                        ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                                        : evt.status === 'PENDING'
                                        ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-300'
                                        : evt.status === 'BLOCKED'
                                        ? 'bg-amber-50 dark:bg-amber-950/60 border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300'
                                        : 'bg-rose-50 dark:bg-rose-950/60 border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300'
                                    }`}
                                  >
                                    {evt.status === 'SYNCED' && (locale === 'ar' ? 'تمت المزامنة بنجاح' : 'Synced')}
                                    {evt.status === 'PENDING' && (locale === 'ar' ? 'بانتظار الإرسال' : 'Pending')}
                                    {evt.status === 'BLOCKED' && (locale === 'ar' ? 'محجوزة (تعتمد على أمر)' : 'Blocked')}
                                    {evt.status === 'FAILED' && (locale === 'ar' ? 'تعثرت المزامنة' : 'Failed')}
                                  </span>

                                  {isSelected ? (
                                    <ChevronUp className="w-3.5 h-3.5 text-gray-400" />
                                  ) : (
                                    <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                                  )}
                                </div>
                              </div>

                              {/* Detailed Inspection Drawer */}
                              {isSelected && (
                                <div className="mt-2.5 pt-2.5 border-t border-gray-100 dark:border-[#123832] text-[11px] space-y-1.5 text-gray-600 dark:text-[#8eb698] bg-gray-50/50 dark:bg-[#041714] p-2.5 rounded-xl font-mono">
                                  <div><strong className="text-gray-900 dark:text-[#daf1de]">Command ID:</strong> {evt.commandId}</div>
                                  <div><strong className="text-gray-900 dark:text-[#daf1de]">Command Type:</strong> {evt.commandType}</div>
                                  {evt.errorMsg && (
                                    <div className="p-2 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-800 font-sans mt-1">
                                      <strong>{locale === 'ar' ? 'سبب تعليق/حجز العملية:' : 'Blocking Cause:'}</strong> {evt.errorMsg}
                                    </div>
                                  )}
                                  <div className="pt-1">
                                    <strong className="text-gray-900 dark:text-[#daf1de]">Payload Details:</strong>
                                    <pre className="text-[10px] mt-0.5 p-1.5 rounded bg-gray-100 dark:bg-gray-950 text-gray-800 dark:text-gray-200 overflow-x-auto">
                                      {JSON.stringify(evt.payload, null, 2)}
                                    </pre>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: DEVELOPER DIAGNOSTICS LOG (Super Admin) */}
          {activeTab === 'DIAGNOSTICS' && isSuperAdmin && (
            <div className="space-y-3 bg-gray-950 text-gray-100 p-4 rounded-2xl border border-gray-800 text-xs font-mono overflow-hidden">
              <div className="flex items-center justify-between border-b border-gray-800 pb-2 text-[11px] text-gray-400">
                <div className="flex items-center gap-3">
                  <span>Total History Entries: {historyRecords.length}</span>
                  {historyRecords.length > 0 && (
                    <button
                      type="button"
                      onClick={handleClearDiagnostics}
                      className="text-rose-400 hover:text-rose-300 underline cursor-pointer text-[10px]"
                    >
                      {locale === 'ar' ? 'تفريغ السجل' : 'Clear Log'}
                    </button>
                  )}
                </div>
                <span>Outbox Queue Size: {outboxRecords.length}</span>
              </div>

              {historyRecords.length === 0 ? (
                <div className="py-8 text-center text-gray-500 italic">
                  {locale === 'ar' ? 'لا توجد سجلات مزامنة فنية بعد' : 'No sync history records available.'}
                </div>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                  {historyRecords.map((rec) => {
                    const isSelected = selectedRecordId === rec.commandId;
                    return (
                      <div
                        key={rec.historyId || rec.commandId}
                        className={`p-2.5 rounded-lg border transition-all cursor-pointer ${
                          rec.state === 'SUCCESS' || rec.state === 'SUCCEEDED'
                            ? 'bg-emerald-950/30 border-emerald-800/40 text-emerald-200'
                            : rec.state === 'BLOCKED'
                            ? 'bg-amber-950/30 border-amber-800/40 text-amber-200'
                            : 'bg-rose-950/30 border-rose-800/40 text-rose-200'
                        }`}
                        onClick={() => setSelectedRecordId(isSelected ? null : rec.commandId)}
                      >
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-bold text-gray-100">{rec.commandType}</span>
                          <span className="px-1.5 py-0.5 rounded text-[10px] uppercase font-bold bg-black/40">
                            {rec.state}
                          </span>
                        </div>

                        <div className="text-[10px] text-gray-400 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                          <span>cmd: {rec.commandId}</span>
                          <span>entity: {rec.entityType}/{rec.entityId}</span>
                          <span>attempts: {rec.attemptCount}</span>
                        </div>

                        {rec.errorMessage && (
                          <div className="mt-1 text-[11px] text-rose-300 bg-rose-950/60 p-1.5 rounded border border-rose-800/50">
                            <span className="font-semibold">{rec.errorClass || 'ERROR'}:</span> {rec.errorMessage}
                          </div>
                        )}

                        {isSelected && (
                          <div className="mt-2 pt-2 border-t border-gray-800 text-[10px] space-y-1 text-gray-300">
                            <div><strong className="text-gray-400">GroupId:</strong> {rec.groupId || 'N/A'}</div>
                            <div><strong className="text-gray-400">FailureStage:</strong> {rec.failureStage || 'N/A'}</div>
                            <div><strong className="text-gray-400">RpcReached:</strong> {rec.rpcReached ? 'YES' : 'NO'}</div>
                            <div><strong className="text-gray-400">RetryEligible:</strong> {rec.retryEligible ? 'YES' : 'NO'}</div>
                            <div><strong className="text-gray-400">DependencyCmd:</strong> {rec.dependencyCommandId || 'None'}</div>
                            <div><strong className="text-gray-400">CreatedAt:</strong> {rec.createdAt}</div>
                            <div><strong className="text-gray-400">UpdatedAt:</strong> {rec.updatedAt}</div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

        </div>
      </Modal>
    </div>
  );
};