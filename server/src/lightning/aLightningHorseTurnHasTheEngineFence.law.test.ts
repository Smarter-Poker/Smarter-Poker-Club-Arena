/**
 * A LIGHTNING HORSE TURN CARRIES THE PHYSICAL ENGINE'S FIVE-PART FENCE
 * (2026-10-24, horse capability audit).
 *
 * The decision lane, the in-hand HorseMind read, the barrel and raise plans
 * and the private journal all identify a horse turn by the physical engine's
 * fence, `table:hand:seat:lease:turn`. The Lightning host sent four parts,
 * so every Lightning horse decision lost its in-hand opponent read and its
 * plans, and was missing from the journal (1.73M refusals in two days of
 * production telemetry). These hands run through the real host and the real
 * HandController; only the lane is a recording stand-in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning host fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning host fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const kit = await import('../testing/lightningHostTestKit.js');
const { anchorHorseDecisionHand } = await import('../engine/HorseDecisionHandBinding.js');
const { horseMindHandFromDecision } = await import('../engine/HorseMindHandIdentity.js');
const { horsePlanContextFromDecision, horsePlanContextKey } =
  await import('../engine/HorsePlanHandIdentity.js');
const { horseLifecycleKeys } = await import('../services/horseDecisionJournal/lifecycle.js');
const { lightningHorseDecisionFence } = await import('./LightningHorse.js');
const { buildHost, formedHand, flush, uid } = kit;

const hosts: any[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.abort('test_complete').catch(() => undefined);
  vi.useRealTimers();
});

async function playHorseHand(lease: () => { instance: string; generation: string } | null) {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  const formed = formedHand(3, 4100);
  const t = buildHost(formed, [100, 100, 100], { horses: new Set(formed.players), lease });
  hosts.push(t.host);
  await t.host.start();
  for (let i = 0; i < 600 && t.host.lifecycle === 'dealing'; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
    await flush(4);
  }
  return t;
}

describe('a Lightning horse turn is identified exactly as a physical table turn', () => {
  it('every decision anchors to its hand, reads the hand in-flight and owns a plan namespace', async () => {
    const lease = uid(4242);
    const t = await playHorseHand(() => ({ instance: 'test-instance', generation: lease }));
    const calls = t.horseLane.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const snap of calls) {
      const parts = snap.fence.split(':');
      expect(parts).toHaveLength(5);
      expect(parts[3]).toBe(lease);
      expect(Number(parts[4])).toBe(snap.generation);
      expect(Number(parts[2])).toBe(snap.player.seat);
      // The private journal and committed-hand binding anchor it.
      expect(anchorHorseDecisionHand(snap)).toMatchObject({
        status: 'anchored',
        leaseGeneration: lease,
        seat: snap.player.seat,
      });
      // The worker's in-hand HorseMind observation gets a real identity.
      expect(horseMindHandFromDecision(snap)).not.toBeNull();
      // The barrel / raise plans get a hand namespace.
      expect(horsePlanContextKey(horsePlanContextFromDecision(snap))).not.toBeNull();
      // The lifecycle journal can key it (this threw for every Lightning turn).
      expect(() =>
        horseLifecycleKeys({ ...snap, type: 'DECIDE_FAST', requestId: 1 } as never)
      ).not.toThrow();
    }
    // One hand, one table and hand number across every seat's decisions.
    expect(new Set(calls.map((s) => s.fence.split(':').slice(0, 2).join(':'))).size).toBe(1);
  });

  it('a host without a verified lease is refused by name, never given an invented identity', () => {
    const fence = lightningHorseDecisionFence({
      hostTableId: uid(9000),
      handNumber: 1_000_123,
      seat: 2,
      leaseGeneration: null,
      generation: 3,
    });
    expect(fence).toBe(`${uid(9000)}:1000123:2:unverified:3`);
    const snap = { fence, generation: 3, player: { seat: 2, user_id: uid(1) } } as never;
    expect(anchorHorseDecisionHand(snap)).toEqual({
      status: 'unavailable',
      reason: 'invalid_turn_identity',
    });
    expect(horseMindHandFromDecision(snap)).toBeNull();
  });
});
