import React from 'react';
import { cn } from '../../utils/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, helperText, id, value, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
    const hasValueProp = 'value' in props || value !== undefined;
    const valueProps = hasValueProp ? { value: value ?? '' } : {};

    return (
      <div className="w-full space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-xs font-semibold text-gray-800 dark:text-[#8eb698]">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            'w-full px-3.5 py-2.5 text-sm rounded-xl transition-all duration-200',
            'bg-white dark:bg-[#061f1c] text-gray-900 dark:text-[#daf1de]',
            'placeholder:text-gray-400 dark:placeholder:text-[#5e8674]',
            'border border-gray-300 dark:border-[#14423b]',
            'focus:outline-none focus:ring-2 focus:ring-[#235347]/20 focus:border-[#235347] dark:focus:border-[#8eb698]',
            'disabled:bg-gray-100 dark:disabled:bg-[#041a18] disabled:text-gray-500 dark:disabled:text-[#5e8674] disabled:cursor-not-allowed',
            error ? 'border-red-500 focus:ring-red-500 focus:border-red-500 dark:border-[#e07a7a]' : '',
            className
          )}
          {...props}
          {...valueProps}
        />
        {error && <p className="text-xs text-red-500 dark:text-[#e07a7a] mt-1">{error}</p>}
        {helperText && !error && <p className="text-xs text-gray-500 dark:text-[#8eb698] mt-1">{helperText}</p>}
      </div>
    );
  }
);

Input.displayName = 'Input';
