/**
 * DR posture stays wired (2026-09-01, audit phase 4).
 *
 * The disaster-recovery story is only real while its pieces exist and point
 * at each other. This does not touch any secret or any live system; it pins
 * that the runbook and the secret-backup script are present, name the one
 * component that lives on a single disk, and never leak a value.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = (p: string) => resolve(__dirname, '..', p);
const RUNBOOK = 'docs/dr/RESTORE-RUNBOOK.md';
const BACKUP = 'scripts/dr/backup-engine-secrets.sh';

describe('disaster recovery is documented and wired', () => {
  it('the restore runbook exists and covers the three loss scenarios', () => {
    expect(existsSync(root(RUNBOOK))).toBe(true);
    const t = readFileSync(root(RUNBOOK), 'utf8');
    expect(t).toMatch(/engine box is gone/i);
    expect(t).toMatch(/database corruption/i);
    expect(t).toMatch(/the mac is gone/i);
    // The one control an agent cannot verify must be flagged for a human.
    expect(t).toMatch(/PITR/);
    expect(t).toMatch(/human action|Dan/);
  });

  it('the engine-secret backup script exists and encrypts, never commits plaintext', () => {
    expect(existsSync(root(BACKUP))).toBe(true);
    const s = readFileSync(root(BACKUP), 'utf8');
    expect(s).toContain('openssl enc -aes-256-cbc');
    expect(s).toContain('.dr-backups');
    // The passphrase comes from the keychain, is never written to the repo.
    expect(s).toContain('security find-generic-password');
  });

  it('.dr-backups is gitignored so an encrypted secret can never be committed', () => {
    const gi = readFileSync(root('.gitignore'), 'utf8');
    expect(gi).toMatch(/^\.dr-backups\/?$/m);
  });

  it('the runbook names the single-copy component explicitly', () => {
    const t = readFileSync(root(RUNBOOK), 'utf8');
    expect(t).toMatch(/server\/\.env/);
    expect(t).toMatch(/only one disk|single copy|Hetzner disk only/i);
  });
});
