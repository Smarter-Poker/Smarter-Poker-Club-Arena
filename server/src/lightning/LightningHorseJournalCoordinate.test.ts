import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { buildHost, formedHand, flush, uid } = await import('../testing/lightningHostTestKit.js');
const { anchorHorseDecisionHand } = await import('../engine/HorseDecisionHandBinding.js');
const { horseMindHandFromDecision } = await import('../engine/HorseMindHandIdentity.js');
const {
  horsePlanContextFromDecision,
  horsePlanContextKey,
  horsePlanBatchBindingFromRequest,
  horsePlanBatchBindingIsValid,
  horsePlanBatchBindingMatchesRequest,
} = await import('../engine/HorsePlanHandIdentity.js');
const { buildHorseDecisionKey, validatedHorsePolicySamplingKey } =
  await import('../engine/horseDecision/protocol.js');

const hosts: any[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.abort('test_complete').catch(() => undefined);
  vi.useRealTimers();
});
async function snapshots() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  const formed = formedHand(3, 4100),
    lease = uid(4242);
  const t = buildHost(formed, [100, 100, 100], {
    horses: new Set(formed.players),
    lease: () => ({ instance: 'test-instance', generation: lease }),
  });
  hosts.push(t.host);
  await t.host.start();
  for (let n = 0; n < 600 && t.host.lifecycle === 'dealing'; n++) {
    await vi.advanceTimersByTimeAsync(1000);
    await flush(4);
  }
  expect(t.horseLane.calls.length).toBeGreaterThan(1);
  return { calls: t.horseLane.calls, lease };
}

describe('the original Lightning journal coordinate', () => {
  it('anchors both turn and early snapshots to the actual host lease', async () => {
    const { calls, lease } = await snapshots();
    for (const snap of calls) {
      expect(anchorHorseDecisionHand(snap)).toMatchObject({
        status: 'anchored',
        leaseGeneration: lease,
      });
      expect(horseMindHandFromDecision(snap)).not.toBeNull();
      expect(horsePlanContextKey(horsePlanContextFromDecision(snap))).not.toBeNull();
    }
  });

  it('validates new bookkeeping without changing the existing transport or policy seed', async () => {
    const { calls } = await snapshots();
    for (const snap of calls) {
      expect((snap as any).handJournalCoordinate).toBeDefined();
      const legacy = { ...snap } as any;
      delete legacy.handJournalCoordinate;
      legacy.decisionKey = buildHorseDecisionKey(legacy);
      expect(snap.decisionKey).not.toBe(legacy.decisionKey);
      expect(validatedHorsePolicySamplingKey(snap)).toBe(validatedHorsePolicySamplingKey(legacy));
      expect(snap.fence).toBe(legacy.fence);
    }
  });

  it('retains original coordinates through plan issue and refuses another lease on commit', async () => {
    const { calls } = await snapshots();
    for (const snap of calls) {
      const request = { ...snap, requestId: 1 };
      const binding = horsePlanBatchBindingFromRequest(request);
      expect(binding.planContext.hand).not.toBeNull();
      expect(horsePlanBatchBindingIsValid(JSON.parse(JSON.stringify(binding)))).toBe(true);
      expect(horsePlanBatchBindingMatchesRequest(binding, request)).toBe(true);
      const changed = {
        ...binding,
        handJournalCoordinate: {
          ...(binding as any).handJournalCoordinate,
          leaseGeneration: uid(4243),
        },
      };
      expect(horsePlanBatchBindingMatchesRequest(changed, request)).toBe(false);
    }
  });
});
