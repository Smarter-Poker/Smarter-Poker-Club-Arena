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

  it('the engine-secret backup is explicit, pinned and never reads local env authority', () => {
    expect(existsSync(root(BACKUP))).toBe(true);
    const s = readFileSync(root(BACKUP), 'utf8');
    expect(s).toContain('openssl enc -aes-256-cbc');
    expect(s).toContain('.dr-backups');
    expect(s).toContain('security find-generic-password');
    expect(s).toContain('--authorized-offline-backup');
    expect(s).toContain('DR_ENGINE_SSH_KEY_FILE');
    expect(s).toContain('DR_ENGINE_HOST_KEY');
    expect(s).toContain('StrictHostKeyChecking=yes');
    expect(s).toContain('UserKnownHostsFile="$DR_TMP_DIR/known_hosts"');
    expect(s).toContain('GlobalKnownHostsFile=/dev/null');
    expect(s).toContain('IdentitiesOnly=yes');
    expect(s).not.toContain('StrictHostKeyChecking=accept-new');
    expect(s).not.toMatch(/source\s+.*\.env|hetzner_engine_key|ENGINE_HOST:-engine/);
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
