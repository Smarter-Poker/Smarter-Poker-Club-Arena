/**
 * The secrets-expiry watchdog and its inventory stay honest (2026-09-01).
 *
 * A credential that expires silently is an outage with a date on it. These
 * pins keep the inventory well-formed, keep the watchdog from ever printing a
 * value or failing the job, and keep the two live-check paths present.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = (p: string) => resolve(__dirname, '../..', p);
const INV = 'scripts/ci/secrets-inventory.json';
const SCRIPT = 'scripts/ci/check-secrets-expiry.mjs';

describe('secrets inventory', () => {
  const inv = JSON.parse(readFileSync(root(INV), 'utf8'));

  it('is well-formed: a warn window and a list of named secrets', () => {
    expect(typeof inv.warn_days).toBe('number');
    expect(Array.isArray(inv.secrets)).toBe(true);
    expect(inv.secrets.length).toBeGreaterThan(0);
    for (const s of inv.secrets) {
      expect(typeof s.name).toBe('string');
      expect('where' in s).toBe(true);
      // expiry is a date, null (non-expiring), or "unknown" (needs verifying).
      expect(s.expires === null || typeof s.expires === 'string').toBe(true);
    }
  });

  it('contains no secret VALUES - only names, locations, dates', () => {
    const raw = readFileSync(root(INV), 'utf8');
    // No token-shaped strings.
    expect(raw).not.toMatch(/ghp_[A-Za-z0-9]{20}/);
    expect(raw).not.toMatch(/github_pat_[A-Za-z0-9_]{20}/);
    expect(raw).not.toMatch(/sb_secret_[A-Za-z0-9]/);
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{20}/);
  });

  it('records the one genuinely-expiring credential (the GitHub PAT)', () => {
    const pat = inv.secrets.find((s: any) => s.name === 'GH_PAT');
    expect(pat).toBeTruthy();
    expect(pat.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pat.live_check).toBe('github_token_expiry');
  });
});

describe('the watchdog script', () => {
  const s = readFileSync(root(SCRIPT), 'utf8');

  it('never fails the job - an alarm is an issue, not a red run', () => {
    expect(s).not.toContain('process.exit(1)');
    expect(s).toContain('process.exit(0)');
  });

  it('has both live-check paths: GitHub token expiry and Supabase key format', () => {
    expect(s).toContain('github-authentication-token-expiration');
    expect(s).toContain('sb_secret_');
  });

  it('writes the alarm with a token independent of the one that can expire', () => {
    expect(s).toContain('ISSUE_TOKEN');
    expect(s).toContain('GH_TOKEN_ISSUES');
  });

  it('treats an unknown expiry as a finding, not a pass', () => {
    expect(s).toMatch(/expiry is UNKNOWN/);
  });
});
