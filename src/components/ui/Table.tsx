import React from 'react';

export interface Column<T> {
  header: string;
  accessor: keyof T | ((item: T) => React.ReactNode);
  className?: string;
}

export interface TableProps<T> {
  data: T[];
  columns: Column<T>[];
  keyExtractor: (item: T) => string | number;
  emptyMessage?: string;
  className?: string;
}

export function Table<T>({
  data,
  columns,
  keyExtractor,
  emptyMessage = 'لا توجد بيانات متاحة',
  className = '',
}: TableProps<T>) {
  if (!data || data.length === 0) {
    return (
      <div className={`p-8 text-center text-sm text-[var(--foreground-muted)] glass-subtle rounded-2xl border border-[var(--border-default)] ${className}`}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={`w-full overflow-x-auto rounded-3xl border border-[var(--border-default)] glass-default shadow-xl ${className}`}>
      <table className="w-full text-right rtl:text-right ltr:text-left text-sm text-[var(--foreground)]">
        <thead className="glass-subtle text-xs uppercase text-[var(--foreground-muted)] border-b border-[var(--border-subtle)]">
          <tr>
            {columns.map((col, idx) => (
              <th key={idx} scope="col" className={`px-6 py-3.5 font-semibold ${col.className || ''}`}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-subtle)]">
          {data.map((item) => (
            <tr key={keyExtractor(item)} className="hover:glass-subtle transition-colors">
              {columns.map((col, idx) => {
                const value =
                  typeof col.accessor === 'function'
                    ? col.accessor(item)
                    : (item[col.accessor] as React.ReactNode);
                return (
                  <td key={idx} className={`px-6 py-4 whitespace-nowrap ${col.className || ''}`}>
                    {value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
