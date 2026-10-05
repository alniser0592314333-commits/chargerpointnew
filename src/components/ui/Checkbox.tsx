import React from 'react';

export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className = '', label, id, ...props }, ref) => {
    const inputId = id || (label ? `checkbox-${Math.random().toString(36).substring(2, 7)}` : undefined);

    return (
      <div className="inline-flex items-center gap-2">
        <input
          type="checkbox"
          ref={ref}
          id={inputId}
          className={`h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:ring-offset-gray-900 ${className}`}
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

Checkbox.displayName = 'Checkbox';
