import React from 'react';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', error, value, ...props }, ref) => {
    const hasValueProp = 'value' in props || value !== undefined;
    const valueProps = hasValueProp ? { value: value ?? '' } : {};

    return (
      <textarea
        ref={ref}
        className={`w-full rounded-lg border px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-gray-400 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-900 dark:text-gray-100 ${
          error
            ? 'border-red-500 focus:border-red-500 focus:ring-red-500 dark:border-red-500'
            : 'border-gray-300 focus:border-indigo-500 focus:ring-indigo-500 dark:border-gray-700'
        } ${className}`}
        {...props}
        {...valueProps}
      />
    );
  }
);

Textarea.displayName = 'Textarea';
