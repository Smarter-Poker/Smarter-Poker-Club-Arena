import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: () => {
      throw Error('unexpected DB');
    },
    rpc: () => {
      throw Error('unexpected RPC');
    },
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), describeError: String }));
const { buildHost, formedHand, flush, fakeHorseLane } =
  await import('../testing/lightningHostTestKit.js');
afterEach(() => vi.useRealTimers());
describe('feature authority at the Lightning action owner', () => {
  it.each([false, true])(
    'refuses unselected feature wager through actual host/controller free=%s',
    async (free) => {
      const t = buildHost(formedHand(2, 9911), [100, 100]);
      await t.host.start();
      await flush();
      const host = t.host as any;
      if (free) {
        const first = host.peekState();
        const actor = first.players.find((p: any) => p.seat === first.currentPlayerSeat);
        expect(host.hc.performAction(actor.seat, 'call')).toBe(true);
      }
      const state = host.peekState(),
        actor = state.players.find((p: any) => p.seat === state.currentPlayerSeat),
        lane = fakeHorseLane();
      const commit = vi.spyOn(lane.lane, 'commitDecisionEffects');
      host.executeHorseDecision(
        actor.user_id,
        {
          action: 'raise',
          amount: 20,
          workerFallback: false,
          fast: {
            decision: {
              action: 'raise',
              amount: 20,
              thinkTime: 0,
              featureAuthority: { version: 'horse-feature-decision-v1', authority: {} },
            },
            effects: [],
            planBinding: null,
            planIssueDisposition: 'no_effects',
          },
        },
        free,
        () => lane.lane
      );
      const action = host.actions.findLast(
        (a: any) => a.userId === actor.user_id && a.origin === 'horse_fallback'
      );
      expect(action?.action).toBe(free ? 'check' : 'fold');
      expect(commit).not.toHaveBeenCalled();
      await flush();
    }
  );
});
