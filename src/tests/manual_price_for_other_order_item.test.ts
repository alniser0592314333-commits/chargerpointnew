import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Manual price for the Other order item', () => {
  const read = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

  it('shows a manual price field only for the Other device option and validates it before saving', () => {
    const page = read('src/components/pages/AddOrderPage.tsx');
    expect(page).toContain('export const isOtherDeviceOption');
    expect(page).toContain('{isOtherDeviceOption(devOpt) && (');
    expect(page).toContain('manualPriceToMinor(device.manualPrice || \'\')');
    expect(page).toContain('manualPriceMinor');
    expect(page).toContain('!isOtherDeviceOption(devOpt)');
  });

  it('passes the manual price through the offline-first use-case command without changing normal item pricing', () => {
    const store = read('src/components/pages/dayOrdersStore.ts');
    const useCases = read('src/application/useCases.ts');
    expect(store).toContain('manualPriceMinor?: number');
    expect(useCases).toContain('Manual item pricing is only allowed for the Other device type');
    expect(useCases).toContain('finalChargeSnapshotMinor: pricing.totalPriceMinor');
    expect(useCases).toContain('{ manualPriceMinor: manualPriceByItemId.get(item.id)! }');
    expect(useCases).toContain('calculateItemPrice({');
  });

  it('accepts a server-authoritative override only when the selected device type is Other', () => {
    const migration = read('supabase/migrations/20261115130000_manual_price_for_other_order_item.sql');
    expect(migration).toContain("name_ar, name_en");
    expect(migration).toContain("v_manual_price := NULLIF(p_payload->>'manualPriceMinor', '')::BIGINT");
    expect(migration).toContain("IF NOT v_is_other_item THEN");
    expect(migration).toContain('v_authoritative_final_charge := v_manual_price;');
    expect(migration).toContain('v_authoritative_charger_fee := 0;');
    expect(migration).toContain('v_authoritative_final_charge := GREATEST(0, v_base_price + v_authoritative_charger_fee - v_authoritative_discount);');
  });
});


describe('Manual price for Other in order editing', () => {
  const read = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

  it('keeps the manual amount editable for existing and newly added Other items', () => {
    const page = read('src/components/pages/EditOrderPage.tsx');
    expect(page).toContain("'Manual price (₪)'");
    expect(page).toContain('manualPriceToMinor(item.manualPrice || \'\')');
    expect(page).toContain('manualPriceMinor');
    expect(page).toContain('!isOtherDeviceOption(selectedOption)');
    expect(page).toContain('!isOther && (');
  });

  it('passes manual price through local edit commands for both updated and added items', () => {
    const store = read('src/components/pages/dayOrdersStore.ts');
    const useCases = read('src/application/useCases.ts');
    expect(store).toContain('manualPriceMinor?: number }[]');
    expect(store).toContain('edit.manualPriceMinor');
    expect(useCases).toContain('async updateOrderItem(');
    expect(useCases).toContain('async addOrderItem(');
    expect(useCases).toContain("...(manualPriceMinor !== undefined ? { manualPriceMinor } : {})");
  });

  it('applies the server-authoritative manual final price to UPDATE_ORDER_ITEM only for Other', () => {
    const migration = read('supabase/migrations/20261115150000_manual_price_for_other_order_edit.sql');
    expect(migration).toContain("WHEN 'UPDATE_ORDER_ITEM' THEN");
    expect(migration).toContain("v_manual_price := NULLIF(p_payload->>'manualPriceMinor', '')::BIGINT");
    expect(migration).toContain("IF NOT v_is_other_item THEN");
    expect(migration).toContain('v_authoritative_final_charge := v_manual_price;');
    expect(migration).toContain('v_authoritative_charger_fee := 0;');
  });
});
