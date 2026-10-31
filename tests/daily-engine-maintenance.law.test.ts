import { queuedDailyRelease } from '../scripts/ci/daily-engine-provenance.mjs';
import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  createdAt = '2026-10-21T08:30:01Z',
  owner?: { windows: string; ancestor: boolean; served?: boolean; witness?: string; floor?: string }
) {
  const dir = mkdtempSync(join(tmpdir(), 'daily-admission-'));
  try {
    // The admission reads server/release/owner-maintenance-windows.json from
    // its checkout; run in an isolated tree so the repository's own live entry
    // can never change these verdicts with the wall clock.
    if (owner) {
      mkdirSync(join(dir, 'server/release'), { recursive: true });
      writeFileSync(join(dir, 'server/release/owner-maintenance-windows.json'), owner.windows);
      if (owner.floor)
        writeFileSync(join(dir, 'server/release/activation-floor.json'), owner.floor);
    }
    const result = spawnSync(
      'bash',
      [
        '-c',
        `
      git() {
        if [ "$1" = merge-base ] && [ "$4" = HEAD ]; then [ "$OWNER_ANCESTOR" = 1 ]; return; fi
        if [ "$1" = merge-base ]; then [ "$OWNER_SERVED" = 1 ]; return; fi
        if [ "$1" = rev-parse ]; then
          [ "$WITNESS_MODE" != unreadable ] || return 128
          if [ "$2" = --is-shallow-repository ]; then
            if [ "$WITNESS_MODE" = shallow ]; then echo true; else echo false; fi
          else printf '%040d' 2; fi
          return
        fi
        if [ "$1" = show ]; then
          [ "$WITNESS_MODE" != missing ] || return 128
          if [ "$WITNESS_MODE" = mismatch ]; then printf changed
          elif [ -n "$FLOOR_JSON" ]; then printf '%s' "$FLOOR_JSON"
          else printf 'fixture SQL\n'; fi
          return
        fi
        if [ "$1" = rev-list ] || { [ "$1" = log ] && [ "$2" = -1 ] && [ "$3" = --format=%H ]; }; then
          [ "$WITNESS_MODE" != unknown-serving ] || return 128
          case "$WITNESS_MODE" in served|deleted) printf '%040d' 1 ;; esac
          return 0
        fi
        printf '%s' "$MESSAGE"
      }
      timeout() { shift 3; shift 3; git "$@"; }
      date() { printf '%s' "$HOUR"; }
      gh() { printf '%s' "$RUN_CREATED_AT"; }
      curl() { printf '%s' "$HEALTH"; }
      ${admission}
      cat "$GITHUB_OUTPUT"
    `,
      ],
      {
        encoding: 'utf8',
        cwd: dir,
        env: {
          ...process.env,
          OWNER_ANCESTOR: owner?.ancestor ? '1' : '0',
          OWNER_SERVED: owner?.served ? '1' : '0',
          WITNESS_MODE: owner?.witness ?? 'unserved',
          FLOOR_JSON: owner?.floor ?? '',
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
  it('refuses commit urgency while retaining measured engine emergencies', () => {
    expect(admit('push', '14', 'fix\n\nEngine-Release: urgent', '{}')).toBe(false);
    expect(admit('push', '14', 'routine', '{"liveness":"dead"}')).toBe(true);
    expect(admit('push', '14', 'routine', '{"wholeFleetStalled":true}')).toBe(true);
    expect(admit('push', '14', 'routine', '{"tournamentManagersQuarantined":100}')).toBe(true);
    expect(admit('push', '14', 'routine', '{"tournamentManagersQuarantined":27}')).toBe(false);
    expect(admit('push', '14', 'routine', 'unreadable')).toBe(false);
  });
  it('admits an explicit owner-ordered window only while it is valid and names a contained commit', () => {
    const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * 60_000).toISOString();
    const doc = (notBefore: string, notAfter: string, contains = 'a'.repeat(40)) =>
      JSON.stringify({
        version: 1,
        windows: [
          { id: 'fixture', ownerOrder: 'Owner order: live now.', contains, notBefore, notAfter },
        ],
      });
    const healthy = `{"liveness":"ok","releaseSha":"${'e'.repeat(40)}"}`;
    const open = doc(iso(-10), iso(60));
    // Once: when the serving engine already contains the commit, nothing more.
    expect(
      admit('push', '14', 'routine', healthy, undefined, undefined, {
        windows: open,
        ancestor: true,
        served: true,
      })
    ).toBe(false);
    expect(
      admit('push', '14', 'routine', '{"liveness":"ok"}', undefined, undefined, {
        windows: open,
        ancestor: true,
      })
    ).toBe(false);
    expect(
      admit('push', '14', 'routine', healthy, undefined, undefined, {
        windows: open,
        ancestor: true,
      })
    ).toBe(true);
    expect(
      admit('push', '14', 'routine', healthy, undefined, undefined, {
        windows: open,
        ancestor: false,
      })
    ).toBe(false);
    for (const closed of [
      doc(iso(-120), iso(-60)),
      doc(iso(30), iso(90)),
      doc(iso(-10), iso(400)),
      doc(iso(-10), iso(60), 'nope'),
      '{"version":2}',
      'not json',
    ]) {
      expect(
        admit('push', '14', 'routine', healthy, undefined, undefined, {
          windows: closed,
          ancestor: true,
        })
      ).toBe(false);
    }
    // Commit text still grants nothing, with or without an owner file.
    expect(
      admit('push', '14', 'fix\n\nEngine-Release: urgent', healthy, undefined, undefined, {
        windows: doc(iso(-120), iso(-60)),
        ancestor: true,
      })
    ).toBe(false);
  });
  it('keeps original-hand recovery admission bound to its unserved feature within the original window', () => {
    const { windows } = JSON.parse(
      readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8')
    );
    const recovery = windows.find(
      (entry: { id: string }) => entry.id === '2026-10-29-original-hand-and-pause-owner-recovery'
    );
    const path = 'supabase/migrations/20261028233353_durable_private_hand_continuation.sql';
    expect(recovery.releaseWitness).toEqual({
      path,
      sha256: createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex'),
    });
    expect(recovery.contains).toBe('ac6a6207042e7671a22803b6e127dbe36afd8e0e');
    expect(recovery.notBefore).toBe('2026-10-29T01:40:00Z');
    expect(recovery.notAfter).toBe('2026-10-29T07:40:00Z');
    expect(recovery.announceAtChicagoMinutes).toEqual([53]);
    expect(recovery.migrations).toEqual([]);
  });
  it('keeps the corrective started-original delivery separate from the consumed first window', () => {
    const { windows } = JSON.parse(
      readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8')
    );
    const recovery = windows.find(
      (entry: { id: string }) => entry.id === '2026-10-29-started-original-actuation-recovery'
    );
    const path =
      'supabase/migrations/20261029064404_continuation_waits_for_a_bounded_maintenance_lane.sql';
    expect(recovery.releaseWitness).toEqual({
      path,
      sha256: createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex'),
    });
    expect(recovery.contains).toBe('ddb62f02f5475538dd07fb6571375d444d1bdd04');
    expect(recovery.notBefore).toBe('2026-10-29T06:35:00Z');
    expect(recovery.notAfter).toBe('2026-10-29T08:50:00Z');
    expect(recovery.announceAtChicagoMinutes).toEqual([53]);
    expect(recovery.migrations).toEqual([]);
    expect(recovery.ownerOrder).toContain('1a2aee9264a6ee30ede540c2655ee32e860a22bf');
    expect(recovery.ownerOrder).toContain('aca0b52c832447c5f0e4636a19a4fcdbe2f1047a');
    expect(recovery.ownerOrder).toContain('full 285-second');
  });
  it('binds the retained checkpoint continuation to its exact guard and a new finite tournament-aligned window', () => {
    const { windows } = JSON.parse(
      readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8')
    );
    const recovery = windows.find(
      (entry: { id: string }) => entry.id === '2026-10-29-retained-original-checkpoint-recovery'
    );
    const path = 'server/scripts/retained-original-checkpoint-guard.mjs';
    expect(recovery.releaseWitness).toEqual({
      path,
      // Expired authority retains its original immutable witness. A later
      // safety correction cannot retarget that historical authorization.
      sha256: '7acf0cb7778fcbbcf382f55a6a5ebd2ae90068af3497c199c1c711db50fa5c32',
    });
    expect(recovery.contains).toBe('aca3bb78ee4821ec425b5acaf303869106b4a21a');
    expect(recovery.notBefore).toBe('2026-10-29T15:20:00Z');
    expect(recovery.notAfter).toBe('2026-10-29T21:20:00Z');
    expect(recovery.announceAtChicagoMinutes).toEqual([53]);
    expect(recovery.migrations).toEqual([]);
  });
  it('bounds the actual shared-deadline correction without changing the earlier expired entry', () => {
    const { windows } = JSON.parse(
      readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8')
    );
    const recovery = windows.find(
      (entry: { id: string }) => entry.id === '2026-10-29-shared-checkpoint-deadline-recovery'
    );
    expect(recovery.contains).toBe('c76abbb7f497bf6e0539d0d54abf638e5cfa52f3');
    expect(recovery.notBefore).toBe('2026-10-29T21:10:00Z');
    expect(recovery.notAfter).toBe('2026-10-30T03:10:00Z');
    expect(recovery.announceAtChicagoMinutes).toEqual([53]);
    expect(recovery.migrations).toEqual([]);
    expect(recovery.releaseWitness).toEqual({
      path: 'server/scripts/retained-original-checkpoint-guard.mjs',
      // This expired record also owns the historical guard, not current bytes.
      sha256: '7acf0cb7778fcbbcf382f55a6a5ebd2ae90068af3497c199c1c711db50fa5c32',
    });
    expect(recovery.ownerOrder).toContain('five seconds reserved for cleanup');
    expect(recovery.ownerOrder).toContain('Do not attach to or close a foreign inspector');
  });
  it('binds the single MTT incident activation to its protected feature without extending timing', () => {
    const { windows } = JSON.parse(
      readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8')
    );
    const entry = windows.find(
      (w: { id: string }) => w.id === '2026-10-29-mtt-registration-half-before-start'
    );
    expect(entry.contains).toBe('8d34e9c06efa21adc71dc343c57113d447913889');
    expect(entry.notBefore).toBe('2026-10-29T21:25:00Z');
    expect(entry.notAfter).toBe('2026-10-30T03:25:00Z');
    expect(entry.announceAtChicagoMinutes).toEqual([53]);
    expect(entry.migrations).toEqual([]);
    expect(entry.releaseWitness).toBeUndefined();
    // Exercise the real admission shell with an unserved/served feature. Only
    // isolated fixture times move, so this regression remains valid after expiry.
    const fixture = JSON.stringify({
      version: 1,
      windows: [
        {
          ...entry,
          notBefore: new Date(Date.now() - 60_000).toISOString(),
          notAfter: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    const healthy = JSON.stringify({
      liveness: 'ok',
      releaseSha: 'ea9c894938e383c4b08b3f4fae965e93e8fde87d',
    });
    expect(
      admit('push', '18', 'routine', healthy, undefined, undefined, {
        windows: fixture,
        ancestor: true,
        served: false,
      })
    ).toBe(true);
    expect(
      admit('push', '18', 'routine', healthy, undefined, undefined, {
        windows: fixture,
        ancestor: true,
        served: true,
      })
    ).toBe(false);
    expect(
      admit('push', '18', 'routine', healthy, undefined, undefined, {
        windows: fixture,
        ancestor: false,
        served: false,
      })
    ).toBe(false);
  });
  it('bounds the channel-admission owner order to one qualified tournament-aligned cutover', () => {
    const { windows } = JSON.parse(
      readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8')
    );
    const matching = windows.filter(
      (w: { id: string }) => w.id === '2026-10-30-channel-admission-next-55'
    );
    expect(matching).toHaveLength(1);
    const [entry] = matching;
    expect(entry.contains).toBe('97bcce289707e58d682d25654a5978a34327bf79');
    expect(entry.notBefore).toBe('2026-10-30T13:40:00Z');
    expect(entry.notAfter).toBe('2026-10-30T15:00:00Z');
    expect(entry.announceAtChicagoMinutes).toEqual([53]);
    expect(entry.migrations).toEqual([]);
    expect(entry.releaseWitness).toBeUndefined();
    expect(entry.ownerOrder).toContain('DO THE CUT OVER AT THE NEXT :55 BREAK');
    expect(entry.ownerOrder).toContain('full 285-second');
    // This historical order records the reviewed cutover bytes; a later legitimate
    // ChannelHub change must not rewrite the owner's original instruction.
    expect(entry.ownerOrder).toContain(
      'c5b7eec46dc5afbb05eebe6584a4630b0f674e9ba7be00ba709df1f5b1b0293a'
    );
    const fixture = JSON.stringify({
      version: 1,
      windows: [
        {
          ...entry,
          notBefore: new Date(Date.now() - 60_000).toISOString(),
          notAfter: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    const healthy = JSON.stringify({ liveness: 'ok', releaseSha: 'e'.repeat(40) });
    for (const [ancestor, served, expected] of [
      [true, false, true],
      [true, true, false],
      [false, false, false],
    ])
      expect(
        admit('push', '18', 'routine', healthy, undefined, undefined, {
          windows: fixture,
          ancestor,
          served,
        })
      ).toBe(expected);
  });
  it('binds the safe channel continuation to its own floor and refuses consumed or foreign authority', () => {
    const { windows } = JSON.parse(
      readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8')
    );
    const matches = windows.filter(
      (w: { id: string }) => w.id === '2026-10-30-channel-admission-safe-55-continuation'
    );
    expect(matches).toHaveLength(1);
    const [entry] = matches;
    expect(entry.contains).toBe('97bcce289707e58d682d25654a5978a34327bf79');
    expect(entry.notBefore).toBe('2026-10-30T14:10:00Z');
    expect(entry.notAfter).toBe('2026-10-30T16:05:00Z');
    expect(entry.announceAtChicagoMinutes).toEqual([53]);
    expect(entry.migrations).toEqual([]);
    // This historical witness stays fixed when a future owner changes the floor.
    expect(entry.releaseWitness).toEqual({
      path: 'server/release/activation-floor.json',
      sha256: '1fc1b58a044e79acce20e21c8b12ef27aa674bfd46b0831dacec39ae84f3a92e',
    });
    const notBefore = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const notAfter = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const floor = JSON.stringify({
      schema: 'engine-release-activation-floor/v2-owner-window',
      preparationAt: notBefore,
      activationAt: notBefore,
      expiresAt: notAfter,
      timeZone: 'America/Chicago',
      ownerWindowId: entry.id,
      clientPublicationAt: notBefore,
    });
    const fixture = {
      ...entry,
      notBefore,
      notAfter,
      releaseWitness: {
        ...entry.releaseWitness,
        sha256: createHash('sha256').update(floor).digest('hex'),
      },
    };
    const check = (w = fixture, mode = 'unserved', source = floor) =>
      admit(
        'push',
        '14',
        'routine',
        JSON.stringify({ liveness: 'ok', releaseSha: 'e'.repeat(40) }),
        undefined,
        undefined,
        {
          windows: JSON.stringify({ version: 1, windows: [w] }),
          ancestor: true,
          served: true,
          witness: mode,
          floor: source,
        }
      );
    // An old floor path in the serving base is not this exact new floor blob.
    expect(check()).toBe(true);
    // Preserve actual merged ordering for the currently selected floor. A
    // historical channel order retains its own isolated refusal cases below.
    const currentFloor = JSON.parse(
      readFileSync(join(root, 'server/release/activation-floor.json'), 'utf8')
    );
    const selected = windows.find((w: { id: string }) => w.id === currentFloor.ownerWindowId);
    expect(selected).toBeDefined();
    const selectedFloor = JSON.stringify({
      ...currentFloor,
      preparationAt: notBefore,
      activationAt: notBefore,
      expiresAt: notAfter,
      clientPublicationAt: notBefore,
    });
    const ordered = windows.map((w: { id: string }) =>
      w.id === selected.id
        ? {
            ...selected,
            notBefore,
            notAfter,
            releaseWitness: {
              ...selected.releaseWitness,
              sha256: createHash('sha256').update(selectedFloor).digest('hex'),
            },
          }
        : w
    );
    expect(
      admit(
        'push',
        '14',
        'routine',
        JSON.stringify({ liveness: 'ok', releaseSha: 'e'.repeat(40) }),
        undefined,
        undefined,
        {
          windows: JSON.stringify({ version: 1, windows: ordered }),
          ancestor: true,
          served: true,
          witness: 'unserved',
          floor: selectedFloor,
        }
      )
    ).toBe(true);
    for (const mode of ['served', 'deleted', 'unknown-serving', 'shallow', 'missing', 'mismatch'])
      expect(check(fixture, mode), mode).toBe(false);
    expect(check({ ...fixture, id: 'foreign-owner' })).toBe(false);
    expect(
      check({ ...fixture, releaseWitness: { ...fixture.releaseWitness, sha256: 'f'.repeat(64) } })
    ).toBe(false);
  });
  it('binds a witness to exact target bytes and full unserved history rather than a shared base', () => {
    const witness = {
      path: 'supabase/migrations/20261028171228_fixture_rebuy.sql',
      sha256: createHash('sha256').update('fixture SQL\n').digest('hex'),
    };
    const doc = (releaseWitness: unknown = witness) =>
      JSON.stringify({
        version: 1,
        windows: [
          {
            id: 'legacy-first',
            ownerOrder: 'Independent legacy owner order.',
            contains: 'a'.repeat(40),
            notBefore: new Date(Date.now() - 60_000).toISOString(),
            notAfter: new Date(Date.now() + 60_000).toISOString(),
          },
          {
            id: 'fixture',
            ownerOrder: 'Owner order: live now.',
            contains: 'a'.repeat(40),
            notBefore: new Date(Date.now() - 60_000).toISOString(),
            notAfter: new Date(Date.now() + 60_000).toISOString(),
            releaseWitness,
          },
        ],
      });
    const check = (mode: string, windows = doc(), ancestor = true, served = true) =>
      admit(
        'push',
        '14',
        'routine',
        `{"liveness":"ok","releaseSha":"${'e'.repeat(40)}"}`,
        undefined,
        undefined,
        { windows, ancestor, served, witness: mode }
      );
    // Only this exact maintained bootstrap source may be a non-migration
    // feature witness. Its bytes and unserved history keep the same once rule.
    const guardWitness = {
      ...witness,
      path: 'server/scripts/retained-original-checkpoint-guard.mjs',
    };
    expect(check('unserved', doc(guardWitness))).toBe(true);
    for (const mode of ['served', 'deleted', 'mismatch', 'unreadable'])
      expect(check(mode, doc(guardWitness)), mode).toBe(false);
    expect(check('unserved', doc({ ...guardWitness, path: guardWitness.path + '.other' }))).toBe(
      false
    );
    expect(
      check('unserved', doc({ ...guardWitness, path: 'server/scripts/other-guard.mjs' }))
    ).toBe(false);
    // The peer has our shared base, but has never contained our actual feature.
    expect(check('unserved')).toBe(true);
    // A consumed specific order does not revoke an independent legacy order.
    expect(check('served', doc(), true, false)).toBe(true);
    // Unknown selected feature authority must not fall through to that order.
    expect(check('unreadable', doc(), true, false)).toBe(false);
    for (const mode of [
      'served',
      'deleted',
      'unreadable',
      'shallow',
      'missing',
      'mismatch',
      'unknown-serving',
    ])
      expect(check(mode), mode).toBe(false);
    expect(check('unserved', doc(), false)).toBe(false);
    for (const invalid of [
      null,
      {},
      { ...witness, path: '../escape.sql' },
      { ...witness, sha256: 'bad' },
      { ...witness, extra: true },
    ])
      expect(check('unserved', doc(invalid), true, false), JSON.stringify(invalid)).toBe(false);
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
function certificatePolicy(
  at: string,
  reason: string,
  transition = false,
  schedule?: object,
  legacyUrgent = false
) {
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
      RECOVERY_URGENT: legacyUrgent ? '1' : '0',
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
  it('refuses a legacy urgency flag as off-cycle certificate authority', () => {
    expect(
      certificatePolicy(
        '2026-10-23T05:08:37+00:00',
        'Scheduled Engine Maintenance',
        false,
        undefined,
        true
      )
    ).not.toBe(0);
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

const receiver = parse(
  readFileSync(join(root, '.github/workflows/auto-deploy-hetzner.yml'), 'utf8')
);
const liveProof = receiver.jobs.deploy.steps
  .find((s: { id?: string }) => s.id === 'verify')
  .run.split("<<'PYTHON'\n")[1]
  .split('\nPYTHON')[0];

it('proves installed routine refusal during the existing countdown without requiring an early thaw', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import io, urllib.request
urllib.request.urlopen = lambda *args, **kwargs: io.BytesIO(b'{"running":true,"liveness":"ok","wholeFleetStalled":false,"tournamentManagersQuarantined":0,"maintenance":{"active":true}}')
${liveProof}
`,
      join(root, 'server/scripts/engine-release-transaction.sh'),
    ],
    { encoding: 'utf8' }
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('refuses legacy urgency against live healthy play');
});

it('every declared source witness is supported by the installed stage and host admission', () => {
  const document = JSON.parse(
    readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8')
  );
  for (const window of document.windows) {
    if (!Object.hasOwn(window, 'releaseWitness')) continue;
    expect(Object.keys(window.releaseWitness).sort(), window.id).toEqual(['path', 'sha256']);
    if (window.releaseWitness.path === 'server/release/activation-floor.json') {
      const raw = readFileSync(join(root, window.releaseWitness.path));
      const floor = JSON.parse(raw.toString());
      expect(floor.schema).toBe('engine-release-activation-floor/v2-owner-window');
      expect(window.releaseWitness.sha256, window.id).toMatch(/^[0-9a-f]{64}$/);
      if (window.id === floor.ownerWindowId) {
        expect(window.releaseWitness.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
        expect(window.notBefore).toBe(floor.activationAt);
        expect(window.notAfter).toBe(floor.expiresAt);
      } else {
        // Historical immutable requests retain their own witness and expiry.
        // Stage/host admission never treats it as the currently selected floor.
        expect(window.releaseWitness.sha256).not.toBe(
          createHash('sha256').update(raw).digest('hex')
        );
        // Independent historical owners may have later expiry bounds; their
        // immutable witness never grants the currently selected floor authority.
      }
      expect(admission).toContain('floor_witness');
      expect(admission).toContain('--find-object=');
      continue;
    }
    expect(window.releaseWitness.path, window.id).toMatch(
      /^(?:supabase\/migrations\/[0-9]{14}_[a-z0-9_]+\.sql|server\/scripts\/retained-original-checkpoint-guard\.mjs)$/
    );
    expect(window.releaseWitness.sha256, window.id).toMatch(/^[0-9a-f]{64}$/);
  }
});
