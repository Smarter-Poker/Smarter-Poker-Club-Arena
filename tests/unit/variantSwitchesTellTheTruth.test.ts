/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PINEAPPLE IS CONNECTED; SEVEN-DEUCE IS NO LONGER OFFERED WHERE IT CANNOT FIRE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two entries from the audit that turned out to be opposite problems.
 *
 * PINEAPPLE was a real, fully built variant — three hole cards, a discard
 * street, its own timer — with a toggle that had never been connected to it.
 * Mapping, not building.
 *
 * SEVEN-DEUCE was the reverse. The audit called its Hold'em gate a bug; it is
 * not. The engine's own comment gives the reason — "meaningless in PLO;
 * short-deck has no deuces" — and holding four cards, a 7 and a 2 is nearly
 * every hand. The ENGINE was right and the SWITCH was wrong: the creation
 * screen offered it on tables where it could never pay out once.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const BASE = read('server/src/engine/ServerTableEngineBase.ts');
const DEALING = read('server/src/engine/ServerTableEngineDealing.ts');
const SETTLEMENT = read('server/src/engine/ServerTableEngineSettlement.ts');
const SELECT = read('server/src/services/supabase/tables.ts');
/**
 * 2026-09-04 (Operation Table Stakes, Slice 1): the cash create path is
 * fn_cash_game_create (SQL) fed by CashGameCreateFlow.tsx. The Seven-Deuce
 * pins read those two instead of TableConfigPage.buildTableData.
 */
const FLOW = read('src/components/cash/CashGameCreateFlow.tsx');
const SQL = read('supabase/migrations/20260904160500_cash_games_slice_1.sql');

describe('Pineapple Hold’em', () => {
  it('is reachable by the engine at all', () => {
    expect(SELECT).toContain('pineapple_holdem');
  });

  it('deals a Hold’em table as pineapple when the host asks', () => {
    const fn = sliceMethod(BASE, 'protected dealtGameVariant()');
    expect(fn).toContain('pineapple_holdem');
    expect(fn).toMatch(/variant === 'nlh' \|\| variant === 'nlhe'/);
  });

  it('refuses to turn a PLO table into one', () => {
    // "Pineapple PLO" is not a game, and a stray flag must not invent it.
    const fn = sliceMethod(BASE, 'protected dealtGameVariant()');
    expect(fn).toContain('return variant;');
  });

  it('is used by BOTH HandController builders, not one', () => {
    expect(BASE).toContain('gameVariant: this.dealtGameVariant() as GameVariant');
    // BOMB POT VARIANT OVERRIDE 2026-08-28 (spec §10.1): the dealing builder
    // routes through dealtGameVariant with the bomb override in front — a
    // whitelisted bomb variant wins on bomb hands, dealtGameVariant (and so
    // pineapple_holdem) decides everything else.
    expect(DEALING).toContain(
      'gameVariant: (bombHandVariant ?? this.dealtGameVariant()) as GameVariant'
    );
    expect(BASE).not.toContain('gameVariant: this.tableInfo.game_variant as GameVariant');
    expect(DEALING).not.toContain('gameVariant: this.tableInfo.game_variant as GameVariant');
  });
});

describe('Seven-Deuce', () => {
  it('keeps the engine gate exactly as it is', () => {
    // This is the rule, not the bug. Do not "fix" it open.
    expect(SETTLEMENT).toContain('sevenDeuceIsNlh');
    expect(SETTLEMENT).toMatch(/game_variant \|\| 'nlh'\) === 'nlh'/);
  });

  it('is not offered on a variant that can never pay it', () => {
    // The switch renders inside one gate, and that gate is the engine's own
    // equality: NLH and nothing else.
    expect(FLOW).toMatch(/\{variant === 'nlh' && \(\s*<Toggle\s*label="Seven Deuce Bonus"/);
    expect(FLOW).not.toMatch(/'plo[^']*'[^\n]*Seven Deuce/);
  });

  it('forces the column false rather than leaving a stale true behind', () => {
    // A host who switches an NLH game to PLO must not leave a flag set that
    // the table will never honour. The snapshot ANDs it with the variant on
    // the way in, and the tables row is written from the snapshot.
    expect(SQL).toMatch(
      /'seven_deuce_enabled', coalesce\(\(v_o->'options'->>'seven_deuce_enabled'\)::boolean, false\) AND v_v = 'nlh'/
    );
    expect(SQL).toMatch(
      /\(v_opts->>'seven_deuce_enabled'\)::boolean, CASE WHEN \(v_opts->>'seven_deuce_enabled'\)::boolean THEN 2 ELSE 0 END/
    );
  });
});
