/**
 * Design System & Responsive Playground (Development & QA View)
 */

import React, { useState } from 'react';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Input } from '../ui/Input';
import { Textarea } from '../ui/Textarea';
import { Checkbox } from '../ui/Checkbox';
import { Switch } from '../ui/Switch';
import { FormField } from '../ui/FormField';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { StatusBadge } from '../ui/StatusBadge';
import { Divider } from '../ui/Divider';
import { Tabs } from '../ui/Tabs';
import { Breadcrumb } from '../ui/Breadcrumb';
import { Pagination } from '../ui/Pagination';
import { Table } from '../ui/Table';
import { Dropdown } from '../ui/Dropdown';
import { EmptyState } from '../ui/EmptyState';
import { LoadingState } from '../ui/LoadingState';
import { ErrorState } from '../ui/ErrorState';
import { Skeleton } from '../ui/Skeleton';
import { Alert } from '../ui/Alert';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { Modal } from '../ui/Modal';
import { Sheet } from '../ui/Sheet';
import { useTheme } from '../../theme/themeContext';
import { useI18n } from '../../i18n/i18nContext';

export const DesignSystemPlayground: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  const { locale, setLocale } = useI18n();

  const [activeTab, setActiveTab] = useState('primitives');
  const [switchChecked, setSwitchChecked] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const sampleTableData = [
    { id: 1, name: 'أحمد محمد', role: 'مشرف', status: 'active' },
    { id: 2, name: 'سارة خالد', role: 'محاسب', status: 'active' },
    { id: 3, name: 'محمد علي', role: 'مشغل', status: 'inactive' },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      {/* Playground Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-gray-900 p-6 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            مختبر نظام التصميم والاستجابة (Design System Playground)
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            بيئة تفاعلية لاختبار المكونات المرئية، السمات، والاتجاهات (RTL/LTR).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={toggleTheme}>
            السمة: {theme === 'dark' ? 'داكن 🌙' : 'فاتح ☀️'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>
            اللغة: {locale === 'ar' ? 'العربية (AR)' : 'English (EN)'}
          </Button>
        </div>
      </div>

      <Breadcrumb
        items={[
          { label: 'الرئيسية', href: '#' },
          { label: 'نظام التصميم', href: '#' },
          { label: 'المكونات التفاعلية' },
        ]}
      />

      <Tabs
        tabs={[
          { id: 'primitives', label: 'المكونات الأساسية', badge: '14' },
          { id: 'feedback', label: 'الحالات والتنبيهات', badge: '6' },
          { id: 'overlays', label: 'النوافذ المنبثقة', badge: '3' },
        ]}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      {/* Tab 1: Primitives */}
      {activeTab === 'primitives' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Buttons Card */}
            <Card>
              <h3 className="font-semibold text-base mb-4 text-gray-900 dark:text-gray-100">الأزرار (Buttons)</h3>
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary">رئيسي</Button>
                  <Button variant="secondary">ثانوي</Button>
                  <Button variant="outline">إطار</Button>
                  <Button variant="ghost">شفاف</Button>
                  <Button variant="danger">حذف</Button>
                </div>
                <div className="flex items-center gap-2 pt-2">
                  <IconButton label="بحث">🔍</IconButton>
                  <IconButton label="إعدادات" variant="secondary">⚙️</IconButton>
                  <IconButton label="حذف" variant="danger">🗑️</IconButton>
                  <Dropdown
                    trigger={<Button variant="outline" size="sm">القائمة المنسدلة ▼</Button>}
                    items={[
                      { id: '1', label: 'تعديل', onClick: () => {} },
                      { id: '2', label: 'حذف', destructive: true, onClick: () => {} },
                    ]}
                  />
                </div>
              </div>
            </Card>

            {/* Form Controls Card */}
            <Card>
              <h3 className="font-semibold text-base mb-4 text-gray-900 dark:text-gray-100">حقول الإدخال (Form Inputs)</h3>
              <div className="space-y-4">
                <FormField label="الاسم الكامل" required helperText="أدخل اسم الزبون هنا">
                  <Input placeholder="مثال: أحمد محمد" />
                </FormField>
                <FormField label="الملاحظات">
                  <Textarea placeholder="اكتب ملاحظات إضافية..." rows={2} />
                </FormField>
                <div className="flex items-center justify-between pt-2">
                  <Checkbox label="تفعيل الشاحن" defaultChecked />
                  <Switch checked={switchChecked} onCheckedChange={setSwitchChecked} label="نشط" />
                </div>
              </div>
            </Card>

            {/* Badges & Statuses */}
            <Card>
              <h3 className="font-semibold text-base mb-4 text-gray-900 dark:text-gray-100">الشارات والحالات (Badges & Statuses)</h3>
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="primary">أساسي</Badge>
                  <Badge variant="neutral">ثانوي</Badge>
                  <Badge variant="success">نجاح</Badge>
                  <Badge variant="warning">تحذير</Badge>
                  <Badge variant="danger">خطأ</Badge>
                </div>
                <Divider label="حالات الطلبات والأجهزة" />
                <div className="flex flex-wrap gap-2">
                  <StatusBadge status="pending" />
                  <StatusBadge status="charging" />
                  <StatusBadge status="delivered" />
                  <StatusBadge status="paid" />
                  <StatusBadge status="partially_paid" />
                  <StatusBadge status="unpaid" />
                </div>
              </div>
            </Card>
          </div>

          {/* Table Section */}
          <Card>
            <h3 className="font-semibold text-base mb-4 text-gray-900 dark:text-gray-100">الجداول المتجاوبة (Responsive Table)</h3>
            <Table
              data={sampleTableData}
              keyExtractor={(item) => item.id}
              columns={[
                { header: 'المعرف', accessor: 'id' },
                { header: 'الاسم', accessor: 'name' },
                { header: 'الدور', accessor: 'role' },
                {
                  header: 'الحالة',
                  accessor: (item) => (
                    <StatusBadge status={item.status === 'active' ? 'active' : 'inactive'} />
                  ),
                },
              ]}
            />
          </Card>
        </div>
      )}

      {/* Tab 2: Feedback */}
      {activeTab === 'feedback' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Alert variant="info" title="معلومة هامة">
              هذه رسالة تنبيهية توضيحية لضمان تجربة مستخدم سلسة وهادئة.
            </Alert>
            <Alert variant="success" title="تم بنجاح">
              تم حفظ التغييرات والعملية المالية بنجاح تام داخل معاملة الخادم.
            </Alert>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <EmptyState title="لا توجد بيانات" description="ابدأ بإضافة أول عنصر لعرضه هنا." />
            <LoadingState message="جاري مزامنة البيانات مع الخادم..." />
            <ErrorState message="تعذر الاتصال بالخادم، يرجى المحاولة لاحقاً." onRetry={() => {}} />
          </div>

          <Card>
            <h3 className="font-semibold text-base mb-4 text-gray-900 dark:text-gray-100">هياكل التحميل الهيكلية (Skeletons)</h3>
            <div className="space-y-3">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-20 w-full" />
            </div>
          </Card>
        </div>
      )}

      {/* Tab 3: Overlays */}
      {activeTab === 'overlays' && (
        <Card>
          <h3 className="font-semibold text-base mb-4 text-gray-900 dark:text-gray-100">النوافذ واللوحات الجانبية (Modals & Sheets)</h3>
          <div className="flex flex-wrap gap-4">
            <Button onClick={() => setIsModalOpen(true)}>فتح نافذة منبثقة (Modal)</Button>
            <Button variant="secondary" onClick={() => setIsSheetOpen(true)}>فتح لوحة جانبية (Sheet)</Button>
            <Button variant="danger" onClick={() => setIsConfirmOpen(true)}>نافذة تأكيد (Confirmation)</Button>
          </div>
        </Card>
      )}

      <Pagination currentPage={currentPage} totalPages={5} onPageChange={setCurrentPage} />

      {/* Overlays Components */}
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="نافذة منبثقة تجريبية">
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
          هذه نافذة نموذجية تضمن إمكانية الإغلاق، التمرير، وعدم حجب المحتوى على جميع الشاشات.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setIsModalOpen(false)}>إغلاق</Button>
          <Button onClick={() => setIsModalOpen(false)}>موافق</Button>
        </div>
      </Modal>

      <Sheet isOpen={isSheetOpen} onClose={() => setIsSheetOpen(false)} title="لوحة جانبية تفاعلية">
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">محتوى اللوحة الجانبية (Sheet) القابل للتمرير.</p>
          <Button onClick={() => setIsSheetOpen(false)}>إغلاق اللوحة</Button>
        </div>
      </Sheet>

      <ConfirmationDialog
        isOpen={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        onConfirm={() => alert('تم التأكيد')}
        title="تأكيد العملية الحساسة"
        message="هل أنت متأكد من رغبتك في تنفيذ هذه العملية؟ لا يمكن التراجع عنها."
        variant="destructive"
        confirmText="تأكيد وحذف"
      />
    </div>
  );
};

