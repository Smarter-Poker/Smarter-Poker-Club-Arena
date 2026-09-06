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
import { describe, it, expect } from 'vitest';
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
    const block = sliceEnclosingBlock(CLIENT, 'this.restartWindowUntil = resumeAt > 0');
    expect(block).toContain('resume_expected_at');
    expect(block).toContain('RESTART_WINDOW_GRACE_MS');
  });

  it('the grace expires, so one announcement cannot disable the failsafe forever', () => {
    expect(RESTART_WINDOW_GRACE_MS).toBeGreaterThan(0);
    // Comfortably longer than a slow boot, comfortably shorter than the hour
    // until the next break - otherwise the windows would join up.
    expect(RESTART_WINDOW_GRACE_MS).toBeLessThan(10 * 60 * 1000);
    const fn = sliceMethod(CLIENT, 'private inAnnouncedRestart(): boolean {');
    expect(fn).toContain('Date.now() < this.restartWindowUntil');
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

describe('LAW 5 - the page refuses to reload during a break, with no socket needed', () => {
  it('the failsafe checks the break before it reloads', () => {
    const block = sliceEnclosingBlock(TABLE_PAGE, "const KEY = 'ca_ws_autoreload_at'");
    const guard = block.indexOf('maintenanceBreakRef.current.active');
    const reload = block.indexOf('window.location.reload()');
    expect(guard, 'the break guard is gone from the failsafe').toBeGreaterThan(-1);
    expect(reload).toBeGreaterThan(guard);
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
    const block = sliceEnclosingBlock(CLIENT, 'this.restartWindowUntil = resumeAt > 0');
    expect(block).toMatch(/typeof p\.resume_expected_at === 'number' \? p\.resume_expected_at : 0/);
    expect(block).toContain('resumeAt > 0 ? resumeAt + RESTART_WINDOW_GRACE_MS : 0');
  });

  it('and the field starts at zero, which means no window', () => {
    expect(CLIENT).toMatch(/private restartWindowUntil = 0;/);
  });
});
