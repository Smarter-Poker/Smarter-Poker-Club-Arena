import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const uncommented = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const audit = read('.github/scripts/audit-engine-provenance.sh');
const code = uncommented(audit);
const workflow = read('.github/workflows/production-integrity-audit.yml');

describe('the retired engine watchdog cannot come back as a reconciler', () => {
  it('removes the old watchdog scripts and host workflow', () => {
    expect(existsSync(resolve(root, '.github/scripts/engine-watchdog.sh'))).toBe(false);
    expect(existsSync(resolve(root, '.github/scripts/publish-watchdog.sh'))).toBe(false);
    expect(existsSync(resolve(root, '.github/scripts/schedule-liveness.mjs'))).toBe(false);
    expect(existsSync(resolve(root, '.github/workflows/publish-watchdog.yml'))).toBe(false);
  });
});

describe('the engine provenance audit observes production without releasing it', () => {
  it('reads the served engine version and compares it with engine code on main', () => {
    expect(code).toContain('$ENGINE_URL/health');
    expect(code).toContain('JSON.parse(body).releaseSha');
    expect(code).toContain("'server/**'");
    expect(code).toContain(':(exclude)server/**/*.test.ts');
    expect(code).toContain(':(exclude)server/sim/**');
    expect(code).toContain('git merge-base --is-ancestor "$SERVED" "$MAIN_SHA"');
    expect(code).toContain('git merge-base --is-ancestor "$REQ_SHA" "$SERVED"');
  });

  it('treats an unreadable health response as unknown and fails the audit', () => {
    expect(audit).toContain('ENGINE PROVENANCE UNKNOWN');
    expect(code).toMatch(/if ! \[\[ "\$SERVED" =~[\s\S]{0,700}?exit 1/);
  });

  it('never waits, dispatches, retries, opens issues, or starts an engine deployment', () => {
    expect(code).not.toMatch(/\bgh\s+workflow\s+run\b/);
    expect(code).not.toMatch(/repos\/\$REPO\/dispatches/);
    expect(code).not.toMatch(/event_type=['"]deploy-club-arena-engine['"]/);
    expect(code).not.toMatch(/client_payload\[ref_sha\]/);
    expect(code).not.toMatch(/\bDISPATCHED=/);
    expect(code).not.toMatch(/\bgh\s+issue\b/);
    expect(code).not.toMatch(/\b(?:sleep|window_at_or_after|RESTART_MINUTE|GRACE_MIN)\b/);
  });

  it('returns non-success whenever production cannot be proven current', () => {
    expect(audit).toContain('ENGINE PROVENANCE UNKNOWN');
    expect(audit).toContain('Engine provenance: BEHIND');
    expect(code.match(/exit 1/g)?.length).toBeGreaterThanOrEqual(3);
    expect(code).toContain('git merge-base --is-ancestor "$SERVED" "$MAIN_SHA"');
    expect(code).toContain('git merge-base --is-ancestor "$REQ_SHA" "$SERVED"');
  });
});

describe('the production-integrity workflow has read-only release authority', () => {
  it('hosts the engine and client release audits independently', () => {
    expect(workflow).toMatch(/^ {2}client_release:$/m);
    expect(workflow).toMatch(/^ {2}engine:$/m);
    expect(workflow).toContain('bash .github/scripts/audit-engine-provenance.sh');
    expect(workflow).toContain('bash .github/scripts/audit-publish-provenance.sh');
  });

  it('gives the engine audit read-only job permissions', () => {
    const engineJob = workflow.slice(
      workflow.indexOf('\n  engine:'),
      workflow.indexOf('\n  live_drift:')
    );
    expect(engineJob).toMatch(/^\s{4}permissions:\s*$/m);
    expect(engineJob).toMatch(/^\s{6}contents:\s*read\s*$/m);
    expect(engineJob).not.toMatch(/^\s{6}(?:issues|actions):\s*write\s*$/m);
    expect(engineJob).not.toMatch(/GH_TOKEN|DATABASE_URL/);
  });

  it('cannot dispatch or toggle GitHub Actions workflows', () => {
    const permissions = workflow.slice(
      workflow.indexOf('\npermissions:'),
      workflow.indexOf('\nconcurrency:')
    );
    expect(permissions).toMatch(/^\s+contents:\s*read\s*$/m);
    expect(permissions).toMatch(/^\s+actions:\s*read\s*$/m);
    expect(permissions).not.toMatch(/^\s+(?:actions|contents):\s*write\s*$/m);
  });
});
