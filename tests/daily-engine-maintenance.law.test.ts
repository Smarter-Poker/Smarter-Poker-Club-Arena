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
    for (const mutation of [{ schema: 'invalid' }, { ownerWindowId: '?' }])
      expect(
        check(fixture, 'unserved', JSON.stringify({ ...JSON.parse(floor), ...mutation }))
      ).toBe(false);
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

it('binds the new frozen-recovery hold-ownership carrier without rewriting prior authority', () => {
  const raw = readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8');
  const doc = JSON.parse(raw);
  const id = '2026-10-31-cashier-frozen-recovery-hold-ownership-next-55';
  const entry = doc.windows.find((w: { id: string }) => w.id === id);
  expect(doc.windows.length).toBeGreaterThanOrEqual(59);
  expect(doc.windows.filter((w: { id: string }) => w.id === id)).toHaveLength(1);
  expect(entry.id).toBe(id);
  const marker = ',\n    {\n      "id": "' + id + '"';
  expect(raw.split(marker)).toHaveLength(2);
  expect(
    createHash('sha256')
      .update(raw.slice(0, raw.indexOf(marker)))
      .digest('hex')
  ).toBe('8bf3242602ca15642cdde1d3400cdc002aa6366efd70526495744065deea2c8e');
  expect(doc.databaseWindows.length).toBeGreaterThanOrEqual(3);
  expect(
    createHash('sha256')
      .update(JSON.stringify(doc.databaseWindows.slice(0, 3)))
      .digest('hex')
  ).toBe('c1aabc10442b0299731ea9d1fae5bd8e4c94b42cb21bde52fb03271ae5b81bb9');
  const floorRaw = readFileSync(join(root, 'server/release/activation-floor.json'));
  const currentFloor = JSON.parse(floorRaw.toString());
  if (currentFloor.ownerWindowId === id)
    expect(currentFloor).toEqual({
      schema: 'engine-release-activation-floor/v2-owner-window',
      preparationAt: '2026-10-31T00:20:00Z',
      activationAt: '2026-10-31T00:20:00Z',
      expiresAt: '2026-10-31T03:10:00Z',
      timeZone: 'America/Chicago',
      ownerWindowId: id,
      clientPublicationAt: '2026-10-31T00:20:00Z',
    });
  expect(entry.notBefore).toBe('2026-10-31T00:20:00Z');
  expect(entry.notAfter).toBe('2026-10-31T03:10:00Z');
  expect(entry.announceAtChicagoMinutes).toEqual([53]);
  expect(entry.contains).toBe('671f7741c4302f92c3487a8cccf32a9ef17c3140');
  expect(entry.migrations).toEqual([]);
  expect(entry.releaseWitness).toEqual({
    path: 'server/release/activation-floor.json',
    sha256: '626eabb5a81a572158beef4982a82cf8d0e9a9815d48d587701cf250c53a9fab',
  });
  if (currentFloor.ownerWindowId === id)
    expect(entry.releaseWitness.sha256).toBe(createHash('sha256').update(floorRaw).digest('hex'));
  for (const proof of [
    'b8e43e73864d46db088096474d0334f22076e83c1ce70b8a50c382a3a2cae312',
    '401a15fa30f663b8614cf962ed4650c7f55927d29705ab9bdef9dac0638ee6e4',
    '8ee8d46e5e8045ca727ea7684a3474c3',
    'current-head checks',
    'EED33',
    'OWN healthy v3 thaw',
    'no future automatic extension',
  ])
    expect(entry.ownerOrder).toContain(proof);
});

