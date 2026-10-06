import React, { useState, useEffect, useRef } from "react";
import { useI18n } from "../../i18n/i18nContext";
import { presentError } from '../../domain/errors';
import { Button } from "../ui/Button";
import { authService, UserSession } from "../../services/auth/authService";
import {
  AdminRow,
  AuditLog,
  CustomPermission,
  rpcFetchAdmins,
  rpcFetchAuditLogs,
  rpcFetchCustomPermissions,
  rpcCreateAdmin,
  rpcSuspendAdmin,
  rpcActivateAdmin,
  rpcUpdateAdminPassword,
  rpcUpdateAdminBin,
  rpcGrantCustomPermission,
  rpcRevokeCustomPermission,
  rpcSetAdminCustomPermissions,
} from "../../services/supabase/client";
import {
  Shield,
  UserPlus,
  Power,
  PowerOff,
  LockKeyhole,
  KeyRound,
  ShieldAlert,
  ListCollapse,
  Search,
  Check,
  Plus,
  X,
  ArrowLeft,
  Settings,
  ShieldCheck,
  Activity,
  History,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

export const AdminManagementPage: React.FC = () => {
  const { t, locale, isRTL } = useI18n();

  // Core lists
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [customPermissions, setCustomPermissions] = useState<CustomPermission[]>([]);

  // Page level state
  const [currentAdminSession, setCurrentAdminSession] = useState<UserSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [currentTab, setCurrentTab] = useState<"list" | "logs">("list");
  const [searchQuery, setSearchQuery] = useState("");

  // Modals state
  const [selectedAdmin, setSelectedAdmin] = useState<AdminRow | null>(null);
  const [modalType, setModalType] = useState<"create" | "password" | "bin" | "permissions" | "suspend" | "activate" | null>(null);

  // Form Fields
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("OPERATOR");
  const [bin, setBin] = useState("");
  const [callerBin, setCallerBin] = useState("");
  const [reauthUsername, setReauthUsername] = useState("");
  const [reauthPassword, setReauthPassword] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // Custom Permissions Selection Helper
  const [tempPermissions, setTempPermissions] = useState<Record<string, boolean>>({});
  const [showActiveSection, setShowActiveSection] = useState(true);
  const [showDisabledSection, setShowDisabledSection] = useState(true);
  const [permissionSearch, setPermissionSearch] = useState("");
  const binInputRef = useRef<HTMLInputElement>(null);

  // All available permissions for selection
  const SYSTEM_PERMISSIONS = [
    { key: "orders:view", labelEn: "View Orders", labelAr: "عرض الطلبات" },
    { key: "orders:create", labelEn: "Create Orders", labelAr: "إنشاء الطلبات" },
    { key: "orders:edit", labelEn: "Edit Orders", labelAr: "تعديل الطلبات" },
    { key: "orders:deliver", labelEn: "Deliver Orders", labelAr: "تسليم الطلبات" },
    { key: "orders:cancel", labelEn: "Cancel Orders", labelAr: "إلغاء الطلبات" },
    { key: "orders:correct", labelEn: "Correct Orders", labelAr: "تصحيح الطلبات" },
    { key: "customers:view", labelEn: "View Customers", labelAr: "عرض العملاء" },
    { key: "customers:create", labelEn: "Create Customers", labelAr: "إضافة عملاء" },
    { key: "customers:edit", labelEn: "Edit Customers", labelAr: "تعديل العملاء" },
    { key: "customers:deactivate", labelEn: "Suspend Customers", labelAr: "إيقاف العملاء" },
    { key: "customers:debt-limit", labelEn: "Adjust Debt Limits", labelAr: "تعديل سقف الدين" },
    { key: "customers:charger-exemption", labelEn: "Exempt from Charger Fees", labelAr: "إعفاء من رسوم الشاحن" },
    { key: "customers:financial-view", labelEn: "View Customer Financials", labelAr: "عرض مالية العميل" },
    { key: "finance:view", labelEn: "View Finances", labelAr: "عرض المالية" },
    { key: "finance:create-payment", labelEn: "Create Payments", labelAr: "إنشاء عمليات دفع" },
    { key: "finance:approve-payment", labelEn: "Approve Payments", labelAr: "اعتماد المقبوضات" },
    { key: "finance:refund", labelEn: "Process Refunds", labelAr: "إرجاع مبالغ" },
    { key: "finance:correction", labelEn: "Financial Corrections", labelAr: "تصحيحات مالية" },
    { key: "finance:credit-adjustment", labelEn: "Adjust Credits", labelAr: "تعديل الرصيد الدائن" },
    { key: "devices:view", labelEn: "View Devices", labelAr: "عرض الأجهزة" },
    { key: "devices:manage", labelEn: "Manage Devices", labelAr: "إدارة الأجهزة" },
    { key: "devices:pricing", labelEn: "Adjust Base Pricing", labelAr: "تعديل أسعار الأجهزة" },
    { key: "devices:charger-policy", labelEn: "Manage Charger Policy", labelAr: "إدارة سياسات الشحن" },
    { key: "settings:manage", labelEn: "Manage Global Settings", labelAr: "إدارة إعدادات النظام" },
    { key: "admin:manage", labelEn: "Manage Subordinate Admins", labelAr: "إدارة المشرفين الفرعيين" },
    { key: "sync:manage", labelEn: "Access & Manage Sync Center", labelAr: "عرض وإدارة مركز المزامنة" },
  ];

  const ROLES = [
    { value: "ADMIN", labelEn: "Administrator", labelAr: "مشرف عام" },
    { value: "OPERATOR", labelEn: "Operator", labelAr: "مشغل" },
    { value: "MANAGER", labelEn: "Manager", labelAr: "مدير صالة" },
    { value: "FINANCE", labelEn: "Finance Officer", labelAr: "مسؤول مالي" },
    { value: "STAFF", labelEn: "Staff Member", labelAr: "موظف" },
    { value: "VIEWER", labelEn: "Viewer (Read Only)", labelAr: "مراقب (للقراءة)" },
  ];

  // Fetch core data on mount
  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [adminsRes, logsRes, permsRes] = await Promise.all([
        rpcFetchAdmins(),
        rpcFetchAuditLogs(),
        rpcFetchCustomPermissions(),
      ]);

      if (adminsRes.error) throw new Error(adminsRes.error);
      if (logsRes.error) throw new Error(logsRes.error);
      if (permsRes.error) throw new Error(permsRes.error);

      setAdmins(adminsRes.data || []);
      setAuditLogs(logsRes.data || []);
      setCustomPermissions(permsRes.data || []);
    } catch (err: any) {
      setError(presentError(err, locale) || "Failed to load admin management data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    authService.getCurrentSession().then(setCurrentAdminSession);
  }, []);

  const clearForm = () => {
    setUsername("");
    setEmail("");
    setPassword("");
    setFullName("");
    setRole("OPERATOR");
    setBin("");
    setCallerBin("");
    setReauthUsername("");
    setReauthPassword("");
    setError(null);
    setSuccess(null);
    setTempPermissions({});
  };

  const handleOpenModal = (type: typeof modalType, admin: AdminRow | null = null) => {
    setSelectedAdmin(admin);
    clearForm();
    setModalType(type);

    if (type === "permissions" && admin) {
      // Build permission check map
      const map: Record<string, boolean> = {};
      let activeCount = 0;
      SYSTEM_PERMISSIONS.forEach((p) => {
        const found = customPermissions.find(
          (cp) => cp.admin_id === admin.id && cp.permission === p.key
        );
        const isGranted = found ? found.is_grant : false;
        map[p.key] = isGranted;
        if (isGranted) activeCount++;
      });
      setTempPermissions(map);
      setCallerBin("");
      setPermissionSearch("");
      setShowActiveSection(true);
      setShowDisabledSection(activeCount === 0 || activeCount < SYSTEM_PERMISSIONS.length);
    }
  };

  const handleCloseModal = () => {
    setModalType(null);
    setSelectedAdmin(null);
    clearForm();
  };

  // Create Subordinate Admin Mutation
  const handleCreateAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setActionLoading(true);

    try {
      // 1. Validate that we have loaded the admins list and have currentAdminSession
      if (!currentAdminSession) {
        throw new Error(
          locale === "ar"
            ? "جلسة العمل غير صالحة. يرجى تسجيل الدخول مجدداً."
            : "Invalid session. Please login again."
        );
      }

      const loggedInAdmin = admins.find((a) => a.email === currentAdminSession.email);
      if (!loggedInAdmin) {
        throw new Error(
          locale === "ar"
            ? "تعذر العثور على حساب المشرف الخاص بك."
            : "Your admin profile could not be found."
        );
      }

      // 2. Verify that submitted username refers to the currently logged in Super Admin
      if (reauthUsername.trim() !== loggedInAdmin.username) {
        throw new Error(
          locale === "ar"
            ? "اسم مستخدم المشرف العام غير صحيح أو لا يطابق حسابك الحالي."
            : "Super Admin username is incorrect or does not match your active account."
        );
      }

      // 3. Verify current Super Admin password
      const reauthRes = await authService.verifyCurrentPassword(
        reauthUsername.trim(),
        reauthPassword
      );

      if (!reauthRes.success || reauthRes.error) {
        throw new Error(
          locale === "ar"
            ? "كلمة مرور المشرف العام الحالية غير صحيحة."
            : "Incorrect Super Admin current password."
        );
      }

      // 4. Verify account is still SUPER_ADMIN and ACTIVE
      if (loggedInAdmin.role !== "SUPER_ADMIN" && loggedInAdmin.role !== "Super Admin") {
        throw new Error(
          locale === "ar"
            ? "غير مصرح: يجب أن تكون بمستوى Super Admin لتنفيذ هذا الإجراء."
            : "Unauthorized: You must have Super Admin level to perform this action."
        );
      }

      if (!loggedInAdmin.is_active) {
        throw new Error(
          locale === "ar"
            ? "حسابك معطل حالياً."
            : "Your account is currently suspended."
        );
      }

      // 5. Proceed with calling the create admin RPC
      const res = await rpcCreateAdmin({
        username,
        email,
        password,
        fullName,
        role,
        bin,
        callerBin,
      });

      if (res.error) {
        throw new Error(res.error);
      }

      // 6. Purge sensitive credentials immediately from state
      setReauthPassword("");
      setCallerBin("");

      setSuccess(
        locale === "ar"
          ? "تم إنشاء حساب المشرف الجديد وتفعيله بنجاح."
          : "New administrator account created and activated successfully."
      );
      await fetchData();
      setTimeout(() => handleCloseModal(), 1500);
    } catch (err: any) {
      setError(presentError(err, locale) || "Failed to create administrator");
    } finally {
      setActionLoading(false);
    }
  };

  // Reset Subordinate Password Mutation
  const handleUpdatePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAdmin) return;
    setError(null);
    setSuccess(null);
    setActionLoading(true);

    try {
      const res = await rpcUpdateAdminPassword(selectedAdmin.id, password, callerBin);
      if (res.error) throw new Error(res.error);

      setSuccess(
        locale === "ar"
          ? "تمت إعادة تعيين كلمة المرور للمشرف بنجاح."
          : "Administrator password reset successfully."
      );
      await fetchData();
      setTimeout(() => handleCloseModal(), 1500);
    } catch (err: any) {
      setError(presentError(err, locale) || "Failed to reset password");
    } finally {
      setActionLoading(false);
    }
  };

  // Reset Subordinate BIN Mutation
  const handleUpdateBinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAdmin) return;
    setError(null);
    setSuccess(null);
    setActionLoading(true);

    try {
      const res = await rpcUpdateAdminBin(selectedAdmin.id, bin, callerBin);
      if (res.error) throw new Error(res.error);

      setSuccess(
        locale === "ar"
          ? "تم تحديث رمز الأمان BIN للمشرف بنجاح."
          : "Administrator security BIN updated successfully."
      );
      await fetchData();
      setTimeout(() => handleCloseModal(), 1500);
    } catch (err: any) {
      setError(presentError(err, locale) || "Failed to update BIN");
    } finally {
      setActionLoading(false);
    }
  };

  // Suspend Subordinate Admin Account Mutation
  const handleSuspendSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAdmin) return;
    setError(null);
    setSuccess(null);
    setActionLoading(true);

    try {
      const res = await rpcSuspendAdmin(selectedAdmin.id, callerBin);
      if (res.error) throw new Error(res.error);

      setSuccess(
        locale === "ar"
          ? "تم تعليق حساب المشرف بنجاح."
          : "Administrator account suspended successfully."
      );
      await fetchData();
      setTimeout(() => handleCloseModal(), 1500);
    } catch (err: any) {
      setError(presentError(err, locale) || "Failed to suspend account");
    } finally {
      setActionLoading(false);
    }
  };

  // Activate Subordinate Admin Account Mutation
  const handleActivateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAdmin) return;
    setError(null);
    setSuccess(null);
    setActionLoading(true);

    try {
      const res = await rpcActivateAdmin(selectedAdmin.id, callerBin);
      if (res.error) throw new Error(res.error);

      setSuccess(
        locale === "ar"
          ? "تم تفعيل حساب المشرف بنجاح."
          : "Administrator account activated successfully."
      );
      await fetchData();
      setTimeout(() => handleCloseModal(), 1500);
    } catch (err: any) {
      setError(presentError(err, locale) || "Failed to activate account");
    } finally {
      setActionLoading(false);
    }
  };

  // Local toggle between Active and Disabled lists (immediate responsive UI)
  const handleToggleLocalPermission = (permissionKey: string) => {
    setError(null);
    setSuccess(null);
    setTempPermissions((prev) => ({
      ...prev,
      [permissionKey]: !prev[permissionKey],
    }));
  };

  // Bulk select all filtered permissions
  const handleSelectAllFilteredPermissions = (keysToEnable: string[]) => {
    setError(null);
    setSuccess(null);
    setTempPermissions((prev) => {
      const next = { ...prev };
      keysToEnable.forEach((k) => {
        next[k] = true;
      });
      return next;
    });
  };

  // Bulk deselect all permissions
  const handleDeselectAllPermissions = () => {
    setError(null);
    setSuccess(null);
    setTempPermissions((prev) => {
      const next: Record<string, boolean> = {};
      Object.keys(prev).forEach((k) => {
        next[k] = false;
      });
      return next;
    });
  };

  // Batch save all custom permissions with Super Admin BIN
  const handleSaveAllPermissions = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedAdmin) return;
    setError(null);
    setSuccess(null);

    const cleanCallerBin = callerBin.trim();
    if (!cleanCallerBin || cleanCallerBin.length < 4) {
      setError(
        locale === "ar"
          ? "يرجى إدخال رمز الأمان (BIN) الخاص بك كـ Super Admin لتأكيد وتطبيق الصلاحيات (4 أرقام على الأقل)."
          : "Please enter your Super Admin security BIN to apply permissions (at least 4 digits)."
      );
      binInputRef.current?.focus();
      return;
    }

    setActionLoading(true);

    try {
      const activeKeys = Object.entries(tempPermissions)
        .filter(([_, isGranted]) => isGranted === true)
        .map(([key]) => key);

      const res = await rpcSetAdminCustomPermissions(
        selectedAdmin.id,
        activeKeys,
        cleanCallerBin
      );

      if (res.error) throw new Error(res.error);

      setSuccess(
        locale === "ar"
          ? `تم حفظ وتطبيق ${activeKeys.length} صلاحية مخصصة للمشرف بنجاح!`
          : `Successfully saved and applied ${activeKeys.length} custom permissions!`
      );
      setCallerBin("");
      await fetchData();
      setTimeout(() => handleCloseModal(), 1200);
    } catch (err: any) {
      setError(presentError(err, locale) || "Failed to update permissions");
      binInputRef.current?.focus();
    } finally {
      setActionLoading(false);
    }
  };

  // Toggle single permission helper
  const handleTogglePermission = async (permissionKey: string, currentVal: boolean) => {
    handleToggleLocalPermission(permissionKey);
  };

  // Filter admins based on search query
  const filteredAdmins = admins.filter((admin) => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return (
      admin.username.toLowerCase().includes(q) ||
      (admin.full_name && admin.full_name.toLowerCase().includes(q)) ||
      (admin.email && admin.email.toLowerCase().includes(q)) ||
      admin.role.toLowerCase().includes(q)
    );
  });

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-24 px-4 sm:px-6">
      {/* Page Header */}
      <div className="pt-2 pb-1 border-b border-gray-200/80 dark:border-[#123832] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-[#daf1de] flex items-center gap-2">
            <Shield className="w-6 h-6 text-emerald-600 dark:text-[#8eb698]" />
            <span>{locale === "ar" ? "إدارة المشرفين والحسابات" : "Admin Account & Security Management"}</span>
          </h1>
          <p className="text-xs text-gray-500 dark:text-[#8eb698] mt-1">
            {locale === "ar"
              ? "صلاحيات Super Admin: إضافة وتعديل المشرفين، تجميد الحسابات، ضبط الصلاحيات الدقيقة، ومراجعة سجل العمليات السحابي."
              : "Super Admin Control Panel: Manage accounts, suspend/activate standard admins, adjust granular permissions, and audit log activities."}
          </p>
        </div>

        <Button
          type="button"
          variant="primary"
          onClick={() => handleOpenModal("create")}
          className="text-xs font-semibold h-9 px-4 gap-1.5 self-start sm:self-auto cursor-pointer"
        >
          <UserPlus className="w-4 h-4" />
          <span>{locale === "ar" ? "إضافة مشرف جديد" : "Create New Admin"}</span>
        </Button>
      </div>

      {/* Tabs Menu */}
      <div className="flex border-b border-gray-200 dark:border-[#123832] gap-6">
        <button
          onClick={() => {
            setCurrentTab("list");
            setError(null);
            setSuccess(null);
          }}
          className={`pb-3 text-sm font-semibold relative transition-all cursor-pointer ${
            currentTab === "list"
              ? "text-emerald-700 dark:text-[#daf1de] border-b-2 border-emerald-600 dark:border-[#8eb698]"
              : "text-gray-500 hover:text-gray-900 dark:text-[#8eb698] dark:hover:text-[#daf1de]"
          }`}
        >
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4" />
            <span>{locale === "ar" ? "قائمة المشرفين" : "Administrator List"}</span>
            <span className="bg-gray-100 dark:bg-[#0c312b] px-2 py-0.5 rounded-full text-xs text-gray-600 dark:text-[#8eb698] font-bold">
              {admins.length}
            </span>
          </div>
        </button>

        <button
          onClick={() => {
            setCurrentTab("logs");
            setError(null);
            setSuccess(null);
          }}
          className={`pb-3 text-sm font-semibold relative transition-all cursor-pointer ${
            currentTab === "logs"
              ? "text-emerald-700 dark:text-[#daf1de] border-b-2 border-emerald-600 dark:border-[#8eb698]"
              : "text-gray-500 hover:text-gray-900 dark:text-[#8eb698] dark:hover:text-[#daf1de]"
          }`}
        >
          <div className="flex items-center gap-1.5">
            <History className="w-4 h-4" />
            <span>{locale === "ar" ? "سجل العمليات الإدارية" : "Administrative Audit Trail"}</span>
            <span className="bg-gray-100 dark:bg-[#0c312b] px-2 py-0.5 rounded-full text-xs text-gray-600 dark:text-[#8eb698] font-bold">
              {auditLogs.length}
            </span>
          </div>
        </button>
      </div>

      {/* Status Banners */}
      {error && (
        <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs font-semibold border border-red-200 dark:border-red-900 flex items-center gap-2">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 text-xs font-semibold border border-emerald-200 dark:border-emerald-900 flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {/* Main Content Areas */}
      {loading ? (
        <div className="py-12 text-center text-sm text-gray-500 dark:text-[#8eb698]">
          <Activity className="w-6 h-6 animate-spin mx-auto text-emerald-600 mb-2" />
          <span>{locale === "ar" ? "جاري جلب البيانات بأمان..." : "Fetching securely..."}</span>
        </div>
      ) : currentTab === "list" ? (
        <div className="space-y-4">
          {/* Search Box */}
          <div className="relative">
            <div className="absolute inset-y-0 start-0 ps-3.5 flex items-center pointer-events-none text-gray-400">
              <Search className="w-4 h-4" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                locale === "ar"
                  ? "البحث باسم المشرف، اسم الحساب، البريد الإلكتروني أو الصلاحية..."
                  : "Search by username, full name, email, or role..."
              }
              className="w-full ps-10 pe-4 py-2 text-sm rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          {/* Admins Grid */}
          {filteredAdmins.length === 0 ? (
            <div className="p-8 text-center border border-dashed border-gray-200 dark:border-[#123832] rounded-2xl text-gray-500 dark:text-[#8eb698] text-sm">
              {locale === "ar" ? "لم يتم العثور على أي مشرفين مطابقين للبحث." : "No matching administrator accounts found."}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredAdmins.map((admin) => {
                const isAdminActive = admin.is_active !== false;
                const isSuper = admin.role === "SUPER_ADMIN" || admin.role === "Super Admin";

                return (
                  <div
                    key={admin.id}
                    className={`p-4 rounded-2xl border transition-all ${
                      isAdminActive
                        ? "bg-white dark:bg-[#061f1c] border-gray-200/80 dark:border-[#123832] shadow-xs hover:border-gray-300 dark:hover:border-emerald-900"
                        : "bg-gray-100/50 dark:bg-[#031513] border-gray-200 dark:border-red-950/40 opacity-75"
                    }`}
                  >
                    {/* Header Info */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-gray-900 dark:text-[#daf1de] text-sm truncate">
                            {admin.full_name || admin.username}
                          </span>
                          <span
                            className={`px-2 py-0.5 text-[10px] font-semibold rounded-full border shrink-0 ${
                              isSuper
                                ? "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900/60"
                                : "bg-emerald-50 dark:bg-[#0c312b] text-emerald-700 dark:text-[#8eb698] border-emerald-200 dark:border-[#14423b]"
                            }`}
                          >
                            {admin.role}
                          </span>
                          {!isAdminActive && (
                            <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900 shrink-0">
                              {locale === "ar" ? "معطل / مجمّد" : "Suspended"}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-gray-500 dark:text-[#8eb698] block mt-0.5 truncate">
                          @{admin.username} • {admin.email || "No Email"}
                        </span>
                        {!isAdminActive && (
                          <div className="text-[11px] text-red-600 dark:text-red-400 mt-2 font-medium bg-red-50/50 dark:bg-red-950/20 p-2 rounded-lg border border-red-100 dark:border-red-950/30">
                            <span>{locale === "ar" ? "تم التعليق: " : "Suspended on: "}</span>
                            <span className="font-semibold text-gray-700 dark:text-gray-300">
                              {admin.disabled_at ? new Date(admin.disabled_at).toLocaleString(locale === "ar" ? "ar-EG" : "en-US") : "---"}
                            </span>
                            {admin.disabled_by && (
                              <span className="block mt-0.5">
                                <span>{locale === "ar" ? "بواسطة المشرف: " : "Suspended by: "}</span>
                                <span className="font-bold text-gray-950 dark:text-white">
                                  {admins.find(a => a.id === admin.disabled_by)?.full_name || admins.find(a => a.id === admin.disabled_by)?.username || admin.disabled_by}
                                </span>
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Status indicator swatches */}
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${isAdminActive ? "bg-emerald-500" : "bg-red-500"}`} />
                    </div>

                    {/* Actions panel */}
                    <div className="mt-4 pt-3.5 border-t border-gray-100 dark:border-[#0f302b] flex flex-wrap gap-2">
                      {/* Granular Permission Control - only for non-super admins */}
                      {!isSuper && isAdminActive && (
                        <button
                          onClick={() => handleOpenModal("permissions", admin)}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gray-100 hover:bg-gray-200 dark:bg-[#0c312b] dark:hover:bg-[#14433b] text-gray-700 dark:text-[#daf1de] transition-all cursor-pointer flex items-center gap-1"
                        >
                          <Settings className="w-3.5 h-3.5" />
                          <span>{locale === "ar" ? "الصلاحيات" : "Permissions"}</span>
                        </button>
                      )}

                      {/* Reset password button */}
                      {isAdminActive && (
                        <button
                          onClick={() => handleOpenModal("password", admin)}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gray-100 hover:bg-gray-200 dark:bg-[#0c312b] dark:hover:bg-[#14433b] text-gray-700 dark:text-[#daf1de] transition-all cursor-pointer flex items-center gap-1"
                        >
                          <LockKeyhole className="w-3.5 h-3.5" />
                          <span>{locale === "ar" ? "كلمة المرور" : "Password"}</span>
                        </button>
                      )}

                      {/* Reset BIN button */}
                      {isAdminActive && (
                        <button
                          onClick={() => handleOpenModal("bin", admin)}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gray-100 hover:bg-gray-200 dark:bg-[#0c312b] dark:hover:bg-[#14433b] text-gray-700 dark:text-[#daf1de] transition-all cursor-pointer flex items-center gap-1"
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                          <span>{locale === "ar" ? "تعديل BIN" : "Reset BIN"}</span>
                        </button>
                      )}

                      {/* Suspend / Activate Account button - only non-super admins */}
                      {!isSuper && (
                        isAdminActive ? (
                          <button
                            onClick={() => handleOpenModal("suspend", admin)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-red-50 hover:bg-red-100 dark:bg-red-950/30 dark:hover:bg-red-950/60 text-red-600 dark:text-red-400 transition-all cursor-pointer flex items-center gap-1"
                          >
                            <PowerOff className="w-3.5 h-3.5" />
                            <span>{locale === "ar" ? "تعليق الحساب" : "Suspend Account"}</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => handleOpenModal("activate", admin)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:hover:bg-[#0f3d35] text-emerald-700 dark:text-[#8eb698] transition-all cursor-pointer flex items-center gap-1"
                          >
                            <Power className="w-3.5 h-3.5" />
                            <span>{locale === "ar" ? "تنشيط وتفعيل" : "Activate"}</span>
                          </button>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* Audit Logs Tab */
        <div className="bg-white dark:bg-[#061f1c] rounded-2xl border border-gray-200 dark:border-[#123832] shadow-2xs overflow-hidden">
          <div className="p-4 border-b border-gray-100 dark:border-[#0f302b] bg-gray-50/50 dark:bg-[#041714]">
            <h3 className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
              {locale === "ar" ? "السجلات الإدارية السحابية المشفرة" : "Authorized Security Audit Log"}
            </h3>
            <p className="text-xs text-gray-400 dark:text-[#5e8674] mt-0.5">
              {locale === "ar"
                ? "يتم تتبع وتسجيل جميع الإجراءات الرقابية الحساسة ولا يمكن حذفها أو تعديلها برمجياً."
                : "Sealed administrative events. Cryptographically protected, non-tamperable audit logs."}
            </p>
          </div>

          <div className="divide-y divide-gray-100 dark:divide-[#0f302b] overflow-x-auto max-h-[500px]">
            {auditLogs.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500 dark:text-[#8eb698]">
                {locale === "ar" ? "لا توجد عمليات إدارية مسجلة بعد." : "No admin operations registered yet."}
              </div>
            ) : (
              auditLogs.map((log) => {
                const actor = admins.find((a) => a.id === log.actor_admin_id);
                const target = admins.find((a) => a.id === log.target_admin_id);

                return (
                  <div key={log.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-emerald-700 dark:text-[#8eb698]">
                          {actor ? actor.full_name || actor.username : `System / ID [${log.actor_admin_id?.substring(0, 8)}]`}
                        </span>
                        <span className="bg-gray-100 dark:bg-[#0c312b] px-1.5 py-0.5 rounded text-[10px] text-gray-500 dark:text-[#8eb698] border border-transparent dark:border-[#14423b] font-mono">
                          {log.action}
                        </span>
                        {target && (
                          <span className="text-gray-500 dark:text-neutral-400">
                            ➔ {locale === "ar" ? "على" : "on"} <span className="font-semibold text-gray-900 dark:text-[#daf1de]">{target.full_name || target.username}</span>
                          </span>
                        )}
                      </div>

                      {log.metadata && Object.keys(log.metadata).length > 0 && (
                        <div className="text-[11px] text-gray-500 dark:text-[#5e8674] font-mono">
                          {JSON.stringify(log.metadata)}
                        </div>
                      )}
                    </div>

                    <div className="text-[10px] text-gray-400 dark:text-[#5e8674] whitespace-nowrap self-start sm:self-auto">
                      {new Date(log.created_at).toLocaleString(locale === "ar" ? "ar-EG" : "en-US")}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* MODALS RENDER SECTION */}
      {modalType && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs">
          <div className={`bg-white dark:bg-[#061f1c] w-full ${modalType === "permissions" ? "max-w-3xl" : "max-w-lg"} rounded-2xl border border-gray-200 dark:border-[#123832] shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-200`}>
            
            {/* Modal Header */}
            <div className="p-4 border-b border-gray-100 dark:border-[#0f302b] flex items-center justify-between bg-gray-50/50 dark:bg-[#041714]">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-emerald-600 dark:text-[#8eb698]" />
                <h3 className="font-bold text-gray-900 dark:text-[#daf1de] text-sm">
                  {modalType === "create" && (locale === "ar" ? "إنشاء حساب مشرف فرعي" : "Create Subordinate Admin Account")}
                  {modalType === "password" && (locale === "ar" ? `تعديل كلمة مرور: ${selectedAdmin?.username}` : `Reset Password for ${selectedAdmin?.username}`)}
                  {modalType === "bin" && (locale === "ar" ? `تعديل رمز BIN: ${selectedAdmin?.username}` : `Reset Security BIN for ${selectedAdmin?.username}`)}
                  {modalType === "suspend" && (locale === "ar" ? "تأكيد تعليق الحساب" : "Confirm Suspension")}
                  {modalType === "activate" && (locale === "ar" ? "تأكيد تفعيل الحساب" : "Confirm Activation")}
                  {modalType === "permissions" && (locale === "ar" ? `تخصيص الصلاحيات للمشرف: ${selectedAdmin?.full_name || selectedAdmin?.username} (@${selectedAdmin?.username})` : `Granular Permissions for ${selectedAdmin?.username}`)}
                </h3>
              </div>
              <button
                onClick={handleCloseModal}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className={`p-5 ${modalType === "permissions" ? "max-h-[82vh]" : "max-h-[460px]"} overflow-y-auto space-y-4`}>
              
              {/* Local errors inside Modal */}
              {error && (
                <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs font-semibold border border-red-200 dark:border-red-900 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {success && (
                <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 text-xs font-semibold border border-emerald-200 dark:border-emerald-900 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{success}</span>
                </div>
              )}

              {/* 1. Create Form */}
              {modalType === "create" && (
                <form onSubmit={handleCreateAdminSubmit} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-bold text-gray-700 dark:text-[#8eb698] mb-1">
                        {locale === "ar" ? "اسم المستخدم (Username)" : "Username"}
                      </label>
                      <input
                        type="text"
                        required
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="e.g. operator_john"
                        className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-gray-700 dark:text-[#8eb698] mb-1">
                        {locale === "ar" ? "الاسم الكامل" : "Full Name"}
                      </label>
                      <input
                        type="text"
                        required
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder="John Doe"
                        className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-bold text-gray-700 dark:text-[#8eb698] mb-1">
                        {locale === "ar" ? "البريد الإلكتروني" : "Email"}
                      </label>
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="john@example.com"
                        className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-gray-700 dark:text-[#8eb698] mb-1">
                        {locale === "ar" ? "المسمى الوظيفي / الدور" : "System Role"}
                      </label>
                      <select
                        value={role}
                        onChange={(e) => setRole(e.target.value)}
                        className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20 cursor-pointer"
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {locale === "ar" ? r.labelAr : r.labelEn}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-bold text-gray-700 dark:text-[#8eb698] mb-1">
                        {locale === "ar" ? "كلمة المرور (6 أحرف كحد أدنى)" : "Initial Password"}
                      </label>
                      <input
                        type="password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-gray-700 dark:text-[#8eb698] mb-1">
                        {locale === "ar" ? "رمز الأمان الخاص بالمشرف (BIN)" : "Admin Security BIN"}
                      </label>
                      <input
                        type="password"
                        required
                        value={bin}
                        onChange={(e) => setBin(e.target.value)}
                        placeholder="e.g. 5678"
                        maxLength={12}
                        className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>
                  </div>

                  <div className="p-3 bg-amber-50 dark:bg-amber-950/30 rounded-xl border border-amber-200 dark:border-amber-900/60 text-[11px] text-amber-800 dark:text-amber-400">
                    {locale === "ar"
                      ? "إجراء تفويض ومصادقة مطلوب: يرجى تأكيد هويتك كـ Super Admin بإدخال اسم المستخدم، كلمة المرور، ورمز BIN الخاص بك لتخويل عملية الإنشاء:"
                      : "Required Identity Verification: Verify your Super Admin username, password, and security BIN to authorize creation:"}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-xs font-bold text-amber-900 dark:text-amber-400 mb-1">
                        {locale === "ar" ? "اسم مستخدم Super Admin الخاص بك" : "Your Super Admin Username"}
                      </label>
                      <input
                        type="text"
                        required
                        value={reauthUsername}
                        onChange={(e) => setReauthUsername(e.target.value)}
                        placeholder="e.g. superadmin"
                        className="w-full px-3 py-2 text-xs rounded-xl border border-amber-300 dark:border-amber-800 bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-amber-900 dark:text-amber-400 mb-1">
                        {locale === "ar" ? "كلمة مرور Super Admin الخاصة بك" : "Your Super Admin Password"}
                      </label>
                      <input
                        type="password"
                        required
                        value={reauthPassword}
                        onChange={(e) => setReauthPassword(e.target.value)}
                        placeholder="••••••••"
                        className="w-full px-3 py-2 text-xs rounded-xl border border-amber-300 dark:border-amber-800 bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-amber-900 dark:text-amber-400 mb-1">
                      {locale === "ar" ? "رمز BIN الخاص بك" : "Your Super Admin BIN"}
                    </label>
                    <input
                      type="password"
                      required
                      value={callerBin}
                      onChange={(e) => setCallerBin(e.target.value)}
                      placeholder="••••"
                      maxLength={12}
                      className="w-full px-3 py-2 text-xs rounded-xl border border-amber-300 dark:border-amber-800 bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100 dark:border-[#0f302b]">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCloseModal}
                      disabled={actionLoading}
                      className="text-xs h-8 px-3"
                    >
                      {locale === "ar" ? "إلغاء" : "Cancel"}
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={actionLoading}
                      className="text-xs h-8 px-4 font-semibold cursor-pointer bg-emerald-600 text-white"
                    >
                      {actionLoading ? "..." : locale === "ar" ? "حفظ وتفعيل الحساب" : "Save & Activate"}
                    </Button>
                  </div>
                </form>
              )}

              {/* 2. Reset Password Form */}
              {modalType === "password" && (
                <form onSubmit={handleUpdatePasswordSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-700 dark:text-[#8eb698] mb-1">
                      {locale === "ar" ? "كلمة المرور الجديدة (6 أحرف كحد أدنى)" : "New Password"}
                    </label>
                    <input
                      type="password"
                      required
                      autoFocus
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>

                  <div className="p-3 bg-amber-50 dark:bg-amber-950/30 rounded-xl border border-amber-200 dark:border-amber-900/60 text-[11px] text-amber-800 dark:text-amber-400">
                    {locale === "ar"
                      ? "إجراء تفويض مطلوب: أدخل رمز الأمان BIN الخاص بك بصفتك Super Admin لتعديل كلمة مرور المشرف:"
                      : "Administrative Authorization: Enter your Super Admin security BIN to authorize password reset:"}
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-amber-900 dark:text-amber-400 mb-1">
                      {locale === "ar" ? "رمز الأمان BIN الخاص بك" : "Your Super Admin BIN"}
                    </label>
                    <input
                      type="password"
                      required
                      value={callerBin}
                      onChange={(e) => setCallerBin(e.target.value)}
                      placeholder="••••"
                      maxLength={12}
                      className="w-full px-3 py-2 text-xs rounded-xl border border-amber-300 dark:border-amber-800 bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100 dark:border-[#0f302b]">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCloseModal}
                      disabled={actionLoading}
                      className="text-xs h-8 px-3"
                    >
                      {locale === "ar" ? "إلغاء" : "Cancel"}
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={actionLoading}
                      className="text-xs h-8 px-4 font-semibold cursor-pointer"
                    >
                      {actionLoading ? "..." : locale === "ar" ? "إعادة تعيين كلمة المرور" : "Reset Password"}
                    </Button>
                  </div>
                </form>
              )}

              {/* 3. Reset BIN Form */}
              {modalType === "bin" && (
                <form onSubmit={handleUpdateBinSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-700 dark:text-[#8eb698] mb-1">
                      {locale === "ar" ? "رمز الأمان BIN الجديد للمشرف (أرقام فقط)" : "New Security BIN"}
                    </label>
                    <input
                      type="password"
                      required
                      autoFocus
                      value={bin}
                      onChange={(e) => setBin(e.target.value)}
                      placeholder="••••"
                      maxLength={12}
                      className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>

                  <div className="p-3 bg-amber-50 dark:bg-amber-950/30 rounded-xl border border-amber-200 dark:border-amber-900/60 text-[11px] text-amber-800 dark:text-amber-400">
                    {locale === "ar"
                      ? "إجراء تفويض مطلوب: أدخل رمز الأمان BIN الخاص بك بصفتك Super Admin لتعديل الـ BIN لهذا المشرف:"
                      : "Administrative Authorization: Enter your Super Admin security BIN to authorize BIN update:"}
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-amber-900 dark:text-amber-400 mb-1">
                      {locale === "ar" ? "رمز الأمان BIN الخاص بك" : "Your Super Admin BIN"}
                    </label>
                    <input
                      type="password"
                      required
                      value={callerBin}
                      onChange={(e) => setCallerBin(e.target.value)}
                      placeholder="••••"
                      maxLength={12}
                      className="w-full px-3 py-2 text-xs rounded-xl border border-amber-300 dark:border-amber-800 bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100 dark:border-[#0f302b]">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCloseModal}
                      disabled={actionLoading}
                      className="text-xs h-8 px-3"
                    >
                      {locale === "ar" ? "إلغاء" : "Cancel"}
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={actionLoading}
                      className="text-xs h-8 px-4 font-semibold cursor-pointer"
                    >
                      {actionLoading ? "..." : locale === "ar" ? "تحديث رمز BIN" : "Update BIN"}
                    </Button>
                  </div>
                </form>
              )}

              {/* 4. Suspend Form */}
              {modalType === "suspend" && (
                <form onSubmit={handleSuspendSubmit} className="space-y-4">
                  <div className="text-xs text-gray-600 dark:text-[#8eb698] leading-relaxed">
                    {locale === "ar"
                      ? `هل أنت متأكد من رغبتك في تعليق/تجميد حساب المشرف ${selectedAdmin?.username}؟ لن يتمكن من تسجيل الدخول إلى المنظومة نهائياً.`
                      : `Are you sure you want to suspend administrator account @${selectedAdmin?.username}? They will lose complete system access immediately.`}
                  </div>

                  <div className="p-3 bg-red-50 dark:bg-red-950/20 rounded-xl border border-red-200 dark:border-red-900 text-[11px] text-red-700 dark:text-red-400">
                    {locale === "ar"
                      ? "إجراء حساس: يرجى تأكيد تفويض التعليق بإدخال رمز BIN الخاص بك كـ Super Admin:"
                      : "Critical Action: Please enter your Super Admin security BIN to authorize account suspension:"}
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-red-900 dark:text-red-400 mb-1">
                      {locale === "ar" ? "رمز الأمان BIN الخاص بك" : "Your Super Admin BIN"}
                    </label>
                    <input
                      type="password"
                      required
                      autoFocus
                      value={callerBin}
                      onChange={(e) => setCallerBin(e.target.value)}
                      placeholder="••••"
                      maxLength={12}
                      className="w-full px-3 py-2 text-xs rounded-xl border border-red-300 dark:border-red-900 bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-red-500/20"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100 dark:border-[#0f302b]">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCloseModal}
                      disabled={actionLoading}
                      className="text-xs h-8 px-3"
                    >
                      {locale === "ar" ? "إلغاء" : "Cancel"}
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={actionLoading}
                      className="text-xs h-8 px-4 font-semibold cursor-pointer bg-red-600 text-white border-red-600 hover:bg-red-700"
                    >
                      {actionLoading ? "..." : locale === "ar" ? "تعليق وتجميد الحساب" : "Suspend Account"}
                    </Button>
                  </div>
                </form>
              )}

              {/* 5. Activate Form */}
              {modalType === "activate" && (
                <form onSubmit={handleActivateSubmit} className="space-y-4">
                  <div className="text-xs text-gray-600 dark:text-[#8eb698] leading-relaxed">
                    {locale === "ar"
                      ? `هل تريد تنشيط وإعادة تفعيل حساب المشرف ${selectedAdmin?.username}؟ سيستعيد كامل صلاحيات الوصول للنظام.`
                      : `Are you sure you want to activate administrator account @${selectedAdmin?.username}? They will recover access permissions.`}
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-gray-700 dark:text-[#8eb698] mb-1">
                      {locale === "ar" ? "رمز الأمان BIN الخاص بك" : "Your Super Admin BIN"}
                    </label>
                    <input
                      type="password"
                      required
                      autoFocus
                      value={callerBin}
                      onChange={(e) => setCallerBin(e.target.value)}
                      placeholder="••••"
                      maxLength={12}
                      className="w-full px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100 dark:border-[#0f302b]">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCloseModal}
                      disabled={actionLoading}
                      className="text-xs h-8 px-3"
                    >
                      {locale === "ar" ? "إلغاء" : "Cancel"}
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={actionLoading}
                      className="text-xs h-8 px-4 font-semibold cursor-pointer"
                    >
                      {actionLoading ? "..." : locale === "ar" ? "تنشيط الحساب" : "Activate Account"}
                    </Button>
                  </div>
                </form>
              )}

              {/* 6. Permissions Granular Editor */}
              {modalType === "permissions" && (() => {
                const filteredSystemPermissions = SYSTEM_PERMISSIONS.filter((p) => {
                  if (!permissionSearch.trim()) return true;
                  const q = permissionSearch.toLowerCase().trim();
                  return (
                    p.labelAr.toLowerCase().includes(q) ||
                    p.labelEn.toLowerCase().includes(q) ||
                    p.key.toLowerCase().includes(q)
                  );
                });

                const activePermissionsList = filteredSystemPermissions.filter(
                  (p) => tempPermissions[p.key] === true
                );

                const disabledPermissionsList = filteredSystemPermissions.filter(
                  (p) => !tempPermissions[p.key]
                );

                return (
                  <div className="space-y-4">
                    {/* Header info, search & bulk tools */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-gray-100 dark:border-[#0f302b]">
                      <div>
                        <p className="text-sm font-bold text-gray-900 dark:text-[#daf1de]">
                          {locale === "ar"
                            ? `تخصيص الصلاحيات للمشرف: ${selectedAdmin?.full_name || selectedAdmin?.username}`
                            : `Customize permissions for ${selectedAdmin?.full_name || selectedAdmin?.username}`}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-[#8eb698] mt-0.5">
                          {locale === "ar"
                            ? "اضغط على مربع الصلاحية لتفعيلها باللون الأخضر ونقلها فوراً لقائمة المفعلات، ثم أدخل رمز BIN واضغط حفظ."
                            : "Click the toggle box on any permission to grant it and transfer it instantly to Active."}
                        </p>
                      </div>

                      {/* Search Bar */}
                      <div className="relative w-full sm:w-64 shrink-0">
                        <Search className="w-3.5 h-3.5 absolute right-3 top-2.5 text-gray-400" />
                        <input
                          type="text"
                          value={permissionSearch}
                          onChange={(e) => setPermissionSearch(e.target.value)}
                          placeholder={locale === "ar" ? "بحث في أسماء الصلاحيات..." : "Search permissions..."}
                          className="w-full pr-9 pl-3 py-1.5 text-xs rounded-xl border border-gray-200 dark:border-[#123832] bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                        />
                      </div>
                    </div>

                    {/* Bulk Action Controls */}
                    <div className="flex items-center justify-between gap-2 px-1">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleSelectAllFilteredPermissions(filteredSystemPermissions.map((p) => p.key))}
                          className="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:hover:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60 transition-colors cursor-pointer"
                        >
                          {locale === "ar" ? "✓ تفعيل الكل" : "✓ Grant All"}
                        </button>
                        <button
                          type="button"
                          onClick={handleDeselectAllPermissions}
                          className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-[#0c312b] dark:hover:bg-[#123d35] text-gray-700 dark:text-[#8eb698] border border-gray-200 dark:border-[#14423b] transition-colors cursor-pointer"
                        >
                          {locale === "ar" ? "✕ تعطيل الكل" : "✕ Revoke All"}
                        </button>
                      </div>

                      <div className="text-[11px] font-semibold text-gray-500 dark:text-[#8eb698]">
                        <span>{locale === "ar" ? "المجموع:" : "Total:"} </span>
                        <span className="font-bold text-emerald-600 dark:text-emerald-400">{activePermissionsList.length}</span>
                        <span> / {filteredSystemPermissions.length}</span>
                      </div>
                    </div>

                    {/* Lists Container */}
                    <div className="space-y-4 max-h-[440px] overflow-y-auto pr-1">
                      
                      {/* Section 1: Active Permissions List (القائمة الأولى: المفعلة) */}
                      <div className="rounded-2xl border-2 border-emerald-500/30 dark:border-emerald-700/50 bg-emerald-50/20 dark:bg-[#0c312b]/15 overflow-hidden shadow-xs">
                        <button
                          type="button"
                          onClick={() => setShowActiveSection(!showActiveSection)}
                          className="w-full px-4 py-3 flex items-center justify-between text-xs font-bold text-emerald-950 dark:text-emerald-200 bg-emerald-100/70 dark:bg-emerald-950/50 hover:bg-emerald-100 dark:hover:bg-emerald-950/70 transition-colors cursor-pointer select-none"
                        >
                          <div className="flex items-center gap-2.5">
                            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                            <span className="text-sm font-bold">{locale === "ar" ? "الصلاحيات المفعلة" : "Active Permissions"}</span>
                            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-600 text-white shadow-xs">
                              {activePermissionsList.length}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                            <span className="text-[11px] font-normal">{showActiveSection ? (locale === "ar" ? "طي" : "Collapse") : (locale === "ar" ? "عرض" : "Expand")}</span>
                            {showActiveSection ? (
                              <ChevronUp className="w-4 h-4" />
                            ) : (
                              <ChevronDown className="w-4 h-4" />
                            )}
                          </div>
                        </button>

                        {showActiveSection && (
                          <div className="p-3 space-y-2">
                            {activePermissionsList.length === 0 ? (
                              <div className="p-5 text-center bg-white/60 dark:bg-[#061f1c]/60 rounded-xl border border-dashed border-emerald-200 dark:border-emerald-900/50 text-xs text-gray-500 dark:text-[#8eb698] leading-relaxed">
                                {locale === "ar"
                                  ? "لا توجد صلاحيات مفعلة حالياً لهذا المشرف. اضغط على زر (+ تفعيل) بجانب أي صلاحية من قائمة الصلاحيات المعطلة أدناه لتفعيلها ونقلها إلى هنا فوراً."
                                  : "No active permissions currently. Click (+ Grant) on any permission in the Disabled list below to activate it here."}
                              </div>
                            ) : (
                              activePermissionsList.map((perm) => (
                                <div
                                  key={perm.key}
                                  className="w-full flex items-center justify-between gap-3 p-3 rounded-xl border border-emerald-200/80 dark:border-emerald-800/60 bg-white dark:bg-[#061f1c] hover:bg-emerald-50/50 dark:hover:bg-emerald-950/30 transition-all shadow-2xs"
                                >
                                  {/* Permission Label in full line */}
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="font-bold text-gray-900 dark:text-[#daf1de] text-sm block">
                                        {locale === "ar" ? perm.labelAr : perm.labelEn}
                                      </span>
                                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/40">
                                        {perm.key}
                                      </span>
                                    </div>
                                  </div>

                                  {/* Green Active Toggle Box */}
                                  <button
                                    type="button"
                                    onClick={() => handleToggleLocalPermission(perm.key)}
                                    title={locale === "ar" ? "اضغط لإلغاء التفعيل ونقلها للصلاحيات المعطلة" : "Click to revoke"}
                                    className="px-3.5 py-1.5 rounded-lg text-xs font-bold cursor-pointer shrink-0 transition-all flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs border border-emerald-500 select-none"
                                  >
                                    <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                                    <span>{locale === "ar" ? "مفعلة ✓" : "Active ✓"}</span>
                                  </button>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>

                      {/* Section 2: Disabled Permissions List (القائمة الثانية: المعطلة) */}
                      <div className="rounded-2xl border border-gray-200 dark:border-[#123832] bg-gray-50/40 dark:bg-[#041714]/40 overflow-hidden shadow-xs">
                        <button
                          type="button"
                          onClick={() => setShowDisabledSection(!showDisabledSection)}
                          className="w-full px-4 py-3 flex items-center justify-between text-xs font-bold text-gray-700 dark:text-[#8eb698] bg-gray-100/80 dark:bg-[#0e2c26] hover:bg-gray-100 dark:hover:bg-[#123831] transition-colors cursor-pointer select-none"
                        >
                          <div className="flex items-center gap-2.5">
                            <ListCollapse className="w-4 h-4 text-gray-500 dark:text-[#5e8674]" />
                            <span className="text-sm font-bold">{locale === "ar" ? "الصلاحيات المعطلة" : "Disabled Permissions"}</span>
                            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-gray-200 dark:bg-[#19493f] text-gray-700 dark:text-[#daf1de]">
                              {disabledPermissionsList.length}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 text-gray-500 dark:text-[#8eb698]">
                            <span className="text-[11px] font-normal">{showDisabledSection ? (locale === "ar" ? "طي" : "Collapse") : (locale === "ar" ? "عرض" : "Expand")}</span>
                            {showDisabledSection ? (
                              <ChevronUp className="w-4 h-4" />
                            ) : (
                              <ChevronDown className="w-4 h-4" />
                            )}
                          </div>
                        </button>

                        {showDisabledSection && (
                          <div className="p-3 space-y-2">
                            {disabledPermissionsList.length === 0 ? (
                              <div className="p-5 text-center bg-white dark:bg-[#061f1c] rounded-xl border border-dashed border-gray-200 dark:border-[#123832] text-xs text-emerald-600 dark:text-emerald-400 font-bold">
                                {locale === "ar" ? "رائع! جميع الصلاحيات تم تفعيلها ونقلها إلى قسم المفعلات أعلاه." : "All permissions are currently granted and active!"}
                              </div>
                            ) : (
                              disabledPermissionsList.map((perm) => (
                                <div
                                  key={perm.key}
                                  className="w-full flex items-center justify-between gap-3 p-3 rounded-xl border border-gray-200/90 dark:border-[#123832] bg-white dark:bg-[#061f1c] hover:border-emerald-300 dark:hover:border-emerald-800/60 transition-all shadow-2xs"
                                >
                                  {/* Permission Label in full line */}
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="font-semibold text-gray-700 dark:text-[#8eb698] text-sm block">
                                        {locale === "ar" ? perm.labelAr : perm.labelEn}
                                      </span>
                                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-gray-100 dark:bg-[#0e2c26] text-gray-400 dark:text-[#5e8674]">
                                        {perm.key}
                                      </span>
                                    </div>
                                  </div>

                                  {/* Interactive Box to Grant / Activate */}
                                  <button
                                    type="button"
                                    onClick={() => handleToggleLocalPermission(perm.key)}
                                    title={locale === "ar" ? "اضغط لتفعيل الصلاحية ونقلها لقائمة المفعلات أعلاه" : "Click to grant"}
                                    className="px-3.5 py-1.5 rounded-lg text-xs font-bold cursor-pointer shrink-0 transition-all flex items-center gap-1.5 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-[#082420] hover:bg-emerald-50 hover:border-emerald-500 hover:text-emerald-700 dark:hover:bg-emerald-950/40 dark:hover:border-emerald-500 dark:hover:text-emerald-300 text-gray-700 dark:text-gray-200 shadow-2xs select-none"
                                  >
                                    <Plus className="w-3.5 h-3.5 text-gray-500 hover:text-emerald-600" />
                                    <span>{locale === "ar" ? "+ تفعيل" : "+ Grant"}</span>
                                  </button>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>

                    </div>

                    {/* Super Admin BIN Authorization Card */}
                    <div className="p-3.5 bg-amber-50/80 dark:bg-amber-950/20 rounded-2xl border border-amber-200 dark:border-amber-900/50 space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-bold text-amber-950 dark:text-amber-300 flex items-center gap-1.5">
                          <LockKeyhole className="w-4 h-4 text-amber-600 shrink-0" />
                          <span>{locale === "ar" ? "تأكيد برمز الأمان (Super Admin BIN)" : "Super Admin Authorization BIN"}</span>
                        </label>
                        <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-100/70 dark:bg-emerald-950/50 px-2 py-0.5 rounded-md">
                          {activePermissionsList.length} {locale === "ar" ? "صلاحيات سيتم تطبيقها" : "permissions to apply"}
                        </span>
                      </div>
                      <p className="text-[11px] text-amber-800/80 dark:text-amber-400">
                        {locale === "ar"
                          ? "أدخل رمز BIN الخاص بك لتأكيد وحفظ الصلاحيات المحددة فوراً في قاعدة البيانات وحساب المشرف."
                          : "Enter your Super Admin BIN to commit these permissions to the authoritative database."}
                      </p>
                      <input
                        ref={binInputRef}
                        type="password"
                        required
                        value={callerBin}
                        onChange={(e) => {
                          setCallerBin(e.target.value);
                          if (error) setError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleSaveAllPermissions();
                          }
                        }}
                        placeholder="••••"
                        maxLength={12}
                        className="w-full px-3.5 py-2 text-xs rounded-xl border border-amber-300 dark:border-amber-800 bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de] focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                      />
                    </div>

                    {/* Actions Footer */}
                    <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-gray-100 dark:border-[#0f302b]">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleCloseModal}
                        disabled={actionLoading}
                        className="text-xs h-9 px-4 font-semibold cursor-pointer"
                      >
                        {locale === "ar" ? "إلغاء" : "Cancel"}
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        onClick={handleSaveAllPermissions}
                        disabled={actionLoading}
                        className="text-xs h-9 px-6 font-bold cursor-pointer bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
                      >
                        {actionLoading
                          ? (locale === "ar" ? "جاري الحفظ والتطبيق..." : "Saving & applying...")
                          : (locale === "ar"
                            ? `حفظ وتطبيق الصلاحيات (${activePermissionsList.length})`
                            : `Save & Apply (${activePermissionsList.length})`)}
                      </Button>
                    </div>
                  </div>
                );
              })()}

            </div>

          </div>
        </div>
      )}

    </div>
  );
};
