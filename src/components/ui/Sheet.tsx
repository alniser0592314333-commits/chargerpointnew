import React from 'react';
import { IconButton } from './IconButton';

export interface SheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  position?: 'right' | 'left';
  children: React.ReactNode;
}

export const Sheet: React.FC<SheetProps> = ({
  isOpen,
  onClose,
  title,
  position = 'right',
  children,
}) => {
  if (!isOpen) return null;

  const positionClasses = {
    right: 'right-0 top-0 h-full w-80 max-w-full border-s',
    left: 'left-0 top-0 h-full w-80 max-w-full border-e',
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-xs transition-opacity" onClick={onClose} />
      <div
        className={`relative z-50 flex flex-col bg-white dark:bg-gray-900 shadow-2xl transition-transform duration-300 ${positionClasses[position]} border-gray-200 dark:border-gray-800`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          {title && <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>}
          <IconButton label="إغلاق" onClick={onClose} size="sm">
            ✕
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </div>
    </div>
  );
};
