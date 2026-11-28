export interface OrderSearchResult {
  orderId: string;
  orderNumber: number;
  dayId: string;
  businessDate: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  customerPhone?: string;
  createdAt: string;
  status: string;
  totalMinor: number;
}

type SafeRecord = Record<string, unknown>;

const asRecord = (value: unknown): SafeRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as SafeRecord
    : {};

const nonEmptyString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const validCalendarDate = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
};

/**
 * Convert a possibly legacy/malformed local order row into the stable DTO used
 * by the customer/order search screen. Invalid identity fields are omitted
 * rather than being allowed to crash the entire search result render.
 */
export const projectOrderSearchResult = (
  orderValue: unknown,
  customerValue: unknown,
  dayValue: unknown,
  itemValues: unknown[],
  customerCode: string,
): OrderSearchResult | null => {
  const order = asRecord(orderValue);
  const customer = asRecord(customerValue);
  const day = asRecord(dayValue);

  const orderId = nonEmptyString(order.id);
  const dayId = nonEmptyString(order.dayId);
  const customerId = nonEmptyString(order.customerId);
  const orderNumber = Number(order.displayNumber);

  if (
    !orderId ||
    !dayId ||
    !customerId ||
    !Number.isSafeInteger(orderNumber) ||
    orderNumber < 1
  ) return null;

  const createdAt = nonEmptyString(order.createdAt);
  const businessDate =
    validCalendarDate(day.businessDate) ||
    validCalendarDate(createdAt) ||
    validCalendarDate(dayId.startsWith('day-') ? dayId.slice(4) : '');

  const totalMinor = itemValues.reduce((sum, value) => {
    const item = asRecord(value);
    if (item.orderId !== orderId || item.status === 'cancelled') return sum;
    const amount = Number(item.totalPriceMinor);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);

  return {
    orderId,
    orderNumber,
    dayId,
    businessDate,
    customerId,
    customerName: nonEmptyString(customer.name) || 'عميل غير معروف',
    customerCode: nonEmptyString(customerCode) || '----',
    ...(typeof customer.phone === 'string' && customer.phone.trim()
      ? { customerPhone: customer.phone.trim() }
      : {}),
    createdAt,
    status: nonEmptyString(order.status) || 'unknown',
    totalMinor: Number.isFinite(totalMinor) ? totalMinor : 0,
  };
};
