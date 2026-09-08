/**
 * THE ALARMS THEMSELVES.
 *
 * DealRateVerifier.test.ts proves the detector will not misfire. This proves
 * that when it does fire, somebody is actually told — which is the half that
 * was missing on 2026-08-22, when 1,603 kills over six hours were found by an
 * agent reading the database rather than by anyone being notified.
 *
 * The floor alarm is the important one. MIN_TABLES_TO_JUDGE makes the deal-rate
 * check stand down on a small fleet, so a failure that ALSO empties the fleet
 * would switch the detector off exactly when it matters. The floor covers that
 * hole, and only this test pins it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const raised: Array<{ alertname: string; severity: string; summary: string }> = [];
const resolved: string[] = [];

vi.mock('./engineAlerts.js', () => ({
  raiseEngineAlert: async (a: { alertname: string; severity: string; summary: string }) => {
    raised.push(a);
    return true;
  },
  resolveEngineAlert: async (name: string) => {
    resolved.push(name);
    return true;
  },
}));

const builder = { select: vi.fn(), in: vi.fn(), gt: vi.fn() };
const handHistory = { select: vi.fn(), in: vi.fn(), gt: vi.fn() };
const recovery = { select: vi.fn(), eq: vi.fn(), gt: vi.fn() };
vi.mock('./supabase.js', () => ({
  supabase: {
    from: (table: string) => (table === 'engine_recovery_events' ? recovery : handHistory),
  },
}));

const { DealRateVerifier } = await import('./DealRateVerifier.js');

function hands(count: number | null, error: unknown = null) {
  handHistory.select.mockReturnValue(handHistory);
  handHistory.in.mockReturnValue(handHistory);
  handHistory.gt.mockResolvedValue({ count, error });
}
function kills(count: number, error: unknown = null) {
  recovery.select.mockReturnValue(recovery);
  recovery.eq.mockReturnValue(recovery);
  recovery.gt.mockResolvedValue({ count, error });
}
const tables = (n: number) => Array.from({ length: n }, (_, i) => `t-${i}`);

beforeEach(() => {
  raised.length = 0;
  resolved.length = 0;
  for (const b of [builder, handHistory, recovery]) {
    Object.values(b).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset());
  }
  kills(0);
});

/** Push the verifier past its startup grace so the floor can be judged. */
function pastBoot(v: unknown) {
  (v as { startedAt: number }).startedAt = Date.now() - 10 * 60_000;
}

describe('the canary hole: a fleet that empties must not silence the alarm', () => {
  it('stays quiet while booting IF the platform is dealing elsewhere', async () => {
    // Measured on a real production boot: 0 dealable tables at 62s, 59 at 139s.
    // The boots that would NOT clear a 3-minute window are the slow ones, which
    // happen when the database is already degraded -- the worst possible moment
    // to email a critical about a fleet that is simply still starting.
    //
    // 2026-08-30: the grace now has to justify itself. THIS process having no
    // tables yet is not evidence of anything while hands are being dealt, so
    // the boot stays silent exactly as before.
    const v = new DealRateVerifier(() => tables(0));
    hands(5);
    await v.check();
    await v.check();
    await v.check();
    await v.check();
    expect(raised).toHaveLength(0);
    expect(v.snapshot().belowFloorChecks).toBe(0);
  });

  it('does NOT stay quiet when the whole platform has been dark across restarts', async () => {
    /**
     * THE RULE THIS REPLACES, AND WHY.
     *
     * The grace was measured from `startedAt` — THIS PROCESS's clock, reset on
     * every restart. On 2026-08-30 Supabase went into RESIZING, the engine
     * could not win its leadership claim, and it restarted roughly every two
     * minutes for over forty minutes. Every one of those processes died well
     * inside the five-minute grace, so belowFloorChecks was never incremented
     * once. The entire platform was dark, the alarm written for exactly that
     * could not fire, and a person found it by looking at a lobby.
     *
     * So a young process no longer buys silence on its own. It buys silence
     * when the DATABASE — which outlives the restart — still shows hands. Zero
     * hands anywhere for a full grace window is not a boot, it is an outage,
     * and it still takes CONSECUTIVE_BELOW_FLOOR checks to be called in.
     */
    const v = new DealRateVerifier(() => tables(0));
    hands(0);
    await v.check();
    await v.check();
    expect(raised).toHaveLength(0); // still damped: two checks is not a verdict
    await v.check();
    expect(raised.map((a) => a.alertname)).toContain('ClubArenaFleetFloorLost');
    expect(raised[0].severity).toBe('critical');
  });

  it('raises a CRITICAL when the fleet falls below the floor', async () => {
    const v = new DealRateVerifier(() => tables(1));
    pastBoot(v);
    hands(0);
    await v.check();
    await v.check();
    expect(raised).toHaveLength(0); // not yet — one quiet moment is not a collapse
    await v.check();
    expect(raised.map((r) => r.alertname)).toEqual(['ClubArenaFleetFloorLost']);
    expect(raised[0].severity).toBe('critical');
    expect(v.snapshot().belowFloorChecks).toBe(3);
  });

  it('resolves the floor alarm when the fleet comes back', async () => {
    let size = 1;
    const v = new DealRateVerifier(() => tables(size));
    pastBoot(v);
    hands(0);
    await v.check();
    await v.check();
    await v.check();
    size = 40;
    hands(5);
    await v.check();
    expect(resolved).toContain('ClubArenaFleetFloorLost');
    expect(v.snapshot().belowFloorChecks).toBe(0);
  });
});

