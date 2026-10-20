import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const root = process.cwd();
const workflow = parse(
  readFileSync(join(root, '.github/workflows/stage-engine-release.yml'), 'utf8')
);
const admission = workflow.jobs.detect.steps.find((s: { id?: string }) => s.id === 'admission').run;

function admit(event: string, hour: string, message: string, health: string) {
  const dir = mkdtempSync(join(tmpdir(), 'daily-admission-'));
  try {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
      git() { printf '%s' "$MESSAGE"; }
      date() { printf '%s' "$HOUR"; }
      curl() { printf '%s' "$HEALTH"; }
      ${admission}
      cat "$GITHUB_OUTPUT"
    `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          EVENT_NAME: event,
          HOUR: hour,
          MESSAGE: message,
          HEALTH: health,
          GITHUB_OUTPUT: join(dir, 'output'),
        },
      }
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.includes('allowed=true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('daily routine admission uses the existing protected receiver only', () => {
  it('queues ordinary daytime pushes even when they change server code', () => {
    expect(admit('push', '14', 'normal server change', '{"liveness":"ok"}')).toBe(false);
  });
  it('admits only the 03:30 Chicago candidate of the UTC DST pair', () => {
    expect(admit('schedule', '03', 'routine', '{"liveness":"ok"}')).toBe(true);
    expect(admit('schedule', '04', 'routine', '{"liveness":"ok"}')).toBe(false);
    expect(admit('schedule', '02', 'routine', '{"liveness":"ok"}')).toBe(false);
  });
  it('keeps explicit urgency and measured degradation as emergency causes', () => {
    expect(admit('push', '14', 'fix\n\nEngine-Release: urgent', '{}')).toBe(true);
    expect(admit('push', '14', 'routine', '{"liveness":"dead"}')).toBe(true);
    expect(admit('push', '14', 'routine', '{"wholeFleetStalled":true}')).toBe(true);
    expect(admit('push', '14', 'routine', '{"tournamentManagersQuarantined":100}')).toBe(true);
    expect(admit('push', '14', 'routine', '{"tournamentManagersQuarantined":27}')).toBe(false);
    expect(admit('push', '14', 'routine', 'unreadable')).toBe(false);
  });
  it('keeps tournament breaks at :55 independently of global daily maintenance', () => {
    const server = readFileSync(join(root, 'server/src/GameServer.ts'), 'utf8');
    expect(server).toContain('private static readonly BREAK_START_MINUTE = 55;');
    expect(server).toContain('this.scheduleSynchronizedBreaks();');
    expect(server).toContain('nearbyMaintenanceWindows(startAt)');
    const sql = readFileSync(
      join(root, 'supabase/migrations/20261020210313_daily_chicago_maintenance_observation.sql'),
      'utf8'
    );
    expect(sql).toContain('IF v_end IS NULL THEN RETURN NULL; END IF;');
    expect(sql).toContain("IF v_verdict = 'fail' THEN");
    expect(
      readFileSync(join(root, 'scripts/ci/test-on-time-maintenance-thaw.py'), 'utf8')
    ).toContain('scripts/ci/test-daily-maintenance-observation.py');
    expect(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')).toContain(
      'python3 -B scripts/ci/test-on-time-maintenance-thaw.py'
    );
  });
});

const transaction = readFileSync(
  join(root, 'server/scripts/engine-release-transaction.sh'),
  'utf8'
);
const guardAt = transaction.indexOf('# Protect mixed-version rollout too:');
const policy = transaction.slice(guardAt, transaction.indexOf('remaining=int(', guardAt));
function certificatePolicy(at: string, reason: string, transition = false, schedule?: object) {
  const code =
    `import json,sys\nm=json.load(sys.stdin)\n` +
    policy.replace(
      'local=datetime.now(ZoneInfo("America/Chicago"))',
      'local=datetime.fromisoformat(os.environ["FIXTURE_AT"]).astimezone(ZoneInfo("America/Chicago"))'
    );
  return spawnSync('python3', ['-c', code], {
    encoding: 'utf8',
    input: JSON.stringify({ reason, schedule }),
    env: {
      ...process.env,
      FIXTURE_AT: at,
      RECOVERY_URGENT: '0',
      DAILY_TRANSITION: transition ? '1' : '0',
    },
  }).status;
}
describe('routine activation and the owner-approved initial transition stay bounded', () => {
  it('admits routine certificates only at 04:00-04:05 Chicago across DST', () => {
    for (const at of [
      '2026-10-20T09:00:00+00:00',
      '2026-10-20T09:04:59+00:00',
      '2026-11-01T10:00:00+00:00',
    ]) {
      expect(certificatePolicy(at, 'Scheduled Engine Maintenance')).toBe(0);
    }
    for (const at of [
      '2026-10-20T08:59:59+00:00',
      '2026-10-20T09:05:00+00:00',
      '2026-10-20T20:55:00+00:00',
    ]) {
      expect(certificatePolicy(at, 'Scheduled Engine Maintenance')).not.toBe(0);
    }
  });
  it('permits the initial old-engine :55 certificate and closes that exception on the daily engine', () => {
    expect(
      certificatePolicy('2026-10-20T20:55:00+00:00', 'Scheduled Engine Maintenance', true)
    ).toBe(0);
    expect(
      certificatePolicy('2026-10-20T20:54:59+00:00', 'Scheduled Engine Maintenance', true)
    ).not.toBe(0);
    expect(
      certificatePolicy('2026-10-20T20:55:00+00:00', 'Scheduled Engine Maintenance', true, {})
    ).not.toBe(0);
    expect(admit('push', '14', 'Engine-Release: daily-maintenance-transition', '{}')).toBe(true);
    const request = transaction.slice(
      transaction.indexOf('request_recovery_window()'),
      transaction.indexOf('persist_break_deadline()')
    );
    expect(request).not.toContain('DAILY_TRANSITION');
  });
  it('keeps the same schedule policy on both ordinary and immutable-predecessor doors', () => {
    expect(transaction.split('# Protect mixed-version rollout too:')).toHaveLength(3);
    expect(certificatePolicy('2026-10-20T20:20:00+00:00', 'Deployment Recovery')).toBe(0);
    expect(transaction).not.toContain('urgent|engine-degraded|deadline)');
  });
});
