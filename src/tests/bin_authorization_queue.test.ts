import { describe, expect, it } from 'vitest';
import {
  isBinRequiredOutboxCommand,
  redactAuthorizationSecretsFromPayload,
} from '../infrastructure/sync/binAuthorization';

describe('queued BIN authorization classification', () => {
  it('holds offline customer payments until a BIN is supplied', () => {
    expect(isBinRequiredOutboxCommand({
      commandType: 'CREATE_PAYMENT',
      payload: { deferBinVerification: true },
    })).toBe(true);
  });

  it('holds legacy payment commands without a BIN even before their first server rejection', () => {
    expect(isBinRequiredOutboxCommand({
      commandType: 'CREATE_PAYMENT',
      payload: {},
    })).toBe(true);
  });

  it('redacts BIN credentials and local-only flags while preserving payment data', () => {
    expect(redactAuthorizationSecretsFromPayload({
      amountMinor: 500,
      customerId: 'customer-1',
      bin: '1234',
      adminBin: '1234',
      deferBinVerification: true,
      offlinePendingApproval: true,
    })).toEqual({
      amountMinor: 500,
      customerId: 'customer-1',
    });
  });

  it('recovers legacy payment commands rejected by the server for a missing BIN', () => {
    expect(isBinRequiredOutboxCommand({
      commandType: 'CREATE_PAYMENT',
      payload: {},
      lastError: 'Authorization required: BIN is required for CREATE_PAYMENT',
    })).toBe(true);
  });

  it('does not ask for a new BIN after a command already has one and is no longer deferred', () => {
    expect(isBinRequiredOutboxCommand({
      commandType: 'CREATE_PAYMENT',
      payload: { bin: '1234', deferBinVerification: false },
    })).toBe(false);
  });

  it('does not affect ordinary non-financial commands', () => {
    expect(isBinRequiredOutboxCommand({
      commandType: 'CREATE_ORDER',
      payload: { deferBinVerification: true },
    })).toBe(false);
  });
});
