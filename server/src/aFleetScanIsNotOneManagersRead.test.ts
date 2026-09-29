import { describe, expect, it } from 'vitest';
import { GameServer } from './GameServer.js';
import {
  bindTournamentDataAuthorityMethods,
  currentTournamentDataAuthority,
  runWithTournamentDataAuthority,
} from './services/supabase/dataActorContext.js';

/*
 * A FLEET SCAN IS NOT ONE MANAGER'S READ (2026-09-26).
 *
 * At 04:45:56Z a lease loss on engine f1d956c3 sent every mixed-custody
 * retirement through TournamentManager's bound `staleness` check, which calls
 * `GameServer.hasCompleteMixedF06PhysicalMap`. That scanned the whole fleet and
 * called each engine's authority-bound `getEngineLeaseAuthority()` from inside
 * the calling manager's context, so the first engine of any OTHER tournament
 * threw "Tournament data authority cannot be rebound inside another manager
 * context". No retirement could complete; 338 managers quarantined and the
 * felt fell from ~550 hands/min to ~0 until the process was restarted.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const GEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GEN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T_A1 = 'a1a1a1a1-0000-4000-8000-000000000001';
const T_A2 = 'a2a2a2a2-0000-4000-8000-000000000002';
const T_B1 = 'b1b1b1b1-0000-4000-8000-000000000003';

/** A tournament table engine, bound to its own tournament exactly as in production. */
function engine(tournamentId: string, leaseGeneration: string) {
  return bindTournamentDataAuthorityMethods(
    { tournamentId, leaseGeneration },
    {
      getEngineLeaseAuthority() {
        return { scope: 'tournament', verified: true, generation: leaseGeneration, tournamentId };
      },
    }
  ) as any;
}

function fleet(entries: [string, any][], owned: string[]) {
  const server = Object.create(GameServer.prototype) as any;
  const manager = {};
  server.tableEngines = new Map(entries);
  server.tournamentOwnedTables = new Set(owned);
  server.tournamentEngines = new Map([[A, manager]]);
  server.drainedF06TournamentCustody = undefined;
  return { server, manager };
}

const asManagerA = <T>(work: () => T) =>
  runWithTournamentDataAuthority({ tournamentId: A, leaseGeneration: GEN_A }, work);

describe('a fleet scan made from inside one manager reads every tournament at the process root', () => {
  it('reproduces the production throw with the scan made in the caller context', () => {
    const a1 = engine(A, GEN_A);
    const b1 = engine(B, GEN_B);
    // The shape that shipped: the scan runs where the caller runs.
    expect(() =>
      asManagerA(() => [a1, b1].filter((e) => e.getEngineLeaseAuthority()?.tournamentId === A))
    ).toThrow('Tournament data authority cannot be rebound inside another manager context');
  });

  it('answers true for a complete map while another tournament shares the fleet', () => {
    const a1 = engine(A, GEN_A);
    const { server, manager } = fleet(
      [
        [T_A1, a1],
        [T_B1, engine(B, GEN_B)],
      ],
      [T_A1, T_B1]
    );
    expect(asManagerA(() => server.hasCompleteMixedF06PhysicalMap(A, manager, [[T_A1, a1]]))).toBe(
      true
    );
  });

  it('keeps the predicate exact: an extra, missing or unowned engine is still incomplete', () => {
    const a1 = engine(A, GEN_A);
    const a2 = engine(A, GEN_A);
    const extra = fleet(
      [
        [T_A1, a1],
        [T_A2, a2],
        [T_B1, engine(B, GEN_B)],
      ],
      [T_A1, T_A2, T_B1]
    );
    expect(
      asManagerA(() => extra.server.hasCompleteMixedF06PhysicalMap(A, extra.manager, [[T_A1, a1]]))
    ).toBe(false);
    const unowned = fleet([[T_A1, a1]], []);
    expect(
      asManagerA(() =>
        unowned.server.hasCompleteMixedF06PhysicalMap(A, unowned.manager, [[T_A1, a1]])
      )
    ).toBe(false);
    const missing = fleet([[T_B1, engine(B, GEN_B)]], [T_B1]);
    expect(
      asManagerA(() =>
        missing.server.hasCompleteMixedF06PhysicalMap(A, missing.manager, [[T_A1, a1]])
      )
    ).toBe(false);
  });

  it("restores the caller's own authority after the scan", () => {
    const a1 = engine(A, GEN_A);
    const { server, manager } = fleet(
      [
        [T_A1, a1],
        [T_B1, engine(B, GEN_B)],
      ],
      [T_A1, T_B1]
    );
    const seen = asManagerA(() => {
      server.hasCompleteMixedF06PhysicalMap(A, manager, [[T_A1, a1]]);
      return currentTournamentDataAuthority();
    });
    expect(seen).toMatchObject({ tournamentId: A, leaseGeneration: GEN_A });
  });
});
