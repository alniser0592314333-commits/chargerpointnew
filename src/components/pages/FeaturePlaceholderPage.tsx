import React from 'react';
import { Button } from '../ui/Button';
import { ArrowRight, ArrowLeft } from 'lucide-react';
import { useI18n } from '../../i18n/i18nContext';

export interface FeaturePlaceholderPageProps {
  title: string;
  targetId: string;
  description: string;
  onBack: () => void;
}

export const FeaturePlaceholderPage: React.FC<FeaturePlaceholderPageProps> = ({
  title,
  targetId,
  description,
  onBack,
}) => {
  const { locale } = useI18n();

  return (
    <div className="max-w-3xl mx-auto py-6 px-4 sm:px-6 space-y-6 text-gray-900 dark:text-gray-100">
      <div className="flex items-center gap-3 pb-4 border-b border-gray-200 dark:border-gray-800">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 text-gray-600 dark:text-gray-300">
          {locale === 'ar' ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
          <span>رجوع</span>
        </Button>
      </div>

      <div className="p-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 space-y-3">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
        <p className="text-xs font-mono text-emerald-600 dark:text-emerald-400">Target ID: {targetId}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{description}</p>
      </div>
    </div>
  );
};
