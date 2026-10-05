import React from 'react';
import { cn } from '../../utils/cn';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'bordered' | 'elevated';
}

export const Card: React.FC<CardProps> = ({
  children,
  className,
  variant = 'default',
  ...props
}) => {
  const variants = {
    default: 'glass-default rounded-3xl p-6 text-[var(--foreground)]',
    bordered: 'glass-subtle border border-[var(--border-default)] rounded-3xl p-6 shadow-md',
    elevated: 'glass-elevated rounded-3xl p-6 shadow-2xl',
  };

  return (
    <div className={cn('transition-all duration-300 hover:border-[var(--border-highlight)]', variants[variant], className)} {...props}>
      {children}
    </div>
  );
};
