import React from 'react';
import { cn } from '../../utils/cn';

export interface SelectOption {
  label: string;
  value: string | number;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: SelectOption[];
  error?: string;
  helperText?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, options, error, helperText, id, value, ...props }, ref) => {
    const selectId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
    const hasValueProp = 'value' in props || value !== undefined;
    const valueProps = hasValueProp ? { value: value ?? '' } : {};

    return (
      <div className="w-full space-y-1.5">
        {label && (
          <label htmlFor={selectId} className="block text-sm font-medium text-gray-700 dark:text-[#8eb698]">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={cn(
            'w-full px-3.5 py-2 text-sm bg-white dark:bg-[#061f1c] border rounded-lg shadow-sm transition-colors',
            'text-gray-900 dark:text-[#daf1de]',
            'focus:outline-none focus:ring-2 focus:ring-[#235347] focus:border-[#235347] dark:focus:border-[#8eb698]',
            error
              ? 'border-red-500 focus:ring-red-500 focus:border-red-500 dark:border-[#e07a7a]'
              : 'border-gray-300 dark:border-[#14423b]',
            className
          )}
          {...props}
          {...valueProps}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} className="bg-white dark:bg-[#0a2f29] text-gray-900 dark:text-[#daf1de]">
              {option.label}
            </option>
          ))}
        </select>
        {error && <p className="text-xs text-red-600 dark:text-[#e07a7a]">{error}</p>}
        {helperText && !error && <p className="text-xs text-gray-500 dark:text-[#8eb698]">{helperText}</p>}
      </div>
    );
  }
);

Select.displayName = 'Select';
