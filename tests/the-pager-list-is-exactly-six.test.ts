/**
 * THE 3AM PAGER LIST IS EXACTLY SIX, AND THEY ARE THESE SIX
 *
 * On 2026-09-04, with the Sentry subscription gone, Alertmanager became the
 * only path from a firing rule to a human. Dan was asked which alerts are
 * worth being woken for and answered with six. Each carries `page: sms`, which
 * routes it to the World Hub pager (pages/api/internal/alertmanager-page.js)
 * and from there to his phone.
 *
 * This test exists because the list will drift in both directions otherwise:
 * a seventh alert quietly added becomes the SMS storm the estate has already
 * had once, and a label quietly lost becomes a 3am outage nobody was told
 * about. Change the list on purpose, here, in the same commit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';

const DIR = resolve(__dirname, '../infra/monitoring');

const APPROVED = [
  'HandsAreFailingToSettle', // chips not moving (the 13-hour outage)
  'SLOHandsAreNotBeingDealt', // the platform has stopped dealing
  'EngineDown', // the platform has stopped
  'UndeclaredTriggerOnAMoneyTable', // a chip path changed without review
  'ReplicationSlotCriticallyBehind', // the disk is filling
  'OpenClawFleetLongSilence', // the whole job fleet has gone quiet
].sort();

function allRules() {
  const rules: Array<{ alert: string; labels: Record<string, string>; file: string }> = [];
  for (const f of readdirSync(DIR)) {
    if (!/\.ya?ml$/.test(f) || !/rules|alerts/.test(f) || /QUARANT/.test(f)) continue;
    const doc: any = load(readFileSync(resolve(DIR, f), 'utf8'));
    for (const g of doc?.groups ?? [])
      for (const r of g.rules ?? []) {
        if (r.alert) rules.push({ alert: r.alert, labels: r.labels ?? {}, file: f });
      }
  }
  return rules;
}

describe('the pager list', () => {
  it('is exactly the six alerts Dan approved, no more and no fewer', () => {
    const paged = allRules()
      .filter((r) => r.labels.page === 'sms')
      .map((r) => r.alert)
      .sort();
    expect(paged).toEqual(APPROVED);
  });

  it('every paged alert is severity critical - a warning is never a 3am text', () => {
    for (const r of allRules().filter((r) => r.labels.page === 'sms')) {
      expect(r.labels.severity, `${r.alert} in ${r.file}`).toBe('critical');
    }
  });

  it('alertmanager routes page=sms to the pager receiver and still to email', () => {
    const am: any = load(readFileSync(resolve(DIR, 'alertmanager.yml'), 'utf8'));
    const pager = (am.route.routes as any[]).find((r) => (r.matchers ?? []).includes('page="sms"'));
    expect(pager, 'a page="sms" route must exist').toBeTruthy();
    expect(pager.receiver).toBe('pager-sms');
    expect(pager.continue).toBe(true);
    expect(pager.repeat_interval).toBe('4h');
    const recv = (am.receivers as any[]).find((r) => r.name === 'pager-sms');
    expect(recv?.webhook_configs?.[0]?.url).toBe(
      'https://smarter.poker/api/internal/alertmanager-page'
    );
    expect(recv.webhook_configs[0].send_resolved).toBe(true);
    expect(recv.webhook_configs[0].http_config.authorization.credentials_file).toBe(
      '/etc/alertmanager/cron_secret'
    );
  });

  it('the secret is mounted, ignored by git, and required by deploy.sh', () => {
    const compose = readFileSync(resolve(DIR, 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/\.\/cron_secret:\/etc\/alertmanager\/cron_secret:ro/);
    const gi = readFileSync(resolve(__dirname, '../.gitignore'), 'utf8');
    expect(gi).toMatch(/^infra\/monitoring\/cron_secret$/m);
    expect(gi).toMatch(/^infra\/monitoring\/resend_key$/m);
    const deploy = readFileSync(resolve(DIR, 'deploy.sh'), 'utf8');
    expect(deploy).toMatch(/cron_secret.*missing or empty/);
  });
});
