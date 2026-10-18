import React, { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/i18nContext';
import { CustomerAuthScene } from './CustomerAuthScene';
import './first-visit-welcome.css';

const SEEN_KEY = 'cp_customer_welcome_intro_seen_v1';
type IntroStage = 'assembling' | 'welcome' | 'exiting';

const hasSeenIntro = () => {
  try {
    if (window.localStorage.getItem(SEEN_KEY) === '1') return true;
  } catch {}
  try {
    return window.sessionStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
};

const rememberIntro = () => {
  try { window.localStorage.setItem(SEEN_KEY, '1'); } catch {
    try { window.sessionStorage.setItem(SEEN_KEY, '1'); } catch {}
  }
};

/** A one-time, decorative welcome for the customer-facing portal only. */
export const FirstVisitWelcomeIntro: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { locale, isRTL } = useI18n();
  const isAr = locale === 'ar';
  const [visible, setVisible] = useState(() => enabled && !hasSeenIntro());
  const [stage, setStage] = useState<IntroStage>('assembling');

  useEffect(() => {
    if (!enabled || hasSeenIntro()) {
      setVisible(false);
      return;
    }

    let welcomeTimer = 0;
    let exitTimer = 0;
    let finishTimer = 0;
    let reducedMotion = false;
    try {
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {}

    setVisible(true);
    setStage(reducedMotion ? 'welcome' : 'assembling');

    if (reducedMotion) {
      welcomeTimer = window.setTimeout(() => setStage('exiting'), 1450);
      finishTimer = window.setTimeout(() => {
        rememberIntro();
        setVisible(false);
      }, 1750);
    } else {
      welcomeTimer = window.setTimeout(() => setStage('welcome'), 1900);
      exitTimer = window.setTimeout(() => setStage('exiting'), 3650);
      finishTimer = window.setTimeout(() => {
        rememberIntro();
        setVisible(false);
      }, 4850);
    }

    return () => {
      window.clearTimeout(welcomeTimer);
      window.clearTimeout(exitTimer);
      window.clearTimeout(finishTimer);
    };
  }, [enabled]);

  if (!enabled || !visible) return null;

  return (
    <div
      className="cp-welcome-intro"
      data-stage={stage}
      dir={isRTL ? 'rtl' : 'ltr'}
      role="status"
      aria-live="polite"
    >
      <div className="cp-welcome-intro__scene">
        <CustomerAuthScene uid="cp-first-visit-welcome" className="cp-welcome-intro__art" />
      </div>
      <div className="cp-welcome-intro__copy">
        <span className="cp-welcome-intro__eyebrow">{isAr ? 'نقطة الشحن' : 'CHARGING POINT'}</span>
        <h1>{isAr ? 'أهلًا بك في نقطة الشحن' : 'Welcome to Charging Point'}</h1>
        <p>
          {isAr
            ? 'خلّينا متابعة طلبك وتفاصيله وإشعار الدفع أسهل وأوضح.'
            : 'Follow your order, see its details, and send payment updates more easily.'}
        </p>
        <span className="cp-welcome-intro__rule" />
      </div>
      <span className="cp-welcome-intro__edge-light cp-welcome-intro__edge-light--one" />
      <span className="cp-welcome-intro__edge-light cp-welcome-intro__edge-light--two" />
    </div>
  );
};
