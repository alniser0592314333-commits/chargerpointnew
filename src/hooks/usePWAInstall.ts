import { useEffect, useState } from 'react';
import {
  initializePWAInstallCapture,
  promptPWAInstall,
  subscribePWAInstall,
  getPWAInstallState,
} from '../services/pwaInstallService';

export function usePWAInstall() {
  const [state, setState] = useState(() => ({
    installable: false,
    installed: false,
  }));
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    initializePWAInstallCapture();
    setState(getPWAInstallState());
    const userAgent = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(userAgent));

    return subscribePWAInstall(() => {
      setState(getPWAInstallState());
    });
  }, []);

  const install = async () => promptPWAInstall();

  return {
    isInstallable: state.installable,
    isInstalled: state.installed,
    isIOS,
    install,
  };
}
