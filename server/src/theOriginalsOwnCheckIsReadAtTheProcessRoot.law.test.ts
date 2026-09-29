import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameServer } from './GameServer.js';
import {
  bindTournamentDataAuthorityMethods,
  runWithTournamentDataAuthority,
} from './services/supabase/dataActorContext.js';

/*
 * THE ORIGINAL MANAGER'S OWN CHECK IS READ AT THE PROCESS ROOT (2026-09-28).
 *
 * Tournament 4e2de62d ("Friday Fight Night Opener") lost lease generation
 * 9e2be701 at 13:49:49Z on engine 763e4cec with its four stopped table engines
 * still in the process. The successor generation 658aba20 prepared mixed
 * transfer 2b5b36ff at 13:50:32Z and was admitted; its
 * `manager.recoverMixedF06Custody` calls `reservation.assertCurrent`, which
 * re-checks the admission's `current()` inside the SUCCESSOR's bound data
 * authority. That closure asked the in-process drained packet `packet.current()`
 * inline, and that check belongs to the ORIGINAL manager: its methods are bound
 * to generation 9e2be701. Same tournament, another generation, so the first
 * bound call threw "Tournament data authority cannot be rebound inside another
 * manager context", and every re-admission from 13:50:39Z on was retained on
 * GameServer.mixed_original_recovery_retained. #5478 had moved the fleet scan in
 * the same closure to the process root and left this read inline.
 */

const T = '4e2de62d-3680-4247-ba6f-0b26485701b2';
const ORIGIN = '9e2be701-264f-4847-8b15-2781519a7515';
const SUCCESSOR = '658aba20-a0ac-4ece-9c1f-bd47153b3f84';

/** The original manager as the successor meets it: every method bound to ITS generation. */
function originalManager(answer: boolean) {
  return bindTournamentDataAuthorityMethods(
    { tournamentId: T, leaseGeneration: ORIGIN },
    {
      captureDrainedF06Originals() {
        return answer;
      },
    }
  );
}

/** The drained packet: its `current` is the original's own staleness closure. */
function packet(answer: boolean) {
  const manager = originalManager(answer);
  return { current: () => manager.captureDrainedF06Originals() === true } as any;
}

const asSuccessor = <R>(work: () => R) =>
  runWithTournamentDataAuthority({ tournamentId: T, leaseGeneration: SUCCESSOR }, work);

const server = () => Object.create(GameServer.prototype) as GameServer;

describe("the original manager's own check is read at the process root", () => {
  it('reproduces the production throw with the inline read', () => {
    const p = packet(true);
    expect(() => asSuccessor(() => p.current())).toThrow(
      'Tournament data authority cannot be rebound inside another manager context'
    );
  });

  it("answers the original's own verdict from inside the successor", () => {
    const s = server();
    expect(asSuccessor(() => s.drainedOriginalIsCurrent(packet(true)))).toBe(true);
    expect(asSuccessor(() => s.drainedOriginalIsCurrent(packet(false)))).toBe(false);
  });

  it('keeps the predicate exact: no packet is current, and outside any manager it is unchanged', () => {
    const s = server();
    expect(asSuccessor(() => s.drainedOriginalIsCurrent(null))).toBe(true);
    expect(s.drainedOriginalIsCurrent(undefined)).toBe(true);
    expect(s.drainedOriginalIsCurrent(packet(true))).toBe(true);
    expect(s.drainedOriginalIsCurrent(packet(false))).toBe(false);
  });

  it('the successor stays in its own authority after the read', () => {
    const s = server();
    const successor = bindTournamentDataAuthorityMethods(
      { tournamentId: T, leaseGeneration: SUCCESSOR },
      { own: () => 'ok' }
    );
    expect(
      asSuccessor(() => {
        s.drainedOriginalIsCurrent(packet(true));
        return successor.own();
      })
    ).toBe('ok');
  });

  it('the mixed admission closure reads the packet at the root, never inline', () => {
    const src = readFileSync(join(__dirname, 'GameServer.ts'), 'utf8');
    const at = src.indexOf('const reservation = this.tournamentRetirementCustody.reserveMixed(');
    const closure = src.slice(src.lastIndexOf('const current = () =>', at), at);
    expect(closure).toContain('this.drainedOriginalIsCurrent(packet)');
    expect(closure).toContain('this.noTournamentEngineOnFleet(tournamentId)');
    expect(closure).not.toContain('packet.current()');
    const method = src.slice(src.indexOf('  drainedOriginalIsCurrent(packet'));
    expect(method.slice(0, method.indexOf('\n  }\n'))).toContain(
      'return bindToProcessRoot(() => packet.current())();'
    );
  });
});
