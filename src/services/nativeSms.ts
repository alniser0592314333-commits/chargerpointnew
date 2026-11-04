import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeSmsResult {
  /** Accepted by Android's SMS service; this is not a carrier delivery receipt. */
  status: 'submitted';
  subscriptionId: number;
  parts: number;
}

interface NativeSmsPlugin {
  sendSms(options: { phone: string; message: string }): Promise<NativeSmsResult>;
}

const NativeSms = registerPlugin<NativeSmsPlugin>('NativeSms');

export const sendSmsUsingSystemDefaultSim = async (
  phone: string,
  message: string
): Promise<NativeSmsResult> => {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    throw new Error('SMS_AVAILABLE_IN_ADMIN_ANDROID_APK_ONLY');
  }

  return NativeSms.sendSms({ phone, message });
};
