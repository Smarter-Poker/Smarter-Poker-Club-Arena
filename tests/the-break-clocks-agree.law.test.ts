/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BREAK CLOCKS AGREE (law, to-do #2563 item 12)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The :55 maintenance break is coordinated by constants that live in FIVE
 * places that cannot import each other: the engine (TypeScript), the deploy
 * workflow (cron), the engine watchdog (bash), two SQL migrations, and the
 * browser hook. Nothing but this file makes them agree.
 *
 * Each pin below is a real failure, not a hypothetical - the watchdog HAS
 * already desynchronised from the deploy once (2026-09-01: it still carried
 * the five Chicago windows after the deploy went hourly, stayed silent for
 * fourteen and a half hours of stranded code, and reported success the whole
 * time). This law is what makes that class of drift a red test instead of a
 * production incident.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const ENGINE = read('server/src/maintenance/MaintenanceBreak.ts');
const WATCHDOG = read('.github/scripts/engine-watchdog.sh');
const DEPLOY = read('.github/workflows/auto-deploy-hetzner.yml');
const FREEZE_SQL = read(
  'supabase/migrations/20260902090000_the_platform_freezes_at_the_tables_not_the_functions.sql'
);
const THAW_SQL = read(
  'supabase/migrations/20260902091000_the_thaw_gives_back_every_frozen_minute.sql'
);
const ENTRY_BOUNDARY_SQL = read(
  'supabase/migrations/20260908042800_maintenance_announcement_and_entry_purchases_are_serialized.sql'
);
const HOOK = read('src/hooks/useMaintenanceBreak.ts');

/**
 * ═══ THE SOCKET CLOCKS AGREE TOO (Realtime Phase 5, 2026-09-06) ════════════
 *
 * A table socket is governed by four clocks that live in four files which
 * cannot import each other, and one of them is not in this repository at all:
 *
 *   engine ping cadence   HEARTBEAT_INTERVAL_MS, both socket servers
 *   engine patience       HEARTBEAT_TIMEOUT_MS, both socket servers
 *   client patience       EngineStateClient.STALE_HARD_MS
 *   the proxy             Caddy, on engine-01
 *
 * They only work because of the RELATIONSHIPS between them, and every one of
 * those relationships is currently a coincidence that nothing checks:
 *
 *   - the engine pings more often than the client gives up, or a healthy
 *     socket is torn down by its own client every minute;
 *   - the engine pings more often than IT gives up, or it reaps a peer that
 *     never had a chance to answer;
 *   - the engine pings far more often than any proxy idle timeout, which is
 *     the ONLY reason a Caddy in front of it has never closed a live table.
 *
 * MEASURED ON THE BOX, 2026-09-06: `/etc/caddy/Caddyfile` sets no timeout of
 * any kind for `engine.smarter.poker` - it is `reverse_proxy localhost:8080`
 * and nothing else - so Caddy v2.11.4's defaults apply and the 25-second ping
 * keeps the connection far from any of them. That is a fact about a file this
 * repository does not deploy, which is exactly why the relationship is pinned
 * here rather than the number: if anyone ever gives that proxy an idle
 * timeout, the safe range is written down beside the constant it has to clear.
 */
describe('the socket clocks agree, and clear any proxy idle timeout', () => {
  const TABLE_WS = read('server/src/transport/EngineWebSocketServer.ts');
  const CHANNEL_WS = read('server/src/transport/ChannelWebSocketServer.ts');
  const STATE_CLIENT = read('src/services/EngineStateClient.ts');

  /**
   * Read a millisecond constant, accepting either a literal (`25_000`) or the
   * readable product these files also use (`5 * 60_000`). Reading only the
   * first form is how a pin quietly stops watching the constant it names: the
   * regex misses, the match is null, and the test dies on a TypeError that
   * looks like a broken test rather than a broken relationship.
   */
  const num = (src: string, name: string): number => {
    const m = src.match(new RegExp(`${name} = ([0-9_]+)(?:\\s*\\*\\s*([0-9_]+))?`));
    expect(m, `${name} is not in this file any more`).not.toBeNull();
    const a = Number(m![1].replace(/_/g, ''));
    const b = m![2] ? Number(m![2].replace(/_/g, '')) : 1;
    return a * b;
  };

  const pingMs = num(TABLE_WS, 'HEARTBEAT_INTERVAL_MS');
  const enginePatienceMs = num(TABLE_WS, 'HEARTBEAT_TIMEOUT_MS');
  const clientPatienceMs = num(STATE_CLIENT, 'STALE_HARD_MS');

  it('both socket servers ping on the same cadence and wait the same time', () => {
    expect(num(CHANNEL_WS, 'HEARTBEAT_INTERVAL_MS')).toBe(pingMs);
    expect(num(CHANNEL_WS, 'HEARTBEAT_TIMEOUT_MS')).toBe(enginePatienceMs);
  });

  it('the engine pings at least twice before it gives up on a peer', () => {
    expect(enginePatienceMs).toBeGreaterThanOrEqual(pingMs * 2);
  });

  it('the engine pings at least twice before the CLIENT gives up', () => {
    // Otherwise one dropped ping tears down a healthy table from the browser
    // side, every time, and it looks like a flaky network.
    expect(clientPatienceMs).toBeGreaterThanOrEqual(pingMs * 2);
  });

  it('the ping clears the smallest idle timeout a proxy is likely to have', () => {
    /* Caddy on engine-01 sets none today (measured 2026-09-06), so this is a
       margin against the future rather than the present. Sixty seconds is the
       shortest idle timeout in common use; the ping has to be comfortably
       under it, not merely under it, because the margin is what absorbs a
       slow event loop on a one-core engine. */
    const SHORTEST_LIKELY_PROXY_IDLE_MS = 60_000;
    expect(pingMs * 2).toBeLessThan(SHORTEST_LIKELY_PROXY_IDLE_MS);
  });

  it('re-auth rides the heartbeat sweep, so it can never run more often than one', () => {
    const reauthMs = num(TABLE_WS, 'REAUTH_INTERVAL_MS');
    expect(reauthMs).toBeGreaterThan(pingMs);
    // And the stagger is bounded by the period, or a socket could be pushed
    // past its next due time indefinitely.
    /* The stagger moved into `wsHelpers.staggeredReauthAt(intervalMs)` in the
       Phase 5 audit, when the channel socket was given the same mechanism -
       three sockets, one implementation. The table server passes its own
       REAUTH_INTERVAL_MS in; the bound still has to be the period. */
    expect(TABLE_WS).toContain('staggeredReauthAt(REAUTH_INTERVAL_MS)');
    expect(read('server/src/transport/wsHelpers.ts')).toContain('Math.random() * intervalMs');
  });
});

describe('the break minute is the same minute everywhere', () => {
  const engineMinute = Number(ENGINE.match(/BREAK_START_MINUTE = (\d+)/)![1]);

  it('the engine parks at :55', () => {
    expect(engineMinute).toBe(55);
  });

  it('the watchdog waits for the same minute', () => {
    // 2026-09-01: these two disagreed (watchdog still on five Chicago hours)
    // and the engine served a 14.5-hour-old image behind green runs.
    const wd = Number(WATCHDOG.match(/RESTART_MINUTE="\$\{RESTART_MINUTE:-(\d+)\}"/)![1]);
    expect(wd).toBe(engineMinute);
  });

  it('every deploy cron tick lands before the break with time to build', () => {
    const minutes = DEPLOY.match(/cron: '([\d,]+) \* \* \* \*'/)![1]
      .split(',')
      .map(Number);
    for (const m of minutes) {
      // Late enough that the runner is fresh, early enough to check out,
      // test and build before the engine parks the platform at :55. A tick
      // AT or AFTER :55 would wait ~59 minutes for the next break.
      expect(m, `cron tick :${m}`).toBeGreaterThanOrEqual(35);
      expect(m, `cron tick :${m}`).toBeLessThanOrEqual(50);
      expect(m).toBeLessThan(engineMinute);
    }
  });
});

describe('the freeze ceiling is the same ceiling everywhere', () => {
  it('fn_platform_frozen refuses to honour a break longer than 15 minutes', () => {
    expect(FREEZE_SQL).toContain("INTERVAL '15 minutes'");
  });

  it('fn_thaw_platform refuses to shift by more than the same ceiling', () => {
    // 900 seconds = 15 minutes. A thaw that believed a 9-hour freeze would
    // shift every deadline on the platform by 9 hours.
    expect(THAW_SQL).toMatch(/p_frozen_seconds > 900/);
  });
});

describe('the last-hand window is the same window everywhere', () => {
  it('the engine announces two minutes before the break', () => {
    expect(ENGINE).toMatch(/LAST_HAND_LEAD_MS = 2 \* 60 \* 1000/);
  });

  it('the current SQL and browser use the exact seven-minute announcement window', () => {
    // The original four-minute fallback is historical and superseded: it
    // reopened entry at :57 although a recovered engine stayed parked to :00.
    // The current migration derives the same :53 + 2 + 5 absolute end for the
    // entry predicate, public state RPC and browser.
    expect(ENTRY_BOUNDARY_SQL.match(/INTERVAL '7 minutes'/g) ?? []).toHaveLength(2);
    expect(ENTRY_BOUNDARY_SQL).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_maintenance_break_state'
    );
    expect(HOOK).toMatch(/MAINTENANCE_WINDOW_MS = 7 \* 60 \* 1000/);
    expect(HOOK).toContain('data.resume_expected_at');
    expect(HOOK).toMatch(
      /s\.phase !== 'recovering'[\s\S]{0,160}s\.breakEndsAtMs[\s\S]{0,80}serverNow\(\) >= s\.breakEndsAtMs/
    );
    expect(HOOK).toContain("phase: 'recovering'");
    expect(HOOK).toContain('connectionProtectedUntilMs');
  });
});

