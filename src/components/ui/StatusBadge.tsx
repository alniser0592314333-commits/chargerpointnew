import React from 'react';

export type StatusType =
  | 'pending'
  | 'charging'
  | 'delivered'
  | 'cancelled'
  | 'paid'
  | 'partially_paid'
  | 'unpaid'
  | 'active'
  | 'inactive'
  | 'completed'
  | 'failed'
  | 'approved'
  | 'rejected';

export interface StatusBadgeProps {
  status: StatusType;
  label?: string;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, label, className = '' }) => {
  const statusStyles: Record<StatusType, string> = {
    pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-300 dark:border-amber-800',
    charging: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 border-blue-300 dark:border-blue-800',
    delivered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800',
    cancelled: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300 border-gray-300 dark:border-gray-700',
    paid: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800',
    partially_paid: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-300 border-cyan-300 dark:border-cyan-800',
    unpaid: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border-rose-300 dark:border-rose-800',
    active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800',
    inactive: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300 border-gray-300 dark:border-gray-700',
    completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800',
    failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300 border-red-300 dark:border-red-800',
    approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800',
    rejected: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300 border-red-300 dark:border-red-800',
  };

  const defaultLabels: Record<StatusType, string> = {
    pending: 'معلق',
    charging: 'قيد الشحن',
    delivered: 'تم التسليم',
    cancelled: 'ملغي',
    paid: 'مدفوع',
    partially_paid: 'مدفوع جزئياً',
    unpaid: 'غير مدفوع',
    active: 'نشط',
    inactive: 'غير نشط',
    completed: 'مكتمل',
    failed: 'فشل',
    approved: 'مقبول',
    rejected: 'مرفوض',
  };

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${statusStyles[status] || statusStyles.pending} ${className}`}
    >
      {label || defaultLabels[status] || status}
    </span>
  );
};
