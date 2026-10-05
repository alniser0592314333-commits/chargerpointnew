import React from 'react';

export interface DividerProps {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  label?: string;
}

export const Divider: React.FC<DividerProps> = ({ orientation = 'horizontal', className = '', label }) => {
  if (orientation === 'vertical') {
    return <div className={`inline-block h-full w-[1px] bg-gray-200 dark:bg-gray-800 self-stretch ${className}`} />;
  }

  if (label) {
    return (
      <div className={`relative flex py-2 items-center ${className}`}>
        <div className="flex-grow border-t border-gray-200 dark:border-gray-800" />
        <span className="flex-shrink mx-4 text-xs text-gray-500 dark:text-gray-400 font-medium">{label}</span>
        <div className="flex-grow border-t border-gray-200 dark:border-gray-800" />
      </div>
    );
  }

  return <hr className={`border-t border-gray-200 dark:border-gray-800 my-4 ${className}`} />;
};
