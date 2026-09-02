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
 * 2026-09-02 (chip accounting standard, Lane A2): the key moved out of the
 * engine and into the database. Every tournament credit now goes through
 * `settleTournamentObligation`, which settles the obligation row
 * (tournament_id, kind, place) — UNIQUE by constraint — and the RPC derives
 * the ledger key from that row. There is no `tourney:` string left for a
 * refactor to get wrong. What these pins now assert is the same property in
 * its new home: every 'place' settle carries a PLACE, and no paying path
 * builds a key of its own.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAYING_PATHS = [
  'server/src/tournament/TournamentManagerEliminations.ts',
  'server/src/tournament/tournamentRecovery.ts',
  'server/src/tournament/TournamentManager.ts',
];

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * Every settleTournamentObligation({...}) argument object in a file, brace to
 * brace. Each is one obligation being settled.
 */
const settleCalls = (src: string): string[] =>
  code(src).match(/settleTournamentObligation\(\s*supabase\s*,\s*\{[\s\S]*?\n\s*\}/g) ?? [];

/** Real template-literal keys only (a `${` means the engine builds it). */
const tourneyKeys = (src: string): string[] =>
  (code(src).match(/`tourney:[^`]*`/g) ?? []).filter((k) => k.includes('${'));

describe('a place is paid once: the place obligation, not a hand-built key', () => {
  for (const path of PAYING_PATHS) {
    it(`${path} settles through the one helper`, () => {
      expect(settleCalls(read(path)).length).toBeGreaterThan(0); // this file does pay
    });

    it(`${path} builds no tourney: idempotency key of its own`, () => {
      // A key built here is a second opinion about what was paid. The
      // database holds the only one.
      expect(tourneyKeys(read(path))).toEqual([]);
    });

    it(`${path} gives every 'place' settle a place`, () => {
      const src = read(path);
      for (const call of settleCalls(src)) {
        // Either the literal kind is 'place' / 'late_reg_adjustment', or the
        // kind is a variable that the call sites resolve — in which case the
        // call must still forward a `place:` field.
        const isPlaceKind = /kind:\s*'(place|late_reg_adjustment)'/.test(call);
        const isUserKind =
          /kind:\s*'(bubble_protection|final_table_deal|refund|satellite_remainder|mystery_bounty|bounty|bounty_residual|seat)'/.test(
            call
          );
        if (isUserKind) continue;
        expect(
          /\bplace:/.test(call),
          `${path}: a ${isPlaceKind ? "'place'" : 'variable-kind'} settle without a place:\n${call}`
        ).toBe(true);
      }
    });
  }

  it('the finish path and the recovery watchdog settle the SAME obligation for place 1', () => {
    // They must collide on purpose — that is what makes a retry a no-op.
    const eliminations = read('server/src/tournament/TournamentManagerEliminations.ts');
    const recovery = read('server/src/tournament/tournamentRecovery.ts');
    expect(
      settleCalls(eliminations).some((c) => /kind:\s*'place'[\s\S]*place:\s*1\b/.test(c))
    ).toBe(true);
    expect(code(recovery)).toMatch(/\{ kind: 'place', place \}/);
  });
});
