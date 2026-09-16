/**
 * LAW: A SCHEDULED RESTART IS NOT A FAILURE (Realtime Phase 4, 2026-09-05)
 *
 * The engine restarts inside an announced break at :55 of every hour and is
 * away for two to three minutes (CLAUDE.md 13). Until this phase nothing on
 * the TRANSPORT knew that. The maintenance frame went straight past
 * `EngineStateClient` to `TablePage`, which drew a countdown while the ladder
 * underneath treated the silence as a box that had died:
 *
 *   1s, 2s, 4s, 8s, 16s, 30s, 30s ... maxRetries at about three minutes
 *   -> status 'failed'
 *   -> TablePage's twenty-second failsafe reloads the page
 *
 * That is a scheduled, hourly page reload under a seated player who had just
 * been told their seat would survive - discarding the felt, the overlays and
 * any armed pre-action, to arrive at a box that is still booting. On the way
 * it also asks GoTrue whether the session is alive, because three failed
 * handshakes in a row is the shape of the 2026-09-03 outage; here it is not,
 * and every connected browser asking auth at once for an answer the server
 * already gave is the storm this phase exists to stop.
 *
 * PINS
 *   1. The client reads `resume_expected_at` off the maintenance frame and
 *      remembers the window, with a grace so ONE announcement cannot disable
 *      the failsafe forever.
 *   2. Inside the window the ladder never reaches 'failed'.
 *   3. Inside the window it polls at a flat cadence instead of doubling, so a
 *      table that could return at :58:02 does not wait until :58:30.
 *   4. Inside the window it does not ask GoTrue.
 *   5. TablePage's failsafe independently refuses to reload during a break,
 *      because a browser that LOADED during the outage never received the
 *      frame - there was no socket to receive it on.
 *   6. An engine that does not send the field leaves the ladder exactly as it
 *      was. The frame is additive.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESTART_POLL_MS, RESTART_WINDOW_GRACE_MS } from '../src/services/EngineStateClient';
import { sliceMethod, sliceEnclosingBlock, blankNonCode } from './helpers/sourceWindow';

const ROOT = join(__dirname, '..');
const CLIENT = readFileSync(join(ROOT, 'src', 'services', 'EngineStateClient.ts'), 'utf8');
const TABLE_PAGE = readFileSync(join(ROOT, 'src', 'pages', 'TablePage.tsx'), 'utf8');
const BREAK = readFileSync(
  join(ROOT, 'server', 'src', 'maintenance', 'MaintenanceBreak.ts'),
  'utf8'
);

describe('LAW 1 - the transport reads the announcement', () => {
  it('the engine puts the two numbers on the maintenance frame', () => {
    const payload = sliceMethod(BREAK, 'private eventPayload(');
    expect(payload).toContain('restart_in_ms');
    expect(payload).toContain('resume_expected_at');
  });

  it('resume_expected_at is derived from the pinned constants, never guessed', () => {
    const fn = sliceMethod(BREAK, 'private resumeExpectedAt(): number {');
    expect(fn).toContain('MaintenanceBreak.LAST_HAND_LEAD_MS');
    expect(fn).toContain('MaintenanceBreak.BREAK_DURATION_MS');
    // At counting_down the end is already fixed and must be used as-is.
    expect(fn).toContain('if (this.breakEndsAt > 0) return this.breakEndsAt');
  });

  it('the client latches the window off that frame, plus a grace', () => {
    // The frame goes through the SAME door as the database reading below, so
    // the two cannot disagree about which wins (audit, 2026-09-05).
    const block = sliceEnclosingBlock(CLIENT, 'this.noteScheduledRestart(p.resume_expected_at)');
    expect(block).toContain('resume_expected_at');
    const setter = sliceMethod(CLIENT, 'noteScheduledRestart(resumeExpectedAt: number');
    expect(setter).toContain('RESTART_WINDOW_GRACE_MS');
  });

  it('the grace expires, so one announcement cannot disable the failsafe forever', () => {
    expect(RESTART_WINDOW_GRACE_MS).toBeGreaterThan(0);
    // Comfortably longer than a slow boot, comfortably shorter than the hour
    // until the next break - otherwise the windows would join up.
    expect(RESTART_WINDOW_GRACE_MS).toBeLessThan(10 * 60 * 1000);
    const fn = sliceMethod(CLIENT, 'private inAnnouncedRestart(): boolean {');
    /* serverNow(), not Date.now(), since the Phase 5 audit (2026-09-06).
       `restartWindowUntil` is `resume_expected_at` - the ENGINE's stamp - plus
       the grace, so measuring it against the device clock let a skewed phone
       leave the window early and escalate its ladder into the very restart
       this window exists to wait out. */
    expect(fn).toContain('serverNow() < this.restartWindowUntil');
  });
});

