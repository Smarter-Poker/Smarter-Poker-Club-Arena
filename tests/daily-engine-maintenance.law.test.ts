import { queuedDailyRelease } from '../scripts/ci/daily-engine-provenance.mjs';
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

function admit(
  event: string,
  hour: string,
  message: string,
  health: string,
  schedule = '30 8 * * *',
  createdAt = '2026-10-21T08:30:01Z'
) {
  const dir = mkdtempSync(join(tmpdir(), 'daily-admission-'));
  try {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
      git() { printf '%s' "$MESSAGE"; }
      date() { printf '%s' "$HOUR"; }
      gh() { printf '%s' "$RUN_CREATED_AT"; }
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
          SCHEDULE_EXPRESSION: schedule,
          RUN_CREATED_AT: createdAt,
          REPO: 'test/repo',
          RUN_ID: '123',
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
    // The actual runner hour does not change nominal admission.
    expect(admit('schedule', '04', 'routine', '{"liveness":"ok"}')).toBe(true);
    expect(admit('schedule', '14', 'routine', '{"liveness":"ok"}')).toBe(true);
    expect(
      admit('schedule', '03', 'routine', '{"liveness":"ok"}', '30 9 * * *', '2026-10-21T09:30:01Z')
    ).toBe(false);
    expect(
      admit('schedule', '04', 'routine', '{"liveness":"ok"}', '30 9 * * *', '2026-12-21T09:30:01Z')
    ).toBe(true);
    expect(
      admit('schedule', '03', 'routine', '{"liveness":"ok"}', '30 8 * * *', '2026-12-21T08:30:01Z')
    ).toBe(false);
    expect(
      admit('schedule', '04', 'routine', '{"liveness":"ok"}', '30 8 * * *', '2026-03-08T08:30:01Z')
    ).toBe(true);
    expect(
      admit('schedule', '04', 'routine', '{"liveness":"ok"}', '30 9 * * *', '2026-11-01T09:30:01Z')
    ).toBe(true);
    expect(admit('schedule', '04', 'routine', '{"liveness":"ok"}', '30 8 * * *', 'malformed')).toBe(
      false
    );
    expect(
      admit('schedule', '04', 'routine', '{"liveness":"ok"}', '30 8 * * *', '2026-10-22T00:01:00Z')
    ).toBe(false);
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

const dailyHealth = {
  maintenance: {
    schedule: {
      timeZone: 'America/Chicago',
      startHour: 4,
      startMinute: 0,
      hourlyCashFreeze: false,
    },
  },
};
describe('provenance distinguishes a legitimate daily queue from a missed release', () => {
  it('queues daytime changes only until their first eligible window proof deadline', () => {
    const queued = queuedDailyRelease(
      dailyHealth,
      '2026-10-20T15:00:00Z',
      Date.parse('2026-10-20T21:00:00Z')
    );
    expect(queued?.dueAt).toBe(Date.parse('2026-10-21T09:15:00Z'));
    expect(
      queuedDailyRelease(dailyHealth, '2026-10-20T15:00:00Z', Date.parse('2026-10-21T09:15:00Z'))
    ).toBeNull();
  });
  it('respects the03:30 preparation cutoff and Chicago DST', () => {
    expect(
      queuedDailyRelease(dailyHealth, '2026-10-20T08:29:59Z', Date.parse('2026-10-20T08:50:00Z'))
        ?.dueAt
    ).toBe(Date.parse('2026-10-20T09:15:00Z'));
    expect(
      queuedDailyRelease(dailyHealth, '2026-10-20T08:30:01Z', Date.parse('2026-10-20T08:50:00Z'))
        ?.dueAt
    ).toBe(Date.parse('2026-10-21T09:15:00Z'));
    expect(
      queuedDailyRelease(dailyHealth, '2026-10-31T15:00:00Z', Date.parse('2026-11-01T09:00:00Z'))
        ?.dueAt
    ).toBe(Date.parse('2026-11-01T10:15:00Z'));
  });
  it('never grants this envelope to an old engine, missing time or future commit', () => {
    expect(
      queuedDailyRelease({}, '2026-10-20T15:00:00Z', Date.parse('2026-10-20T21:00:00Z'))
    ).toBeNull();
    expect(queuedDailyRelease(dailyHealth, 'unreadable', Date.now())).toBeNull();
    expect(queuedDailyRelease(dailyHealth, '2030-10-20T15:00:00Z', Date.now())).toBeNull();
    const audit = readFileSync(join(root, '.github/scripts/audit-engine-provenance.sh'), 'utf8');
    expect(audit).toContain('git log --reverse --format=%cI "$SERVED..$REQ_SHA"');
    expect(audit).toContain('QUEUED (not deployed)');
    expect(audit).toContain('ENGINE PROVENANCE MISMATCH');
  });
});
