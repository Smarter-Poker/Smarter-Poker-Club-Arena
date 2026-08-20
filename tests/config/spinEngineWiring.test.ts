/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN ENGINE WIRING — source-level guards on the money path
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * These read the server source rather than executing it, because the engine
 * needs a live Postgres and a running tournament to exercise. What actually
 * needs pinning here is not behaviour under load — it is that four specific
 * mistakes cannot come back:
 *
 *   1. A Spin priced like an MTT (buy-in + fee). Dan: "THEY ARE STRAIGHT JUST
 *      10 BUY IN... NO ADDITIONAL RAKE IS ADDED." A fee on top would double
 *      the true house edge from 7.87% to 14.7%.
 *   2. A fourth local multiplier table. Three of them disagreed; the one that
 *      ran was not the one that was documented.
 *   3. prize_pool overwritten with no ledger row — the leak that put ~1,160
 *      of margin into no ledger at all across 2,091 games.
 *   4. An ungated jackpot: a high multiplier selected without asking whether
 *      the Reserve Pool can pay it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const recurring = readFileSync(
  resolve(__dirname, '../../server/src/services/TournamentRecurringService.ts'),
  'utf8'
);
const engine = readFileSync(
  resolve(__dirname, '../../server/src/tournament/TournamentManagerBase.ts'),
  'utf8'
);

/** The object literal of the tournaments insert that creates a Spin. */
function spinInsertBlock(src: string): string {
  const i = src.indexOf("tournament_type: 'SPIN',");
  expect(i, 'expected a Spin insert').toBeGreaterThan(-1);
  return src.slice(i, i + 1600);
}

describe('a Spin is not priced like an MTT', () => {
  it('charges NO fee on top of the buy-in', () => {
    expect(spinInsertBlock(recurring)).toMatch(/buy_in_fee:\s*0\b/);
  });

  it('does not reintroduce config.rake on the Spin path', () => {
    expect(spinInsertBlock(recurring)).not.toMatch(/buy_in_fee:\s*config\.rake/);
  });

  it('leaves the SNG path alone — those ARE buy-in + rake', () => {
    const i = recurring.indexOf("tournament_type: 'SNG',");
    expect(i).toBeGreaterThan(-1);
    expect(recurring.slice(i, i + 900)).toMatch(/buy_in_fee:\s*config\.rake/);
  });
});

describe('one multiplier table, not four', () => {
  it('both server files import the canonical spec', () => {
    /* The `.js` is not optional and not a typo in the source. server/ is
       `"type": "module"` and every relative import in these two files carries
       the extension (8 of 8), because Node's ESM resolver will not resolve a
       bare specifier at runtime.
       This regex omitted it, so the assertion failed against correct code —
       and since the client vitest suite ran in no CI job until 2026-08-20,
       it failed unnoticed on main. */
    expect(recurring).toMatch(/from '\.\.\/config\/spinSpec\.js'/);
    expect(engine).toMatch(/from '\.\.\/config\/spinSpec\.js'/);
  });

  it("the engine's two hardcoded fallback tables are gone", () => {
    // EV 2.2415 and 2.3288 — neither matched the documented design.
    expect(engine).not.toMatch(/SPIN_STANDARD/);
    expect(engine).not.toMatch(/SPIN_HYPER/);
  });

  it('no server file defines its own weighted multiplier literal', () => {
    // The shape that started all of this: { multiplier: N, weight: N }.
    for (const [name, src] of [
      ['TournamentManagerBase', engine],
      ['TournamentRecurringService', recurring],
    ] as const) {
      const literals = src.match(/\{\s*multiplier:\s*\d+,\s*weight:\s*\d/g) ?? [];
      // The recurring service keeps ONE derived view built from SPIN_TIERS,
      // which is a mapping rather than a hardcoded table.
      expect(literals.length, `${name} declares a hardcoded multiplier table`).toBe(0);
    }
  });

  it('derives its multiplier list from SPIN_TIERS', () => {
    expect(recurring).toMatch(/SPIN_MULTIPLIERS\s*=\s*SPIN_TIERS\.map/);
  });
});

describe('every game is booked', () => {
  it('settles through the ledger RPC', () => {
    expect(engine).toMatch(/fn_spin_settle_game/);
  });

  it('reports loudly rather than swallowing a failed settlement', () => {
    // Losing the ledger row is the whole defect this replaces; it must never
    // fail silently again. Anchored on the RPC CALL, not the first mention —
    // the block is preceded by a comment naming the same function.
    const i = engine.indexOf("supabase.rpc('fn_spin_settle_game'");
    expect(i, 'expected a call to fn_spin_settle_game').toBeGreaterThan(-1);
    const block = engine.slice(i, i + 2200);
    expect(block).toMatch(/reportError/);
    expect(block).toMatch(/unbooked/i);
  });

  it('books the rake at the rate the stake actually implies', () => {
    expect(engine).toMatch(/p_rake_rate:\s*spinRakeRate\(buyIn\)/);
  });
});

describe('the jackpot gate cannot be bypassed', () => {
  it('draws through the reserve-gated RPC at creation', () => {
    expect(recurring).toMatch(/fn_spin_draw_multiplier/);
  });

  it('re-draws through the SAME gate when a multiplier is missing', () => {
    expect(engine).toMatch(/fn_spin_draw_multiplier/);
  });

  it('the offline fallback can only pick ALWAYS-AVAILABLE tiers', () => {
    // A database hiccup must not be able to hand out a jackpot the pool was
    // never asked about.
    expect(recurring).toMatch(/reserveThresholdX\s*<=\s*0/);
  });

  it('a missing multiplier resolves DOWN to the smallest tier, never up', () => {
    expect(engine).toMatch(/SPIN_TIERS\[0\]\.multiplier/);
  });
});

describe('structure scales with the multiplier', () => {
  it('creation sets stack, blinds and payouts from the tier', () => {
    const block = spinInsertBlock(recurring);
    expect(block).toMatch(/starting_chips:\s*spinStack/);
    expect(block).toMatch(/blind_structure:\s*spinBlinds/);
    expect(block).toMatch(/payout_structure:\s*spinPayouts/);
  });

  it('the engine re-applies stack and payouts at start', () => {
    expect(engine).toMatch(/starting_chips:\s*tier\?\.startingStack/);
    expect(engine).toMatch(/payout_structure:/);
  });
});