describe('the resume arrives in installments, inside the :00 minute (2026-09-05)', () => {
  /**
   * The engine is one core. At 04:00 UTC on 2026-09-05, 720 tables resumed
   * in a 25-per-750ms stagger in adoption order (tournaments first), the core
   * saturated within thirty seconds and the container was replaced at 04:07.
   * The resume is now RESUME_WAVES waves, RESUME_WAVE_GAP_MS apart, and the
   * whole spread must stay a small fraction of the minute: CLAUDE.md 13 says
   * every table resumes "together" at :00, read as "within the same few
   * seconds". A spread that grows toward the minute is a second break.
   */
  const waves = Number(ENGINE.match(/RESUME_WAVES = (\d+);/)![1]);
  const gapMs = Number(ENGINE.match(/RESUME_WAVE_GAP_MS = (\d+);/)![1]);
  const minTables = Number(ENGINE.match(/RESUME_WAVE_MIN_TABLES = (\d+);/)![1]);

  it('spreads the fleet over more than one wave', () => {
    expect(waves).toBeGreaterThanOrEqual(4);
    expect(gapMs).toBeGreaterThanOrEqual(500);
  });

  it('finishes the last wave within 15 seconds of the first', () => {
    expect((waves - 1) * gapMs).toBeLessThanOrEqual(15_000);
  });

  it('brings a small fleet up in one wave, so a test fleet never waits on a timer', () => {
    expect(minTables).toBeGreaterThanOrEqual(10);
  });

  it('the plan reads nothing about who is seated (CLAUDE.md 10.5)', () => {
    const start = ENGINE.indexOf('static planResumeWaves');
    const body = ENGINE.slice(start, ENGINE.indexOf('\n  }\n', start));
    expect(body).not.toMatch(/humansSeated|is_horse|isHorse/);
  });

  it('publishes the rollout on /health as maintenance.resumeWaves', () => {
    expect(ENGINE).toMatch(/resumeWaves: this\.resumeWaves,/);
  });
});

