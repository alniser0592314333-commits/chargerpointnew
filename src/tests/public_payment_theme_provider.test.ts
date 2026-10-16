import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Public payment route providers', () => {
  it('wraps PublicPaymentPage in ThemeProvider because the page calls useTheme', () => {
    const source = readFileSync(new URL('../PublicPortalApp.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(
      /prefix:\s*'\/pay\/'[\s\S]*?render:\s*\(token:\s*string\)\s*=>\s*<ThemeProvider>\s*<PublicPaymentPage token=\{token\}\s*\/>\s*<\/ThemeProvider>/
    );
  });
});
