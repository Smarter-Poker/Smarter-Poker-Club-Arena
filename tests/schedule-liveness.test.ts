import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const uncommented = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const integrityWorkflow = read('.github/workflows/production-integrity-audit.yml');
const releaseObservers = readdirSync(resolve(root, '.github/scripts'))
  .filter((name) => /(?:audit|watchdog|liveness)/i.test(name))
  .map((name) => ({ name, code: uncommented(read(`.github/scripts/${name}`)) }));

describe('schedule reconciliation is retired', () => {
  it('removes the schedule-liveness dispatcher and legacy watchdog workflow', () => {
    expect(existsSync(resolve(root, '.github/scripts/schedule-liveness.mjs'))).toBe(false);
    expect(existsSync(resolve(root, '.github/workflows/publish-watchdog.yml'))).toBe(false);
  });

  it('does not reference either retired path from an active workflow', () => {
    const workflows = readdirSync(resolve(root, '.github/workflows'))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => read(`.github/workflows/${name}`))
      .join('\n');
    expect(workflows).not.toContain('schedule-liveness.mjs');
    expect(workflows).not.toContain('publish-watchdog.yml');
  });
});

describe('audits and watchdogs report but never repair release state', () => {
  it('retains independent release observers', () => {
    expect(releaseObservers.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['audit-engine-provenance.sh', 'audit-publish-provenance.sh'])
    );
  });

  it('none can dispatch another workflow or repository event', () => {
    for (const { name, code } of releaseObservers) {
      expect(code, name).not.toMatch(/\bgh\s+workflow\s+run\b/);
      expect(code, name).not.toMatch(/\/dispatches\b/);
      expect(code, name).not.toMatch(/event_type\s*[:=]/);
    }
  });

  it('none can disable, enable, or re-register a workflow', () => {
    for (const { name, code } of releaseObservers) {
      expect(code, name).not.toMatch(/actions\/workflows\/[^\n]+\/(?:disable|enable)/);
      expect(code, name).not.toMatch(/\bgh\s+workflow\s+(?:disable|enable)\b/);
      expect(code, name).not.toMatch(/SCHEDULE_CYCLE_REGISTRATIONS/);
    }
  });
});

describe('the production integrity audit lacks release authority', () => {
  it('runs on a fixed schedule or a default-branch repository event', () => {
    const triggers = integrityWorkflow.slice(
      integrityWorkflow.indexOf('\non:'),
      integrityWorkflow.indexOf('\npermissions:')
    );
    expect(triggers).toMatch(/^\s{2}schedule:/m);
    expect(triggers).toMatch(/^\s{2}repository_dispatch:/m);
    expect(triggers).not.toMatch(/^\s{2}workflow_dispatch:/m);
  });

  it('has read-only repository and Actions permissions', () => {
    const permissions = integrityWorkflow.slice(
      integrityWorkflow.indexOf('\npermissions:'),
      integrityWorkflow.indexOf('\nconcurrency:')
    );
    expect(permissions).toMatch(/^\s+contents:\s*read\s*$/m);
    expect(permissions).toMatch(/^\s+actions:\s*read\s*$/m);
    expect(permissions).not.toMatch(/^\s+(?:contents|actions):\s*write\s*$/m);
  });
});
