import { describe, expect, it } from 'vitest';
import { parseAppVersion } from '../services/appReleasePolicy';

describe('app release version parsing', () => {
  it('maps semantic versions to a monotonic Android version code', () => {
    expect(parseAppVersion('1.0.0')?.code).toBe(1_000_000);
    expect(parseAppVersion('1.0.1')?.code).toBe(1_000_001);
    expect(parseAppVersion('1.1.0')?.code).toBe(1_001_000);
    expect(parseAppVersion('2.0.0')?.code).toBe(2_000_000);
  });

  it('rejects incomplete, malformed, and oversized versions', () => {
    expect(parseAppVersion('1.0')).toBeNull();
    expect(parseAppVersion('v1.0.0')).toBeNull();
    expect(parseAppVersion('01.0.0')).toBeNull();
    expect(parseAppVersion('1.1000.0')).toBeNull();
    expect(parseAppVersion('9999.0.0')).toBeNull();
  });
});
