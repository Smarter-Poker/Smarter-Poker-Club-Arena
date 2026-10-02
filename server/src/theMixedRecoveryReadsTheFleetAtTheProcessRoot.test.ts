import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameServer } from './GameServer.js';
import {
  bindTournamentDataAuthorityMethods,
  runWithTournamentDataAuthority,
} from './services/supabase/dataActorContext.js';

/*
 * THE MIXED RECOVERY'S OWN FLEET CHECK READS AT THE PROCESS ROOT (2026-09-27).
 *
 * 20260927145449 voided the dead origin hands of 70 stranded mixed-custody
 * events at 21:24 UTC. Engine e6b9dc5d then admitted each successor and ran
 * `manager.recoverMixedF06Custody`, whose `reservation.assertCurrent` re-checks
 * the admission's `current()` from inside that manager's data authority. That
 * closure scanned every table engine inline, so the first engine of any other
 * tournament threw "Tournament data authority cannot be rebound inside another
 * manager context" and every event was retained
 * (GameServer.mixed_original_recovery_retained); none resumed.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const GEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GEN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

function server(entries: [string, any][]) {
  const s = Object.create(GameServer.prototype) as any;
  s.tableEngines = new Map(entries);
  return s;
}

const asManagerA = <T>(work: () => T) =>
  runWithTournamentDataAuthority({ tournamentId: A, leaseGeneration: GEN_A }, work);

describe('the mixed recovery reads the fleet at the process root', () => {
  it('reproduces the production throw with the inline scan', () => {
    const fleet = [engine(B, GEN_B)];
    expect(() =>
      asManagerA(() =>
        fleet.every((e) => {
          const authority = e.getEngineLeaseAuthority();
          return authority?.scope !== 'tournament' || authority.tournamentId !== A;
        })
      )
    ).toThrow('Tournament data authority cannot be rebound inside another manager context');
  });

  it('answers from inside the manager while another tournament shares the fleet', () => {
    const s = server([
      ['b1', engine(B, GEN_B)],
      ['cash', { getEngineLeaseAuthority: () => ({ scope: 'cash' }) }],
    ]);
    expect(asManagerA(() => s.noTournamentEngineOnFleet(A))).toBe(true);
  });

  it('keeps the predicate exact: an engine of this tournament still holds it', () => {
    const s = server([
      ['b1', engine(B, GEN_B)],
      ['a1', engine(A, GEN_A)],
    ]);
    expect(asManagerA(() => s.noTournamentEngineOnFleet(A))).toBe(false);
    expect(s.noTournamentEngineOnFleet(A)).toBe(false);
  });

  it('the mixed admission closure uses the root read, not an inline scan', () => {
    const src = readFileSync(join(__dirname, 'GameServer.ts'), 'utf8');
    const at = src.indexOf('const reservation = this.tournamentRetirementCustody.reserveMixed(');
    const closure = src.slice(src.lastIndexOf('const current = () =>', at), at);
    expect(closure).toContain('this.noTournamentEngineOnFleet(tournamentId)');
    expect(closure).not.toContain('getEngineLeaseAuthority');
  });
});
