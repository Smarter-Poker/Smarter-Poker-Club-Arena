/**
 * LAW (2026-10-24): A LIGHTNING HAND IS A HAND IN THE STATS AND IN THE
 * COLLUSION SCAN.
 *
 * Production 2026-10-24: 0 of 40 settled Lightning hands reached ca_hand_facts
 * or ca_hand_transfers, against 40 of 40 physical hands - so fn_ca_collusion_scan,
 * the player statistics, the Lightning session recap's VPIP/PFR and the VPIP
 * floor never saw a fast-fold hand. A settled Lightning hand now carries the
 * physical hand's private stats payload, built by the same builder:
 *
 *   1. one fact row per participant dealt in, horse or human (CLAUDE.md 10.5),
 *      each keyed by the Lightning hand id at the host table and its club -
 *      exactly the scope fn_lightning_settle_hand keeps and the projector
 *      accepts (migration 20261025000729);
 *   2. the head-to-head transfers of the same hand, same keys;
 *   3. built once: every settlement retry sends the identical request;
 *   4. a builder that fails, or a host table with no club, settles the hand
 *      exactly as before, with no facts.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning law fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning law fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), describeError: String }));
const { mulberry32 } = await import('../engine/HandFuzzer.js');
const kit = await import('../testing/lightningHostTestKit.js');

const CLUB = '00000000-0000-4000-8000-0000000c1ab0';

async function settled(
  base: number,
  opts: Parameters<typeof kit.buildHost>[2] = {},
  stacks = [100, 100, 100, 100]
) {
  const formed = kit.formedHand(stacks.length, base);
  const t = kit.buildHost(formed, stacks, {
    horses: new Set([formed.players[0]!, formed.players[2]!]),
    rules: { club_id: CLUB },
    ...opts,
  });
  await t.host.start();
  await kit.playOut(t.host, mulberry32(base));
  await kit.flush(40);
  return { t, formed };
}

type Facts = { version: number; facts: any[]; transfers: any[] };
const factsOf = (row: Record<string, unknown>): Facts | undefined =>
  (row._accepted_post_commit_facts as { stats_facts?: Facts } | undefined)?.stats_facts;

describe('LAW: a Lightning hand is a hand in the stats and in the collusion scan', () => {
  it('sends one fact row per participant, keyed by the Lightning hand at the host table and club', async () => {
    for (const base of [12_100, 12_200, 12_300]) {
      const { t, formed } = await settled(base);
      expect(t.host.lifecycle).toBe('complete');
      const sent = t.calls.settle[0]!;
      const facts = factsOf(sent.handRow);
      expect(facts, 'a settled Lightning hand carries its stats facts').toBeDefined();
      expect(facts!.version).toBe(2);
      expect(new Set(facts!.facts.map((f) => f.user_id))).toEqual(new Set(formed.players));
      for (const f of facts!.facts) {
        expect(f.hand_id).toBe(formed.handId);
        expect(f.hand_id).toBe(sent.handId);
        expect(f.table_id).toBe(sent.hostTableId);
        expect(f.club_id).toBe(CLUB);
        expect(f.tournament_id ?? null).toBeNull();
        expect(f.played_at).toBe(sent.handRow.ended_at);
      }
      // The facts' money is the settlement's money, to the cent.
      for (const r of sent.results) {
        const f = facts!.facts.find((x) => x.user_id === r.playerId)!;
        expect(f.invested).toBeCloseTo(r.contributed, 2);
        expect(f.returned).toBeCloseTo(r.won, 2);
      }
      for (const x of facts!.transfers) {
        expect(x.hand_id).toBe(formed.handId);
        expect(x.table_id).toBe(sent.hostTableId);
        expect(x.club_id).toBe(CLUB);
        expect(x.amount).toBeGreaterThan(0);
      }
    }
  });

  it('builds the facts once, so every settlement retry sends the identical request', async () => {
    const build = vi.fn((await import('../services/supabase/handFacts.js')).writeHandFacts);
    const { t } = await settled(12_400, {
      rules: { club_id: CLUB },
      settleScript: ['transport', 'ok'],
      deps: { statsFacts: build },
    });
    expect(t.calls.settle.length).toBe(2);
    expect(build).toHaveBeenCalledTimes(1);
    expect(t.calls.settle[1]!.handRow).toEqual(t.calls.settle[0]!.handRow);
    expect(factsOf(t.calls.settle[1]!.handRow)).toBeDefined();
  });

  it('settles exactly as before when the builder fails or the table has no club', async () => {
    const failing = await settled(12_500, {
      rules: { club_id: CLUB },
      deps: {
        statsFacts: async () => {
          throw new Error('builder down');
        },
      },
    });
    expect(failing.t.host.lifecycle).toBe('complete');
    expect(failing.t.calls.settle[0]!.handRow).not.toHaveProperty('_accepted_post_commit_facts');

    const noClub = await settled(12_600, { rules: {} });
    expect(noClub.t.host.lifecycle).toBe('complete');
    expect(noClub.t.calls.settle[0]!.handRow).not.toHaveProperty('_accepted_post_commit_facts');
  });
});
