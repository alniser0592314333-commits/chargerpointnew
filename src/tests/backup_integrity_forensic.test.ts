import { describe, expect, it } from 'vitest';
import {
  canonicalizeSnapshotForComparison,
  computeCanonicalSnapshotSha256,
  normalizeQrTokenEntity,
  validateReplacementData,
} from '../services/backup/backupService';
import { SnapshotFormatError } from '../domain/errors';

describe('Backup / replacement integrity contract', () => {
  it('treats entity collection order as non-semantic for recovery verification', async () => {
    const a = {
      customers: [
        { id: 'b', name: 'B' },
        { id: 'a', name: 'A' },
      ],
      orders: [
        { id: '2', status: 'charging' },
        { id: '1', status: 'delivered' },
      ],
    };
    const b = {
      customers: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      orders: [
        { id: '1', status: 'delivered' },
        { id: '2', status: 'charging' },
      ],
    };

    expect(canonicalizeSnapshotForComparison(a)).toEqual(
      canonicalizeSnapshotForComparison(b)
    );
    expect(await computeCanonicalSnapshotSha256(a)).toBe(
      await computeCanonicalSnapshotSha256(b)
    );
  });

  it('allows read-only backup capture of an unsafe legacy QR placeholder', () => {
    const result = normalizeQrTokenEntity(
      {
        id: '11111111-1111-4111-8111-111111111111:qr',
        targetId: '11111111-1111-4111-8111-111111111111',
        tokenType: 'ORDER',
        publicToken: null,
      },
      { allowLegacyPlaceholder: true }
    );

    expect(result.id).toMatch(/:qr$/i);
    expect(result._legacyQrPlaceholder).toBe(true);
  });

  it('never permits an unsafe legacy QR placeholder into a destructive replacement', () => {
    expect(() =>
      validateReplacementData({
        customers: [{ id: '11111111-1111-4111-8111-111111111111', name: 'A' }],
        businessDays: [],
        orders: [],
        orderItems: [],
        financialLedger: [],
        payments: [],
        paymentAllocations: [],
        deviceTypes: [],
        qrTokens: [
          {
            id: '11111111-1111-4111-8111-111111111111:qr',
            targetId: '11111111-1111-4111-8111-111111111111',
            tokenType: 'ORDER',
            publicToken: null,
          },
        ],
      })
    ).toThrow(SnapshotFormatError);
  });
});
