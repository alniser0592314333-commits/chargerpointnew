import { useEffect, useState } from 'react';
import {
  initializePWAInstallCapture,
  promptPWAInstall,
  usePWAInstallSnapshot,
} from '../services/pwaInstallService';

export function usePWAInstall() {
  const { installable, installed } = usePWAInstallSnapshot();
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    initializePWAInstallCapture();

    const userAgent = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(userAgent));
  }, []);

  const install = async () => {
    return promptPWAInstall();
  };

  return {
    isInstallable: installable,
    isInstalled: installed,
    isIOS,
    install,
  };
}