describe('deal silence is reported, not just acted on', () => {
  it('raises a CRITICAL once the verdict is reached', async () => {
    const v = new DealRateVerifier(() => tables(40));
    hands(0);
    await v.check();
    await v.check();
    expect(raised).toHaveLength(0);
    await v.check();
    expect(raised.map((r) => r.alertname)).toEqual(['ClubArenaFleetSilent']);
  });

  it('resolves as soon as a single hand is dealt', async () => {
    const v = new DealRateVerifier(() => tables(40));
    hands(0);
    await v.check();
    await v.check();
    await v.check();
    hands(1);
    await v.check();
    expect(resolved).toContain('ClubArenaFleetSilent');
  });
});

describe('the kill storm that nobody was told about', () => {
  it('raises a CRITICAL on the 2026-08-22 signature', async () => {
    const v = new DealRateVerifier(() => tables(40));
    hands(50); // tables ARE dealing — a kill storm is not a freeze
    kills(120);
    await v.check();
    expect(raised.map((r) => r.alertname)).toContain('ClubArenaEngineKillStorm');
    expect(v.snapshot().killsInWindow).toBe(120);
  });

  it('counts only automatic watchdog kills, never drills or other recovery actions', async () => {
    const v = new DealRateVerifier(() => tables(40));
    hands(50);
    // The database applies these exact positive filters before returning this
    // count. A `.neq(fault_injection)` filter would fail open for any future
    // class; the two `.eq` predicates deliberately do not.
    kills(4);
    await v.check();
    expect(recovery.eq.mock.calls).toEqual([
      ['event', 'watchdog_kill_rebuild'],
      ['event_class', 'automatic_recovery'],
    ]);
    expect(v.snapshot().killsInWindow).toBe(4);
    expect(raised.map((r) => r.alertname)).not.toContain('ClubArenaEngineKillStorm');
  });

  it('does not fire on a single table recovering itself', async () => {
    const v = new DealRateVerifier(() => tables(40));
    hands(50);
    kills(2);
    await v.check();
    expect(raised.map((r) => r.alertname)).not.toContain('ClubArenaEngineKillStorm');
  });

  it('a kill storm never touches liveness - the tables come back', async () => {
    const v = new DealRateVerifier(() => tables(40));
    hands(50);
    kills(500);
    await v.check();
    expect(v.snapshot().dbConfirmedDead).toBe(false);
  });

  it('an unreadable kill count is not reported as zero', async () => {
    const v = new DealRateVerifier(() => tables(40));
    hands(50);
    kills(0, { message: 'fetch failed' });
    await v.check();
    expect(v.snapshot().killsInWindow).toBeNull();
  });
});