it('binds the renewed MTT outage delivery without extending or rewriting earlier authority', () => {
  const raw = readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8');
  const doc = JSON.parse(raw);
  const id = '2026-10-31-mtt-action-outage-next-safe-break';
  const matching = doc.windows.filter((w: { id: string }) => w.id === id);
  expect(matching).toHaveLength(1);
  const [entry] = matching;
  // Pin the exact preceding 59 records, including formatting and order.
  const marker = ',\n    {\n      "id": "' + id + '"';
  expect(raw.split(marker)).toHaveLength(2);
  expect(doc.windows.findIndex((w: { id: string }) => w.id === id)).toBe(59);
  expect(
    createHash('sha256')
      .update(raw.slice(0, raw.indexOf(marker)))
      .digest('hex')
  ).toBe('c01e63f3c8b0262b93f33aef104eb64e79bd716a3ac04807692824630eea8c23');
  expect(
    createHash('sha256')
      .update(JSON.stringify(doc.databaseWindows.slice(0, 3)))
      .digest('hex')
  ).toBe('c1aabc10442b0299731ea9d1fae5bd8e4c94b42cb21bde52fb03271ae5b81bb9');
  expect(entry.contains).toBe('671f7741c4302f92c3487a8cccf32a9ef17c3140');
  expect(entry.notBefore).toBe('2026-10-31T02:46:00Z');
  expect(entry.notAfter).toBe('2026-10-31T04:10:00Z');
  expect(entry.announceAtChicagoMinutes).toEqual([53]);
  expect(entry.migrations).toEqual([]);
  expect(entry.releaseWitness).toEqual({
    path: 'server/release/activation-floor.json',
    sha256: 'a00a089a3cb49987e14db2c0d5fe4c230109c9f8852bfe59764040f323c74f73',
  });
  const floorRaw = readFileSync(join(root, 'server/release/activation-floor.json'));
  const floor = JSON.parse(floorRaw.toString());
  if (floor.ownerWindowId === id) {
    expect(floor).toEqual({
      schema: 'engine-release-activation-floor/v2-owner-window',
      preparationAt: entry.notBefore,
      activationAt: entry.notBefore,
      expiresAt: entry.notAfter,
      timeZone: 'America/Chicago',
      ownerWindowId: id,
      clientPublicationAt: entry.notBefore,
    });
    expect(entry.releaseWitness).toEqual({
      path: 'server/release/activation-floor.json',
      sha256: createHash('sha256').update(floorRaw).digest('hex'),
    });
  }
  for (const safeguard of [
    'current-head checks',
    'EED33',
    '29 runtime pins',
    'full285s reserve',
    'OWN healthy v3 thaw',
    'one actual activation maximum',
    'automatic extension',
  ])
    expect(entry.ownerOrder).toContain(safeguard);
});

it('binds a distinct qualified next-break carrier and preserves Diamond operator closure', () => {
  const raw = readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8');
  const doc = JSON.parse(raw);
  const id = '2026-10-31-mtt-action-outage-qualified-next-break';
  const marker = ',\n    {\n      "id": "' + id + '"';
  expect(raw.split(marker)).toHaveLength(2);
  expect(doc.windows.findIndex((w: { id: string }) => w.id === id)).toBe(60);
  expect(
    createHash('sha256')
      .update(raw.slice(0, raw.indexOf(marker)))
      .digest('hex')
  ).toBe('65d83df32769560949ac3abaf141a9d207e3bc41891056706524bcbb2f740045');
  expect(
    createHash('sha256')
      .update(raw.slice(raw.indexOf('  "databaseWindows"')))
      .digest('hex')
  ).toBe('b42eb3dd7b76725a8fb83d8282cfd599a7edc2c3b5a6d3ddb6a70f075fd18ca1');
  const entry = doc.windows[60];
  expect(entry.contains).toBe('280303d1e569344c837780b0605f95c5b00e687b');
  expect(entry.notBefore).toBe('2026-10-31T03:53:00Z');
  expect(entry.notAfter).toBe('2026-10-31T05:10:00Z');
  expect(entry.announceAtChicagoMinutes).toEqual([53]);
  expect(entry.migrations).toEqual([]);
  // Historical carrier bytes remain pinned after the next distinct carrier.
  const floorRaw = Buffer.from(
    JSON.stringify(
      {
        schema: 'engine-release-activation-floor/v2-owner-window',
        preparationAt: entry.notBefore,
        activationAt: entry.notBefore,
        expiresAt: entry.notAfter,
        timeZone: 'America/Chicago',
        ownerWindowId: id,
        clientPublicationAt: entry.notBefore,
      },
      null,
      2
    ) + '\n'
  );
  expect(JSON.parse(floorRaw.toString())).toEqual({
    schema: 'engine-release-activation-floor/v2-owner-window',
    preparationAt: entry.notBefore,
    activationAt: entry.notBefore,
    expiresAt: entry.notAfter,
    timeZone: 'America/Chicago',
    ownerWindowId: id,
    clientPublicationAt: entry.notBefore,
  });
  expect(entry.releaseWitness).toEqual({
    path: 'server/release/activation-floor.json',
    sha256: 'c3ffe90a717270b0af30a7b306e72877bb48b338b3b16fa612d1d68126da15ed',
  });
  expect(createHash('sha256').update(floorRaw).digest('hex')).toBe(entry.releaseWitness.sha256);
  for (const safeguard of [
    'current-head checks',
    'EED33',
    '29 runtime pins',
    'full285s reserve',
    'OWN healthy v3 thaw',
    'one actual activation maximum',
    'INSTALLED migration20261030235825',
    'KEEP DIAMOND CLOSED',
    '01a18fed-2211-7a62-9416-611dd6e4d96d',
    'not Diamond resumed play',
  ])
    expect(entry.ownerOrder).toContain(safeguard);
});

