/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A PLACE IS PAID ONCE, WHOEVER ENDS UP HOLDING IT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The prize idempotency key used to be `tourney:{id}:prize:{user}:{place}`. It
 * deduped a repeated USER and not a repeated PLACE, so two different players
 * stamped with the same place produced two different keys and both were paid.
 *
 * Observed live on 2026-08-28, hours after the historical duplicates were
 * cleaned up: Union PKO Afternoon (PLO4) `4f42d847` credited "Tournament prize:
 * position 2" twice — 17:43 and 18:43, two different players, 120.00 each —
 * and disbursed 720.00 against a 600.00 prize pool. 120% of the pool, and the
 * excess is exactly one place-2 prize.
 *
 * Neither payment was mispriced. The engine priced each correctly for the
 * position it believed at the time; a later arrival shifted the field, the
 * first player was renumbered from 2nd to 3rd, and the new 2nd place was paid
 * place 2 all over again. Renumbering the RECORD cannot un-send a credit, so
 * the fix (2026-08-28) was at the key: keyed on the place, the second payment
 * is a no-op regardless of who holds it or which code path pays it.
 *
 * 2026-09-08: every terminal leg now commits behind
 * `fn_complete_tournament_terminal`. The generic obligation payer is private
 * database plumbing. These pins assert that live and recovery code share the
 * domain authority and build no payment key of their own.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceCall, sliceMethod } from '../helpers/sourceWindow';

const PAYING_PATHS = [
  'server/src/tournament/TournamentManagerEliminations.ts',
  'server/src/tournament/tournamentRecovery.ts',
  'server/src/tournament/TournamentManager.ts',
];
const TERMINAL_HELPER = 'server/src/tournament/terminalSettlementRpc.ts';
const SATELLITE_HELPER = 'server/src/tournament/satelliteSettlementRpc.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Real template-literal keys only (a `${` means the engine builds it). */
const tourneyKeys = (src: string): string[] =>
  (code(src).match(/`tourney:[^`]*`/g) ?? []).filter((k) => k.includes('${'));

describe('a place is paid once: the place obligation, not a hand-built key', () => {
  for (const path of PAYING_PATHS) {
    it(`${path} settles through an approved database authority`, () => {
      const src = code(read(path));
      if (path.endsWith('/tournamentRecovery.ts')) {
        const recovery = sliceMethod(src, 'recoverStuckCompletingTournaments(');
        const cashCall = sliceCall(recovery, 'requestTournamentTerminalReceipt(');
        const satelliteCall = sliceCall(recovery, 'requestSatelliteSettlementReceipt(');
        expect(cashCall).toMatch(
          /requestTournamentTerminalReceipt\(t\.id, settlementMode, winnerId\)/
        );
        expect(satelliteCall).toMatch(/requestSatelliteSettlementReceipt\(t\.id, winnerId\)/);
        expect(recovery).not.toMatch(
          /supabase\.rpc\('fn_(?:complete_tournament_terminal|settle_satellite_tournament)'/
        );
      } else if (path.endsWith('/TournamentManagerEliminations.ts')) {
        const finish = sliceMethod(src, 'protected async finishTournament(');
        expect(sliceCall(finish, 'requestTournamentTerminalReceipt(')).toMatch(
          /requestTournamentTerminalReceipt\(this\.tournamentId, 'places', winnerId\)/
        );
        expect(finish).not.toMatch(/settleTournamentObligation\(/);
        expect(finish).not.toMatch(/supabase\.rpc\('fn_complete_tournament_terminal'/);
      } else if (path.endsWith('/TournamentManager.ts')) {
        const satellite = sliceMethod(src, 'processSatelliteAwards(');
        expect(sliceCall(satellite, 'requestSatelliteSettlementReceipt(')).toMatch(
          /requestSatelliteSettlementReceipt\(this\.tournamentId, winnerId\)/
        );
        expect(src).not.toMatch(/supabase\.rpc\('fn_settle_satellite_tournament'/);
        expect(src).not.toMatch(/rpc\('fn_award_satellite_seat'/);
      }
    });

    it(`${path} builds no tourney: idempotency key of its own`, () => {
      // A key built here is a second opinion about what was paid. The
      // database holds the only one.
      const source = read(path);
      const payingSource = path.endsWith('/tournamentRecovery.ts')
        ? source.slice(source.indexOf('export async function recoverStuckCompletingTournaments'))
        : source;
      expect(tourneyKeys(payingSource)).toEqual([]);
    });

    it(`${path} has no application-side obligation payer`, () => {
      // A direct payer here would recreate the second authority this suite
      // retired, even if it happened to supply a place today.
      expect(code(read(path))).not.toMatch(/settleTournamentObligation\(/);
    });
  }

  it('the finish path delegates every place to the one authoritative database door', () => {
    const finish = sliceMethod(
      code(read('server/src/tournament/TournamentManagerEliminations.ts')),
      'protected async finishTournament('
    );
    expect(sliceCall(finish, 'requestTournamentTerminalReceipt(')).toMatch(
      /requestTournamentTerminalReceipt\(this\.tournamentId, 'places', winnerId\)/
    );
    expect(finish).not.toMatch(/kind:\s*'place'/);

    const terminalAuthority = sliceMethod(
      code(read(TERMINAL_HELPER)),
      'requestTournamentTerminalReceipt('
    );
    expect(terminalAuthority).toMatch(/p_tournament_id:\s*tournamentId/);
    expect(terminalAuthority).toMatch(/p_observed_winner_id:\s*observedWinnerId/);
    expect(terminalAuthority).toMatch(/p_settlement_mode:\s*settlementMode/);
    expect(sliceCall(terminalAuthority, "supabase.rpc('fn_complete_tournament_terminal'")).toMatch(
      /fn_complete_tournament_terminal'[\s\S]*request/
    );
  });

  it('the satellite path delegates to its one receipt-validating database door', () => {
    const satelliteAuthority = sliceMethod(
      code(read(SATELLITE_HELPER)),
      'requestSatelliteSettlementReceipt('
    );
    expect(satelliteAuthority).toMatch(/p_tournament_id:\s*tournamentId/);
    expect(satelliteAuthority).toMatch(/p_observed_winner_id:\s*observedWinnerId/);
    expect(sliceCall(satelliteAuthority, "supabase.rpc('fn_settle_satellite_tournament'")).toMatch(
      /fn_settle_satellite_tournament'[\s\S]*request/
    );
    expect(satelliteAuthority).toMatch(/verifySatelliteSettlementReceipt\(/);
  });
});