describe('LAW 2/3 - inside the window it waits, it does not fail', () => {
  const ladder = sliceMethod(CLIENT, 'private scheduleReconnect(): void {');

  it("never reaches 'failed' while waiting out a restart", () => {
    const code = blankNonCode(ladder);
    const guard = code.indexOf('waitingOutARestart');
    const failed = code.indexOf('this.opts.maxRetries');
    expect(guard).toBeGreaterThan(0);
    // The restart branch is decided BEFORE the maxRetries branch, so it wins.
    expect(guard).toBeLessThan(failed);
    expect(ladder).toMatch(
      /} else if \(waitingOutARestart\) \{\s*this\.setStatus\('reconnecting'\)/
    );
  });

  it('polls at a flat cadence instead of doubling', () => {
    expect(ladder).toContain('waitingOutARestart\n      ? RESTART_POLL_MS');
    // Fast enough that nobody watches a dead table after the engine returns,
    // slow enough that a few hundred sockets are not a storm.
    expect(RESTART_POLL_MS).toBeGreaterThanOrEqual(2_000);
    expect(RESTART_POLL_MS).toBeLessThanOrEqual(10_000);
  });

  it('a missing table still wins over the restart window', () => {
    /* 4404 means the table is gone, which a restart does not change: it must
       keep announcing 'idle' rather than "reconnecting through the break".
       Guaranteed twice - the flag itself excludes a missing table, and the
       missing-table branch is still evaluated first. */
    expect(ladder).toContain(
      'const waitingOutARestart = !this.tableMissing && this.inAnnouncedRestart()'
    );
    const code = blankNonCode(ladder);
    expect(code.indexOf('if (this.tableMissing)')).toBeLessThan(
      code.indexOf('} else if (waitingOutARestart)')
    );
  });
});

describe('LAW 4 - it does not ask GoTrue about a restart it was told about', () => {
  it('the session check is skipped inside the window', () => {
    const block = sliceEnclosingBlock(CLIENT, 'HANDSHAKE_FAILURES_BEFORE_SESSION_CHECK &&');
    expect(block).toContain('!this.inAnnouncedRestart()');
  });

  it('and still runs when there is no announced restart', () => {
    // The guard narrows the check; it must not delete it. 2026-09-03 is why
    // the check exists at all.
    expect(CLIENT).toContain('this.checkSessionThenReconnect(');
    expect(CLIENT).toContain('HANDSHAKE_FAILURES_BEFORE_SESSION_CHECK');
  });
});

describe('LAW 5 - no outage or break can trigger a generic page reload', () => {
  it('TablePage does not own a generic reload failsafe', () => {
    const code = blankNonCode(TABLE_PAGE);
    expect(code).not.toContain('window.location.reload()');
    expect(code).not.toContain('ca_ws_autoreload_at');
  });

  it('that guard reads the DATABASE-backed break, not the socket frame', () => {
    // useMaintenanceBreak refreshes from fn_maintenance_break_state, which is
    // the only source a browser that loaded mid-outage can reach.
    const hook = readFileSync(join(ROOT, 'src', 'hooks', 'useMaintenanceBreak.ts'), 'utf8');
    expect(hook).toContain('fn_maintenance_break_state');
  });
});

describe('LAW 6 - additive: an engine without the field changes nothing', () => {
  it('a frame with no resume_expected_at leaves the window closed', () => {
    const setter = sliceMethod(CLIENT, 'noteScheduledRestart(resumeExpectedAt: number');
    expect(setter).toContain("typeof resumeExpectedAt !== 'number'");
    expect(setter).toContain('!Number.isFinite(resumeExpectedAt)');
    expect(setter).toContain('resumeExpectedAt <= 0');
  });

  it('and the field starts at zero, which means no window', () => {
    expect(CLIENT).toMatch(/private restartWindowUntil = 0;/);
  });
});

/**
 * LAW 7 - THE FRAME REACHES ONLY THE SOCKETS THAT WERE THERE.
 *
 * The break broadcasts once at :53 and once at :55, and `TableStateHub`
 * delivers to CURRENT subscribers; it retains an event for a late joiner only
 * if the event asks, and never for more than HUB_MAX_EVENT_REPLAY_MS (sixty
 * seconds), which does not span a seven-minute break.
 *
 * So a player who sat down at :54 - every hour, the population most likely to
 * need this - learned nothing, their window stayed shut, and Phase 4 did
 * nothing for them. The database is the authority on the break (CLAUDE.md 13
 * rule 3) and `useMaintenanceBreak` already reads it; this is the wire from
 * that reading into the ladder.
 */
