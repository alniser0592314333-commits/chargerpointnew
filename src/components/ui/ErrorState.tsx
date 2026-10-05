import React from 'react';
import { Button } from './Button';

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  title = 'حدث خطأ ما',
  message,
  onRetry,
  className = '',
}) => {
  return (
    <div className={`flex flex-col items-center justify-center p-8 text-center bg-red-50 dark:bg-red-950/30 rounded-xl border border-red-200 dark:border-red-900 ${className}`}>
      <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center text-red-600 dark:text-red-400 mb-4">
        ⚠️
      </div>
      <h3 className="text-base font-semibold text-red-900 dark:text-red-300 mb-1">{title}</h3>
      <p className="text-sm text-red-600 dark:text-red-400 max-w-md mb-6">{message}</p>
      {onRetry && (
        <Button variant="destructive" size="sm" onClick={onRetry}>
          إعادة المحاولة
        </Button>
      )}
    </div>
  );
};
