/**
 * Presentation-only projection for customer financial history.
 *
 * Financial recognition remains item-level in the canonical ledger. This helper
 * groups those immutable charge events by order for the customer-facing summary,
 * while retaining the aggregate amount, final post-event balance, and item details.
 * It must never be used to persist or mutate ledger events.
 */
export interface CustomerFinancialHistoryDisplayItem {
  id: string;
  eventType: string;
  amountMinor: number;
  postBalanceMinor: number;
  createdAt: string;
  orderId?: string;
  orderDisplayNumber?: number;
  description: string;
  shortTitle: string;
  note?: string;
  orderItems?: Array<{
    id: string;
    deviceName: string;
    priceMinor: number;
    hasCharger: boolean;
  }>;
  orderTotalMinor?: number;
}

export function groupCustomerFinancialHistoryByOrder(
  history: CustomerFinancialHistoryDisplayItem[],
  locale: 'ar' | 'en' = 'ar'
): CustomerFinancialHistoryDisplayItem[] {
  const ordinaryRows: CustomerFinancialHistoryDisplayItem[] = [];
  const chargesByOrder = new Map<string, CustomerFinancialHistoryDisplayItem[]>();

  for (const row of history) {
    if (row.eventType !== 'ORDER_ITEM_CHARGE' || !row.orderId) {
      ordinaryRows.push(row);
      continue;
    }

    const existing = chargesByOrder.get(row.orderId);
    if (existing) existing.push(row);
    else chargesByOrder.set(row.orderId, [row]);
  }

  const groupedRows: CustomerFinancialHistoryDisplayItem[] = [...ordinaryRows];

  for (const [orderId, charges] of chargesByOrder) {
    if (charges.length === 1) {
      const single = charges[0];
      groupedRows.push({
        ...single,
        id: `order-charge-${orderId}`,
        shortTitle: locale === 'ar' ? 'خصم إجمالي الطلب' : 'Total order deduction',
        description: locale === 'ar'
          ? (single.orderDisplayNumber
              ? `خصم إجمالي الطلب رقم #${single.orderDisplayNumber}`
              : 'خصم إجمالي الطلب من رصيد العميل')
          : (single.orderDisplayNumber
              ? `Total charge for order #${single.orderDisplayNumber}`
              : 'Total order charge from customer balance'),
      });
      continue;
    }

    // The final charge row carries the post-balance after all recognized items
    // in this order have been applied. Keep that timestamp/balance for the summary.
    const finalCharge = charges.reduce((latest, row) =>
      new Date(row.createdAt).getTime() >= new Date(latest.createdAt).getTime() ? row : latest
    );
    const seenItemIds = new Set<string>();
    const orderItems = charges.flatMap(row => row.orderItems || []).filter(item => {
      if (seenItemIds.has(item.id)) return false;
      seenItemIds.add(item.id);
      return true;
    });
    const amountMinor = charges.reduce((sum, row) => sum + row.amountMinor, 0);
    const fallbackOrderTotal = charges.reduce((sum, row) => sum + (row.orderTotalMinor ?? 0), 0);
    const orderTotalMinor = orderItems.length > 0
      ? orderItems.reduce((sum, item) => sum + item.priceMinor, 0)
      : fallbackOrderTotal;

    groupedRows.push({
      ...finalCharge,
      id: `order-charge-${orderId}`,
      amountMinor,
      orderItems: orderItems.length > 0 ? orderItems : finalCharge.orderItems,
      orderTotalMinor,
      shortTitle: locale === 'ar' ? 'خصم إجمالي الطلب' : 'Total order deduction',
      description: locale === 'ar'
        ? (finalCharge.orderDisplayNumber
            ? `خصم إجمالي الطلب رقم #${finalCharge.orderDisplayNumber}`
            : 'خصم إجمالي الطلب من رصيد العميل')
        : (finalCharge.orderDisplayNumber
            ? `Total charge for order #${finalCharge.orderDisplayNumber}`
            : 'Total order charge from customer balance'),
    });
  }

  return groupedRows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}


/** Home dashboard projection: aggregate item-level charges per order for display only. */
export interface HomeFinancialActivityDisplayItem {
  id: string;
  eventType: string;
  customerName: string;
  customerId: string;
  amountMinor: number;
  displayTitle: string;
  description: string;
  createdAt: string;
  orderId?: string;
  orderNumber?: number;
}

export function groupHomeFinancialActivitiesByOrder(
  activities: HomeFinancialActivityDisplayItem[],
  locale: 'ar' | 'en' = 'ar'
): HomeFinancialActivityDisplayItem[] {
  const ordinaryRows: HomeFinancialActivityDisplayItem[] = [];
  const chargesByOrder = new Map<string, HomeFinancialActivityDisplayItem[]>();

  for (const activity of activities) {
    if (activity.eventType !== 'ORDER_ITEM_CHARGE' || !activity.orderId) {
      ordinaryRows.push(activity);
      continue;
    }
    const key = `${activity.customerId}::${activity.orderId}`;
    const group = chargesByOrder.get(key);
    if (group) group.push(activity);
    else chargesByOrder.set(key, [activity]);
  }

  const groupedRows = [...ordinaryRows];
  for (const [key, charges] of chargesByOrder) {
    if (charges.length === 1) {
      groupedRows.push(charges[0]);
      continue;
    }
    const latest = charges.reduce((current, row) =>
      new Date(row.createdAt).getTime() >= new Date(current.createdAt).getTime() ? row : current
    );
    const amountMinor = charges.reduce((sum, row) => sum + row.amountMinor, 0);
    const orderNumber = latest.orderNumber ?? charges.find(row => row.orderNumber !== undefined)?.orderNumber;
    const orderLabel = orderNumber === undefined ? '' : ` #${orderNumber}`;
    groupedRows.push({
      ...latest,
      id: `home-order-charge-${key}`,
      amountMinor,
      displayTitle: locale === 'ar' ? `خصم إجمالي الطلب${orderLabel}` : `Total order deduction${orderLabel}`,
      description: locale === 'ar'
        ? `خصم إجمالي من رصيد ${latest.customerName}`
        : `Total charge to ${latest.customerName}`,
    });
  }

  return groupedRows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
