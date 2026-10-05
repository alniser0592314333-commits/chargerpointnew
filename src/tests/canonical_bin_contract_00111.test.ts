/**
 * Focused Regression Test Suite for Migration 00111 Canonical BIN Contract
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Migration 00111 Canonical BIN Contract & Security Verification', () => {
  const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/00111_fix_noncanonical_adminbin.sql');
  
  it('00111 migration file exists and is well-formed', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const content = fs.readFileSync(migrationPath, 'utf8');
    
    // A. adminBin is NOT present in the extraction logic (rejected/ignored)
    expect(content).not.toContain('adminBin');
    expect(content).not.toContain('p_payload->>\'adminBin\'');

    // B & C & D. canonical bin extraction uses p_payload->>'bin'
    expect(content).toContain("v_bin := p_payload->>'bin'");

    // E, F, G. Device Type commands handled without requiring BIN
    expect(content).toContain("WHEN 'CREATE_DEVICE_TYPE'");
    expect(content).toContain("WHEN 'UPDATE_DEVICE_TYPE'");
    expect(content).toContain("WHEN 'RETIRE_DEVICE_TYPE'");

    // H & I. actor_id remains auth.uid() UUID and separated from BIN
    expect(content).toContain('v_actor_id UUID := p_actor_id');
    expect(content).toContain('v_actor_id := auth.uid()');

    // J. No p_bin parameter in execute_canonical_sync_command signature
    expect(content).toContain('p_actor_id UUID DEFAULT NULL');
    expect(content).not.toContain('p_bin TEXT');
  });

  it('Migration history includes 00111', () => {
    const content = fs.readFileSync(migrationPath, 'utf8');
    expect(content).toContain("VALUES ('00111', 'fix_noncanonical_adminbin')");
  });
});
