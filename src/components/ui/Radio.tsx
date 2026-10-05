import React from 'react';

export interface RadioProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Radio = React.forwardRef<HTMLInputElement, RadioProps>(
  ({ className = '', label, id, ...props }, ref) => {
    const inputId = id || (label ? `radio-${Math.random().toString(36).substring(2, 7)}` : undefined);

    return (
      <div className="inline-flex items-center gap-2">
        <input
          type="radio"
          ref={ref}
          id={inputId}
          className={`h-4 w-4 border-gray-300 text-indigo-600 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 ${className}`}
          {...props}
        />
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer select-none">
            {label}
          </label>
        )}
      </div>
    );
  }
);

Radio.displayName = 'Radio';
