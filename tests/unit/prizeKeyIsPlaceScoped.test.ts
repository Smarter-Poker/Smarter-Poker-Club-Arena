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
 * 2026-09-08: ordinary place prizes moved into the single terminal receipt
 * transaction shared by finish and recovery. The engine never constructs a
 * payout key or pays an individual obligation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TERMINAL_PLACE_PATHS = [
  'server/src/tournament/TournamentManagerEliminations.ts',
  'server/src/tournament/tournamentRecovery.ts',
];

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const payingRuntime = (path: string): string => {
  const src = code(read(path));
  if (!path.endsWith('tournamentRecovery.ts')) return src;
  return src.slice(src.indexOf('export async function recoverStuckCompletingTournaments('));
};

/** Real template-literal keys only (a `${` means the engine builds it). */
const tourneyKeys = (src: string): string[] =>
  (code(src).match(/`tourney:[^`]*`/g) ?? []).filter((k) => k.includes('${'));

describe('a place is paid once: the place obligation, not a hand-built key', () => {
  for (const path of TERMINAL_PLACE_PATHS) {
    it(`${path} builds no tourney: idempotency key of its own`, () => {
      // A key built here is a second opinion about what was paid. The
      // database holds the only one.
      expect(tourneyKeys(payingRuntime(path))).toEqual([]);
    });

    it(`${path} sends ordinary places only through the terminal receipt`, () => {
      const src = payingRuntime(path);
      expect(src).toMatch(/requestTournamentTerminalReceipt\(/);
      expect(src).not.toMatch(/settleTournamentPlacesAtomically\(|settleTournamentObligation\(/);
      expect(tourneyKeys(src)).toEqual([]);
    });
  }

  it('the finish path and recovery watchdog invoke the SAME terminal receipt owner', () => {
    // They must collide on purpose; the frozen batch fingerprint makes a
    // retry or lost response a no-op.
    const eliminations = read('server/src/tournament/TournamentManagerEliminations.ts');
    const recovery = read('server/src/tournament/tournamentRecovery.ts');
    expect(code(eliminations)).toMatch(/requestTournamentTerminalReceipt\(/);
    expect(code(recovery)).toMatch(/requestTournamentTerminalReceipt\(/);
  });
});
