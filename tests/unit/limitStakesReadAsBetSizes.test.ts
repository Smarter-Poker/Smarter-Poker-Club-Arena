/**
 * A limit table must read the same in the lobby as it does at the table.
 *
 * WHAT WENT WRONG
 * ---------------
 * Fixed limit is posted by BET size, not blind size: a table storing
 * small_blind 1 / big_blind 2 IS a "2/4" game. TableConfigPage names the table
 * and writes `tables.stakes` that way, but `cashEntry()` built its lobby row
 * straight from the raw blinds. So the LIMIT tab listed
 *
 *     FLH   1 / 2
 *
 * and the table it linked to called itself "FLH 2/4". Two numbers for one
 * table, on the exact surface the limit games were added for.
 *
 * Both sides now go through `stakesLabel()`, so they cannot disagree. These
 * tests pin that, and pin that no-limit and pot-limit rows were not disturbed —
 * a "fix" that relabelled every NLH table would be worse than the bug.
 */
import { describe, it, expect } from 'vitest';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import { stakesLabel } from '../../src/lib/bettingStructure';

const row = (over: Partial<LobbyTableRow> = {}): LobbyTableRow =>
  ({
    id: 't1',
    name: 'Test Table',
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 40,
    max_buy_in: 200,
    max_players: 9,
    status: 'running',
    ...over,
  }) as LobbyTableRow;

describe('the lobby posts a limit table by its bet sizes', () => {
  it('shows 2/4 for a fixed-limit table whose blinds are 1/2', () => {
    expect(cashEntry(row({ game_variant: 'flh' })).stakesLabel).toBe('2/4');
    expect(cashEntry(row({ game_variant: 'flo8' })).stakesLabel).toBe('2/4');
  });

  it('agrees exactly with the label the create screen wrote', () => {
    // TableConfigPage builds tables.stakes from the same helper. If these two
    // ever diverge the lobby and the table disagree again.
    for (const v of ['flh', 'flo8', 'nlh', 'plo4']) {
      expect(cashEntry(row({ game_variant: v })).stakesLabel).toBe(stakesLabel(1, 2, v));
    }
  });

  it('scales with the stake', () => {
    expect(cashEntry(row({ game_variant: 'flh', small_blind: 5, big_blind: 10 })).stakesLabel).toBe(
      '10/20'
    );
  });

  it('leaves no-limit and pot-limit rows reading as blinds', () => {
    // The blinds ARE the stakes for these; relabelling them would be a
    // regression dressed as a fix.
    expect(cashEntry(row({ game_variant: 'nlh' })).stakesLabel).toBe('1/2');
    expect(cashEntry(row({ game_variant: 'plo4' })).stakesLabel).toBe('1/2');
    expect(cashEntry(row({ game_variant: 'short_deck' })).stakesLabel).toBe('1/2');
  });

  it('says nothing rather than claiming a row with missing blinds is 0/0', () => {
    /* Lobby rows come straight from the database and a legacy row can be null.
       `|| 0` used to turn "we do not know" into a STATEMENT: stakesLabelFor
       has no unknown branch, so the board printed "0/0" and CasinoPlaque
       rendered "Blinds 0/0". stakesLabel is `string | null` for exactly this,
       and every renderer already falls back when it is null. */
    for (const variant of ['flh', 'nlh', 'plo4']) {
      const e = cashEntry(row({ game_variant: variant, small_blind: 0, big_blind: 0 }));
      expect(e.stakesLabel, `${variant} invented a stake`).toBeNull();
    }
    // A null column, not merely a zero, is the shape that actually ships.
    const nulled = cashEntry(
      row({ game_variant: 'nlh', small_blind: null, big_blind: null } as never)
    );
    expect(nulled.stakesLabel).toBeNull();
    expect(nulled.stakesValue).toBe(0);
  });

  it('sorts on the big blind, which the label change must not touch', () => {
    // stakesValue drives the lobby's stake sort. It is deliberately still the
    // raw big blind, so a limit table sorts beside the blinds it actually posts.
    expect(cashEntry(row({ game_variant: 'flh' })).stakesValue).toBe(2);
  });
});