it('binds the bounded-census correction without extending or retrying its failed predecessor', () => {
  const raw = readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8');
  const doc = JSON.parse(raw);
  const id = '2026-10-31-mtt-bounded-census-recovery-next-break';
  const marker = ',\n    {\n      "id": "' + id + '"';
  expect(raw.split(marker)).toHaveLength(2);
  expect(doc.windows.findIndex((w: { id: string }) => w.id === id)).toBe(61);
  expect(
    createHash('sha256')
      .update(raw.slice(0, raw.indexOf(marker)))
      .digest('hex')
  ).toBe('396a5fc264489164982c217e93db2c0847ae16befdb52c8834e0afdf46089378');
  expect(
    createHash('sha256')
      .update(raw.slice(raw.indexOf('  "databaseWindows"')))
      .digest('hex')
  ).toBe('b42eb3dd7b76725a8fb83d8282cfd599a7edc2c3b5a6d3ddb6a70f075fd18ca1');
  const entry = doc.windows[61];
  expect(entry.contains).toBe('976850bec328ac8b80d47603f18fcba81e05534f');
  expect(entry.notBefore).toBe('2026-10-31T05:04:00Z');
  expect(entry.notAfter).toBe('2026-10-31T06:10:00Z');
  expect(entry.announceAtChicagoMinutes).toEqual([53]);
  expect(entry.migrations).toEqual([]);
  const currentFloorRaw = readFileSync(join(root, 'server/release/activation-floor.json'));
  const floorRaw = Buffer.from(
    JSON.stringify(
      {
        schema: 'engine-release-activation-floor/v2-owner-window',
        preparationAt: entry.notBefore,
        activationAt: entry.notBefore,
        expiresAt: entry.notAfter,
        timeZone: 'America/Chicago',
        ownerWindowId: id,
        clientPublicationAt: entry.notBefore,
      },
      null,
      2
    ) + '\n'
  );
  if (JSON.parse(currentFloorRaw.toString()).ownerWindowId === id)
    expect(currentFloorRaw.equals(floorRaw)).toBe(true);
  expect(JSON.parse(floorRaw.toString())).toEqual({
    schema: 'engine-release-activation-floor/v2-owner-window',
    preparationAt: entry.notBefore,
    activationAt: entry.notBefore,
    expiresAt: entry.notAfter,
    timeZone: 'America/Chicago',
    ownerWindowId: id,
    clientPublicationAt: entry.notBefore,
  });
  expect(entry.releaseWitness).toEqual({
    path: 'server/release/activation-floor.json',
    sha256: '2d48ff686d45588a0b3ccea58eab630f87962da1d58fd8a2c4714e9bc327737b',
  });
  expect(createHash('sha256').update(floorRaw).digest('hex')).toBe(entry.releaseWitness.sha256);
  for (const safeguard of [
    'current-head checks',
    'EED33',
    '29 runtime pins',
    'full285s reserve',
    'OWN healthy v3 thaw',
    'one actual activation maximum',
    'retryAllowedfalse',
    'loaded Linux Node22.23.2',
    'all-parent restoration',
    'disableBreaks',
    'KEEP DIAMOND CLOSED',
    '01a18fed-2211-7a62-9416-611dd6e4d96d',
    'not Diamond resumed play',
    'automatic extension',
  ])
    expect(entry.ownerOrder).toContain(safeguard);
});

