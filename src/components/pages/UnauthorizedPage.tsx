import React from 'react';

export const UnauthorizedPage: React.FC = () => {
  return (
    <div className="p-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 space-y-2">
      <h1 className="text-xl font-bold text-red-500">غير مصرح (403)</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400">Phase 6 UI Reset Placeholder</p>
    </div>
  );
};
