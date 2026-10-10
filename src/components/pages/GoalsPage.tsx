import React, { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Target,
  X,
} from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';
import { Button } from '../ui/Button';
import { authService, UserSession } from '../../services/auth/authService';
import {
  approveGoalRequestForAdmin,
  createGoalForAdmin,
  generateCustomerGoalProposalForAdmin,
  getGoalsPageData,
  rejectGoalRequestForAdmin,
  updateGoalConfigForAdmin,
  useStoreSubscription,
} from './dayOrdersStore';
import { CustomerEntity, GoalEntity, GoalRequestEntity } from '../../domain/models';

type GoalsTab = 'overview' | 'requests' | 'manage' | 'policy';

interface GoalsPageData {
  goals: GoalEntity[];
  requests: GoalRequestEntity[];
  customers: CustomerEntity[];
}

const EMPTY_DATA: GoalsPageData = { goals: [], requests: [], customers: [] };

export const GoalsPage: React.FC = () => {
  const { locale, isRTL } = useI18n();
  const [session, setSession] = useState<UserSession | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [data, setData] = useState<GoalsPageData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [activeTab, setActiveTab] = useState<GoalsTab>('overview');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | GoalEntity['status']>('ALL');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [targetQuantity, setTargetQuantity] = useState('10');
  const [durationDays, setDurationDays] = useState('7');
  const [bonusIls, setBonusIls] = useState('1.00');
  const [proposalLoading, setProposalLoading] = useState(false);
  const [editingGoal, setEditingGoal] = useState<GoalEntity | null>(null);
  const [editTarget, setEditTarget] = useState('');
  const [editDuration, setEditDuration] = useState('');
  const [editBonusIls, setEditBonusIls] = useState('');
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({});

  const goalStoreScopes = useMemo(
    () => ['goals', 'goalRequests', 'customers', 'financialLedger', 'orderItems'] as Array<
      'goals' | 'goalRequests' | 'customers' | 'financialLedger' | 'orderItems'
    >,
    []
  );
  const storeRevision = useStoreSubscription(goalStoreScopes);

  const isSuperAdmin = Boolean(
    session && String(session.role || '').toUpperCase().replace(/\s+/g, '_') === 'SUPER_ADMIN'
  );
  const canViewGoals = isSuperAdmin || Boolean(session?.permissions?.some((permission) => permission === 'goals:view' || permission === 'goals:manage'));
  const canViewRequests = isSuperAdmin || Boolean(session?.permissions?.some((permission) => permission === 'goals:requests:view' || permission === 'goals:approve'));
  const canManage = isSuperAdmin || Boolean(session?.permissions?.includes('goals:manage'));
  const canApprove = isSuperAdmin || Boolean(session?.permissions?.includes('goals:approve'));
  const canAccessPage = canViewGoals || canViewRequests;

  const copy = locale === 'ar' ? {
    title: 'إدارة الأهداف',
    subtitle: 'متابعة أهداف العملاء وتقدمهم وطلبات الأهداف من مكان واحد.',
    overview: 'لوحة الأهداف',
    requests: 'طلبات العملاء',
    manage: 'إدارة الأهداف',
    policy: 'قواعد الأهداف',
    active: 'أهداف نشطة',
    completed: 'أهداف مكتملة',
    failed: 'أهداف منتهية دون تحقيق',
    pending: 'طلبات تنتظر المراجعة',
    search: 'ابحث باسم العميل أو رقم الهدف...',
    allStatuses: 'كل الحالات',
    noGoals: 'لا توجد أهداف تطابق البحث الحالي.',
    noRequests: 'لا توجد طلبات أهداف حتى الآن.',
    noCustomers: 'لا يوجد عملاء نشطون لإنشاء هدف لهم.',
    customer: 'العميل',
    target: 'الهدف المطلوب',
    progress: 'التقدم',
    reward: 'المكافأة',
    duration: 'المدة (أيام)',
    starts: 'تاريخ البداية',
    expires: 'تاريخ الانتهاء',
    daysLeft: 'يوم متبقٍ',
    expired: 'انتهت المدة',
    activeStatus: 'نشط',
    completedStatus: 'مكتمل',
    failedStatus: 'لم يتحقق',
    requestedTarget: 'العدد المطلوب في الطلب',
    requestedAt: 'تاريخ الطلب',
    reviewedAt: 'تاريخ المراجعة',
    reviewedBy: 'راجع الطلب (معرّف المشرف)',
    rejectionReason: 'سبب الرفض',
    enterReason: 'اكتب سبب الرفض',
    approve: 'موافقة وإنشاء الهدف',
    reject: 'رفض الطلب',
    create: 'إنشاء هدف',
    createTitle: 'إنشاء هدف لعميل',
    chooseCustomer: 'اختر العميل',
    generateProposal: 'اقتراح هدف ذكي',
    generating: 'جارٍ حساب الاقتراح...',
    createGoal: 'إنشاء الهدف',
    save: 'حفظ التعديلات',
    cancel: 'إلغاء',
    edit: 'تعديل الهدف',
    editTitle: 'تعديل هدف نشط',
    refresh: 'تحديث',
    loading: 'جارٍ تحميل بيانات الأهداف...',
    loadError: 'تعذر تحميل بيانات الأهداف.',
    noPermission: 'ليس لديك صلاحية عرض صفحة الأهداف.',
    activeOnlyEdit: 'يمكن تعديل الأهداف النشطة فقط؛ تبقى النتائج المكتملة أو المنتهية محفوظة كما هي.',
    proposalHint: 'الاقتراح مبني على نشاط العميل خلال آخر 7 أيام. يمكنك مراجعة قيم هذا الهدف قبل إنشائه.',
    currentPolicy: 'القواعد الحالية التي يطبقها الخادم',
    durationRule: 'مدة الهدف عشوائية بين 3 و15 يومًا.',
    targetRule: 'يُحسب الهدف من وتيرة العميل خلال آخر 7 أيام مع تحدٍ إضافي، وبحد أدنى 10 أجهزة.',
    rewardRule: 'اقتراح المكافأة يستخدم 8–13 أغورة لكل جهاز وبحد أدنى 80 أغورة؛ السقف الأقصى 20 أغورة لكل جهاز مستهدف. عند التعديل اليدوي، يفرض الخادم السقف ويسمح بصفر وفق القواعد الحالية.',
    policyHint: 'يمكن للسوبر أدمن ضبط الهدف والمدة والمكافأة لكل هدف. لم يتم تغيير قواعد الخادم العامة في هذه المرحلة.',
    required: 'يرجى استكمال الحقول المطلوبة بقيم صحيحة.',
    invalidReward: 'المكافأة تتجاوز السقف المسموح: 20 أغورة لكل جهاز مستهدف.',
    saved: 'تم حفظ التغيير وإرساله عبر مسار المزامنة المعتمد.',
    created: 'تم إنشاء الهدف وإرساله عبر مسار المزامنة المعتمد.',
    approved: 'تمت الموافقة على الطلب وإنشاء الهدف.',
    rejected: 'تم رفض الطلب وتسجيل السبب.',
    operationFailed: 'تعذر تنفيذ العملية. تحقق من الصلاحية وحالة المزامنة ثم أعد المحاولة.',
    percent: 'نسبة الإنجاز',
    history: 'حالة الطلب',
    pendingStatus: 'بانتظار المراجعة',
    approvedStatus: 'تمت الموافقة',
    rejectedStatus: 'مرفوض',
    selectTarget: 'العدد',
    bonusIls: 'المكافأة (شيكل)',
  } : {
    title: 'Goals Management',
    subtitle: 'Track customer goals, progress, and goal requests in one place.',
    overview: 'Goals dashboard',
    requests: 'Customer requests',
    manage: 'Manage goals',
    policy: 'Goal rules',
    active: 'Active goals',
    completed: 'Completed goals',
    failed: 'Expired without completion',
    pending: 'Requests awaiting review',
    search: 'Search by customer or goal ID...',
    allStatuses: 'All statuses',
    noGoals: 'No goals match the current search.',
    noRequests: 'There are no goal requests yet.',
    noCustomers: 'There are no active customers to create a goal for.',
    customer: 'Customer',
    target: 'Target',
    progress: 'Progress',
    reward: 'Reward',
    duration: 'Duration (days)',
    starts: 'Started',
    expires: 'Expires',
    daysLeft: 'days left',
    expired: 'Expired',
    activeStatus: 'Active',
    completedStatus: 'Completed',
    failedStatus: 'Not achieved',
    requestedTarget: 'Requested target',
    requestedAt: 'Requested at',
    reviewedAt: 'Reviewed at',
    reviewedBy: 'Reviewed by (admin ID)',
    rejectionReason: 'Rejection reason',
    enterReason: 'Enter rejection reason',
    approve: 'Approve and create goal',
    reject: 'Reject request',
    create: 'Create goal',
    createTitle: 'Create a customer goal',
    chooseCustomer: 'Choose customer',
    generateProposal: 'Generate smart proposal',
    generating: 'Calculating proposal...',
    createGoal: 'Create goal',
    save: 'Save changes',
    cancel: 'Cancel',
    edit: 'Edit goal',
    editTitle: 'Edit active goal',
    refresh: 'Refresh',
    loading: 'Loading goal data...',
    loadError: 'Unable to load goal data.',
    noPermission: 'You do not have permission to view Goals.',
    activeOnlyEdit: 'Only active goals can be edited. Completed and failed outcomes remain immutable.',
    proposalHint: 'The proposal uses the customer’s activity over the last 7 days. Review the values before creating the goal.',
    currentPolicy: 'Current server-enforced rules',
    durationRule: 'Goal duration is randomized between 3 and 15 days.',
    targetRule: 'The target uses the customer’s recent 7-day pace plus a stretch allowance, with a minimum of 10 devices.',
    rewardRule: 'Proposal rewards use 8–13 agorot per device with a proposal minimum of 80 minor units; the hard cap is 20 agorot per target device. Manual edits follow the current server contract, which enforces the cap and permits zero.',
    policyHint: 'Super Admin can tune the target, duration, and reward per goal. Global server rules are unchanged in this phase.',
    required: 'Please complete the required fields with valid values.',
    invalidReward: 'The reward exceeds the allowed cap of 20 agorot per target device.',
    saved: 'Changes were saved through the existing sync path.',
    created: 'The goal was created through the existing sync path.',
    approved: 'The request was approved and a goal was created.',
    rejected: 'The request was rejected and the reason was recorded.',
    operationFailed: 'The operation failed. Check permissions and sync status before retrying.',
    percent: 'Completion',
    history: 'Request status',
    pendingStatus: 'Pending review',
    approvedStatus: 'Approved',
    rejectedStatus: 'Rejected',
    selectTarget: 'Target',
    bonusIls: 'Reward (ILS)',
  };

  useEffect(() => {
    let mounted = true;
    authService.getCurrentSession().then((currentSession) => {
      if (mounted) {
        setSession(currentSession);
        const normalizedRole = String(currentSession?.role || '').toUpperCase().replace(/\\s+/g, '_');
        const superAdmin = normalizedRole === 'SUPER_ADMIN';
        const permissions = currentSession?.permissions || [];
        if (!superAdmin && !permissions.includes('goals:view') && !permissions.includes('goals:manage')) {
          setActiveTab(permissions.includes('goals:requests:view') || permissions.includes('goals:approve') ? 'requests' : 'manage');
        }
        setSessionLoaded(true);
      }
    }).catch(() => {
      if (mounted) setSessionLoaded(true);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!sessionLoaded) return;
    if (!canAccessPage) {
      setData(EMPTY_DATA);
      setLoading(false);
      return;
    }

    let mounted = true;
    getGoalsPageData({ canViewGoals, canViewRequests })
      .then((snapshot) => {
        if (mounted) {
          setData(snapshot);
          setError('');
        }
      })
      .catch(() => {
        if (mounted) setError(copy.loadError);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [sessionLoaded, canAccessPage, canViewGoals, canViewRequests, storeRevision, copy.loadError]);

  const customerName = useCallback((customerId: string) =>
    data.customers.find((customer) => customer.id === customerId)?.name || customerId, [data.customers]);

  const activeGoals = data.goals.filter((goal) => goal.status === 'ACTIVE');
  const completedGoals = data.goals.filter((goal) => goal.status === 'COMPLETED');
  const failedGoals = data.goals.filter((goal) => goal.status === 'FAILED');
  const pendingRequests = data.requests.filter((request) => request.status === 'PENDING');

  const visibleGoals = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    return data.goals.filter((goal) => {
      if (statusFilter !== 'ALL' && goal.status !== statusFilter) return false;
      const matches = !normalized ||
        customerName(goal.customerId).toLocaleLowerCase().includes(normalized) ||
        goal.id.toLocaleLowerCase().includes(normalized);
      return matches;
    });
  }, [data.goals, data.customers, search, statusFilter, customerName]);

  const formatMoney = (minor: number) => new Intl.NumberFormat(
    locale === 'ar' ? 'ar-IL' : 'en-IL',
    { style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 }
  ).format((Number(minor) || 0) / 100);

  const formatDate = (value?: string) => value
    ? new Date(value).toLocaleString(locale === 'ar' ? 'ar-IL' : 'en-IL', { dateStyle: 'medium' })
    : '—';

  const statusLabel = (status: GoalEntity['status']) => {
    if (status === 'ACTIVE') return copy.activeStatus;
    if (status === 'COMPLETED') return copy.completedStatus;
    return copy.failedStatus;
  };

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      setData(await getGoalsPageData({ canViewGoals, canViewRequests }));
    } catch {
      setError(copy.loadError);
    } finally {
      setLoading(false);
    }
  };

  const generateProposal = async () => {
    if (!selectedCustomerId) {
      setError(copy.required);
      return;
    }
    setProposalLoading(true);
    setError('');
    setSuccess('');
    try {
      const result = await generateCustomerGoalProposalForAdmin(selectedCustomerId);
      if (!result.success) throw new Error('proposal failed');
      setTargetQuantity(String(result.data.targetQuantity));
      setDurationDays(String(result.data.durationDays));
      setBonusIls((result.data.bonusAmountMinor / 100).toFixed(2));
    } catch {
      setError(copy.operationFailed);
    } finally {
      setProposalLoading(false);
    }
  };

  const createGoal = async (event: FormEvent) => {
    event.preventDefault();
    const target = Number(targetQuantity);
    const duration = Number(durationDays);
    const bonusMinor = Math.round(Number(bonusIls) * 100);
    if (Number.isInteger(target) && target > 0 && Number.isFinite(bonusMinor) && bonusMinor > target * 20) {
      setError(copy.invalidReward);
      return;
    }
    if (!selectedCustomerId || !Number.isInteger(target) || target <= 0 ||
        !Number.isInteger(duration) || duration < 3 || duration > 15 ||
        !Number.isFinite(bonusMinor) || bonusMinor < 0) {
      setError(copy.required);
      return;
    }
    setActionLoading(true);
    setError('');
    setSuccess('');
    try {
      const result = await createGoalForAdmin(selectedCustomerId, target, duration, bonusMinor);
      if (!result.success) throw new Error('create goal failed');
      setSuccess(copy.created);
      setSelectedCustomerId('');
      await refresh();
    } catch {
      setError(copy.operationFailed);
    } finally {
      setActionLoading(false);
    }
  };

  const beginEdit = (goal: GoalEntity) => {
    setEditingGoal(goal);
    setEditTarget(String(goal.targetQuantity));
    setEditDuration(String(goal.durationDays));
    setEditBonusIls((goal.bonusAmountMinor / 100).toFixed(2));
    setError('');
    setSuccess('');
  };

  const saveGoalEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingGoal) return;
    const target = Number(editTarget);
    const duration = Number(editDuration);
    const bonusMinor = Math.round(Number(editBonusIls) * 100);
    if (!Number.isInteger(target) || target <= 0 ||
        !Number.isInteger(duration) || duration < 3 || duration > 15 ||
        !Number.isFinite(bonusMinor) || bonusMinor < 0) {
      setError(copy.required);
      return;
    }
    if (bonusMinor > target * 20) {
      setError(copy.invalidReward);
      return;
    }

    const warnings: string[] = [];
    if (target <= editingGoal.currentProgress) {
      warnings.push(locale === 'ar'
        ? 'الهدف الجديد يساوي أو يقل عن التقدم الحالي، وقد يؤدي ذلك إلى إكمال الهدف وصرف المكافأة فورًا.'
        : 'The new target is at or below current progress and may complete the goal and issue its reward immediately.');
    }
    const proposedExpiry = new Date(new Date(editingGoal.startedAt).getTime() + duration * 24 * 60 * 60 * 1000);
    if (proposedExpiry.getTime() <= Date.now() && target > editingGoal.currentProgress) {
      warnings.push(locale === 'ar'
        ? 'المدة الجديدة تجعل تاريخ الانتهاء في الماضي؛ قد ينتهي الهدف فورًا ويصبح غير قابل للتعديل.'
        : 'The new duration places the expiry in the past; the goal may fail immediately and become immutable.');
    }
    const confirmationText = warnings.join('\n\n') + '\n\n' + (locale === 'ar' ? 'هل تريد المتابعة؟' : 'Continue?');
    if (warnings.length > 0 && !window.confirm(confirmationText)) return;
    setActionLoading(true);
    setError('');
    setSuccess('');
    try {
      const result = await updateGoalConfigForAdmin(editingGoal.id, {
        targetQuantity: target,
        durationDays: duration,
        bonusAmountMinor: bonusMinor,
      });
      if (!result.success) throw new Error('update goal failed');
      setSuccess(copy.saved);
      setEditingGoal(null);
      await refresh();
    } catch {
      setError(copy.operationFailed);
    } finally {
      setActionLoading(false);
    }
  };

  const approveRequest = async (request: GoalRequestEntity) => {
    setActionLoading(true);
    setError('');
    setSuccess('');
    try {
      const result = await approveGoalRequestForAdmin(request.id);
      if (!result.success) throw new Error('approve failed');
      setSuccess(copy.approved);
      await refresh();
    } catch {
      setError(copy.operationFailed);
    } finally {
      setActionLoading(false);
    }
  };

  const rejectRequest = async (request: GoalRequestEntity) => {
    const reason = (rejectionReasons[request.id] || '').trim();
    if (!reason) {
      setError(copy.required);
      return;
    }
    setActionLoading(true);
    setError('');
    setSuccess('');
    try {
      const result = await rejectGoalRequestForAdmin(request.id, reason);
      if (!result.success) throw new Error('reject failed');
      setSuccess(copy.rejected);
      setRejectionReasons((current) => ({ ...current, [request.id]: '' }));
      await refresh();
    } catch {
      setError(copy.operationFailed);
    } finally {
      setActionLoading(false);
    }
  };

  if (!sessionLoaded || loading) {
    return (
      <div className="flex items-center justify-center min-h-64 gap-3 text-sm text-gray-500 dark:text-[#8eb698]">
        <RefreshCw className="h-4 w-4 animate-spin" />
        <span>{copy.loading}</span>
      </div>
    );
  }

  if (!canAccessPage) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
        <div className="flex items-center gap-2 font-semibold"><AlertCircle className="h-5 w-5" />{copy.noPermission}</div>
      </div>
    );
  }

  const tabs: Array<{ id: GoalsTab; label: string }> = [
    ...(canViewGoals ? [{ id: 'overview' as const, label: copy.overview }] : []),
    ...(canViewRequests ? [{ id: 'requests' as const, label: copy.requests }] : []),
    ...(canManage ? [{ id: 'manage' as const, label: copy.manage }] : []),
    ...(isSuperAdmin ? [{ id: 'policy' as const, label: copy.policy }] : []),
  ];

  return (
    <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
      <header className="relative overflow-hidden rounded-3xl border border-emerald-900/10 bg-gradient-to-br from-white via-emerald-50/70 to-teal-100/60 p-5 shadow-sm dark:border-[#1d5147] dark:from-[#082622] dark:via-[#0b302a] dark:to-[#10443a] sm:p-7">
        <div className="absolute -end-10 -top-14 h-48 w-48 rounded-full bg-emerald-300/20 blur-3xl" />
        <div className="relative flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-800 dark:text-[#8eb698]">
              <Target className="h-4 w-4" />
              <span>{copy.title}</span>
            </div>
            <h1 className="text-2xl font-bold text-gray-950 dark:text-[#daf1de] sm:text-3xl">{copy.title}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600 dark:text-[#a8c9b0]">{copy.subtitle}</p>
          </div>
          <Button variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className="h-4 w-4" />
            {copy.refresh}
          </Button>
        </div>
      </header>

      {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-200"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
      {success && <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-200"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{success}</div>}

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          ...(canViewGoals ? [
            { label: copy.active, value: activeGoals.length, icon: Target, style: 'text-emerald-700 dark:text-emerald-300' },
            { label: copy.completed, value: completedGoals.length, icon: CheckCircle2, style: 'text-blue-700 dark:text-blue-300' },
            { label: copy.failed, value: failedGoals.length, icon: Clock3, style: 'text-amber-700 dark:text-amber-300' },
          ] : []),
          ...(canViewRequests ? [{ label: copy.pending, value: pendingRequests.length, icon: AlertCircle, style: 'text-violet-700 dark:text-violet-300' }] : []),
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="rounded-2xl border border-gray-200 bg-white/90 p-4 shadow-sm dark:border-[#17443b] dark:bg-[#082622]/90 sm:p-5">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-medium leading-5 text-gray-500 dark:text-[#8eb698]">{item.label}</span>
                <Icon className={`h-5 w-5 shrink-0 ${item.style}`} />
              </div>
              <div className="mt-3 text-3xl font-bold tabular-nums text-gray-950 dark:text-[#daf1de]">{item.value}</div>
            </div>
          );
        })}
      </section>

      <div className="flex gap-2 overflow-x-auto border-b border-gray-200 pb-2 dark:border-[#17443b]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${activeTab === tab.id ? 'bg-[#235347] text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100 dark:text-[#a8c9b0] dark:hover:bg-[#0c312b]'}`}
          >
            {tab.label}
            {tab.id === 'requests' && pendingRequests.length > 0 && <span className="ms-2 rounded-full bg-white/20 px-2 py-0.5 text-xs">{pendingRequests.length}</span>}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && canViewGoals && (
        <section className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <Search className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 ${isRTL ? 'right-3' : 'left-3'}`} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy.search} className={`w-full rounded-xl border border-gray-200 bg-white py-3 text-sm outline-none focus:border-emerald-700 dark:border-[#1d5147] dark:bg-[#082622] dark:text-[#daf1de] ${isRTL ? 'pr-10 pl-3' : 'pl-10 pr-3'}`} />
            </div>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className="rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm dark:border-[#1d5147] dark:bg-[#082622] dark:text-[#daf1de]">
              <option value="ALL">{copy.allStatuses}</option>
              <option value="ACTIVE">{copy.activeStatus}</option>
              <option value="COMPLETED">{copy.completedStatus}</option>
              <option value="FAILED">{copy.failedStatus}</option>
            </select>
          </div>

          {visibleGoals.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-[#1d5147] dark:text-[#8eb698]">{copy.noGoals}</div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {visibleGoals.map((goal) => {
                const percent = Math.max(0, Math.min(100, Math.round((goal.currentProgress / Math.max(1, goal.targetQuantity)) * 100)));
                const daysLeft = Math.ceil((new Date(goal.expiresAt).getTime() - Date.now()) / 86400000);
                return (
                  <article key={goal.id} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-[#17443b] dark:bg-[#082622]">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs text-gray-500 dark:text-[#8eb698]">{copy.customer}</div>
                        <h2 className="mt-1 truncate text-lg font-bold text-gray-950 dark:text-[#daf1de]">{customerName(goal.customerId)}</h2>
                        <div className="mt-1 break-all font-mono text-[11px] text-gray-400">{goal.id}</div>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${goal.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : goal.status === 'COMPLETED' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'}`}>{statusLabel(goal.status)}</span>
                    </div>
                    <div className="mt-5 flex items-end justify-between gap-3">
                      <div><div className="text-xs text-gray-500 dark:text-[#8eb698]">{copy.progress}</div><div className="mt-1 text-2xl font-bold text-gray-950 dark:text-[#daf1de]">{goal.currentProgress} <span className="text-sm font-medium text-gray-500">/ {goal.targetQuantity}</span></div></div>
                      <div className="text-end"><div className="text-xs text-gray-500 dark:text-[#8eb698]">{copy.percent}</div><div className="mt-1 text-lg font-bold text-emerald-700 dark:text-emerald-300">{percent}%</div></div>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-[#123b32]"><div className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-teal-400 transition-all" style={{ width: `${percent}%` }} /></div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-xl bg-gray-50 p-3 dark:bg-[#0b302a]"><div className="text-xs text-gray-500 dark:text-[#8eb698]">{copy.reward}</div><div className="mt-1 font-semibold text-gray-900 dark:text-[#daf1de]">{formatMoney(goal.bonusAmountMinor)}</div></div>
                      <div className="rounded-xl bg-gray-50 p-3 dark:bg-[#0b302a]"><div className="text-xs text-gray-500 dark:text-[#8eb698]">{copy.duration}</div><div className="mt-1 font-semibold text-gray-900 dark:text-[#daf1de]">{goal.durationDays}</div></div>
                      <div className="rounded-xl bg-gray-50 p-3 dark:bg-[#0b302a]"><div className="text-xs text-gray-500 dark:text-[#8eb698]">{copy.starts}</div><div className="mt-1 text-xs font-medium text-gray-900 dark:text-[#daf1de]">{formatDate(goal.startedAt)}</div></div>
                      <div className="rounded-xl bg-gray-50 p-3 dark:bg-[#0b302a]"><div className="text-xs text-gray-500 dark:text-[#8eb698]">{copy.expires}</div><div className="mt-1 text-xs font-medium text-gray-900 dark:text-[#daf1de]">{formatDate(goal.expiresAt)}</div>{goal.status === 'ACTIVE' && <div className={`mt-1 text-xs ${daysLeft < 0 ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-[#8eb698]'}`}>{daysLeft < 0 ? copy.expired : `${daysLeft} ${copy.daysLeft}`}</div>}</div>
                    </div>
                    {canManage && goal.status === 'ACTIVE' && <div className="mt-4 flex justify-end"><Button variant="outline" size="sm" onClick={() => beginEdit(goal)}><Settings2 className="h-4 w-4" />{copy.edit}</Button></div>}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {activeTab === 'requests' && canViewRequests && (
        <section className="space-y-4">
          {data.requests.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-[#1d5147] dark:text-[#8eb698]">{copy.noRequests}</div>
          ) : (
            data.requests.map((request) => (
              <article key={request.id} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-[#17443b] dark:bg-[#082622]">
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <div className="text-xs text-gray-500 dark:text-[#8eb698]">{copy.customer}</div>
                    <h3 className="mt-1 text-lg font-bold text-gray-950 dark:text-[#daf1de]">{customerName(request.customerId)}</h3>
                    <div className="mt-1 break-all font-mono text-[11px] text-gray-400">{request.id}</div>
                    <div className="mt-3 flex flex-wrap gap-3 text-sm text-gray-600 dark:text-[#a8c9b0]"><span>{copy.requestedTarget}: <strong>{request.requestedTarget ?? '—'}</strong></span><span>{copy.requestedAt}: <strong>{formatDate(request.createdAt)}</strong></span></div>
                    {request.reviewedAt && <div className="mt-2 text-xs text-gray-500 dark:text-[#8eb698]">{copy.reviewedAt}: {formatDate(request.reviewedAt)}{request.reviewedBy ? ` · ${copy.reviewedBy}: ${request.reviewedBy}` : ''}</div>}
                    {request.rejectionReason && <div className="mt-2 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/20 dark:text-red-200">{copy.rejectionReason}: {request.rejectionReason}</div>}
                  </div>
                  <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${request.status === 'PENDING' ? 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200' : request.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'}`}>{request.status === 'PENDING' ? copy.pendingStatus : request.status === 'APPROVED' ? copy.approvedStatus : copy.rejectedStatus}</span>
                </div>
                {request.status === 'PENDING' && canApprove && (
                  <div className="mt-4 border-t border-gray-100 pt-4 dark:border-[#17443b]">
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <Button onClick={() => approveRequest(request)} disabled={actionLoading}><CheckCircle2 className="h-4 w-4" />{copy.approve}</Button>
                      <div className="flex min-w-0 flex-1 gap-2">
                        <input value={rejectionReasons[request.id] || ''} onChange={(event) => setRejectionReasons((current) => ({ ...current, [request.id]: event.target.value }))} placeholder={copy.enterReason} className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-[#1d5147] dark:bg-[#0b302a] dark:text-[#daf1de]" />
                        <Button variant="danger" onClick={() => rejectRequest(request)} disabled={actionLoading || !(rejectionReasons[request.id] || '').trim()}><X className="h-4 w-4" />{copy.reject}</Button>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            ))
          )}
        </section>
      )}

      {activeTab === 'manage' && canManage && (
        <section className="grid gap-5 xl:grid-cols-2">
          <form onSubmit={createGoal} className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-[#17443b] dark:bg-[#082622]">
            <div><h2 className="text-lg font-bold text-gray-950 dark:text-[#daf1de]">{copy.createTitle}</h2><p className="mt-1 text-sm text-gray-500 dark:text-[#8eb698]">{copy.proposalHint}</p></div>
            <label className="block space-y-1.5 text-sm"><span className="font-medium text-gray-700 dark:text-[#a8c9b0]">{copy.chooseCustomer}</span><select value={selectedCustomerId} onChange={(event) => setSelectedCustomerId(event.target.value)} required className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 dark:border-[#1d5147] dark:bg-[#0b302a] dark:text-[#daf1de]"><option value="">{copy.chooseCustomer}</option>{data.customers.filter((customer) => customer.isActive).map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
            <Button type="button" variant="outline" onClick={generateProposal} disabled={!selectedCustomerId || proposalLoading}>{proposalLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}{proposalLoading ? copy.generating : copy.generateProposal}</Button>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="space-y-1.5 text-sm"><span className="font-medium text-gray-700 dark:text-[#a8c9b0]">{copy.target}</span><input type="number" min="1" step="1" required value={targetQuantity} onChange={(event) => setTargetQuantity(event.target.value)} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 dark:border-[#1d5147] dark:bg-[#0b302a] dark:text-[#daf1de]" /></label>
              <label className="space-y-1.5 text-sm"><span className="font-medium text-gray-700 dark:text-[#a8c9b0]">{copy.duration}</span><input type="number" min="3" max="15" step="1" required value={durationDays} onChange={(event) => setDurationDays(event.target.value)} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 dark:border-[#1d5147] dark:bg-[#0b302a] dark:text-[#daf1de]" /></label>
              <label className="space-y-1.5 text-sm"><span className="font-medium text-gray-700 dark:text-[#a8c9b0]">{copy.bonusIls}</span><input type="number" min="0" step="0.01" required value={bonusIls} onChange={(event) => setBonusIls(event.target.value)} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 dark:border-[#1d5147] dark:bg-[#0b302a] dark:text-[#daf1de]" /></label>
            </div>
            <Button type="submit" disabled={actionLoading || !data.customers.some((customer) => customer.id === selectedCustomerId && customer.isActive)}><Plus className="h-4 w-4" />{copy.createGoal}</Button>
          </form>

          <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-[#17443b] dark:bg-[#082622]">
            <h2 className="text-lg font-bold text-gray-950 dark:text-[#daf1de]">{copy.editTitle}</h2>
            <p className="text-sm leading-6 text-gray-500 dark:text-[#8eb698]">{copy.activeOnlyEdit}</p>
            {editingGoal ? (
              <form onSubmit={saveGoalEdit} className="space-y-4">
                <div className="rounded-xl bg-gray-50 p-3 text-sm font-semibold dark:bg-[#0b302a] dark:text-[#daf1de]">{customerName(editingGoal.customerId)} · {editingGoal.currentProgress}/{editingGoal.targetQuantity}</div>
                <label className="block space-y-1.5 text-sm"><span>{copy.target}</span><input type="number" min="1" step="1" value={editTarget} onChange={(event) => setEditTarget(event.target.value)} required className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 dark:border-[#1d5147] dark:bg-[#0b302a] dark:text-[#daf1de]" /></label>
                <label className="block space-y-1.5 text-sm"><span>{copy.duration}</span><input type="number" min="3" max="15" step="1" value={editDuration} onChange={(event) => setEditDuration(event.target.value)} required className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 dark:border-[#1d5147] dark:bg-[#0b302a] dark:text-[#daf1de]" /></label>
                <label className="block space-y-1.5 text-sm"><span>{copy.bonusIls}</span><input type="number" min="0" step="0.01" value={editBonusIls} onChange={(event) => setEditBonusIls(event.target.value)} required className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 dark:border-[#1d5147] dark:bg-[#0b302a] dark:text-[#daf1de]" /></label>
                <div className="flex flex-wrap gap-2"><Button type="submit" disabled={actionLoading}><CheckCircle2 className="h-4 w-4" />{copy.save}</Button><Button type="button" variant="ghost" onClick={() => setEditingGoal(null)}><X className="h-4 w-4" />{copy.cancel}</Button></div>
              </form>
            ) : <p className="text-sm text-gray-500 dark:text-[#8eb698]">{copy.activeOnlyEdit}</p>}
          </div>
        </section>
      )}

      {activeTab === 'policy' && isSuperAdmin && (
        <section className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-[#17443b] dark:bg-[#082622] sm:p-6">
          <div className="flex items-start gap-3"><div className="rounded-xl bg-emerald-100 p-2 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"><Settings2 className="h-5 w-5" /></div><div><h2 className="text-lg font-bold text-gray-950 dark:text-[#daf1de]">{copy.currentPolicy}</h2><p className="mt-1 text-sm text-gray-500 dark:text-[#8eb698]">{copy.policyHint}</p></div></div>
          <ul className="space-y-3 text-sm leading-6 text-gray-700 dark:text-[#b5d3bd]"><li className="rounded-xl bg-gray-50 p-4 dark:bg-[#0b302a]">{copy.durationRule}</li><li className="rounded-xl bg-gray-50 p-4 dark:bg-[#0b302a]">{copy.targetRule}</li><li className="rounded-xl bg-gray-50 p-4 dark:bg-[#0b302a]">{copy.rewardRule}</li></ul>
        </section>
      )}
    </div>
  );
};
