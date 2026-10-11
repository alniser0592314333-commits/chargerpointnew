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
        shortTitle: locale === 'ar'
          ? (single.orderDisplayNumber ? `طلب #${single.orderDisplayNumber}` : 'خصم طلب')
          : (single.orderDisplayNumber ? `Order #${single.orderDisplayNumber}` : 'Order charge'),
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
      shortTitle: locale === 'ar'
        ? (finalCharge.orderDisplayNumber ? `طلب #${finalCharge.orderDisplayNumber}` : 'خصم طلب')
        : (finalCharge.orderDisplayNumber ? `Order #${finalCharge.orderDisplayNumber}` : 'Order charge'),
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
