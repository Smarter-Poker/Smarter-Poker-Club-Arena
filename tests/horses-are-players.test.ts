/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HORSES ARE PLAYERS — the law, and the evidence a rule needs to apply it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-27 (binding): "HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON
 * ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!"
 *
 * The law's own first fix was inert. It removed a horse-only predicate from
 * fn_nit_evictions, but the rule is judged by fn_nit_check reading
 * ca_hand_facts, and the engine wrote that table for humans only - so a
 * horse's VPIP sample was permanently zero, `0 >= 100` was false, and every
 * horse cleared the floor for ever.
 *
 * Proved against production in a rolled-back transaction: NIT Game demanding
 * 99% VPIP evicted the human (24.6% over 544 hands) and returned
 * `ok: true, within_limits` for the horse beside them. After writing the
 * evidence the patched engine now writes, fn_nit_evictions returned that
 * horse.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('a horse leaves the same evidence a human does', () => {
  const FACTS = read('server/src/services/supabase/handFacts.ts');

  it('no longer writes fact rows for humans only', () => {
    expect(FACTS).not.toContain('humanIds');
    expect(FACTS).not.toMatch(/humans only/);
  });

  it('includes horses when the table runs NIT Game', () => {
    expect(FACTS).toMatch(/!p\.isHorse \|\| input\.nitGame === true/);
  });

  it('takes the table setting as an input rather than guessing', () => {
    expect(FACTS).toMatch(/nitGame\?: boolean/);
  });

  it('the engine passes the real table setting through', () => {
    expect(read('server/src/engine/ServerTableEngineSettlement.ts')).toMatch(
      /nitGame: this\.tableInfo\.nit_game === true/
    );
    expect(read('server/src/services/supabase/handHistory.ts')).toMatch(/nitGame: params\.nitGame/);
  });

  it('the stale claim that horses are excluded is gone', () => {
    // nitGame.ts asserted "Horses are excluded inside the function" AFTER the
    // predicate had been removed. A comment that contradicts its own code is
    // how the next reader reintroduces the bug.
    expect(read('server/src/services/supabase/nitGame.ts')).not.toMatch(
      /Horses are excluded inside the function/
    );
  });
});

describe('the law is mechanical, not just written down', () => {
  it('the gate exists and is wired into CI and the local suite', () => {
    expect(existsSync(join(__dirname, '..', 'scripts/ci/check-horses-are-players.mjs'))).toBe(true);
    expect(read('.github/workflows/ci.yml')).toContain(
      'node scripts/ci/check-horses-are-players.mjs'
    );
    expect(read('scripts/ci/all-gates.sh')).toContain('check-horses-are-players');
  });

  it('every registered site carries a kind and a reason', () => {
    const gate = read('scripts/ci/check-horses-are-players.mjs');
    const kinds = gate.match(/kind: '(IDENTIFICATION|EQUAL OUTCOME)'/g) || [];
    const whys = gate.match(/why:/g) || [];
    const allowed = gate.match(/allowed: \d+/g) || [];
    expect(kinds.length).toBeGreaterThanOrEqual(7);
    expect(whys.length).toBe(kinds.length);
    expect(allowed.length).toBe(kinds.length);
  });

  it('does not try to guess which way a negation cuts', () => {
    // `if (!seated?.is_horse) continue` excludes horses in one file and selects
    // them in another. Guessing about a rule that ejects players is worse than
    // asking a person to write it down.
    expect(read('scripts/ci/check-horses-are-players.mjs')).toMatch(
      /deliberately does not try to guess/
    );
  });
});
