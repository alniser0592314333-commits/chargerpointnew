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
  businessDate?: string;
  orderId?: string;
  orderItemId?: string;
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
  const reversalCandidates: CustomerFinancialHistoryDisplayItem[] = [];

  for (const row of history) {
    if (row.eventType === 'REVERSAL' && row.orderId && row.orderItemId) {
      reversalCandidates.push(row);
      continue;
    }
    if (row.eventType !== 'ORDER_ITEM_CHARGE' || !row.orderId) {
      ordinaryRows.push(row);
      continue;
    }
    const existing = chargesByOrder.get(row.orderId);
    if (existing) existing.push(row);
    else chargesByOrder.set(row.orderId, [row]);
  }

  // A reversal only joins an order summary when it references an item whose
  // original charge is present in this customer's ledger history. Unlinked or
  // unrelated reversals remain independent audit rows.
  const reversalsByOrder = new Map<string, CustomerFinancialHistoryDisplayItem[]>();
  for (const reversal of reversalCandidates) {
    const charges = chargesByOrder.get(reversal.orderId!);
    if (charges?.some((charge) => charge.orderItemId && charge.orderItemId === reversal.orderItemId)) {
      const existing = reversalsByOrder.get(reversal.orderId!);
      if (existing) existing.push(reversal);
      else reversalsByOrder.set(reversal.orderId!, [reversal]);
    } else {
      ordinaryRows.push(reversal);
    }
  }

  const groupedRows: CustomerFinancialHistoryDisplayItem[] = [...ordinaryRows];
  for (const [orderId, charges] of chargesByOrder) {
    const reversals = reversalsByOrder.get(orderId) || [];
    if (charges.length === 1 && reversals.length === 0) {
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

    const allEvents = [...charges, ...reversals];
    const latestEvent = allEvents.reduce((latest, row) =>
      new Date(row.createdAt).getTime() >= new Date(latest.createdAt).getTime() ? row : latest
    );
    const amountMinor = allEvents.reduce((sum, row) => sum + row.amountMinor, 0);
    const latestBalanceEvent = allEvents.reduce((latest, row) =>
      new Date(row.createdAt).getTime() >= new Date(latest.createdAt).getTime() ? row : latest
    );

    const chargeByItem = new Map<string, number>();
    const reversalByItem = new Map<string, number>();
    for (const charge of charges) {
      if (charge.orderItemId) chargeByItem.set(charge.orderItemId, (chargeByItem.get(charge.orderItemId) || 0) + charge.amountMinor);
    }
    for (const reversal of reversals) {
      if (reversal.orderItemId) reversalByItem.set(reversal.orderItemId, (reversalByItem.get(reversal.orderItemId) || 0) + reversal.amountMinor);
    }

    const itemDetails = new Map<string, NonNullable<CustomerFinancialHistoryDisplayItem['orderItems']>[number]>();
    for (const charge of charges) {
      for (const item of charge.orderItems || []) {
        if (!charge.orderItemId) {
          if (!itemDetails.has(item.id)) itemDetails.set(item.id, item);
          continue;
        }
        const netCharge = (chargeByItem.get(charge.orderItemId) || 0) + (reversalByItem.get(charge.orderItemId) || 0);
        if (netCharge < 0) {
          itemDetails.set(item.id, { ...item, priceMinor: Math.abs(netCharge) });
        } else {
          itemDetails.delete(item.id);
        }
      }
    }

    const orderItems = Array.from(itemDetails.values());
    const fallbackOrderTotal = Math.abs(amountMinor);
    const orderTotalMinor = orderItems.length > 0
      ? orderItems.reduce((sum, item) => sum + item.priceMinor, 0)
      : fallbackOrderTotal;

    groupedRows.push({
      ...latestEvent,
      id: `order-charge-${orderId}`,
      eventType: amountMinor < 0 ? 'ORDER_ITEM_CHARGE' : 'REVERSAL',
      amountMinor,
      postBalanceMinor: latestBalanceEvent.postBalanceMinor,
      orderItems,
      orderTotalMinor,
      shortTitle: reversals.length > 0
        ? (locale === 'ar' ? 'صافي حساب الطلب' : 'Net order balance')
        : (locale === 'ar' ? 'خصم إجمالي الطلب' : 'Total order deduction'),
      description: reversals.length > 0
        ? (locale === 'ar'
            ? (latestEvent.orderDisplayNumber
                ? `صافي حساب الطلب رقم #${latestEvent.orderDisplayNumber}`
                : 'صافي حساب الطلب من رصيد العميل')
            : (latestEvent.orderDisplayNumber
                ? `Net balance for order #${latestEvent.orderDisplayNumber}`
                : 'Net order balance from customer account'))
        : (locale === 'ar'
            ? (latestEvent.orderDisplayNumber
                ? `خصم إجمالي الطلب رقم #${latestEvent.orderDisplayNumber}`
                : 'خصم إجمالي الطلب من رصيد العميل')
            : (latestEvent.orderDisplayNumber
                ? `Total charge for order #${latestEvent.orderDisplayNumber}`
                : 'Total order charge from customer balance')),
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
  businessDate?: string;
  orderId?: string;
  orderItemId?: string;
  orderNumber?: number;
}

export function groupHomeFinancialActivitiesByOrder(
  activities: HomeFinancialActivityDisplayItem[],
  locale: 'ar' | 'en' = 'ar'
): HomeFinancialActivityDisplayItem[] {
  const ordinaryRows: HomeFinancialActivityDisplayItem[] = [];
  const chargesByOrder = new Map<string, HomeFinancialActivityDisplayItem[]>();
  const reversalCandidates: HomeFinancialActivityDisplayItem[] = [];

  for (const activity of activities) {
    if (activity.eventType === 'REVERSAL' && activity.orderId && activity.orderItemId) {
      reversalCandidates.push(activity);
      continue;
    }
    if (activity.eventType !== 'ORDER_ITEM_CHARGE' || !activity.orderId) {
      ordinaryRows.push(activity);
      continue;
    }
    const key = `${activity.customerId}::${activity.orderId}`;
    const group = chargesByOrder.get(key);
    if (group) group.push(activity);
    else chargesByOrder.set(key, [activity]);
  }

  const reversalsByOrder = new Map<string, HomeFinancialActivityDisplayItem[]>();
  for (const reversal of reversalCandidates) {
    const key = `${reversal.customerId}::${reversal.orderId}`;
    const charges = chargesByOrder.get(key);
    if (charges?.some((charge) => charge.orderItemId && charge.orderItemId === reversal.orderItemId)) {
      const existing = reversalsByOrder.get(key);
      if (existing) existing.push(reversal);
      else reversalsByOrder.set(key, [reversal]);
    } else {
      ordinaryRows.push(reversal);
    }
  }

  const groupedRows = [...ordinaryRows];
  for (const [key, charges] of chargesByOrder) {
    const reversals = reversalsByOrder.get(key) || [];
    if (charges.length === 1 && reversals.length === 0) {
      groupedRows.push(charges[0]);
      continue;
    }
    const allEvents = [...charges, ...reversals];
    const latest = allEvents.reduce((current, row) =>
      new Date(row.createdAt).getTime() >= new Date(current.createdAt).getTime() ? row : current
    );
    const amountMinor = allEvents.reduce((sum, row) => sum + row.amountMinor, 0);
    const orderNumber = latest.orderNumber ?? charges.find(row => row.orderNumber !== undefined)?.orderNumber;
    const orderLabel = orderNumber === undefined ? '' : ` #${orderNumber}`;
    groupedRows.push({
      ...latest,
      id: `home-order-charge-${key}`,
      eventType: amountMinor < 0 ? 'ORDER_ITEM_CHARGE' : 'REVERSAL',
      amountMinor,
      displayTitle: reversals.length > 0
        ? (locale === 'ar' ? `صافي حساب الطلب${orderLabel}` : `Net order balance${orderLabel}`)
        : (locale === 'ar' ? `خصم إجمالي الطلب${orderLabel}` : `Total order deduction${orderLabel}`),
      description: locale === 'ar'
        ? `صافي حساب الطلب لـ ${latest.customerName}`
        : `Net order balance for ${latest.customerName}`,
    });
  }

  return groupedRows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
