import React, { useState } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { useToast } from '../ui/Toast';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { 
  Layers, 
  Database, 
  Lock, 
  Globe2, 
  Smartphone, 
  Cpu, 
  CheckCircle2, 
  AlertTriangle,
  Server,
  Workflow,
  Sparkles
} from 'lucide-react';

export const ArchitectureOverview: React.FC = () => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [selectValue, setSelectValue] = useState('v1');

  const layers = [
    {
      icon: <Layers className="w-6 h-6 text-blue-600 dark:text-blue-400" />,
      titleKey: 'layerUiTitle' as const,
      descKey: 'layerUiDesc' as const,
      badge: 'Presentation'
    },
    {
      icon: <Cpu className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />,
      titleKey: 'layerDomainTitle' as const,
      descKey: 'layerDomainDesc' as const,
      badge: 'Domain Core'
    },
    {
      icon: <Workflow className="w-6 h-6 text-purple-600 dark:text-purple-400" />,
      titleKey: 'layerAppTitle' as const,
      descKey: 'layerAppDesc' as const,
      badge: 'Command / Query'
    },
    {
      icon: <Database className="w-6 h-6 text-amber-600 dark:text-amber-400" />,
      titleKey: 'layerDataTitle' as const,
      descKey: 'layerDataDesc' as const,
      badge: 'Offline-First'
    },
    {
      icon: <Lock className="w-6 h-6 text-rose-600 dark:text-rose-400" />,
      titleKey: 'layerAuthTitle' as const,
      descKey: 'layerAuthDesc' as const,
      badge: 'RBAC'
    },
    {
      icon: <Globe2 className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />,
      titleKey: 'layerI18nTitle' as const,
      descKey: 'layerI18nDesc' as const,
      badge: 'AR / EN (RTL)'
    },
    {
      icon: <Sparkles className="w-6 h-6 text-cyan-600 dark:text-cyan-400" />,
      titleKey: 'layerThemeTitle' as const,
      descKey: 'layerThemeDesc' as const,
      badge: 'Design System'
    },
    {
      icon: <Smartphone className="w-6 h-6 text-teal-600 dark:text-teal-400" />,
      titleKey: 'layerResponsiveTitle' as const,
      descKey: 'layerResponsiveDesc' as const,
      badge: 'Adaptive Web/PWA'
    }
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-10">
      {/* Hero Banner */}
      <div className="text-center space-y-4 py-8 bg-gradient-to-b from-blue-50/50 dark:from-blue-950/20 to-transparent rounded-3xl border border-blue-100/50 dark:border-blue-900/30 p-8">
        <Badge variant="primary" size="md">
          <Server className="w-3.5 h-3.5 inline mr-1.5" />
          {t('systemTitle')}
        </Badge>
        <h2 className="text-3xl sm:text-4xl font-extrabold text-gray-900 dark:text-gray-100 tracking-tight">
          {t('subtitle')}
        </h2>
        <p className="max-w-2xl mx-auto text-base text-gray-600 dark:text-gray-400">
          {t('noBusinessDataNotice')}
        </p>
      </div>

      {/* Status Indicators */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="flex items-center gap-4 border-l-4 border-l-emerald-500">
          <div className="p-3 bg-emerald-50 dark:bg-emerald-950/50 rounded-xl">
            <CheckCircle2 className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Supabase & Backend</p>
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{t('supabaseStatus')}</p>
          </div>
        </Card>

        <Card className="flex items-center gap-4 border-l-4 border-l-blue-500">
          <div className="p-3 bg-blue-50 dark:bg-blue-950/50 rounded-xl">
            <Database className="w-6 h-6 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Offline Sync Engine</p>
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{t('offlineStatus')}</p>
          </div>
        </Card>

        <Card className="flex items-center gap-4 border-l-4 border-l-purple-500">
          <div className="p-3 bg-purple-50 dark:bg-purple-950/50 rounded-xl">
            <Lock className="w-6 h-6 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Type Security</p>
            <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{t('strictTypesStatus')}</p>
          </div>
        </Card>
      </div>

      {/* Architecture Layers Grid */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {t('architectureLayers')}
          </h3>
          <Badge variant="neutral">Modular Architecture</Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {layers.map((layer, idx) => (
            <Card key={idx} variant="default" className="flex flex-col justify-between hover:shadow-md transition-shadow">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="p-2.5 bg-gray-50 dark:bg-gray-800 rounded-xl">
                    {layer.icon}
                  </div>
                  <Badge variant="neutral" size="sm">{layer.badge}</Badge>
                </div>
                <h4 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  {t(layer.titleKey)}
                </h4>
                <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                  {t(layer.descKey)}
                </p>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Shared UI Components Preview Test Bench */}
      <div className="space-y-6 pt-6 border-t border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {t('componentsPreview')}
          </h3>
          <Badge variant="success">Accessible & Theme-Aware</Badge>
        </div>

        <Card className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Buttons & Badges</h4>
              <div className="flex flex-wrap gap-3">
                <Button variant="primary" onClick={() => showToast('Primary button clicked successfully!', 'success')}>
                  {t('btnPrimary')}
                </Button>
                <Button variant="secondary" onClick={() => showToast('Secondary action triggered.', 'info')}>
                  {t('btnSecondary')}
                </Button>
                <Button variant="danger" onClick={() => showToast('Danger action warning!', 'error')}>
                  {t('btnDanger')}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="primary">Primary</Badge>
                <Badge variant="success">Success</Badge>
                <Badge variant="warning">Warning</Badge>
                <Badge variant="danger">Danger</Badge>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Form Inputs & Select</h4>
              <Input
                label="Sample Input"
                placeholder={t('inputPlaceholder')}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                helperText="Type to test input component"
              />
              <Select
                label={t('selectLabel')}
                options={[
                  { label: 'Version 1.0 (Foundation)', value: 'v1' },
                  { label: 'Version 2.0 (Domain)', value: 'v2' },
                ]}
                value={selectValue}
                onChange={(e) => setSelectValue(e.target.value)}
              />
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Modals & Dialogs</h4>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Test the accessible modal foundation with keyboard navigation (Esc to close).
              </p>
              <Button variant="outline" onClick={() => setIsModalOpen(true)}>
                {t('openModal')}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* Sample Modal */}
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={t('modalTitle')}>
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            This modal is part of the shared UI foundation. It fully supports RTL layout, dark mode, click-outside and Esc key closing.
          </p>
          <div className="flex justify-end gap-3 pt-4 border-t border-gray-100 dark:border-gray-800">
            <Button variant="outline" onClick={() => setIsModalOpen(false)}>
              {t('cancel')}
            </Button>
            <Button variant="primary" onClick={() => { setIsModalOpen(false); showToast('Modal action saved.', 'success'); }}>
              {t('save')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
