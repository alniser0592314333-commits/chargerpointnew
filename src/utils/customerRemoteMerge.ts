import type { CustomerEntity } from '../domain/models';

type CustomerRemotePayload = Record<string, unknown>;

/**
 * Customer UPDATE change-log entries are patches, not full customer snapshots.
 * Merge only fields actually present so a protected-field update (for example,
 * chargerFeeExempt) cannot erase the customer's name or reset other profile data.
 */
export const mergeCustomerRemoteDelta = (
  prior: CustomerEntity | undefined,
  payload: CustomerRemotePayload,
  entityId: string,
  changeVersion?: number,
  changeTimestamp?: string
): CustomerEntity => {
  const has = (key: string, snakeKey?: string): boolean =>
    Object.prototype.hasOwnProperty.call(payload, key) ||
    (!!snakeKey && Object.prototype.hasOwnProperty.call(payload, snakeKey));
  const read = (key: string, snakeKey?: string): unknown =>
    payload[key] !== undefined ? payload[key] : snakeKey ? payload[snakeKey] : undefined;

  const phoneValue = read('phone');
  const notesValue = read('notes');
  const deletedAtValue = read('deletedAt', 'deleted_at');

  return {
    id: String(read('id') ?? prior?.id ?? entityId),
    name: String(read('name') ?? prior?.name ?? ''),
    phone: has('phone') ? (phoneValue == null ? '' : String(phoneValue)) : (prior?.phone || ''),
    status: (read('status') ?? prior?.status) as CustomerEntity['status'],
    isActive: Boolean(read('isActive', 'is_active') ?? prior?.isActive ?? true),
    notes: has('notes') ? (notesValue == null ? undefined : String(notesValue)) : prior?.notes,
    debtLimitMinor: Number(read('debtLimitMinor', 'debt_limit_minor') ?? prior?.debtLimitMinor ?? 0),
    chargerFeeExempt: Boolean(read('chargerFeeExempt', 'charger_fee_exempt') ?? prior?.chargerFeeExempt ?? false),
    createdAt: String(read('createdAt', 'created_at') ?? prior?.createdAt ?? new Date().toISOString()),
    updatedAt: String(read('updatedAt', 'updated_at') ?? changeTimestamp ?? prior?.updatedAt ?? new Date().toISOString()),
    version: Number(changeVersion ?? read('version') ?? prior?.version ?? 1),
    deletedAt: deletedAtValue === undefined ? prior?.deletedAt : (deletedAtValue == null ? undefined : String(deletedAtValue)),
  };
};