describe('LAW 7 - a player who joins after the announcement is covered too', () => {
  const HOOK = readFileSync(join(ROOT, 'src', 'hooks', 'useEngineTableState.ts'), 'utf8');

  it('the transport accepts a restart it was told about from outside', () => {
    expect(CLIENT).toMatch(/noteScheduledRestart\(resumeExpectedAt: number \| null \| undefined\)/);
  });

  it('it is monotonic, so a stale read cannot shorten a live window', () => {
    const setter = sliceMethod(CLIENT, 'noteScheduledRestart(resumeExpectedAt: number');
    expect(setter).toContain(
      'if (until > this.restartWindowUntil) this.restartWindowUntil = until'
    );
  });

  it('the hook wires the break into the client, and seeds it before connecting', () => {
    expect(HOOK).toContain('scheduledRestartUntil');
    const code = blankNonCode(HOOK);
    const seed = code.indexOf('client.noteScheduledRestart(scheduledRestartUntilRef.current)');
    const connect = code.indexOf('void client.connect()');
    expect(seed, 'the window is not seeded at mount').toBeGreaterThan(-1);
    expect(seed, 'seeded AFTER connecting, so the first retries still escalate').toBeLessThan(
      connect
    );
  });

  it('a later break is pushed in without tearing the socket down', () => {
    // The value is read through a ref inside the connect effect and pushed by
    // its own effect: joining the connect effect's deps would rebuild the
    // socket the moment a break started.
    expect(HOOK).toContain('scheduledRestartUntilRef');
    expect(HOOK).toMatch(
      /useEffect\(\(\) => \{\s*clientRef\.current\?\.noteScheduledRestart\(scheduledRestartUntil\);\s*\}, \[scheduledRestartUntil\]\)/
    );
    expect(HOOK).toMatch(/\}, \[tableId, enabled\]\);/);
  });

  it('TablePage passes the DATABASE-backed break, and reads it before the socket', () => {
    expect(TABLE_PAGE).toContain(
      'scheduledRestartUntil: maintenanceBreak.active ? maintenanceBreak.breakEndsAtMs : null'
    );
    const code = blankNonCode(TABLE_PAGE);
    expect(
      code.indexOf('useMaintenanceBreak()'),
      'the break must be read before the socket that consumes it'
    ).toBeLessThan(code.indexOf('useEngineTableState('));
  });
});

describe('the original 4404 callback confirms closure before announcing it', () => {
  // Execute the owning effect body, not a reimplementation of its decisions.
  // React refs and the RPC promise are the only boundaries supplied here.
  const body = sliceEnclosingBlock(TABLE_PAGE, 'if (!engineLastError) return;');
  const invoke = new Function(
    'engineLastError',
    'seatFirstOpenRef',
    'maintenanceBreakRef',
    'notFoundCountRef',
    'tableClosedToastShownRef',
    'refreshMaintenanceBreak',
    'heartbeatToastRef',
    body.slice(1, -1)
  );

  function fixture() {
    type Verdict = 'active' | 'idle' | 'unknown';
    const pending: { promise: Promise<Verdict>; resolve: (v: Verdict) => void }[] = [];
    const refresh = vi.fn(() => {
      let resolve!: (v: Verdict) => void;
      const promise = new Promise<Verdict>((r) => {
        resolve = r;
      });
      pending.push({ promise, resolve });
      return promise;
    });
    const seatFirst = { current: false };
    const maintenance = { current: { active: false } };
    const count = { current: 0 };
    const claimed = { current: false };
    const info = vi.fn();
    const fire = () =>
      invoke({ code: 4404 }, seatFirst, maintenance, count, claimed, refresh, {
        current: { info },
      });
    const settle = async (index: number, verdict: Verdict) => {
      pending[index].resolve(verdict);
      await pending[index].promise;
    };
    return { fire, settle, refresh, maintenance, seatFirst, claimed, info };
  }

  it('an unknown read releases the slot; a later confirmed idle result announces once', async () => {
    const f = fixture();
    f.fire();
    f.fire();
    f.fire();
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.claimed.current).toBe(true);
    await f.settle(0, 'unknown');
    expect(f.info).not.toHaveBeenCalled();
    expect(f.claimed.current).toBe(false);
    f.fire();
    expect(f.refresh).toHaveBeenCalledTimes(2);
    await f.settle(1, 'idle');
    expect(f.info).toHaveBeenCalledExactlyOnceWith('This Table Is No Longer Running');
    expect(f.claimed.current).toBe(true);
    f.fire();
    expect(f.refresh).toHaveBeenCalledTimes(2);
  });

  it('an active RPC verdict suppresses closure before the React ref catches up', async () => {
    const f = fixture();
    f.fire();
    f.fire();
    f.fire();
    await f.settle(0, 'active');
    expect(f.maintenance.current.active).toBe(false);
    expect(f.info).not.toHaveBeenCalled();
    expect(f.claimed.current).toBe(false);
  });

  it('a live break arriving during an idle read still wins', async () => {
    const f = fixture();
    f.fire();
    f.fire();
    f.fire();
    f.maintenance.current.active = true;
    await f.settle(0, 'idle');
    expect(f.info).not.toHaveBeenCalled();
    expect(f.claimed.current).toBe(false);
  });

  it('concurrent errors share the claimed slot and keep pre-start/active guards', async () => {
    const f = fixture();
    f.seatFirst.current = true;
    f.fire();
    f.fire();
    f.fire();
    f.seatFirst.current = false;
    f.maintenance.current.active = true;
    f.fire();
    f.fire();
    f.fire();
    expect(f.refresh).not.toHaveBeenCalled();
    f.maintenance.current.active = false;
    f.fire();
    f.fire();
    expect(f.refresh).not.toHaveBeenCalled();
    f.fire();
    f.fire();
    f.fire();
    expect(f.refresh).toHaveBeenCalledTimes(1);
    await f.settle(0, 'idle');
    expect(f.info).toHaveBeenCalledExactlyOnceWith('This Table Is No Longer Running');
  });
});