it('binds a distinct Cashier original-cohort census carrier while preserving historical authority', () => {
  const raw = readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8');
  const doc = JSON.parse(raw);
  const id = '2026-10-31-cashier-original-cohort-safe-census-cutover';
  const matches = doc.windows.filter((w: { id: string }) => w.id === id);
  expect(matches).toHaveLength(1);
  expect(doc.windows.length).toBeGreaterThanOrEqual(63);
  expect(doc.windows.findIndex((w: { id: string }) => w.id === id)).toBe(62);
  const entry = matches[0];
  const marker = ',\n    {\n      "id": "' + id + '"';
  expect(raw.split(marker)).toHaveLength(2);
  expect(
    createHash('sha256')
      .update(raw.slice(0, raw.indexOf(marker)))
      .digest('hex')
  ).toBe('a285959ae407886721edc1bbef1137ea7a48a121aa862088b6f52cc1f39fa2b2');
  expect(doc.databaseWindows.length).toBeGreaterThanOrEqual(3);
  expect(
    createHash('sha256')
      .update(JSON.stringify(doc.databaseWindows.slice(0, 3)))
      .digest('hex')
  ).toBe('c1aabc10442b0299731ea9d1fae5bd8e4c94b42cb21bde52fb03271ae5b81bb9');
  expect(entry.contains).toBe('976850bec328ac8b80d47603f18fcba81e05534f');
  expect(entry.notBefore).toBe('2026-10-31T06:00:00Z');
  expect(entry.notAfter).toBe('2026-10-31T08:10:00Z');
  expect(entry.announceAtChicagoMinutes).toEqual([53]);
  expect(entry.migrations).toEqual([]);
  const historicalFloor = Buffer.from(
    JSON.stringify(
      {
        schema: 'engine-release-activation-floor/v2-owner-window',
        preparationAt: entry.notBefore,
        activationAt: entry.notBefore,
        expiresAt: entry.notAfter,
        timeZone: 'America/Chicago',
        ownerWindowId: id,
        clientPublicationAt: entry.notBefore,
      },
      null,
      2
    ) + '\n'
  );
  expect(entry.releaseWitness).toEqual({
    path: 'server/release/activation-floor.json',
    sha256: '6008a4314d7a80e77ad0df28c6cc4dd83777ab813f3e66192108be25e063b0ac',
  });
  expect(createHash('sha256').update(historicalFloor).digest('hex')).toBe(
    entry.releaseWitness.sha256
  );
  const currentFloor = readFileSync(join(root, 'server/release/activation-floor.json'));
  if (JSON.parse(currentFloor.toString()).ownerWindowId === id)
    expect(currentFloor.equals(historicalFloor)).toBe(true);
  for (const proof of [
    'PROTECTED inclusion of PR8853',
    'current-head checks',
    '35-million-object',
    'all-parent restoration',
    'disableBreaks',
    'EED33',
    'full285s reserve',
    'OWN healthy v3 thaw',
    'one actual activation maximum',
    'no automatic extension',
    'original15/128/110',
    'KEEP DIAMOND CLOSED',
  ])
    expect(entry.ownerOrder).toContain(proof);
});

