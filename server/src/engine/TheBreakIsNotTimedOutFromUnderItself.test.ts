/**
 * THE BREAK IS NOT TIMED OUT FROM UNDER ITSELF (2026-10-06)
 *
 * Production, 2026-10-05/06: after a release cutover the engine boots at
 * about :55:45, adopts the persisted break, and parks every table with
 * MaintenanceBreak.remainingParkBudgetMs() - the SCHEDULED end (:00:00) plus
 * 30s. The break actually ends on the certified release (~:00:28) and its
 * resume waves run 10.5s after that. At :00:30 the gate's safety timeout let
 * every table still waiting for its wave out of the gate; a wave landing
 * while the loop was walking back found `handForHandResolve === null`, gave no
 * progress credit, and the table came off the break with a clock anchored at
 * boot. GameServer's zombie sweep (shouldBeDealing && !isParkedByDesign() &&
 * msSinceProgress() > 180s) then killed and rebuilt it: 51 tables at 23:00,
 * 24 at 00:00, 30 at 02:00.
 *
 * These drive the real engine's gate and resume path on the production
 * timeline. Each fails on the code before the fix.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const BOOT = Date.parse('2026-10-06T23:55:45.000Z');
const SCHEDULED_END = Date.parse('2026-10-07T00:00:00.000Z');
const CERTIFIED_RELEASE = Date.parse('2026-10-07T00:00:28.070Z');
const WAVE_GAP_MS = 1500;
const ZOMBIE_MS = 180_000;

/** GameServer's zombie verdict for a table that has reached its deal threshold. */
function judgedZombie(engine: ServerTableEngine): boolean {
  return !engine.isParkedByDesign() && engine.msSinceProgress() > ZOMBIE_MS;
}

function bootAdoptedEngine(tableId: string) {
  const engine = new ServerTableEngine(tableId);
  const internal = engine as any;
  internal.running = true;
  // Never touch the database from the gate's presence write.
  internal.persistPresenceForRestart = vi.fn(async () => undefined);
  // What MaintenanceBreak.adopt() hands an engine built during the countdown.
  engine.pauseForMaintenance(SCHEDULED_END - Date.now() + 30_000);
  let released = false;
  const parked = (internal.awaitPauseGate() as Promise<void>).then(() => {
    released = true;
  });
  return { engine, internal, parked, wasReleased: () => released };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a table the maintenance break still holds is not timed out of its gate', () => {
  it('a table woken by a late resume wave is credited and not judged a zombie', async () => {
    vi.useFakeTimers({ now: BOOT });
    const { engine, internal, parked, wasReleased } = bootAdoptedEngine(
      'a0d6c0de-0000-4000-8000-000000000001'
    );

    // Wave 2 of the certified release: past the adopted park budget.
    await vi.advanceTimersByTimeAsync(CERTIFIED_RELEASE + 2 * WAVE_GAP_MS - BOOT);
    expect(Date.now()).toBeGreaterThan(SCHEDULED_END + 30_000);

    // Still parked at the gate - the break holds it, so nothing released it.
    expect(wasReleased()).toBe(false);
    expect(internal.handForHandResolve).not.toBeNull();
    expect(engine.isParkedByDesign()).toBe(true);
    expect(engine.msSinceProgress()).toBeGreaterThan(ZOMBIE_MS);

    engine.resumeFromMaintenance();
    await parked;

    // The thaw credits the frozen minutes: the first post-thaw sweep (~4s
    // after the wave) finds a fresh clock, not one anchored at boot.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(engine.msSinceProgress()).toBeLessThan(10_000);
    expect(judgedZombie(engine)).toBe(false);
  });

  it('a table that genuinely does not deal after the thaw still trips the zombie sweep at 180s', async () => {
    vi.useFakeTimers({ now: BOOT });
    const { engine, parked } = bootAdoptedEngine('a0d6c0de-0000-4000-8000-000000000002');
    await vi.advanceTimersByTimeAsync(CERTIFIED_RELEASE - BOOT);
    engine.resumeFromMaintenance();
    await parked;

    await vi.advanceTimersByTimeAsync(ZOMBIE_MS - 1_000);
    expect(judgedZombie(engine)).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(judgedZombie(engine)).toBe(true);
  });

  it('the safety net survives the break for an authority that still holds the table', async () => {
    vi.useFakeTimers({ now: BOOT });
    const engine = new ServerTableEngine('a0d6c0de-0000-4000-8000-000000000003');
    const internal = engine as any;
    internal.running = true;
    const budget = SCHEDULED_END - Date.now() + 30_000;
    engine.pauseForMaintenance(budget);
    internal.handForHandPaused = true; // hand-for-hand, no explicit-resume claim
    let released = false;
    const parked = (internal.awaitPauseGate() as Promise<void>).then(() => {
      released = true;
    });

    // Break outlives the budget; the table stays parked.
    await vi.advanceTimersByTimeAsync(CERTIFIED_RELEASE + 2 * WAVE_GAP_MS - BOOT);
    expect(released).toBe(false);

    // The break lets go but hand-for-hand still holds the gate.
    engine.resumeFromMaintenance();
    expect(released).toBe(false);
    expect(internal.pauseGateTimer).not.toBeNull();

    // If hand-for-hand never releases it, the safety timeout still does.
    await vi.advanceTimersByTimeAsync(budget + 1_000);
    await parked;
    expect(released).toBe(true);
  });

  it('an ordinary pause with no break behind it still self-resumes on its timeout', async () => {
    vi.useFakeTimers({ now: BOOT });
    const engine = new ServerTableEngine('a0d6c0de-0000-4000-8000-000000000004');
    const internal = engine as any;
    internal.running = true;
    internal.handForHandPaused = true;
    let released = false;
    const parked = (internal.awaitPauseGate() as Promise<void>).then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(120_000 + 1);
    await parked;
    expect(released).toBe(true);
  });
});
