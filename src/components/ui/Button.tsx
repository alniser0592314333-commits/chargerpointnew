import React from 'react';
import { cn } from '../../utils/cn';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'destructive' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  className,
  variant = 'primary',
  size = 'md',
  isLoading = false,
  disabled,
  ...props
}) => {
  const baseStyles = 'inline-flex items-center justify-center font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none rounded-xl cursor-pointer backdrop-blur-sm';

  const resolvedVariant = variant === 'destructive' ? 'danger' : variant;

  const variants = {
    primary: 'bg-[#235347] hover:bg-[#163832] text-[#DAF1DE] dark:bg-[#235347] dark:hover:bg-[#163832] dark:text-[#DAF1DE] focus:ring-[#8EB698] shadow-lg shadow-[#051F20]/30 border border-[#8EB698]/20',
    secondary: 'bg-[#163832]/60 hover:bg-[#163832] text-[#DAF1DE] border border-[#8EB698]/20 focus:ring-[#8EB698]',
    danger: 'bg-red-600/90 hover:bg-red-700 text-white focus:ring-red-500 shadow-sm border border-red-500/30',
    outline: 'border border-[#8EB698]/30 hover:bg-[#235347]/20 text-[#051F20] dark:text-[#DAF1DE] focus:ring-[#8EB698]',
    ghost: 'hover:bg-[#235347]/15 text-[#051F20] dark:text-[#DAF1DE] focus:ring-[#8EB698]',
  };

  const sizes = {
    sm: 'text-xs px-3 py-1.5 gap-1.5',
    md: 'text-sm px-4 py-2 gap-2',
    lg: 'text-base px-6 py-3 gap-2.5',
  };

  return (
    <button
      className={cn(baseStyles, variants[resolvedVariant], sizes[size], className)}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading && (
        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-current" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      )}
      {children}
    </button>
  );
};