describe('the break duration is five minutes, once', () => {
  it('engine and tournament break agree at 5 minutes', () => {
    expect(ENGINE).toMatch(/BREAK_DURATION_MS = 5 \* 60 \* 1000/);
    const GS = read('server/src/GameServer.ts');
    expect(GS).toMatch(/BREAK_DURATION_MS = 5 \* 60 \* 1000/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SCORECARD GRADES WHAT THE BREAK CONTROLS (2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan was paged at 00:00 with "Maintenance Break At 00:00 Did Not Pass. Hands
 * In Window 0, Thaw Ran, Recovery ?s, Shipped No". Hands zero. Thaw ran. Both
 * of the things the break exists to do had passed, and it was graded a failure
 * anyway - fifteen times in twenty-four hours, none of them a real failure.
 *
 * Two criteria caused all of it, and both are the same mistake this programme
 * keeps making: a guard turning "I could not measure that" into "that failed".
 *
 *   COALESCE(v_rec, 999) <= 180    - a NULL recovery became the worst case.
 *   abs(v_delta) < 0.005           - conservation on a ~175,000,000 chip pool,
 *                                    graded even though the engine is exempt
 *                                    from the freeze by design and therefore
 *                                    moves chips inside every window.
 *
 * These pins read the LAST migration that defines the recorder, not a fixed
 * filename, because migrations are append-only: a future migration that
 * reintroduces the sentinel would otherwise slip past a test pinned to today's
 * file. Whatever governs the database is what gets checked.
 */
describe('the break scorecard grades only what the break controls', () => {
  const MIGRATIONS_DIR = resolve(__dirname, '..', 'supabase/migrations');

  /** Every migration defining the recorder, oldest first. */
  const recorderMigrations = (): string[] =>
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) =>
        readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8').includes(
          'CREATE OR REPLACE FUNCTION public.fn_ca_record_break_scorecard'
        )
      );

  /** The one Postgres ends up with: the newest definition wins. */
  const governingRecorder = (): string => {
    const all = recorderMigrations();
    expect(all.length, 'no migration defines fn_ca_record_break_scorecard').toBeGreaterThan(0);
    return readFileSync(resolve(MIGRATIONS_DIR, all[all.length - 1]), 'utf8');
  };

  /** The verdict expression only - not the whole file. */
  const verdictBlock = (sql: string): string => {
    const i = sql.indexOf('v_verdict := CASE');
    expect(i, 'the recorder must still compute a verdict').toBeGreaterThan(0);
    return sql.slice(i, sql.indexOf('END;', i) + 4);
  };

  it('never turns an unmeasured signal into a failing sentinel', () => {
    // The exact shape of the 2026-09-04 defect: COALESCE(<unmeasured>, <big>)
    // compared against a ceiling, so NULL loses.
    const verdict = verdictBlock(governingRecorder());
    expect(
      /COALESCE\s*\(\s*v_rec\s*,\s*\d+\s*\)/i.test(verdict),
      'the verdict coerces a NULL recovery to a numeric sentinel. Unmeasured is not failed - ' +
        'this is what paged Dan fifteen times for breaks that worked.'
    ).toBe(false);
  });

  it('does not grade freeze conservation, which it cannot interpret', () => {
    // The engine holds a service_role claim and is exempt from the freeze by
    // design, so circulation legitimately moves inside every window. A delta
    // is evidence, not a verdict.
    const verdict = verdictBlock(governingRecorder());
    expect(
      /v_conserved/.test(verdict),
      'the verdict grades freeze conservation. The engine is exempt from the freeze by design, ' +
        'so a non-zero delta means the engine did its job, not that the freeze leaked.'
    ).toBe(false);
  });

  it('still fails a break that dealt hands inside itself', () => {
    // The teeth. On 2026-09-02 a break dealt 3110 hands; that must always fail.
    const verdict = verdictBlock(governingRecorder());
    expect(verdict).toMatch(/v_hands\s*<=\s*(c_max_hands|\d+)/);
  });

  it('still fails a break that did not give the clocks back', () => {
    const verdict = verdictBlock(governingRecorder());
    expect(verdict).toMatch(/v_thaw\.frozen_seconds/);
  });

  it('reports an unmeasurable break as unknown rather than failed', () => {
    const verdict = verdictBlock(governingRecorder());
    expect(verdict).toMatch(/v_hands\s+IS\s+NULL\s+THEN\s+'unknown'/i);
  });

  it('the detector would have caught the original defect', () => {
    // Both directions. A guard that only ever passes proves nothing, so assert
    // the same patterns DO match the migrations that carried the bug.
    const olds = recorderMigrations()
      .map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8'))
      .map(verdictBlock)
      .filter((v) => /COALESCE\s*\(\s*v_rec\s*,\s*\d+\s*\)/i.test(v) || /v_conserved/.test(v));
    expect(
      olds.length,
      'no historical migration contains the sentinel or the conservation grade, so these ' +
        'assertions are not actually detecting anything and must be re-derived.'
    ).toBeGreaterThan(0);
  });

  it('never shows a bare question mark where a measurement is missing', () => {
    // "Recovery ?s" reads as a broken template. Say what is missing.
    const all = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) =>
        readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8').includes(
          'CREATE OR REPLACE FUNCTION public.fn_ca_break_scorecard_push'
        )
      );
    expect(all.length).toBeGreaterThan(0);
    const push = readFileSync(resolve(MIGRATIONS_DIR, all[all.length - 1]), 'utf8');
    expect(
      /COALESCE\([^)]*,\s*'\?'\s*\)/.test(push),
      "the push renders a missing measurement as '?', which reads as a bug rather than as " +
        'an absent number.'
    ).toBe(false);
  });
});
