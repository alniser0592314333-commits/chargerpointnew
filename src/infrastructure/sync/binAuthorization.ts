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

  const error = String(item.lastError || '');
  return (
    payload.deferBinVerification === true ||
    error === 'BIN_REQUIRED' ||
    /BIN is required/i.test(error) ||
    /Authorization required:\\s*BIN/i.test(error)
  );
};
