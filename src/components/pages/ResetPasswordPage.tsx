import React, { useState } from 'react';
import { supabaseUpdatePassword } from '../../services/supabase/client';
import { Button } from '../ui/Button';
import { useI18n } from '../../i18n/i18nContext';

export const ResetPasswordPage = ({ onNavigate }: { onNavigate: (path: string) => void }) => {
    const { locale } = useI18n();
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleReset = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        if (password !== confirmPassword) {
            setError(locale === 'en' ? 'Passwords do not match' : 'كلمات المرور غير متطابقة');
            return;
        }
        if (password.length < 6) {
            setError(locale === 'en' ? 'Password too short' : 'كلمة المرور قصيرة جداً');
            return;
        }
        setLoading(true);
        const { error } = await supabaseUpdatePassword(password);
        if (error) {
            setError(error);
            setLoading(false);
        } else {
            onNavigate('/login');
        }
    };

    return (
        <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-950 p-4">
            <div className="w-full max-w-md p-6 bg-white dark:bg-[#0b2924] border border-gray-200 dark:border-[#14423b] rounded-2xl shadow-xl">
                <h1 className="text-lg font-extrabold text-center mb-6 text-gray-900 dark:text-[#daf1de]">
                    {locale === 'en' ? 'Reset Password' : 'إعادة تعيين كلمة المرور'}
                </h1>
                {error && (
                    <div className="p-3 mb-4 text-xs text-rose-700 dark:text-red-300 bg-rose-50 dark:bg-red-950/40 border border-rose-200 dark:border-red-800/50 rounded-xl">
                        {error}
                    </div>
                )}
                <form onSubmit={handleReset} className="space-y-4">
                    <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de]">
                            {locale === 'en' ? 'New Password' : 'كلمة المرور الجديدة'}
                        </label>
                        <input
                            type="password"
                            className="w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 px-3 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </div>
                    <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-gray-700 dark:text-[#daf1de]">
                            {locale === 'en' ? 'Confirm Password' : 'تأكيد كلمة المرور'}
                        </label>
                        <input
                            type="password"
                            className="w-full text-xs bg-gray-50 dark:bg-[#06201c] border border-gray-200 dark:border-[#14423b] rounded-xl py-2.5 px-3 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            required
                        />
                    </div>
                    <Button type="submit" variant="primary" className="w-full text-xs py-2.5 rounded-xl font-bold bg-emerald-600 hover:bg-emerald-700 text-white" disabled={loading}>
                        {loading ? (locale === 'en' ? 'Saving...' : 'جاري الحفظ...') : (locale === 'en' ? 'Save Password' : 'حفظ كلمة المرور')}
                    </Button>
                </form>
            </div>
        </div>
    );
};
