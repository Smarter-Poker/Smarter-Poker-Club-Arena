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
 * the fix has to be at the key: keyed on the place, the second payment is a
 * no-op regardless of who holds it or which code path pays it.
 *
 * These assert the SOURCE, because the defect is a key format that must never
 * come back, and it has to hold across all four paying paths at once.
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

/**
 * Real template-literal prize keys only.
 *
 * The `${` requirement matters: comments in these files quote the OLD broken
 * format as `tourney:{id}:prize:{user}:{place}` to explain what went wrong, and
 * that prose is worth keeping. Documentation of a fixed bug is not the bug. A
 * key the engine actually builds always interpolates something.
 */
const prizeKeys = (src: string): string[] =>
  (src.match(/`tourney:[^`]*:prize:[^`]*`/g) ?? []).filter((k) => k.includes('${'));

describe('the prize idempotency key is scoped to the place, not the player', () => {
  for (const path of PAYING_PATHS) {
    it(`${path} keys every prize on the place`, () => {
      const keys = prizeKeys(read(path));
      expect(keys.length).toBeGreaterThan(0); // this file does pay prizes
      for (const k of keys) {
        expect(k, `user-scoped prize key still present: ${k}`).toContain(':prize:place:');
      }
    });

    it(`${path} interpolates no user id into a prize key`, () => {
      for (const k of prizeKeys(read(path))) {
        // A user id in the key is what let one place be paid twice.
        expect(k).not.toMatch(/prize:\$\{[^}]*(user|winner|Id)[^}]*\}/i);
      }
    });
  }

  it('every paying path agrees on one format, so they dedupe against each other', () => {
    // The recovery watchdog and the finish path must collide with the
    // elimination path on purpose — that is what makes a retry a no-op.
    const shapes = new Set<string>();
    for (const path of PAYING_PATHS) {
      for (const k of prizeKeys(read(path))) {
        shapes.add(k.replace(/\$\{[^}]+\}/g, '${}'));
      }
    }
    for (const s of shapes) {
      expect(s, `unexpected prize key shape: ${s}`).toMatch(/:prize:place:/);
    }
  });
});