it('binds the independent Horse input correction to one new qualified tournament-aligned activation', () => {
  const raw = readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8');
  const doc = JSON.parse(raw);
  const id = '2026-10-31-horse-input-attribution-qualified-next-55';
  const marker = ',\n    {\n      "id": "' + id + '"';
  expect(raw.split(marker)).toHaveLength(2);
  expect(doc.windows.findIndex((w: { id: string }) => w.id === id)).toBe(63);
  expect(
    createHash('sha256')
      .update(raw.slice(0, raw.indexOf(marker)))
      .digest('hex')
  ).toBe('bec8a5de78129d4e67b19deda54811172a30d8b70af77d54df4e340ecc38d9dd');
  expect(
    createHash('sha256')
      .update(raw.slice(raw.indexOf('  "databaseWindows"')))
      .digest('hex')
  ).toBe('b42eb3dd7b76725a8fb83d8282cfd599a7edc2c3b5a6d3ddb6a70f075fd18ca1');
  const entry = doc.windows[63];
  expect(entry.contains).toBe('2f9ca8db67acdcdeb02e0da8c261570d2d87e2e9');
  expect(entry.notBefore).toBe('2026-10-31T05:10:00Z');
  expect(entry.notAfter).toBe('2026-10-31T07:10:00Z');
  expect(entry.announceAtChicagoMinutes).toEqual([53]);
  expect(entry.migrations).toEqual([]);
  expect(entry.releaseWitness).toEqual({
    path: 'server/release/activation-floor.json',
    sha256: '1bc98b68090b4be486d2d062ebca013b5abbf77e8cbdc3f17f13bf14617b7ea1',
  });
  const floorRaw = readFileSync(join(root, 'server/release/activation-floor.json'));
  const floor = JSON.parse(floorRaw.toString());
  if (floor.ownerWindowId === id) {
    expect(floor).toEqual({
      schema: 'engine-release-activation-floor/v2-owner-window',
      preparationAt: entry.notBefore,
      activationAt: entry.notBefore,
      expiresAt: entry.notAfter,
      timeZone: 'America/Chicago',
      ownerWindowId: id,
      clientPublicationAt: entry.notBefore,
    });
    expect(createHash('sha256').update(floorRaw).digest('hex')).toBe(entry.releaseWitness.sha256);
  }
  for (const announcement of ['2026-10-31T05:53:59.999Z', '2026-10-31T06:53:59.999Z']) {
    expect(Date.parse(announcement)).toBeGreaterThanOrEqual(Date.parse(entry.notBefore));
    expect(Date.parse(entry.notAfter) - Date.parse(announcement)).toBeGreaterThanOrEqual(420_000);
  }
  for (const safeguard of [
    'actual protected inclusion',
    'current-head required checks',
    'EED33',
    '29 runtime pins',
    'actual terminal readback',
    'source-bound cleanup/disposition',
    'supported owning correction and exact qualification',
    'or authoritative evidence resolving the known976 legacy heap lookup timeout and cleanup failure',
    'a new window or mere old-lease cleanup is not a retry reason',
    'before any new host operation',
    '120s notice',
    '300s durable freeze',
    'full285s reserve',
    '40s checkpoint including5s cleanup',
    '245s post-checkpoint proof',
    '135s rollback reserve',
    'one actual activation maximum',
    'complete OWN healthy v3 thaw',
    'no arbitrary-minute restart',
    'automatic extension',
    'NEVER replay an installed migration',
    'KEEP DIAMOND CLOSED',
    '01a18fed-2211-7a62-9416-611dd6e4d96d',
    'every canonical index0-999',
  ])
    expect(entry.ownerOrder).toContain(safeguard);
});

