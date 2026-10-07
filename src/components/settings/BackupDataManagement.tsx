import React, { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { useToast } from '../ui/Toast';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import {
  backupService,
  CreateSnapshotOptions,
  PortableBackupFile,
} from '../../services/backup/backupService';
import { localDb, BackupSnapshotRecord, BackupSourceType } from '../../infrastructure/localDb/localDb';
import { authService } from '../../services/auth/authService';
import { rpcVerifyAdminBin } from '../../services/supabase/client';
import { AuthorizationContext, ActorAdmin } from '../../application/authContext';
import { reloadStoreFromLocal } from '../pages/dayOrdersStore';
import {
  Database,
  CloudDownload,
  Trash2,
  RefreshCw,
  Plus,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  FileArchive,
  Layers,
  KeyRound,
  Eye,
  Info,
  History,
  CloudUpload,
  Download,
  Upload,
} from 'lucide-react';

export const BackupDataManagement: React.FC = () => {
  const { t, locale, isRTL } = useI18n();
  const { showToast } = useToast();

  const [snapshots, setSnapshots] = useState<BackupSnapshotRecord[]>([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState<boolean>(true);
  const [isActionLoading, setIsActionLoading] = useState<boolean>(false);

  // Selected snapshot for details modal
  const [inspectingSnapshot, setInspectingSnapshot] = useState<BackupSnapshotRecord | null>(null);

  // Create Snapshot Dialog State
  const [isCreateOpen, setIsCreateOpen] = useState<boolean>(false);
  const [createSourceType, setCreateSourceType] = useState<BackupSourceType>('OFFLINE');
  const [createName, setCreateName] = useState<string>('');
  const [createBin, setCreateBin] = useState<string>('');

  // Restore Snapshot Dialog State
  const [restoreTarget, setRestoreTarget] = useState<BackupSnapshotRecord | null>(null);
  const [restoreBin, setRestoreBin] = useState<string>('');

  // Delete Snapshot Dialog State
  const [deleteTarget, setDeleteTarget] = useState<BackupSnapshotRecord | null>(null);
  const [deleteBin, setDeleteBin] = useState<string>('');

  // Restore from Online Cloud State
  const [isRestoreOnlineOpen, setIsRestoreOnlineOpen] = useState<boolean>(false);
  const [restoreOnlineBin, setRestoreOnlineBin] = useState<string>('');

  // Zero-Reset / Delete Local Data State
  const [isDeleteLocalOpen, setIsDeleteLocalOpen] = useState<boolean>(false);
  const [deleteLocalBin, setDeleteLocalBin] = useState<string>('');

  // Online Business Reset State
  const [isDeleteOnlineOpen, setIsDeleteOnlineOpen] = useState<boolean>(false);
  const [deleteOnlineBin, setDeleteOnlineBin] = useState<string>('');

  // Local -> Online Replacement State
  const [isReplaceOnlineOpen, setIsReplaceOnlineOpen] = useState<boolean>(false);
  const [replaceOnlineBin, setReplaceOnlineBin] = useState<string>('');
  const [isDiffLoading, setIsDiffLoading] = useState<boolean>(false);
  const [diffData, setDiffData] = useState<any | null>(null);

  // Clear Sync History State
  const [isClearSyncHistoryOpen, setIsClearSyncHistoryOpen] = useState<boolean>(false);

  // Upload Backup & Duplicate Resolution State
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [pendingImportFile, setPendingImportFile] = useState<PortableBackupFile | null>(null);
  const [isDuplicateModalOpen, setIsDuplicateModalOpen] = useState<boolean>(false);

  // Authenticated Admin Profile State for Reset Preview
  const [activeAdminInfo, setActiveAdminInfo] = useState<{ username: string; role: string; fullName: string; isSuperAdmin: boolean } | null>(null);

  useEffect(() => {
    authService.getCurrentSession().then((session) => {
      if (session) {
        setActiveAdminInfo({
          username: session.email ? session.email.split('@')[0] : 'superadmin',
          fullName: session.fullName || 'Administrator',
          role: session.role || 'SUPER_ADMIN',
          isSuperAdmin: session.role === 'SUPER_ADMIN',
        });
      }
    });
  }, []);

  // Helper to build AuthorizationContext for active admin
  const getAuthContext = useCallback(async (): Promise<AuthorizationContext> => {
    const session = await authService.getCurrentSession();
    if (!session) {
      throw new Error(locale === 'ar' ? 'يجب تسجيل الدخول كمسؤول للمتابعة' : 'Admin authentication required');
    }

    const actor: ActorAdmin = {
      id: session.userId,
      username: session.email ? session.email.split('@')[0] : 'admin',
      fullName: session.fullName || 'Admin',
      role: session.role as any,
      permissions: (session.permissions || []) as any,
      isSuperAdmin: session.role === 'SUPER_ADMIN',
    };

    return new AuthorizationContext(actor, async (enteredBin: string) => {
      if (authService.isSupabaseConfigured()) {
        try {
          return await rpcVerifyAdminBin(enteredBin);
        } catch {
          return false;
        }
      }
      return authService.verifyBin(enteredBin);
    });
  }, [locale]);

  // Load snapshot list deterministically (newest first)
  const fetchSnapshots = useCallback(async () => {
    try {
      setLoadingSnapshots(true);
      const list = await backupService.listSnapshots();
      // Ensure sorted newest first
      const sorted = [...list].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setSnapshots(sorted);
    } catch (err: any) {
      console.error('Failed to list snapshots:', err);
      showToast(err.message || (locale === 'ar' ? 'فشل تحميل النسخ الاحتياطية' : 'Failed to load snapshots'), 'error');
    } finally {
      setLoadingSnapshots(false);
    }
  }, [locale, showToast]);

  useEffect(() => {
    fetchSnapshots();
  }, [fetchSnapshots]);

  // Helper for formatting date
  const formatDate = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(d);
    } catch {
      return isoString;
    }
  };

  // Helper to get Source Type Badge color & localized label
  const getSourceTypeBadge = (type: BackupSourceType) => {
    switch (type) {
      case 'OFFLINE':
        return {
          label: t('sourceTypeOffline'),
          className: 'bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/40',
        };
      case 'ONLINE':
        return {
          label: t('sourceTypeOnline'),
          className: 'bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800/40',
        };
      case 'CONSOLIDATED':
        return {
          label: t('sourceTypeConsolidated'),
          className: 'bg-emerald-100 dark:bg-[#0c312b] text-emerald-800 dark:text-[#daf1de] border-emerald-300 dark:border-emerald-700/60',
        };
      default:
        return {
          label: type,
          className: 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700',
        };
    }
  };

  // 1. Handle Create Snapshot Action
  const handleCreateSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanBin = createBin.trim();
    if (!cleanBin || cleanBin.length < 4 || !/^\d{4,}$/.test(cleanBin)) {
      showToast(locale === 'ar' ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل' : 'Valid numeric BIN of at least 4 digits is required', 'error');
      return;
    }

    try {
      setIsActionLoading(true);
      const auth = await getAuthContext();
      const options: CreateSnapshotOptions = {
        name: createName.trim() || undefined,
        bin: cleanBin,
      };

      await backupService.createSnapshot(createSourceType, auth, options);
      showToast(t('snapshotCreatedSuccess'), 'success');
      setIsCreateOpen(false);
      setCreateName('');
      setCreateBin('');
      await fetchSnapshots();
    } catch (err: any) {
      console.error('Create snapshot error:', err);
      let msg = err.message;
      if (msg?.includes('Valid numeric BIN') || msg?.includes('BIN is required') || err.name === 'BinRequiredError') {
        msg = locale === 'ar' ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل' : 'Valid numeric BIN of at least 4 digits is required';
      } else if (msg?.includes('Invalid BIN') || msg?.includes('WRONG_BIN')) {
        msg = locale === 'ar' ? 'رمز التحقق (BIN) غير صحيح' : 'Invalid BIN credential for authenticated admin';
      } else if (!msg) {
        msg = locale === 'ar' ? 'فشل إنشاء النسخة الاحتياطية' : 'Failed to create snapshot';
      }
      showToast(msg, 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  // 2. Handle Restore Snapshot Action
  const handleRestoreSnapshot = async () => {
    if (!restoreTarget) return;
    const cleanBin = restoreBin.trim();
    if (!cleanBin || cleanBin.length < 4 || !/^\d{4,}$/.test(cleanBin)) {
      showToast(locale === 'ar' ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل' : 'Valid numeric BIN of at least 4 digits is required', 'error');
      return;
    }

    try {
      setIsActionLoading(true);
      const auth = await getAuthContext();
      const res = await backupService.restoreSnapshot(restoreTarget.snapshotId, auth, {
        bin: cleanBin,
      });

      await reloadStoreFromLocal();
      const countMsg = t('snapshotRestoredSuccess').replace('{count}', String(res.restoredCount));
      showToast(countMsg, 'success');
      setRestoreTarget(null);
      setRestoreBin('');
    } catch (err: any) {
      console.warn('Restore snapshot error:', err);
      let msg = err.message;
      if (msg?.includes('Valid numeric BIN') || msg?.includes('BIN is required') || err.name === 'BinRequiredError') {
        msg = locale === 'ar' ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل' : 'Valid numeric BIN of at least 4 digits is required';
      } else if (msg?.includes('Invalid BIN') || msg?.includes('WRONG_BIN')) {
        msg = locale === 'ar' ? 'رمز التحقق (BIN) غير صحيح' : 'Invalid BIN credential for authenticated admin';
      } else if (!msg) {
        msg = locale === 'ar' ? 'فشل استعادة النسخة الاحتياطية' : 'Failed to restore snapshot';
      }
      showToast(msg, 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  // 3. Handle Delete Snapshot Action
  const handleDeleteSnapshot = async () => {
    if (!deleteTarget) return;
    const cleanBin = deleteBin.trim();
    if (!cleanBin || cleanBin.length < 4 || !/^\d{4,}$/.test(cleanBin)) {
      showToast(locale === 'ar' ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل' : 'Valid numeric BIN of at least 4 digits is required', 'error');
      return;
    }

    try {
      setIsActionLoading(true);
      const auth = await getAuthContext();
      await backupService.deleteSnapshot(deleteTarget.snapshotId, auth, {
        bin: cleanBin,
      });

      showToast(t('snapshotDeletedSuccess'), 'success');
      setDeleteTarget(null);
      setDeleteBin('');
      await fetchSnapshots();
    } catch (err: any) {
      console.warn('Delete snapshot error:', err);
      let msg = err.message;
      if (msg?.includes('Valid numeric BIN') || msg?.includes('BIN is required') || err.name === 'BinRequiredError') {
        msg = locale === 'ar' ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل' : 'Valid numeric BIN of at least 4 digits is required';
      } else if (msg?.includes('Invalid BIN') || msg?.includes('WRONG_BIN')) {
        msg = locale === 'ar' ? 'رمز التحقق (BIN) غير صحيح' : 'Invalid BIN credential for authenticated admin';
      } else if (!msg) {
        msg = locale === 'ar' ? 'فشل حذف النسخة الاحتياطية' : 'Failed to delete snapshot';
      }
      showToast(msg, 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  // 4. Handle Restore Local Data from Online Action
  const handleRestoreOnline = async () => {
    const cleanBin = restoreOnlineBin.trim();
    if (!cleanBin || cleanBin.length < 4 || !/^\d{4,}$/.test(cleanBin)) {
      showToast(locale === 'ar' ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل' : 'Valid numeric BIN of at least 4 digits is required', 'error');
      return;
    }

    try {
      setIsActionLoading(true);
      const auth = await getAuthContext();
      const res = await backupService.restoreOnlineToLocal(auth, {
        bin: cleanBin,
      });

      await reloadStoreFromLocal();
      const countMsg = t('onlineRestoredSuccess').replace('{count}', String(res.restoredCount));
      showToast(countMsg, 'success');
      setIsRestoreOnlineOpen(false);
      setRestoreOnlineBin('');
    } catch (err: any) {
      console.warn('Restore online error:', err);
      let msg = err.message;
      if (msg?.includes('Valid numeric BIN') || msg?.includes('BIN is required') || err.name === 'BinRequiredError') {
        msg = locale === 'ar' ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل' : 'Valid numeric BIN of at least 4 digits is required';
      } else if (msg?.includes('Invalid BIN') || msg?.includes('WRONG_BIN')) {
        msg = locale === 'ar' ? 'رمز التحقق (BIN) غير صحيح' : 'Invalid BIN credential for authenticated admin';
      } else if (!msg) {
        msg = locale === 'ar' ? 'فشل استعادة البيانات من الخادم' : 'Failed to restore from server';
      }
      showToast(msg, 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  // 5. Handle Reset Local Operational Business Data (Zero Reset)
  const handleDeleteLocalData = async () => {
    const cleanBin = deleteLocalBin.trim();
    if (!cleanBin || cleanBin.length < 4 || !/^\d{4,}$/.test(cleanBin)) {
      showToast(locale === 'ar' ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل' : 'Valid numeric BIN of at least 4 digits is required', 'error');
      return;
    }

    try {
      setIsActionLoading(true);
      const auth = await getAuthContext();
      await backupService.deleteLocalBusinessData(auth, {
        bin: cleanBin,
      });

      await reloadStoreFromLocal();
      showToast(t('localDataDeletedSuccess'), 'success');
      setIsDeleteLocalOpen(false);
      setDeleteLocalBin('');
    } catch (err: any) {
      console.warn('Delete local data error:', err);
      let msg = err.message;
      if (msg?.includes('Valid numeric BIN') || msg?.includes('BIN is required') || err.name === 'BinRequiredError') {
        msg = locale === 'ar' ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل' : 'Valid numeric BIN of at least 4 digits is required';
      } else if (msg?.includes('Invalid BIN') || msg?.includes('WRONG_BIN')) {
        msg = locale === 'ar' ? 'رمز التحقق (BIN) غير صحيح' : 'Invalid BIN credential for authenticated admin';
      } else if (!msg) {
        msg = locale === 'ar' ? 'فشل تصفير البيانات التشغيلية' : 'Failed to reset operational data';
      }
      showToast(msg, 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  // 6. Handle Clear Sync History
  const handleClearSyncHistory = async () => {
    try {
      setIsActionLoading(true);
      const auth = await getAuthContext();
      await backupService.clearSyncHistory(auth);

      showToast(t('syncHistoryClearedSuccess'), 'success');
      setIsClearSyncHistoryOpen(false);
    } catch (err: any) {
      console.warn('Clear sync history error:', err);
      const msg = err.message || (locale === 'ar' ? 'فشل مسح سجل المزامنة' : 'Failed to clear sync history');
      showToast(msg, 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  // 7. Handle Online Reset (Delete Online Business Data)
  const handleDeleteOnlineData = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanBin = deleteOnlineBin.trim();
    if (!cleanBin || cleanBin.length < 4 || !/^\d{4,}$/.test(cleanBin)) {
      showToast(
        locale === 'ar'
          ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل'
          : 'Valid numeric BIN of at least 4 digits is required',
        'error'
      );
      return;
    }

    try {
      setIsActionLoading(true);
      const auth = await getAuthContext();
      await backupService.deleteOnlineBusinessData(auth, cleanBin);

      // Post-reset local operational state cleanup
      // Clear local operational tables & outbox so stale local data cannot overwrite reset server
      await localDb.clearOperationalTables();
      await localDb.setLocalResetMarker(true);
      await reloadStoreFromLocal();

      showToast(
        locale === 'ar'
          ? 'تم تصفير بيانات الأعمال على السحابة (PostgreSQL) وتحديث الحالة المحلية بنجاح'
          : 'Online business data reset successfully on PostgreSQL server',
        'success'
      );
      setIsDeleteOnlineOpen(false);
      setDeleteOnlineBin('');
    } catch (err: any) {
      console.warn('Delete online data error:', err);
      let msg = err.message;
      if (
        msg?.includes('Valid numeric BIN') ||
        msg?.includes('BIN is required') ||
        err.name === 'BinRequiredError'
      ) {
        msg =
          locale === 'ar'
            ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل'
            : 'Valid numeric BIN of at least 4 digits is required';
      } else if (msg?.includes('Invalid BIN') || msg?.includes('WRONG_BIN')) {
        msg =
          locale === 'ar'
            ? 'رمز التحقق (BIN) غير صحيح'
            : 'Invalid BIN credential for authenticated admin';
      } else if (!msg) {
        msg =
          locale === 'ar'
            ? 'فشل تصفير بيانات الأعمال السحابية'
            : 'Failed to reset online business data';
      }
      showToast(msg, 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  // 8. Handle Local -> Online Replacement Preview and Execution
  const handleOpenReplacePreview = async () => {
    setIsReplaceOnlineOpen(true);
    setReplaceOnlineBin('');
    setDiffData(null);
    setIsDiffLoading(true);
    try {
      const [online, local] = await Promise.all([
        backupService.captureOnlineData(),
        backupService.captureLocalData(),
      ]);
      const diff = await backupService.previewReplacementDiff(online, local);
      setDiffData(diff);
    } catch (err: any) {
      console.warn('Failed to calculate replacement diff:', err);
      showToast(
        locale === 'ar' ? 'فشل حساب الفروقات قبل الاستبدال' : 'Failed to calculate diff before replacement',
        'error'
      );
    } finally {
      setIsDiffLoading(false);
    }
  };

  const handleExecuteReplaceOnline = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanBin = replaceOnlineBin.trim();
    if (!cleanBin || cleanBin.length < 4 || !/^\d{4,}$/.test(cleanBin)) {
      showToast(
        locale === 'ar'
          ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل'
          : 'Valid numeric BIN of at least 4 digits is required',
        'error'
      );
      return;
    }

    try {
      setIsActionLoading(true);
      const auth = await getAuthContext();
      const res = await backupService.replaceOnlineWithLocalData(auth, cleanBin);

      console.log('[LIVE_RUNTIME_REPLACEMENT_REPORT]', {
        success: res.success,
        operation: res.operation,
        replacementId: res.replacementId,
        completedAt: res.completedAt,
        counts: res.counts,
        safetySnapshotId: res.safetySnapshotId,
      });

      showToast(
        locale === 'ar'
          ? 'تم استبدال بيانات السحابة بنجاح! تم إنشاء نسخة أمان احتياطية تلقائياً.'
          : 'Online data replaced successfully with local state! Safety snapshot captured.',
        'success'
      );
      setIsReplaceOnlineOpen(false);
      setReplaceOnlineBin('');
      await fetchSnapshots();
    } catch (err: any) {
      console.warn('Replace online data error:', err);
      let msg = err.message;
      if (
        msg?.includes('Valid numeric BIN') ||
        msg?.includes('BIN is required') ||
        err.name === 'BinRequiredError'
      ) {
        msg =
          locale === 'ar'
            ? 'رمز التحقق (BIN) مطلوب ويجب أن يتكون من 4 أرقام على الأقل'
            : 'Valid numeric BIN of at least 4 digits is required';
      } else if (msg?.includes('Invalid BIN') || msg?.includes('WRONG_BIN')) {
        msg =
          locale === 'ar'
            ? 'رمز التحقق (BIN) غير صحيح'
            : 'Invalid BIN credential for authenticated admin';
      } else if (!msg) {
        msg =
          locale === 'ar'
            ? 'فشل استبدال بيانات السحابة'
            : 'Failed to replace online business data';
      }
      showToast(msg, 'error');
    } finally {
      setIsActionLoading(false);
    }
  };

  // 9. Handle Download Snapshot to Portable Backup File
  const handleDownloadSnapshot = async (snap: BackupSnapshotRecord) => {
    try {
      const exported = await backupService.exportSnapshotToPortableFormat(snap.snapshotId);
      const blob = new Blob([exported.fileContent], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exported.fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showToast(
        locale === 'ar' ? 'تم تنزيل النسخة الاحتياطية بنجاح' : 'Backup snapshot downloaded successfully',
        'success'
      );
    } catch (err: any) {
      console.error('Download snapshot error:', err);
      showToast(
        err?.message || (locale === 'ar' ? 'فشل تنزيل النسخة الاحتياطية' : 'Failed to download snapshot'),
        'error'
      );
    }
  };

  // 10. Handle Upload Backup File Selection & Validation
  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (e.target) e.target.value = '';

    try {
      setIsActionLoading(true);
      const text = await file.text();
      const validation = backupService.validateAndParsePortableBackup(text);

      if (!validation.valid || !validation.portableFile) {
        showToast(
          validation.error || (locale === 'ar' ? 'ملف النسخة الاحتياطية غير صالح' : 'Invalid backup file'),
          'error'
        );
        return;
      }

      const portableFile = validation.portableFile;
      const res = await backupService.importPortableBackup(portableFile);

      if (res.isDuplicate) {
        setPendingImportFile(portableFile);
        setIsDuplicateModalOpen(true);
      } else {
        showToast(t('backupImportedSuccess'), 'success');
        await fetchSnapshots();
      }
    } catch (err: any) {
      console.error('Upload backup error:', err);
      showToast(
        err?.message || (locale === 'ar' ? 'فشل قراءة ملف النسخة الاحتياطية' : 'Failed to read selected backup file'),
        'error'
      );
    } finally {
      setIsActionLoading(false);
    }
  };

  // 11. Handle Resolve Duplicate Backup Import (Import as Copy vs Overwrite)
  const handleResolveDuplicateImport = async (asCopy: boolean) => {
    if (!pendingImportFile) return;
    try {
      setIsActionLoading(true);
      if (asCopy) {
        await backupService.importPortableBackup(pendingImportFile, { importAsCopy: true });
      } else {
        await backupService.importPortableBackup(pendingImportFile, { overwriteDuplicate: true });
      }
      showToast(t('backupImportedSuccess'), 'success');
      setIsDuplicateModalOpen(false);
      setPendingImportFile(null);
      await fetchSnapshots();
    } catch (err: any) {
      console.error('Duplicate import resolution error:', err);
      showToast(
        err?.message || (locale === 'ar' ? 'فشل استيراد النسخة الاحتياطية' : 'Failed to import snapshot'),
        'error'
      );
    } finally {
      setIsActionLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* GROUP 1: Snapshots & Backup History */}
      <div className="space-y-2">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 px-1">
          <div className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-[#8eb698]">
            {t('backupSectionTitle')} ({snapshots.length})
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap sm:flex-nowrap">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={fetchSnapshots}
              disabled={loadingSnapshots}
              className="text-xs h-7.5 px-2.5 gap-1 cursor-pointer shrink-0"
              title={locale === 'ar' ? 'تحديث القائمة' : 'Refresh list'}
            >
              <RefreshCw className={`w-3 h-3 ${loadingSnapshots ? 'animate-spin' : ''}`} />
              <span>{t('refreshBackups') || (locale === 'ar' ? 'تحديث' : 'Refresh')}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isActionLoading}
              className="text-xs h-7.5 px-2.5 sm:px-3 gap-1 font-semibold text-emerald-700 dark:text-[#daf1de] border-emerald-200 dark:border-emerald-800/50 hover:bg-emerald-50 dark:hover:bg-[#0c312b] cursor-pointer shrink-0"
              title={locale === 'ar' ? 'استيراد ملف Backup' : 'Import Backup file'}
            >
              <Upload className="w-3.5 h-3.5" />
              <span>{t('uploadBackup')}</span>
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.backup.json,application/json"
              onChange={handleFileSelected}
              className="hidden"
            />
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => setIsCreateOpen(true)}
              className="text-xs h-7.5 px-2.5 sm:px-3 gap-1 font-semibold cursor-pointer shrink-0"
              title={locale === 'ar' ? 'حفظ نسخة حالية' : 'Create new snapshot'}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('createSnapshot')}</span>
            </Button>
          </div>
        </div>

        <div className="divide-y divide-gray-100 dark:divide-[#0f302b]">
          {loadingSnapshots ? (
            <div className="py-8 flex flex-col items-center justify-center text-center space-y-2">
              <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-gray-500 dark:text-[#8eb698]">{t('loading')}</span>
            </div>
          ) : snapshots.length === 0 ? (
            <div className="py-8 px-4 flex flex-col items-center justify-center text-center space-y-2">
              <Database className="w-6 h-6 text-gray-400 dark:text-[#8eb698]" />
              <p className="text-xs font-semibold text-gray-800 dark:text-[#daf1de]">
                {t('noSnapshotsFound')}
              </p>
              <p className="text-[11px] text-gray-500 dark:text-[#8eb698] max-w-sm">
                {t('noSnapshotsDesc')}
              </p>
            </div>
          ) : (
            snapshots.map((snap) => {
              const badge = getSourceTypeBadge(snap.sourceType);
              const totalCount = snap.metadata?.totalEntities ?? 0;
              const checksum = snap.metadata?.checksum ? snap.metadata.checksum.substring(0, 8) : '---';
              const isConsolidated = snap.sourceType === 'CONSOLIDATED';
              const conflictsCount = snap.data?.consolidationMetadata?.unresolvedConflicts?.length || 0;

              return (
                <div
                  key={snap.snapshotId}
                  className="p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-gray-50/50 dark:hover:bg-[#0b2924] transition-colors"
                >
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold text-gray-900 dark:text-[#daf1de] truncate">
                        {snap.snapshotName}
                      </span>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${badge.className}`}>
                        {badge.label}
                      </span>
                      <span className="text-[10px] font-medium bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/40 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>{snap.status}</span>
                      </span>
                      {isConsolidated && conflictsCount > 0 && (
                        <span className="text-[10px] font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          <span>{conflictsCount} {t('unresolvedConflicts')}</span>
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-500 dark:text-[#8eb698]">
                      <span>{formatDate(snap.createdAt)}</span>
                      <span>·</span>
                      <span>
                        {t('totalEntitiesLabel')}:{' '}
                        <strong className="text-gray-700 dark:text-[#daf1de] font-semibold">
                          {totalCount}
                        </strong>
                      </span>
                      <span>·</span>
                      <span className="font-mono text-[10px]">crc:{checksum}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setInspectingSnapshot(snap)}
                      className="text-xs h-7 px-2.5 gap-1"
                      title={t('snapshotDetails')}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">{t('snapshotDetails')}</span>
                    </Button>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleDownloadSnapshot(snap)}
                      className="text-xs h-7 px-2.5 gap-1 font-semibold text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/40 hover:bg-blue-50 dark:hover:bg-blue-950/40 cursor-pointer"
                      title={t('downloadSnapshot')}
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">{t('downloadSnapshot')}</span>
                    </Button>

                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        setRestoreTarget(snap);
                        setRestoreBin('');
                      }}
                      className="text-xs h-7 px-2.5 gap-1 font-semibold"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>{t('restoreSnapshot')}</span>
                    </Button>

                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        setDeleteTarget(snap);
                        setDeleteBin('');
                      }}
                      className="text-xs h-7 px-2 px-2.5"
                      title={t('deleteSnapshot')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* GROUP 2: Direct Data Operations */}
      <div className="space-y-3 pb-6 border-b border-gray-200/80 dark:border-[#123832]">
        <div className="px-0.5 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-[#8eb698]">
          {locale === 'ar' ? 'إدارة واستعادة البيانات المباشرة' : 'Direct Data Operations'}
        </div>

        <div className="divide-y divide-gray-100 dark:divide-[#0f302b]">
          {/* Row A: Restore Local Data from Online Cloud */}
          <div className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-h-[52px]">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center text-gray-700 dark:text-[#8eb698] shrink-0 border border-transparent dark:border-[#14423b]">
                <CloudDownload className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div>
                <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] block">
                  {t('restoreOnlineTitle')}
                </span>
                <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                  {t('restoreOnlineDesc')}
                </span>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setIsRestoreOnlineOpen(true);
                setRestoreOnlineBin('');
              }}
              className="text-xs h-8 px-3.5 font-medium text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/50 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 shrink-0 self-start sm:self-auto"
            >
              <CloudDownload className="w-3.5 h-3.5 mr-1.5" />
              <span>{t('restoreOnlineBtn')}</span>
            </Button>
          </div>

          {/* Row B: Clear Sync History */}
          <div className="p-4 sm:p-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-h-[52px]">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-[#0c312b] flex items-center justify-center text-gray-700 dark:text-[#8eb698] shrink-0 border border-transparent dark:border-[#14423b]">
                <History className="w-4 h-4 text-emerald-600 dark:text-[#8eb698]" />
              </div>
              <div>
                <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] block">
                  {t('clearSyncHistoryTitle')}
                </span>
                <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                  {t('clearSyncHistoryDesc')}
                </span>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsClearSyncHistoryOpen(true)}
              className="text-xs h-8 px-3.5 font-medium shrink-0 self-start sm:self-auto"
            >
              <History className="w-3.5 h-3.5 mr-1.5" />
              <span>{t('clearSyncHistoryBtn')}</span>
            </Button>
          </div>

          {/* Row C: Replace Online with Local Data */}
          <div className="p-4 sm:p-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-h-[52px]">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-amber-50 dark:bg-[#2e1d0c] flex items-center justify-center text-amber-700 dark:text-amber-400 shrink-0 border border-amber-200 dark:border-amber-800/40">
                <CloudUpload className="w-4 h-4" />
              </div>
              <div>
                <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] block">
                  {locale === 'ar' ? 'استبدال السحابة بالبيانات المحلية' : 'Replace Online with Local Data'}
                </span>
                <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                  {locale === 'ar'
                    ? 'جعل البيانات المحلية هي المصدر المطلق (Source of Truth) واستبدال السحابة ذرياً.'
                    : 'Make local data the source of truth and atomically overwrite cloud state.'}
                </span>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleOpenReplacePreview}
              className="text-xs h-8 px-3.5 font-semibold text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-700/60 hover:bg-amber-100 dark:hover:bg-amber-900/30 shrink-0 self-start sm:self-auto"
            >
              <CloudUpload className="w-3.5 h-3.5 mr-1.5" />
              <span>{locale === 'ar' ? 'معاينة واستبدال السحابة' : 'Preview & Replace'}</span>
            </Button>
          </div>
        </div>
      </div>

      {/* GROUP 3: Danger Zone & Resets */}
      <div className="space-y-3">
        <div className="px-0.5 text-xs font-bold uppercase tracking-wider text-rose-600 dark:text-rose-400">
          {locale === 'ar' ? 'العمليات الحساسة والتصفير (Danger Zone)' : 'Danger Zone & Resets'}
        </div>

        <div className="divide-y divide-rose-100/80 dark:divide-rose-950/40">
          {/* Row A: Delete Local Database */}
          <div className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-h-[52px]">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-rose-50 dark:bg-rose-950/50 flex items-center justify-center text-rose-600 dark:text-rose-400 shrink-0 border border-rose-200 dark:border-rose-900/40">
                <Trash2 className="w-4 h-4" />
              </div>
              <div>
                <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] block">
                  {t('deleteLocalDataTitle')}
                </span>
                <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                  {t('deleteLocalDataDesc')}
                </span>
              </div>
            </div>

            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => {
                setIsDeleteLocalOpen(true);
                setDeleteLocalBin('');
              }}
              className="text-xs h-8 min-w-[76px] px-3.5 font-semibold shrink-0 self-start sm:self-auto justify-center bg-rose-600 hover:bg-rose-700 text-white border-transparent"
            >
              <span>{locale === 'ar' ? 'حذف' : 'Delete'}</span>
            </Button>
          </div>

          {/* Row B: Delete Cloud Database */}
          <div className="p-4 sm:p-4.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-h-[52px]">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-rose-50 dark:bg-rose-950/50 flex items-center justify-center text-rose-600 dark:text-rose-400 shrink-0 border border-rose-200 dark:border-rose-900/40">
                <Trash2 className="w-4 h-4" />
              </div>
              <div>
                <span className="text-sm font-semibold text-gray-900 dark:text-[#daf1de] block">
                  {locale === 'ar' ? 'حذف قاعدة البيانات السحابية' : 'Delete Cloud Database'}
                </span>
                <span className="text-xs text-gray-500 dark:text-[#8eb698]">
                  {locale === 'ar'
                    ? 'حذف بيانات العمل من الخادم السحابي دون المساس بالحسابات أو الصلاحيات.'
                    : 'Purge online business data from cloud database while preserving admin profiles.'}
                </span>
              </div>
            </div>

            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => {
                setIsDeleteOnlineOpen(true);
                setDeleteOnlineBin('');
              }}
              className="text-xs h-8 min-w-[76px] px-3.5 font-semibold shrink-0 self-start sm:self-auto justify-center bg-rose-600 hover:bg-rose-700 text-white border-transparent"
            >
              <span>{locale === 'ar' ? 'حذف' : 'Delete'}</span>
            </Button>
          </div>
        </div>
      </div>

      {/* ========================================================= */}
      {/* MODAL 1: Create Backup Snapshot */}
      {/* ========================================================= */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => !isActionLoading && setIsCreateOpen(false)}
        title={t('createNewSnapshot')}
      >
        <form onSubmit={handleCreateSnapshot} className="space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-gray-700 dark:text-[#daf1de] mb-1.5">
              {t('sourceType')}
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setCreateSourceType('OFFLINE')}
                className={`p-2.5 rounded-lg border text-start transition-all cursor-pointer ${
                  createSourceType === 'OFFLINE'
                    ? 'border-emerald-500 bg-emerald-50/60 dark:bg-[#0c312b] text-emerald-900 dark:text-[#daf1de] font-semibold'
                    : 'border-gray-200 dark:border-[#14423b] bg-white dark:bg-[#06201c] text-gray-700 dark:text-[#8eb698]'
                }`}
              >
                <div className="font-semibold">{t('sourceTypeOffline')}</div>
                <div className="text-[10px] text-gray-500 dark:text-[#8eb698] mt-0.5">
                  {t('sourceTypeOfflineDesc')}
                </div>
              </button>

              <button
                type="button"
                onClick={() => setCreateSourceType('ONLINE')}
                className={`p-2.5 rounded-lg border text-start transition-all cursor-pointer ${
                  createSourceType === 'ONLINE'
                    ? 'border-emerald-500 bg-emerald-50/60 dark:bg-[#0c312b] text-emerald-900 dark:text-[#daf1de] font-semibold'
                    : 'border-gray-200 dark:border-[#14423b] bg-white dark:bg-[#06201c] text-gray-700 dark:text-[#8eb698]'
                }`}
              >
                <div className="font-semibold">{t('sourceTypeOnline')}</div>
                <div className="text-[10px] text-gray-500 dark:text-[#8eb698] mt-0.5">
                  {t('sourceTypeOnlineDesc')}
                </div>
              </button>

              <button
                type="button"
                onClick={() => setCreateSourceType('CONSOLIDATED')}
                className={`p-2.5 rounded-lg border text-start transition-all cursor-pointer ${
                  createSourceType === 'CONSOLIDATED'
                    ? 'border-emerald-500 bg-emerald-50/60 dark:bg-[#0c312b] text-emerald-900 dark:text-[#daf1de] font-semibold'
                    : 'border-gray-200 dark:border-[#14423b] bg-white dark:bg-[#06201c] text-gray-700 dark:text-[#8eb698]'
                }`}
              >
                <div className="font-semibold">{t('sourceTypeConsolidated')}</div>
                <div className="text-[10px] text-gray-500 dark:text-[#8eb698] mt-0.5">
                  {t('sourceTypeConsolidatedDesc')}
                </div>
              </button>
            </div>
          </div>

          <div>
            <label className="block font-semibold text-gray-700 dark:text-[#daf1de] mb-1">
              {t('snapshotName')}
            </label>
            <Input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder={t('snapshotNamePlaceholder')}
            />
          </div>

          <div>
            <label className="block font-semibold text-gray-700 dark:text-[#daf1de] mb-1 flex items-center gap-1">
              <KeyRound className="w-3.5 h-3.5 text-emerald-600" />
              <span>{locale === 'ar' ? 'رمز التحقق الأمني (BIN) الإلزامي' : 'Admin Security BIN (Required)'}</span>
            </label>
            <Input
              type="password"
              value={createBin}
              onChange={(e) => setCreateBin(e.target.value)}
              placeholder="••••••"
              maxLength={6}
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-gray-100 dark:border-[#123d37]">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsCreateOpen(false)}
              disabled={isActionLoading}
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              isLoading={isActionLoading}
            >
              {t('confirmAndCreate')}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ========================================================= */}
      {/* MODAL 2: Restore Snapshot Confirmation */}
      {/* ========================================================= */}
      <Modal
        isOpen={Boolean(restoreTarget)}
        onClose={() => !isActionLoading && setRestoreTarget(null)}
        title={t('restoreSnapshotConfirmTitle')}
      >
        <div className="space-y-4 text-xs">
          <div className="p-3 rounded-xl bg-amber-50 dark:bg-[#36270d] border border-amber-200 dark:border-[#523d14] flex items-start gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-amber-900 dark:text-amber-200">
                {restoreTarget?.snapshotName}
              </p>
              <p className="text-amber-800 dark:text-amber-300 leading-relaxed text-[11px]">
                {t('restoreSnapshotConfirmDesc')}
              </p>
            </div>
          </div>

          {restoreTarget?.metadata && (
            <div className="bg-gray-50 dark:bg-[#06201c] p-3 rounded-xl border border-gray-200 dark:border-[#123d37] space-y-1.5 text-[11px]">
              <div className="flex justify-between">
                <span className="text-gray-500">{t('totalEntitiesLabel')}:</span>
                <span className="font-bold">{restoreTarget.metadata.totalEntities}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{t('checksumLabel')}:</span>
                <span className="font-mono">{restoreTarget.metadata.checksum}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{t('createdAtLabel')}:</span>
                <span>{formatDate(restoreTarget.createdAt)}</span>
              </div>
            </div>
          )}

          <div>
            <label className="block font-semibold text-gray-700 dark:text-[#daf1de] mb-1 flex items-center gap-1">
              <KeyRound className="w-3.5 h-3.5 text-amber-600" />
              <span>{locale === 'ar' ? 'رمز التحقق (BIN) لتأكيد الاستعادة' : 'Enter Admin BIN to confirm restore'}</span>
            </label>
            <Input
              type="password"
              value={restoreBin}
              onChange={(e) => setRestoreBin(e.target.value)}
              placeholder="••••••"
              maxLength={6}
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-gray-100 dark:border-[#123d37]">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRestoreTarget(null)}
              disabled={isActionLoading}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleRestoreSnapshot}
              isLoading={isActionLoading}
            >
              {t('restoreSnapshot')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ========================================================= */}
      {/* MODAL 3: Delete Snapshot Confirmation */}
      {/* ========================================================= */}
      <Modal
        isOpen={Boolean(deleteTarget)}
        onClose={() => !isActionLoading && setDeleteTarget(null)}
        title={t('deleteSnapshotConfirmTitle')}
      >
        <div className="space-y-4 text-xs">
          <div className="p-3 rounded-xl bg-red-50 dark:bg-[#360d13] border border-red-200 dark:border-[#421419] flex items-start gap-2.5">
            <Trash2 className="w-5 h-5 text-red-600 dark:text-[#f87171] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-red-900 dark:text-[#f87171]">
                {deleteTarget?.snapshotName}
              </p>
              <p className="text-red-700 dark:text-[#f87171]/90 leading-relaxed text-[11px]">
                {t('deleteSnapshotConfirmDesc')}
              </p>
            </div>
          </div>

          <div>
            <label className="block font-semibold text-gray-700 dark:text-[#daf1de] mb-1 flex items-center gap-1">
              <KeyRound className="w-3.5 h-3.5 text-red-600" />
              <span>{locale === 'ar' ? 'رمز التحقق (BIN) لتأكيد الحذف' : 'Admin Security BIN (Required)'}</span>
            </label>
            <Input
              type="password"
              value={deleteBin}
              onChange={(e) => setDeleteBin(e.target.value)}
              placeholder="••••••"
              maxLength={6}
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-gray-100 dark:border-[#123d37]">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isActionLoading}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleDeleteSnapshot}
              isLoading={isActionLoading}
            >
              {t('delete')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ========================================================= */}
      {/* MODAL 4: Restore Online Cloud Data Confirmation */}
      {/* ========================================================= */}
      <Modal
        isOpen={isRestoreOnlineOpen}
        onClose={() => !isActionLoading && setIsRestoreOnlineOpen(false)}
        title={t('restoreOnlineConfirmTitle')}
      >
        <div className="space-y-4 text-xs">
          <div className="p-3 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/40 flex items-start gap-2.5">
            <CloudDownload className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
            <p className="text-indigo-900 dark:text-indigo-200 leading-relaxed text-[11px]">
              {t('restoreOnlineConfirmDesc')}
            </p>
          </div>

          <div>
            <label className="block font-semibold text-gray-700 dark:text-[#daf1de] mb-1 flex items-center gap-1">
              <KeyRound className="w-3.5 h-3.5 text-indigo-600" />
              <span>{locale === 'ar' ? 'رمز التحقق (BIN) للمسؤول' : 'Admin Security BIN'}</span>
            </label>
            <Input
              type="password"
              value={restoreOnlineBin}
              onChange={(e) => setRestoreOnlineBin(e.target.value)}
              placeholder="••••••"
              maxLength={6}
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-gray-100 dark:border-[#123d37]">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsRestoreOnlineOpen(false)}
              disabled={isActionLoading}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleRestoreOnline}
              isLoading={isActionLoading}
            >
              {t('restoreOnlineBtn')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ========================================================= */}
      {/* MODAL 5: Zero Reset Operational Data Confirmation */}
      {/* ========================================================= */}
      <Modal
        isOpen={isDeleteLocalOpen}
        onClose={() => !isActionLoading && setIsDeleteLocalOpen(false)}
        title={t('deleteLocalDataConfirmTitle')}
      >
        <div className="space-y-4 text-xs">
          <div className="p-3.5 rounded-xl bg-red-100 dark:bg-[#421419] border border-red-300 dark:border-[#631e26] flex items-start gap-2.5">
            <ShieldAlert className="w-5 h-5 text-red-600 dark:text-[#f87171] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold text-red-950 dark:text-[#f87171]">
                {locale === 'ar' ? 'تحذير تصفير شامل لكافة البيانات التشغيلية' : 'Comprehensive Operational Zero Reset'}
              </p>
              <p className="text-red-900 dark:text-[#fca5a5] text-[11px] leading-relaxed">
                {t('deleteLocalDataConfirmDesc')}
              </p>
            </div>
          </div>

          <div>
            <label className="block font-semibold text-gray-700 dark:text-[#daf1de] mb-1 flex items-center gap-1">
              <KeyRound className="w-3.5 h-3.5 text-red-600" />
              <span>{locale === 'ar' ? 'رمز التحقق (BIN) لتأكيد التصفير' : 'Enter Admin BIN to confirm zero reset'}</span>
            </label>
            <Input
              type="password"
              value={deleteLocalBin}
              onChange={(e) => setDeleteLocalBin(e.target.value)}
              placeholder="••••••"
              maxLength={6}
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-gray-100 dark:border-[#123d37]">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsDeleteLocalOpen(false)}
              disabled={isActionLoading}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleDeleteLocalData}
              isLoading={isActionLoading}
            >
              {t('deleteLocalDataBtn')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ========================================================= */}
      {/* MODAL 6: Clear Sync History Confirmation */}
      {/* ========================================================= */}
      <Modal
        isOpen={isClearSyncHistoryOpen}
        onClose={() => !isActionLoading && setIsClearSyncHistoryOpen(false)}
        title={t('clearSyncHistoryConfirmTitle')}
      >
        <div className="space-y-4 text-xs">
          <div className="p-3 rounded-xl bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#123d37] flex items-start gap-2.5">
            <Info className="w-5 h-5 text-gray-500 dark:text-[#8eb698] shrink-0 mt-0.5" />
            <p className="text-gray-700 dark:text-[#daf1de] text-[11px] leading-relaxed">
              {t('clearSyncHistoryConfirmDesc')}
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-gray-100 dark:border-[#123d37]">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsClearSyncHistoryOpen(false)}
              disabled={isActionLoading}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleClearSyncHistory}
              isLoading={isActionLoading}
            >
              {t('clearSyncHistoryBtn')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ========================================================= */}
      {/* MODAL 7: Inspect Snapshot Details */}
      {/* ========================================================= */}
      <Modal
        isOpen={Boolean(inspectingSnapshot)}
        onClose={() => setInspectingSnapshot(null)}
        title={t('snapshotDetailsTitle')}
      >
        {inspectingSnapshot && (
          <div className="space-y-4 text-xs">
            <div className="bg-gray-50 dark:bg-[#06201c] p-3.5 rounded-xl border border-gray-200 dark:border-[#123d37] space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-gray-500">{t('snapshotName')}:</span>
                <span className="font-bold text-gray-900 dark:text-[#daf1de]">{inspectingSnapshot.snapshotName}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500">{t('sourceType')}:</span>
                <span className="font-semibold">{inspectingSnapshot.sourceType}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500">{t('createdAtLabel')}:</span>
                <span>{formatDate(inspectingSnapshot.createdAt)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500">{t('totalEntitiesLabel')}:</span>
                <span className="font-bold text-emerald-700 dark:text-[#daf1de]">{inspectingSnapshot.metadata?.totalEntities}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500">{t('checksumLabel')}:</span>
                <span className="font-mono text-[11px] bg-white dark:bg-[#082622] px-2 py-0.5 rounded border border-gray-200 dark:border-[#14423b]">
                  {inspectingSnapshot.metadata?.checksum}
                </span>
              </div>
            </div>

            {/* Entity Counts Table */}
            <div>
              <h4 className="font-bold text-gray-800 dark:text-[#daf1de] mb-1.5">
                {locale === 'ar' ? 'توزيع الكيانات والسجلات' : 'Entity Record Breakdown'}
              </h4>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="p-2 rounded bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] flex justify-between">
                  <span>{locale === 'ar' ? 'العملاء' : 'Customers'}</span>
                  <span className="font-bold">{inspectingSnapshot.metadata?.recordCounts?.customers ?? 0}</span>
                </div>
                <div className="p-2 rounded bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] flex justify-between">
                  <span>{locale === 'ar' ? 'الطلبات' : 'Orders'}</span>
                  <span className="font-bold">{inspectingSnapshot.metadata?.recordCounts?.orders ?? 0}</span>
                </div>
                <div className="p-2 rounded bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] flex justify-between">
                  <span>{locale === 'ar' ? 'الأيام' : 'Days'}</span>
                  <span className="font-bold">{inspectingSnapshot.metadata?.recordCounts?.businessDays ?? 0}</span>
                </div>
                <div className="p-2 rounded bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] flex justify-between">
                  <span>{locale === 'ar' ? 'عناصر الأجهزة' : 'Order Items'}</span>
                  <span className="font-bold">{inspectingSnapshot.metadata?.recordCounts?.orderItems ?? 0}</span>
                </div>
                <div className="p-2 rounded bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] flex justify-between">
                  <span>{locale === 'ar' ? 'السجل المالي' : 'Ledger Entries'}</span>
                  <span className="font-bold">{inspectingSnapshot.metadata?.recordCounts?.financialLedger ?? 0}</span>
                </div>
                <div className="p-2 rounded bg-white dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] flex justify-between">
                  <span>{locale === 'ar' ? 'سندات الدفع' : 'Payments'}</span>
                  <span className="font-bold">{inspectingSnapshot.metadata?.recordCounts?.payments ?? 0}</span>
                </div>
              </div>
            </div>

            {/* Consolidated Metadata if available */}
            {inspectingSnapshot.data?.consolidationMetadata && (
              <div className="p-3 rounded-xl bg-emerald-50/70 dark:bg-[#0c312b]/60 border border-emerald-200 dark:border-[#194f47] space-y-1 text-[11px]">
                <h5 className="font-bold text-emerald-900 dark:text-[#daf1de]">
                  {t('consolidatedStats')}
                </h5>
                <div className="grid grid-cols-3 gap-1 pt-1">
                  <div>{t('onlineRecords')}: {inspectingSnapshot.data.consolidationMetadata.onlineRecordCount}</div>
                  <div>{t('offlineRecords')}: {inspectingSnapshot.data.consolidationMetadata.offlineRecordCount}</div>
                  <div>{t('reconciledRecords')}: {inspectingSnapshot.data.consolidationMetadata.reconciledCount}</div>
                </div>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <Button variant="outline" onClick={() => setInspectingSnapshot(null)}>
                {t('close')}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* ========================================================= */}
      {/* MODAL: Online Business Data Reset */}
      {/* ========================================================= */}
      <Modal
        isOpen={isDeleteOnlineOpen}
        onClose={() => !isActionLoading && setIsDeleteOnlineOpen(false)}
        title={locale === 'ar' ? 'معاينة وتأكيد حذف قاعدة البيانات السحابية' : 'Confirm Cloud Database Deletion'}
      >
        <form onSubmit={handleDeleteOnlineData} className="space-y-4 text-xs">
          <div className="p-3 rounded-xl bg-rose-50 dark:bg-[#351015] border border-rose-200 dark:border-[#601d25] text-rose-950 dark:text-rose-200 flex items-start gap-2.5">
            <Trash2 className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1 leading-relaxed">
              <p className="font-bold text-sm">
                {locale === 'ar' ? 'معاينة عملية حذف قاعدة البيانات السحابية' : 'Cloud Database Deletion Preview'}
              </p>
              <p className="text-[11px]">
                {locale === 'ar'
                  ? 'هذه العملية ستقوم بحذف كافة بيانات العمليات والمبيعات من قاعدة بيانات PostgreSQL على الخادم بشكل نهائي وغير قابل للتراجع.'
                  : 'This operation is permanent and irreversible. It purges all operational business data from the PostgreSQL cloud database server.'}
              </p>
            </div>
          </div>

          {/* Authenticated Admin Identity */}
          {activeAdminInfo && (
            <div className="p-2.5 rounded-lg bg-gray-50 dark:bg-[#082622] border border-gray-200 dark:border-[#14423b] flex items-center justify-between text-[11px]">
              <span className="text-gray-500 dark:text-[#8eb698] font-medium">
                {locale === 'ar' ? 'المسؤول المنفذ للعملية:' : 'Executing Administrator:'}
              </span>
              <span className="font-bold text-gray-900 dark:text-[#daf1de]">
                {activeAdminInfo.fullName} ({activeAdminInfo.username}) — <span className="text-purple-700 dark:text-purple-300 font-semibold">{activeAdminInfo.role}</span>
              </span>
            </div>
          )}

          {/* Scope Breakdown */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
            {/* Entities to be Reset */}
            <div className="p-2.5 rounded-lg bg-red-50/60 dark:bg-rose-950/30 border border-rose-200/80 dark:border-rose-900/40 space-y-1">
              <span className="font-bold text-rose-800 dark:text-rose-300 block">
                {locale === 'ar' ? 'الكيانات التي سيتم تصفيرها:' : 'Entities to be reset:'}
              </span>
              <ul className="list-disc list-inside space-y-0.5 text-rose-900/90 dark:text-rose-200 text-[10px]">
                <li>{locale === 'ar' ? 'طلبات الأجهزة وعناصرها (Orders & Items)' : 'Orders & Order Items'}</li>
                <li>{locale === 'ar' ? 'سجلات العملاء والملفات (Customers)' : 'Customers'}</li>
                <li>{locale === 'ar' ? 'أيام العمل والجلسات (Business Days)' : 'Business Days'}</li>
                <li>{locale === 'ar' ? 'السجل المالي والمعاملات (Ledger)' : 'Financial Ledger'}</li>
                <li>{locale === 'ar' ? 'سندات الدفع والتوزيعات (Payments)' : 'Payments & Allocations'}</li>
                <li>{locale === 'ar' ? 'رموز QR وسجل التغييرات (QR & Logs)' : 'QR Tokens & Change Logs'}</li>
              </ul>
            </div>

            {/* Preserved Safety Items */}
            <div className="p-2.5 rounded-lg bg-emerald-50/60 dark:bg-[#0c312b]/60 border border-emerald-200/80 dark:border-emerald-800/40 space-y-1">
              <span className="font-bold text-emerald-800 dark:text-[#daf1de] block">
                {locale === 'ar' ? 'العناصر المحمية والمحفوظة:' : 'Strictly Preserved:'}
              </span>
              <ul className="list-disc list-inside space-y-0.5 text-emerald-900/90 dark:text-[#8eb698] text-[10px]">
                <li>{locale === 'ar' ? 'حسابات المسؤولين والصلاحيات (Admins & RBAC)' : 'Admin Accounts & RBAC'}</li>
                <li>{locale === 'ar' ? 'هوية Super Admin والأذونات' : 'Super Admin Identity'}</li>
                <li>{locale === 'ar' ? 'النسخ الاحتياطية المحفوظة (backupSnapshots)' : 'IndexedDB backupSnapshots'}</li>
                <li>{locale === 'ar' ? 'ملفات النسخ المصدرة (Portable Backup Files)' : 'Exported Portable Backup Files'}</li>
                <li>{locale === 'ar' ? 'أجهزة التطبيق وأنواع الأجهزة' : 'App Devices & Device Types'}</li>
              </ul>
            </div>
          </div>

          <div>
            <label className="block font-semibold text-gray-700 dark:text-[#daf1de] mb-1">
              {t('enterBinLabel')}
            </label>
            <div className="relative">
              <Input
                type="password"
                maxLength={8}
                value={deleteOnlineBin}
                onChange={(e) => setDeleteOnlineBin(e.target.value)}
                placeholder={t('binPlaceholder')}
                disabled={isActionLoading}
                required
                className="pl-9 text-xs h-9"
              />
              <KeyRound className="w-4 h-4 text-gray-400 absolute left-2.5 top-2.5" />
            </div>
            <p className="text-[11px] text-gray-500 dark:text-[#8eb698] mt-1">
              {t('binHelpText')}
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 dark:border-[#123d37]">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsDeleteOnlineOpen(false)}
              disabled={isActionLoading}
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              variant="danger"
              size="sm"
              disabled={isActionLoading || !deleteOnlineBin.trim()}
              className="bg-rose-600 hover:bg-rose-700 text-white font-semibold"
            >
              {isActionLoading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <span>{locale === 'ar' ? 'حذف' : 'Delete'}</span>
              )}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ========================================================= */}
      {/* MODAL: Local -> Online Replacement Preview & Confirmation */}
      {/* ========================================================= */}
      <Modal
        isOpen={isReplaceOnlineOpen}
        onClose={() => !isActionLoading && setIsReplaceOnlineOpen(false)}
        title={
          locale === 'ar'
            ? 'معاينة واستبدال بيانات السحابة (Local → Online)'
            : 'Preview & Replace Online Data'
        }
      >
        <form onSubmit={handleExecuteReplaceOnline} className="space-y-4 text-xs">
          <div className="p-3 rounded-xl bg-amber-50 dark:bg-[#352510] border border-amber-200 dark:border-[#5a3e1a] text-amber-900 dark:text-amber-200 flex items-start gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1 leading-relaxed">
              <p className="font-bold">
                {locale === 'ar' ? 'عملية استبدال سحابية ذرية (Atomic Replacement)' : 'Atomic Online Replacement'}
              </p>
              <p className="text-[11px]">
                {locale === 'ar'
                  ? 'سيتم استبدال بيانات السحابة بالكامل لتطابق البيانات المحلية الحالية بدقة (Local Wins). يتم حفظ نسخة أمان سحابية تلقائياً قبل البدء. توزيعات المدفوعات مطابقة بالـ UUID حرفياً.'
                  : 'Online state will be completely overwritten to match local data (Local Wins). An automated online safety snapshot is created first. Allocation UUIDs are preserved strictly.'}
              </p>
            </div>
          </div>

          {isDiffLoading ? (
            <div className="py-6 flex flex-col items-center justify-center gap-2 text-gray-500 dark:text-gray-400">
              <RefreshCw className="w-5 h-5 animate-spin" />
              <span>{locale === 'ar' ? 'جاري فحص وحساب الفروقات...' : 'Calculating differences...'}</span>
            </div>
          ) : diffData?.summary ? (
            <div className="space-y-2">
              {diffData.totalLocal === 0 && (
                <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200">
                  {locale === 'ar'
                    ? 'تم إيقاف الاستبدال الآمن: قاعدة البيانات المحلية التشغيلية فارغة. لم يتم لمس السحابة. استرجع البيانات المحلية أولاً ثم أعد المعاينة.'
                    : 'Safe replacement is blocked: the local operational database is empty. The cloud was not modified. Restore/recover local data first, then preview again.'}
                </div>
              )}
              <div className="flex justify-between items-center text-[11px] font-bold text-gray-700 dark:text-[#daf1de]">
                <span>{locale === 'ar' ? 'جدول الفروقات بين المحلي والسحابي:' : 'Entity Diff Summary:'}</span>
                <span className="text-gray-500">
                  {locale === 'ar'
                    ? `إجمالي للإضافة: ${diffData.totalToInsert} | للتحديث: ${diffData.totalToUpdate} | للحذف: ${diffData.totalToDelete}`
                    : `Insert: ${diffData.totalToInsert} | Update: ${diffData.totalToUpdate} | Delete: ${diffData.totalToDelete}`}
                </span>
              </div>

              <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-[#14423b]">
                <table className="w-full text-[11px] text-left">
                  <thead className="bg-gray-50 dark:bg-[#0c312b] text-gray-600 dark:text-[#8eb698] sticky top-0">
                    <tr>
                      <th className="p-1.5">{locale === 'ar' ? 'الكيان' : 'Entity'}</th>
                      <th className="p-1.5 text-center">{locale === 'ar' ? 'المحلي' : 'Local'}</th>
                      <th className="p-1.5 text-center">{locale === 'ar' ? 'السحابي' : 'Online'}</th>
                      <th className="p-1.5 text-center text-emerald-600 dark:text-emerald-400">+</th>
                      <th className="p-1.5 text-center text-blue-600 dark:text-blue-400">~</th>
                      <th className="p-1.5 text-center text-red-600 dark:text-red-400">-</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-[#14423b]">
                    {Object.entries(diffData.summary).map(([key, s]: [string, any]) => {
                      const labels: Record<string, string> = {
                        device_types: locale === 'ar' ? 'أنواع الأجهزة' : 'Device Types',
                        business_days: locale === 'ar' ? 'أيام العمل' : 'Business Days',
                        customers: locale === 'ar' ? 'العملاء' : 'Customers',
                        qr_tokens: locale === 'ar' ? 'رموز QR' : 'QR Tokens',
                        orders: locale === 'ar' ? 'الطلبات' : 'Orders',
                        order_items: locale === 'ar' ? 'عناصر الطلبات' : 'Order Items',
                        payments: locale === 'ar' ? 'سندات الدفع' : 'Payments',
                        financial_ledger: locale === 'ar' ? 'السجل المالي' : 'Financial Ledger',
                        payment_allocations: locale === 'ar' ? 'توزيعات المدفوعات' : 'Payment Allocations',
                      };
                      return (
                        <tr key={key} className={key === 'payment_allocations' ? 'bg-amber-50/40 dark:bg-amber-950/20 font-medium' : ''}>
                          <td className="p-1.5">{labels[key] || key}</td>
                          <td className="p-1.5 text-center font-mono">{s.localCount}</td>
                          <td className="p-1.5 text-center font-mono">{s.onlineCount}</td>
                          <td className="p-1.5 text-center font-mono text-emerald-600 dark:text-emerald-400">{s.toInsert}</td>
                          <td className="p-1.5 text-center font-mono text-blue-600 dark:text-blue-400">{s.toUpdate}</td>
                          <td className="p-1.5 text-center font-mono text-red-600 dark:text-red-400">{s.toDelete}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div>
            <label className="block font-semibold text-gray-700 dark:text-[#daf1de] mb-1">
              {t('enterBinLabel')}
            </label>
            <div className="relative">
              <Input
                type="password"
                maxLength={8}
                value={replaceOnlineBin}
                onChange={(e) => setReplaceOnlineBin(e.target.value)}
                placeholder={t('binPlaceholder')}
                disabled={isActionLoading}
                required
                className="pl-9 text-xs h-9"
              />
              <KeyRound className="w-4 h-4 text-gray-400 absolute left-2.5 top-2.5" />
            </div>
            <p className="text-[11px] text-gray-500 dark:text-[#8eb698] mt-1">
              {t('binHelpText')}
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 dark:border-[#123d37]">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsReplaceOnlineOpen(false)}
              disabled={isActionLoading}
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              variant="danger"
              size="sm"
              disabled={isActionLoading || !replaceOnlineBin.trim() || isDiffLoading || !diffData || diffData.totalLocal === 0}
              className="bg-amber-600 hover:bg-amber-700 text-white font-semibold"
            >
              {isActionLoading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <span>{locale === 'ar' ? 'تأكيد واستبدال السحابة الآن' : 'Replace Online Data Now'}</span>
              )}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ========================================================= */}
      {/* MODAL: Duplicate Backup Import Resolution */}
      {/* ========================================================= */}
      <Modal
        isOpen={isDuplicateModalOpen}
        onClose={() => {
          if (!isActionLoading) {
            setIsDuplicateModalOpen(false);
            setPendingImportFile(null);
          }
        }}
        title={t('backupDuplicateTitle')}
      >
        <div className="space-y-4 text-xs">
          <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-[#352510] border border-amber-200 dark:border-[#5a3e1a] text-amber-900 dark:text-amber-200 flex items-start gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1 leading-relaxed">
              <p className="font-bold">{pendingImportFile?.snapshotName}</p>
              <p className="text-[11px]">{t('backupDuplicateDesc')}</p>
            </div>
          </div>

          {pendingImportFile && (
            <div className="bg-gray-50 dark:bg-[#06201c] p-3 rounded-xl border border-gray-200 dark:border-[#123d37] space-y-1 text-[11px]">
              <div className="flex justify-between">
                <span className="text-gray-500">{t('snapshotName')}:</span>
                <span className="font-bold">{pendingImportFile.snapshotName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{t('totalEntitiesLabel')}:</span>
                <span className="font-bold">{pendingImportFile.metadata?.totalEntities}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{t('createdAtLabel')}:</span>
                <span>{formatDate(pendingImportFile.createdAt)}</span>
              </div>
            </div>
          )}

          <div className="flex flex-col sm:flex-row justify-end gap-2 pt-3 border-t border-gray-100 dark:border-[#123d37]">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setIsDuplicateModalOpen(false);
                setPendingImportFile(null);
              }}
              disabled={isActionLoading}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleResolveDuplicateImport(true)}
              isLoading={isActionLoading}
              className="text-emerald-700 dark:text-[#daf1de] border-emerald-200 dark:border-emerald-800/50"
            >
              {t('importAsCopy')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => handleResolveDuplicateImport(false)}
              isLoading={isActionLoading}
            >
              {t('overwriteExisting')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
