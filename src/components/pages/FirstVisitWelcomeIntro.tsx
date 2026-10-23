import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
import { useI18n } from '../../i18n/i18nContext';
import { CustomerAuthScene } from './CustomerAuthScene';
import './first-visit-welcome.css';

const SEEN_KEY = 'cp_customer_welcome_intro_seen_v2';
const NATIVE_SEEN_KEY = 'cp_customer_native_intro_seen_v1';
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

/** Customer APK intro on every app entry; website retains its original one-time behavior. */
export const FirstVisitWelcomeIntro: React.FC<{ enabled: boolean; restartKey?: number }> = ({ enabled, restartKey = 0 }) => {
  const { locale, isRTL } = useI18n();
  const isAr = locale === 'ar';
  const isNative = Capacitor.isNativePlatform();
  const [visible, setVisible] = useState(() => enabled && (isNative || !hasSeenIntro()));
  const [stage, setStage] = useState<IntroStage>('assembling');
  const hasStartedRef = useRef(false);
  const nativeSplashHidden = useRef(false);

  // Keep Android's native launch screen visible until React has painted either
  // the real welcome intro or the requested destination. This removes the
  // WebView's white pre-render frame instead of recoloring that frame.
  useEffect(() => {
    if (!isNative || nativeSplashHidden.current) return;
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (nativeSplashHidden.current) return;
        nativeSplashHidden.current = true;
        void SplashScreen.hide().catch((error) => {
          console.warn('Native launch screen could not be dismissed after first paint.', error);
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [isNative, enabled, visible]);

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      window.dispatchEvent(new Event('cp:customer-intro-complete'));
      return;
    }

    // The public website keeps its original one-time intro. The native customer APK
    // keeps the original full intro on first launch, then shows a 4-second intro
    // on every later launch.
    const isInitialRun = !hasStartedRef.current;
    hasStartedRef.current = true;
    let nativeFirstLaunch = false;
    if (isNative) {
      try {
        nativeFirstLaunch = isInitialRun && window.localStorage.getItem(NATIVE_SEEN_KEY) !== '1';
      } catch {
        nativeFirstLaunch = true;
      }
    } else if (hasSeenIntro()) {
      setVisible(false);
      window.dispatchEvent(new Event('cp:customer-intro-complete'));
      return;
    }

    let welcomeTimer = 0;
    let exitTimer = 0;
    let finishTimer = 0;
    const totalDuration = isNative ? (nativeFirstLaunch ? 10000 : 4000) : 10000;
    const assemblingDuration = isNative ? (nativeFirstLaunch ? 2100 : 650) : 2100;
    const exitDuration = isNative ? (nativeFirstLaunch ? 900 : 600) : 900;
    const exitAt = Math.max(assemblingDuration + 250, totalDuration - exitDuration);

    setVisible(true);
    setStage('assembling');
    welcomeTimer = window.setTimeout(() => setStage('welcome'), assemblingDuration);
    exitTimer = window.setTimeout(() => setStage('exiting'), exitAt);
    finishTimer = window.setTimeout(() => {
      if (isNative) {
        try { window.localStorage.setItem(NATIVE_SEEN_KEY, '1'); } catch {}
      } else {
        rememberIntro();
      }
      setVisible(false);
      window.dispatchEvent(new Event('cp:customer-intro-complete'));
    }, totalDuration);

    return () => {
      window.clearTimeout(welcomeTimer);
      window.clearTimeout(exitTimer);
      window.clearTimeout(finishTimer);
    };
  }, [enabled, isNative, restartKey]);

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
