import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Payment notification review regression', () => {
  const source = readFileSync(new URL('../components/pages/NotificationsRequestsPage.tsx', import.meta.url), 'utf8');

  it('uses an in-app confirmation instead of native dialogs that can be suppressed in embedded previews', () => {
    expect(source).toContain('role="alertdialog"');
    expect(source).toContain('review(item, pendingConfirmation.action, true)');
    expect(source).not.toContain('window.confirm');
  });

  it('keeps notification records visible if receipt signing fails', () => {
    expect(source).toContain('must not reject the whole Promise.all');
    expect(source).toContain('Receipt preview unavailable for payment notification:');
  });

  it('retries signed receipt URL creation after an expired access token', () => {
    expect(source).toContain('response.status === 401');
    expect(source).toContain('supabaseRefreshToken()');
    expect(source).toContain("result.signedURL ?? result.signedUrl");
  });
});