it('binds the manually resumed MTT continuation without renewing any historical window', () => {
  const raw = readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8');
  const doc = JSON.parse(raw);
  const id = '2026-10-31-mtt-manual-safe-drain-continuation';
  const entry = doc.windows.find((w: { id: string }) => w.id === id);
  expect(doc.windows.filter((w: { id: string }) => w.id === id)).toHaveLength(1);
  expect(doc.windows[64]).toEqual(entry);
  expect(entry.contains).toBe('941a3b5f72300cd1d3f03c262eb22388fcb93e13');
  expect(entry.announceAtChicagoMinutes).toEqual([53]);
  expect(entry.migrations).toEqual([]);
  expect(entry.notBefore).toBe('2026-10-31T09:10:00Z');
  expect(entry.notAfter).toBe('2026-10-31T12:10:00Z');
  const expectedFloor = Buffer.from(
    JSON.stringify(
      {
        schema: 'engine-release-activation-floor/v2-owner-window',
        preparationAt: entry.notBefore,
        activationAt: entry.notBefore,
        expiresAt: entry.notAfter,
        timeZone: 'America/Chicago',
        ownerWindowId: id,
        clientPublicationAt: entry.notBefore,
      },
      null,
      2
    ) + '\n'
  );
  expect(entry.releaseWitness).toEqual({
    path: 'server/release/activation-floor.json',
    sha256: createHash('sha256').update(expectedFloor).digest('hex'),
  });
  const selected = readFileSync(join(root, 'server/release/activation-floor.json'));
  if (JSON.parse(selected.toString()).ownerWindowId === id) expect(selected).toEqual(expectedFloor);
  // Exact original bytes, not merely equivalent parsed historical authorizations.
  const start = raw.indexOf(',\n    {\n      "id": "' + id + '"');
  const end = raw.indexOf('\n  ],\n  "databaseWindows":', start);
  expect(start).toBeGreaterThan(0);
  const historical = raw.slice(0, start) + raw.slice(end);
  expect(createHash('sha256').update(historical).digest('hex')).toBe(
    '4326daa858be30bd4a43afb08399782bb41598e8245f831c476e80d24c499a65'
  );
  for (const boundary of [
    'NEW manual continuation',
    'timestamps are not a quotation',
    'typed retirement',
    'UNKNOWN',
    'Diamond remains closed',
    'ONE actual activation',
    '120s',
    '300s',
    '285s',
    '245s',
    '135s',
    '40s',
    '5s cleanup',
    '20s MAIN',
    'full 5s remote-close',
    'v3 thaw',
    'migration/payment replay',
  ])
    expect(entry.ownerOrder).toContain(boundary);
});

it('binds the noon manual continuation while preserving the expired unpushed carrier', () => {
  const raw = readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8');
  const doc = JSON.parse(raw);
  const id = '2026-10-31-mtt-manual-noon-safe-drain-continuation';
  const entry = doc.windows.find((w: { id: string }) => w.id === id);
  expect(doc.windows.filter((w: { id: string }) => w.id === id)).toHaveLength(1);
  expect(doc.windows[65]).toEqual(entry);
  expect(entry.contains).toBe('941a3b5f72300cd1d3f03c262eb22388fcb93e13');
  expect(entry.announceAtChicagoMinutes).toEqual([53]);
  expect(entry.migrations).toEqual([]);
  expect(entry.notBefore).toBe('2026-10-31T12:20:00Z');
  expect(entry.notAfter).toBe('2026-10-31T15:20:00Z');
  const expectedFloor = Buffer.from(
    JSON.stringify(
      {
        schema: 'engine-release-activation-floor/v2-owner-window',
        preparationAt: entry.notBefore,
        activationAt: entry.notBefore,
        expiresAt: entry.notAfter,
        timeZone: 'America/Chicago',
        ownerWindowId: id,
        clientPublicationAt: entry.notBefore,
      },
      null,
      2
    ) + '\n'
  );
  expect(entry.releaseWitness).toEqual({
    path: 'server/release/activation-floor.json',
    sha256: createHash('sha256').update(expectedFloor).digest('hex'),
  });
  const selected = readFileSync(join(root, 'server/release/activation-floor.json'));
  if (JSON.parse(selected.toString()).ownerWindowId === id) expect(selected).toEqual(expectedFloor);
  // Exact original bytes, not merely equivalent parsed historical authorizations.
  const start = raw.indexOf(',\n    {\n      "id": "' + id + '"');
  const end = raw.indexOf('\n  ],\n  "databaseWindows":', start);
  expect(start).toBeGreaterThan(0);
  const historical = raw.slice(0, start) + raw.slice(end);
  expect(createHash('sha256').update(historical).digest('hex')).toBe(
    '996dc6f138ba4ad59dbe6ad7bb054479ec89ba8b80981144a14d20d0dc881a86'
  );
  for (const boundary of [
    'NEW manual continuation',
    'not timestamps quoted from Dan',
    'typed retirement',
    'UNKNOWN',
    'Diamond remains closed',
    'ONE actual activation',
    '120s',
    '300s',
    '285s',
    '245s',
    '135s',
    '40s',
    '5s cleanup',
    '20s MAIN',
    'full 5s remote-close',
    'v3 thaw',
    'migration/payment replay',
  ])
    expect(entry.ownerOrder).toContain(boundary);
});

