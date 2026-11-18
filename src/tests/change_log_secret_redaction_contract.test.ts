import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('sync change-log secret redaction', () => {
  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261118160000_redact_sensitive_change_log_payloads.sql'
  );

  it('redacts BIN credentials and local-only approval markers on every change-log write', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.redact_sensitive_change_log_payload()');
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF payload ON public.change_log');
    expect(sql).toContain("'bin'");
    expect(sql).toContain("'adminBin'");
    expect(sql).toContain("'deferBinVerification'");
    expect(sql).toContain("'offlinePendingApproval'");
  });

  it('scrubs historical change-log payloads without updating financial records', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('UPDATE public.change_log');
    expect(sql).toContain('WHERE payload ?| ARRAY[');
    expect(sql).not.toContain('UPDATE public.payments');
    expect(sql).not.toContain('UPDATE public.financial_ledger');
  });
});
