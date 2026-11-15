import { describe, expect, it } from 'vitest';
import { parseReleaseVersion } from '../../api/_lib/appReleaseAuth';

describe('APK release version validation', () => {
  it('converts valid semantic versions to the app version code', () => {
    expect(parseReleaseVersion('1.2.8')).toEqual({ version: '1.2.8', code: 1002008 });
    expect(parseReleaseVersion('2.0.0')).toEqual({ version: '2.0.0', code: 2000000 });
  });
  it('rejects malformed, padded, and out-of-range versions', () => {
    expect(parseReleaseVersion('1.2')).toBeNull();
    expect(parseReleaseVersion('1.2.08')).toBeNull();
    expect(parseReleaseVersion('01.2.3')).toBeNull();
    expect(parseReleaseVersion('9999.999.999')).toBeNull();
    expect(parseReleaseVersion('v1.2.3')).toBeNull();
  });
});
