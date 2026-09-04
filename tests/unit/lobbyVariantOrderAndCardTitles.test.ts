import { describe, expect, it } from 'vitest';
import { cashEntry, type LobbyTableRow } from '../../src/components/lobby/lobbyEntries';
import { VARIANT_RANK, variantRank } from '../../src/components/lobby/LobbyTable';
import {
  arenaGameCardDataFromEntry,
  cashCardTitle,
} from '../../src/components/lobby/game-cards/arenaGameCardAdapter';
import { premiumStatusBadge } from '../../src/components/lobby/game-cards/premiumStatus';
import { splitBuyInRange } from '../../src/components/lobby/game-cards/layeredCard';

/**
 * Dan 2026-09-03, the mobile lobby pass:
 *  - "NLH SHOULD BE NO LIMIT, PINEAPPLE AND SHORT DECK, PLO SHOULD BE PLO,
 *    PLO5, PLO6 PLO8o" - the canonical order of the games.
 *  - "PINEAPPLE 1 SHOULD JUST BE CALLED PINEAPPLE, REMOVE THE DUPLICATE."
 *  - "Make sure the Variant Name is first, Like PLO5 25/50 and then the table
 *    name under it."
 *  - "REMOVE ALL THE - FOR THE BUY IN CARDS ... MINIMUM ON TOP 40 AND BELOW IT
 *    THE MAX 200."
 *  - the status pill reads Running / Empty / Full.
 */

function table(over: Partial<LobbyTableRow>): LobbyTableRow {
  return {
    id: 't',
    name: 'NLH 1/2',
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    min_buy_in: 80,
    max_buy_in: 400,
    current_players: 3,
    max_players: 6,
    status: 'open',
    ...over,
  } as LobbyTableRow;
}

describe('the games are ranked in the order Dan named', () => {
  it('No Limit, Pineapple, Short Deck; then PLO, PLO5, PLO6, PLO8', () => {
    const order = ['NLH', 'PNPL', '6+', 'PLO', 'PLO5', 'PLO6', 'PLO8'].map((g) => VARIANT_RANK[g]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('reads the rank off a live entry and parks the unknown after the known', () => {
    expect(variantRank(cashEntry(table({ game_variant: 'short_deck' })))).toBe(VARIANT_RANK['6+']);
    expect(variantRank(cashEntry(table({ game_variant: 'plo8' })))).toBe(VARIANT_RANK.PLO8);
    expect(variantRank({ gameLabel: 'MYSTERY' })).toBeGreaterThan(VARIANT_RANK.FLO8);
  });
});

describe('cash card headings', () => {
  it('drops the auto-number and a subtitle that only repeats the name', () => {
    const pineapple = cashCardTitle(
      cashEntry(table({ name: 'Pineapple 1', game_variant: 'pineapple' }))
    );
    expect(pineapple.title).toBe('Pineapple');
    expect(pineapple.subtitle).toBeUndefined();

    const shortDeck = cashCardTitle(
      cashEntry(table({ name: 'Short Deck 1', game_variant: 'short_deck' }))
    );
    expect(shortDeck.title).toBe('Short Deck');
    expect(shortDeck.subtitle).toBeUndefined();
  });

  it('keeps a variant line that says something the title does not', () => {
    const straddle = cashCardTitle(cashEntry(table({ name: 'NLH Straddle' })));
    expect(straddle.title).toBe('NLH Straddle');
    expect(straddle.subtitle).toMatch(/hold/i);
  });

  it('never mistakes a stake for an index', () => {
    expect(cashCardTitle(cashEntry(table({ name: 'NLH 25/50' }))).title).toBe('NLH 25/50');
  });

  it('puts the variant and stakes first on an Omaha card, the table name under it', () => {
    const plo = cashCardTitle(
      cashEntry(
        table({ name: 'Omaha Bomb Pot', game_variant: 'plo5', small_blind: 25, big_blind: 50 })
      )
    );
    expect(plo.title).toMatch(/^PLO5 /);
    expect(plo.subtitle).toBe('Omaha Bomb Pot');
  });
});

describe('the status pill', () => {
  it('says Empty, Running, Full', () => {
    expect(premiumStatusBadge({ status: 'open', statusLabel: 'Open' }).label).toBe('Empty');
    expect(premiumStatusBadge({ status: 'running', statusLabel: 'Running' }).label).toBe('Running');
    expect(premiumStatusBadge({ status: 'full', statusLabel: 'Full' }).label).toBe('Full');
    expect(premiumStatusBadge({ status: 'waitlist', statusLabel: 'Waitlist 2' }).label).toBe(
      'Waitlist 2'
    );
  });

  it('is what the adapter hands the card', () => {
    const data = arenaGameCardDataFromEntry(cashEntry(table({ current_players: 0 })));
    expect(premiumStatusBadge(data).label).toBe('Empty');
  });
});

describe('the buy-in range', () => {
  it('splits into minimum over maximum with no dash, and leaves a single figure alone', () => {
    expect(splitBuyInRange('80 - 400')).toEqual(['80', '400']);
    expect(splitBuyInRange('2,000 - 10,000')).toEqual(['2,000', '10,000']);
    expect(splitBuyInRange('1K \u2013 2K')).toEqual(['1K', '2K']);
    expect(splitBuyInRange('50')).toBeNull();
  });
});