it('binds the owner-ordered next :55 Horse V63-V69 activation without renewing any historical window', () => {
  const raw = readFileSync(join(root, 'server/release/owner-maintenance-windows.json'), 'utf8');
  const doc = JSON.parse(raw);
  const id = '2026-10-31-horse-v63-v69-next-55';
  const entry = doc.windows.find((w: { id: string }) => w.id === id);
  expect(doc.windows.filter((w: { id: string }) => w.id === id)).toHaveLength(1);
  expect(doc.windows[66]).toEqual(entry);
  expect(entry.contains).toBe('0562b8d49cfc246b3e24327e23ba5e72fc402251');
  expect(entry.announceAtChicagoMinutes).toEqual([53]);
  expect(entry.migrations).toEqual([]);
  expect(entry.notBefore).toBe('2026-10-31T17:15:00Z');
  expect(entry.notAfter).toBe('2026-10-31T23:15:00Z');
  const span = Date.parse(entry.notAfter) - Date.parse(entry.notBefore);
  expect(span).toBeGreaterThanOrEqual(420_000);
  expect(span).toBeLessThanOrEqual(21_600_000);
  // Never reaches the 2026-11-01 04:00 America/Chicago daily window.
  expect(Date.parse(entry.notAfter)).toBeLessThan(Date.parse('2026-11-01T08:30:00Z'));
  const expectedFloor = Buffer.from(
    JSON.stringify(
      {
        schema: 'engine-release-activation-floor/v2-owner-window',
        preparationAt: entry.notBefore,
        activationAt: entry.notBefore,
        expiresAt: entry.notAfter,
        timeZone: 'America/Chicago',
        ownerWindowId: id,
        clientPublicationAt: entry.notBefore,
      },
      null,
      2
    ) + '\n'
  );
  expect(entry.releaseWitness).toEqual({
    path: 'server/release/activation-floor.json',
    sha256: createHash('sha256').update(expectedFloor).digest('hex'),
  });
  const selected = readFileSync(join(root, 'server/release/activation-floor.json'));
  if (JSON.parse(selected.toString()).ownerWindowId === id) expect(selected).toEqual(expectedFloor);
  // Exact original bytes, not merely equivalent parsed historical authorizations.
  const start = raw.indexOf(',\n    {\n      "id": "' + id + '"');
  const end = raw.indexOf('\n  ],\n  "databaseWindows":', start);
  expect(start).toBeGreaterThan(0);
  const historical = raw.slice(0, start) + raw.slice(end);
  expect(createHash('sha256').update(historical).digest('hex')).toBe(
    'af6d171426e581132b60bd755db46f2b703be96889456fe44a51879280d5eb75'
  );
  for (const boundary of [
    'YOU CAN DEPLOY AT THE NEXT :55 BREAK, YOU DO NOT HAVE TO WAIT UNTIL 4AM GET THAT DONE NOW',
    'NEW owner-ordered window',
    'agent-selected',
    'typed retirement',
    'UNKNOWN',
    'Diamond remains closed',
    'ONE actual activation',
    '120s',
    '300s',
    '285s',
    '245s',
    '135s',
    '40s',
    '5s cleanup',
    '20s MAIN',
    'full 5s remote-close',
    'v3 thaw',
    'migration/payment replay',
  ])
    expect(entry.ownerOrder).toContain(boundary);
});
