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

  useEffect(() => {
    initializePWAInstallCapture();
    setState(getPWAInstallState());

    return subscribePWAInstall(() => {
      setState(getPWAInstallState());
    });
  }, []);

  const install = async () => promptPWAInstall();

  return {
    isInstallable: state.installable,
    isInstalled: state.installed,
    install,
  };
}
