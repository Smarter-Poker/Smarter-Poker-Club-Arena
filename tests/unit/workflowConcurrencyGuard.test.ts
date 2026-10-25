import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// Runner relief (October 22, 2026). Superseded pure-check runs are cancelled,
// but nothing that mutates production may ever be cancelled mid-run, and the
// live merge helpers keep their triggers.
const dir = resolve(__dirname, '../../.github/workflows');
type Workflow = {
  on?: unknown;
  true?: unknown;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean | string } | string;
  jobs?: Record<string, { concurrency?: { 'cancel-in-progress'?: boolean | string } }>;
};
const load = (file: string): Workflow => parse(readFileSync(resolve(dir, file), 'utf8'));
const triggers = (wf: Workflow): string[] => {
  const on = (wf.on ?? wf.true) as unknown;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on as string[];
  return Object.keys((on as Record<string, unknown>) ?? {});
};
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

// Production mutators: publish origin upload, engine staging/deploy/cutover,
// migration apply/ledger, monitoring deploy, money recovery, post-deploy proof.
const NEVER_CANCEL = [
  'publish-club-arena.yml',
  'stage-engine-release.yml',
  'auto-deploy-hetzner.yml',
  'apply-merged-migration.yml',
  'applied-migrations-recorded.yml',
  'deploy-monitoring.yml',
  'money-trigger-recovery.yml',
  'post-deploy-e2e.yml',
  'engine-drill.yml',
  'engine-rollback-drill.yml',
  'main-rewind-guard.yml',
];

describe('workflow concurrency guards runner capacity without risking production', () => {
  it('never cancels a production-mutating workflow in progress', () => {
    for (const file of NEVER_CANCEL) {
      const wf = load(file);
      const c = wf.concurrency;
      if (c && typeof c === 'object') expect(c['cancel-in-progress'], file).not.toBe(true);
      for (const [job, def] of Object.entries(wf.jobs ?? {}))
        expect(def?.concurrency?.['cancel-in-progress'], `${file}:${job}`).not.toBe(true);
    }
  });

  it('cancels superseded pure pull_request checks per PR ref', () => {
    for (const file of [
      'midway-cash-rake-policy.yml',
      'mutual-friends-unique.yml',
      'retired-wallet-transfer.yml',
      'physical-safari-package.yml',
      'explicit-table-access.yml',
    ]) {
      const c = load(file).concurrency;
      expect(c && typeof c === 'object', file).toBe(true);
      const conc = c as { group: string; 'cancel-in-progress': boolean | string };
      expect(conc.group, file).toContain('github.ref');
      expect(conc['cancel-in-progress'], file).toBeTruthy();
    }
  });

  it('only cancels a main push run when its group cannot collide with a different SHA range', () => {
    const c = load('explicit-table-access.yml').concurrency as Record<string, string>;
    expect(c.group).toContain('github.sha');
    expect(c['cancel-in-progress']).toContain("github.event_name == 'pull_request'");
  });

  it('every pull_request-only workflow declares concurrency', () => {
    const missing = files.filter((f) => {
      const wf = load(f);
      const t = triggers(wf);
      return (
        t.includes('pull_request') &&
        t.every((x) => ['pull_request', 'workflow_dispatch'].includes(x)) &&
        !wf.concurrency
      );
    });
    expect(missing).toEqual([]);
  });

  it('one migration dispatch never cancels another file', () => {
    // A shared group keeps ONE pending run and cancels it when a newer one
    // joins: on 2026-10-24 22:53Z that dropped 20261024213143 unapplied.
    const wf = load('apply-merged-migration.yml');
    const c = wf.concurrency as { group: string; 'cancel-in-progress': boolean };
    expect(c.group).toContain('inputs.migration || github.event.client_payload.migration');
    expect(c['cancel-in-progress']).toBe(false);
    const text = readFileSync(resolve(dir, 'apply-merged-migration.yml'), 'utf8');
    const queue = text.indexOf('THE QUEUE.');
    const send = text.indexOf('node scripts/ci/apply-recorded-migration.mjs');
    expect(queue).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(queue);
    expect(text).toContain('select(.id < $GITHUB_RUN_ID and .status != \\"completed\\")');
    expect(text).toMatch(/permissions:\n {2}contents: read\n {2}actions: read\n/);
  });

  it('keeps the live protected-merge helpers triggered (they merge PRs today)', () => {
    expect(triggers(load('agent-autopilot.yml'))).toContain('pull_request_target');
    expect(triggers(load('agent-branch-proposal.yml'))).toContain('push');
    expect(triggers(load('agent-open-pr.yml'))).toContain('workflow_run');
  });
});
