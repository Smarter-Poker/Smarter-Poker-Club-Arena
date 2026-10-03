/**
 * The client error gauges ride the money-health collector (2026-10-03), and
 * they must never take the money gauges down with them: the money half is
 * fail-closed by design (a zero it has not earned is worse than no file), the
 * client half is best-effort. Runs the real script with a stand-in `curl`.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '..', 'server/scripts/collect-monitoring-health.sh');
const dir = mkdtempSync(join(tmpdir(), 'collect-health-'));
const envFile = join(dir, 'engine.env');
writeFileSync(envFile, 'SUPABASE_URL=https://db.invalid\nSUPABASE_SERVICE_ROLE_KEY=test-key\n');
const MONEY = JSON.stringify([
  {
    settlement_failure_rate: 0,
    settlement_window_hands: 10,
    settlement_stuck: 0,
    money_undeclared_triggers: 0,
    financial_alerts_unresolved: 1,
    financial_alerts_stale_critical: 0,
    financial_alerts_distinct_conditions: 1,
    cron_pg_runs: 800,
    cron_pg_failures: 0,
    cron_openclaw_stale: 0,
    cron_openclaw_worst_silence_minutes: 0,
    cron_jobs_skipping_all_work: 0,
  },
]);
const CLIENT = JSON.stringify([
  {
    client_errors_10m: 42,
    client_error_users_10m: 7,
    client_error_top_code_users_10m: 5,
    client_error_top_code: 'ACTION_CONTEXT_REQUIRED',
  },
]);
const bin = join(dir, 'bin');
execFileSync('mkdir', ['-p', bin]);
writeFileSync(
  join(bin, 'curl'),
  `#!/usr/bin/env bash
case "$*" in
  *fn_monitoring_health_snapshot*) printf '%s' '${MONEY}' ;;
  *fn_client_error_health*)
    if [ -n "\${CLIENT_FAILS:-}" ]; then echo 'curl: (22) 404' >&2; exit 22; fi
    printf '%s' '${CLIENT}' ;;
  *) exit 7 ;;
esac
`
);
chmodSync(join(bin, 'curl'), 0o755);

function collect(extra: Record<string, string> = {}): string {
  return execFileSync('bash', [SCRIPT], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      ENGINE_ENV_FILE: envFile,
      DRY_RUN: '1',
      ...extra,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('collect-monitoring-health client error gauges', () => {
  it('renders the three client gauges beside the money gauges', () => {
    const out = collect();
    expect(out).toMatch(/^poker_money_undeclared_triggers 0$/m);
    expect(out).toMatch(/^poker_client_errors_10m 42$/m);
    expect(out).toMatch(/^poker_client_error_users_10m 7$/m);
    expect(out).toMatch(/^poker_client_error_top_code_users_10m 5$/m);
    expect(out).toMatch(/^poker_client_error_collect_ok 1$/m);
  });

  it('a failed client read drops only the client series, never the money gauges', () => {
    const out = collect({ CLIENT_FAILS: '1' });
    expect(out).toMatch(/^poker_money_undeclared_triggers 0$/m);
    expect(out).toMatch(/^poker_health_collected_timestamp_seconds \d+$/m);
    expect(out).not.toMatch(/^poker_client_error_top_code_users_10m/m);
    expect(out).toMatch(/^poker_client_error_collect_ok 0$/m);
  });
});
