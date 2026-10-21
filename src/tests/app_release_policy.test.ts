import { describe, expect, it } from 'vitest';
import { parseAppVersion } from '../services/appReleasePolicy';

describe('app release version parsing', () => {
  it('maps semantic versions to increasing Android version codes', () => {
    expect(parseAppVersion('1.0.0')?.code).toBe(1_000_000);
    expect(parseAppVersion('1.0.1')?.code).toBe(1_000_001);
    expect(parseAppVersion('1.1.0')?.code).toBe(1_001_000);
    expect(parseAppVersion('2.0.0')?.code).toBe(2_000_000);
  });
  it('rejects malformed and unsupported versions', () => {
    expect(parseAppVersion('1.0')).toBeNull();
    expect(parseAppVersion('v1.0.0')).toBeNull();
    expect(parseAppVersion('01.0.0')).toBeNull();
    expect(parseAppVersion('1.1000.0')).toBeNull();
    expect(parseAppVersion('9999.0.0')).toBeNull();
  });
});
