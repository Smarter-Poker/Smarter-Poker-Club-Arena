/**
 * AN OWNER FLOOR PARK IS NOT AN OUTAGE (2026-10-15).
 *
 * The owner's horse wallet reset parked every cash table from 16:53 to 18:10
 * UTC and ClubArenaFleetFloorLost paged at 17:33 for a stop he had scheduled.
 * These tests pin the stand-down to a FRESH read of a park holding at least
 * half the floor, and pin that a missing, failed, malformed or stale read
 * silences nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const builder = {
  select: vi.fn(),
  in: vi.fn(),
  eq: vi.fn(),
  gt: vi.fn(),
};
const from = vi.fn((_table: string) => builder);
vi.mock('./supabase.js', () => ({
  supabase: {
    from: (table: string) => from(table),
    rpc: async () => ({ data: null, error: { message: 'not in this test' } }),
  },
}));

const raised: Array<{ alertname: string }> = [];
vi.mock('./engineAlerts.js', () => ({
  raiseEngineAlert: async (input: { alertname: string }) => {
    raised.push(input);
    return true;
  },
  resolveEngineAlert: async () => true,
}));

const watch = await import('./FloorParkWatch.js');
const { DealRateVerifier } = await import('./DealRateVerifier.js');
const { alwaysOnRegistry } = await import('../observability/engineInstruments.js');

function gauge(name: string): number | null {
  const line = alwaysOnRegistry
    .renderPrometheus()
    .split('\n')
    .find((l) => l.startsWith(`${name} `));
  return line ? Number(line.split(' ')[1]) : null;
}

beforeEach(() => {
  raised.length = 0;
  watch.resetFloorParkWatchForTests();
  builder.select.mockReset().mockReturnValue(builder);
  builder.in.mockReset().mockReturnValue(builder);
  builder.eq.mockReset().mockReturnValue(builder);
  builder.gt.mockReset().mockResolvedValue({ count: 0, error: null });
});

describe('the share is read, never assumed', () => {
  it('parses what fn_ca_operator_floor_park_share answers', () => {
    expect(watch.parseFloorParkShare({ held: false, share: 0 })).toBe(0);
    expect(watch.parseFloorParkShare({ held: true, share: 1 })).toBe(1);
    expect(watch.parseFloorParkShare([{ held: true, share: '0.75' }])).toBe(0.75);
    expect(watch.parseFloorParkShare({ held: true })).toBeNull();
    expect(watch.parseFloorParkShare({ held: true, share: 1.5 })).toBeNull();
    expect(watch.parseFloorParkShare(null)).toBeNull();
    expect(watch.parseFloorParkShare('park')).toBeNull();
  });

  it('a fresh read of half the floor or more stands the fleet down, less does not', () => {
    const now = Date.now();
    watch.noteFloorParkShare(1, now);
    expect(watch.fleetIsParkedByOwner(now)).toBe(true);
    watch.noteFloorParkShare(0.5, now);
    expect(watch.fleetIsParkedByOwner(now)).toBe(true);
    watch.noteFloorParkShare(0.49, now);
    expect(watch.fleetIsParkedByOwner(now)).toBe(false);
    expect(watch.FLEET_STANDS_DOWN_AT_PARK_SHARE).toBe(0.5);
  });

  it('a stale read is no read', () => {
    const now = Date.now();
    watch.noteFloorParkShare(1, now - watch.FLOOR_PARK_MAX_AGE_MS - 1);
    expect(watch.ownerFloorParkShare(now)).toBe(0);
    expect(watch.fleetIsParkedByOwner(now)).toBe(false);
  });

  it('never read is no park', () => {
    expect(watch.ownerFloorParkShare()).toBe(0);
    expect(gauge('poker_operator_floor_park_share')).toBe(0);
    expect(gauge('poker_operator_floor_park_known')).toBe(0);
  });

  it('a good answer is published; an error, a malformed answer or a throw silences nothing', async () => {
    await watch.refreshFloorPark(async () => ({ data: { held: true, share: 0.9 }, error: null }));
    expect(watch.ownerFloorParkShare()).toBe(0.9);
    expect(gauge('poker_operator_floor_park_share')).toBe(0.9);
    expect(gauge('poker_operator_floor_park_known')).toBe(1);

    watch.resetFloorParkWatchForTests();
    // Before migration 20261015181538 is installed the function does not exist.
    await watch.refreshFloorPark(async () => ({
      data: null,
      error: { message: 'Could not find the function public.fn_ca_operator_floor_park_share' },
    }));
    expect(watch.ownerFloorParkShare()).toBe(0);
    expect(gauge('poker_operator_floor_park_share')).toBe(0);
    expect(gauge('poker_operator_floor_park_known')).toBe(0);

    await watch.refreshFloorPark(async () => ({ data: { held: true }, error: null }));
    expect(watch.ownerFloorParkShare()).toBe(0);

    await watch.refreshFloorPark(() => {
      throw new Error('ETIMEDOUT');
    });
    expect(watch.ownerFloorParkShare()).toBe(0);
  });
});

/** Push the verifier past its startup grace so the floor can be judged. */
function pastBoot(v: unknown) {
  (v as { startedAt: number }).startedAt = Date.now() - 10 * 60_000;
}

describe('ClubArenaFleetFloorLost and an owner park', () => {
  const one = () => ['table-0'];

  it('still pages a lost floor with no park', async () => {
    const v = new DealRateVerifier(one);
    pastBoot(v);
    for (let i = 0; i < 4; i++) await v.check();
    await new Promise((r) => setTimeout(r, 0));
    expect(raised.map((r) => r.alertname)).toContain('ClubArenaFleetFloorLost');
  });

  it('stands down while a park holds the floor, and the streak does not survive it', async () => {
    const v = new DealRateVerifier(one);
    pastBoot(v);
    watch.noteFloorParkShare(1);
    for (let i = 0; i < 6; i++) await v.check();
    await new Promise((r) => setTimeout(r, 0));
    expect(raised).toEqual([]);
    expect(v.snapshot().belowFloorChecks).toBe(0);
  });

  it('a park of less than half the floor does not stand it down', async () => {
    const v = new DealRateVerifier(one);
    pastBoot(v);
    watch.noteFloorParkShare(0.2);
    for (let i = 0; i < 4; i++) await v.check();
    await new Promise((r) => setTimeout(r, 0));
    expect(raised.map((r) => r.alertname)).toContain('ClubArenaFleetFloorLost');
  });
});
