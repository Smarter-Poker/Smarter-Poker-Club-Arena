/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: AN ALERT THAT IS LIVE IS IN THE REPO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Found 2026-09-05 while auditing Realtime programme Phase 1.
 *
 * `infra/monitoring/deploy.sh` SYMLINKS the live
 * /opt/smarter-poker-monitoring/alert-rules.yml to this repo's copy. But the
 * live file on engine-01 was a hand-written plain file, and it carried two
 * groups - `settlement` and `money-health`, NINE alerts, every one of them
 * about money - that existed in no repository at all.
 *
 * Both directions were broken. A rule added here never reached production
 * (the src clone deploy.sh expects does not exist on the box), and a rule
 * added on the box was erased by the next write - which is what happened to
 * EngineRefusingSessions, EngineCannotReachAuth and both ActionLatency rules
 * within four hours of being loaded. And the symlink made it worse than
 * drift: the first person to run deploy.sh would have silently deleted the
 * nine money alerts, because a symlink replaces, it does not merge.
 *
 * The groups were copied into this file on 2026-09-05 so it is a SUPERSET of
 * what is live and a deploy can only ever add.
 *
 * THE PIN. Every group that was live on the box that day is named here. If
 * you remove one, you are removing an alert that is watching production right
 * now, and you must say so deliberately. Adding groups is always fine.
 *
 * This does not, by itself, make the repo the source of truth - a reconciler
 * that compares /api/v1/rules against these files is Phase 7 of
 * docs/REALTIME-CONNECTIONS-PROGRAMME.md. It stops the bleeding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', 'infra', 'monitoring');

/** Every group observed live on engine-01 at 2026-09-05 03:1x UTC. */
const LIVE_ON_THE_BOX = [
  'engine-health',
  'cron-health',
  'postgres-health',
  'host-health',
  'replication',
  'settlement',
  'money-health',
  'action-latency',
  'engine-freeze',
  'slo-objectives',
  'slo-recording',
  'spin-fairness',
  'spin-money',
  'spin-experience',
  'club-arena-supervisor',
  'tournament-health',
];

function groupsInRepo(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.yml') || f.includes('QUARANTINED')) continue;
    for (const m of readFileSync(join(DIR, f), 'utf8').matchAll(/^ {2}- name: (\S+)/gm)) {
      out.add(m[1]);
    }
  }
  return out;
}

describe('an alert group that is live on the box exists in this repo', () => {
  const repo = groupsInRepo();

  it.each(LIVE_ON_THE_BOX)('%s is versioned here', (group) => {
    expect(
      repo.has(group),
      `The group "${group}" is alerting on production but is not in infra/monitoring/. ` +
        `deploy.sh symlinks these files over the live ones, so a deploy would DELETE it. ` +
        `Copy it in from /opt/smarter-poker-monitoring/ rather than removing this pin.`
    ).toBe(true);
  });

  it('the money and settlement groups recovered on 2026-09-05 keep their alerts', () => {
    const rules = readFileSync(join(DIR, 'alert-rules.yml'), 'utf8');
    for (const alert of [
      'HandsAreFailingToSettle',
      'SettlementFailuresAboveBaseline',
      'NoHandsAreSettling',
      'SettlementsStuckMidStateMachine',
      'SettlementMetricsBlind',
      'UndeclaredTriggerOnAMoneyTable',
      'MoneyAlertsGoingUnread',
      'MoneyAlertBacklogGrowing',
      'MoneyHealthBlind',
    ]) {
      expect(rules, `${alert} was recovered from the box; do not drop it`).toContain(
        `alert: ${alert}`
      );
    }
  });
});
