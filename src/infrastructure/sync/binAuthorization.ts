type BinRequiredOutboxItem = {
  commandType: string;
  payload?: unknown;
  lastError?: string;
};

/** True when an outbox financial/security command must be authorized with a fresh BIN. */
export const isBinRequiredOutboxCommand = (item: BinRequiredOutboxItem): boolean => {
  const binCommands = new Set([
    'DELIVER_ORDER_ITEM',
    'CANCEL_ORDER',
    'CANCEL_ORDER_ITEM',
    'CREATE_CUSTOMER_CREDIT',
    'CREATE_PAYMENT',
  ]);
  if (!binCommands.has(item.commandType)) return false;

  const payload = (item.payload || {}) as Record<string, unknown>;
  const bin = String(payload.bin || '').trim();
  if (bin.length >= 4 && payload.deferBinVerification !== true) return false;

  // CREATE_PAYMENT is never valid without a BIN, including legacy outbox
  // records created before deferred authorization was explicitly marked.
  if (item.commandType === 'CREATE_PAYMENT' && bin.length < 4) return true;

  const error = String(item.lastError || '');
  return (
    payload.deferBinVerification === true ||
    error === 'BIN_REQUIRED' ||
    /BIN is required/i.test(error) ||
    /Authorization required:\\s*BIN/i.test(error)
  );
};


const AUTHORIZATION_SECRET_KEYS = [
  'bin',
  'adminBin',
  'admin_bin',
  'BIN',
  'ADMIN_BIN',
  'AdminBin',
  'deferBinVerification',
  'offlinePendingApproval',
] as const;

/**
 * Remove credentials and local-only approval flags from a command once it no
 * longer needs them. Pending transport failures keep their BIN for retry;
 * accepted or authorization-rejected commands do not.
 */
export function redactAuthorizationSecretsFromPayload(payload: unknown): Record<string, unknown> {
  const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>) }
    : {};
  for (const key of AUTHORIZATION_SECRET_KEYS) delete safePayload[key];
  return safePayload;
}
