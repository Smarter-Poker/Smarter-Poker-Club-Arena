/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SHARE HAND CODEC — round-trip tests
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Added 2026-08-15 alongside the fix that made Share Hand reachable on the cash
 * table. Wiring the feature up without these would have shipped a replay that
 * silently lied: before this commit the encoder wrote CHECK as CALL, and the
 * decoder never read the turn, the river, the winners, the table name, or the
 * hero / winner flags at all.
 *
 * Each test below fails against the pre-fix codec.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeHand,
  decodeHandFromUrl,
  type ShareableHand,
} from '../../src/components/table/ShareHand';

const HAND: ShareableHand = {
  id: 'h1',
  tableName: 'Diamond Lounge — Table 3',
  variant: 'PLO4',
  stakes: '5/10',
  timestamp: 1_755_300_000_000,
  buttonSeat: 4,
  players: [
    {
      seat: 1,
      name: 'Dan',
      stack: 12_500,
      cards: [
        { rank: 'A', suit: 's' },
        { rank: 'K', suit: 'd' },
      ],
      isHero: true,
    },
    { seat: 4, name: 'Villain', stack: 9_800, isWinner: true },
    { seat: 7, name: 'Ana', stack: 3_150 },
  ],
  preflop: [
    { seat: 7, action: 'FOLD' },
    { seat: 1, action: 'RAISE', amount: 30 },
    { seat: 4, action: 'CALL', amount: 30 },
  ],
  flop: {
    cards: [
      { rank: 'A', suit: 'h' },
      { rank: '7', suit: 'c' },
      { rank: '2', suit: 'd' },
    ],
    actions: [
      { seat: 4, action: 'CHECK' },
      { seat: 1, action: 'BET', amount: 45 },
      { seat: 4, action: 'CALL', amount: 45 },
    ],
  },
  turn: {
    card: { rank: 'T', suit: 's' },
    actions: [
      { seat: 4, action: 'CHECK' },
      { seat: 1, action: 'CHECK' },
    ],
  },
  river: {
    card: { rank: 'Q', suit: 'h' },
    actions: [
      { seat: 4, action: 'BET', amount: 120 },
      { seat: 1, action: 'ALL_IN', amount: 12_425 },
      { seat: 4, action: 'FOLD' },
    ],
  },
  potTotal: 12_800,
  winners: [{ seat: 4, amount: 12_800 }],
};

describe('ShareHand codec', () => {
  const decoded = decodeHandFromUrl(encodeHand(HAND));

  it('round-trips at all', () => {
    expect(decoded).not.toBeNull();
  });

  it('preserves CHECK as CHECK (was decoded as CALL)', () => {
    // Two checks on the turn. The old encoder emitted 'C' for both CHECK and
    // CALL because it keyed off the first letter of the action name.
    expect(decoded!.turn!.actions.map((a) => a.action)).toEqual(['CHECK', 'CHECK']);
    expect(decoded!.flop!.actions.map((a) => a.action)).toEqual(['CHECK', 'BET', 'CALL']);
  });

  it('preserves the turn and the river (were dropped entirely)', () => {
    expect(decoded!.turn!.card).toEqual({ rank: 'T', suit: 's' });
    expect(decoded!.river!.card).toEqual({ rank: 'Q', suit: 'h' });
    expect(decoded!.river!.actions).toEqual([
      { seat: 4, action: 'BET', amount: 120 },
      { seat: 1, action: 'ALL_IN', amount: 12_425 },
      { seat: 4, action: 'FOLD' },
    ]);
  });

  it('preserves the winners (were hard-coded to [])', () => {
    expect(decoded!.winners).toEqual([{ seat: 4, amount: 12_800 }]);
  });

  it('preserves the hero and winner flags (were never encoded)', () => {
    expect(decoded!.players.find((p) => p.isHero)?.seat).toBe(1);
    expect(decoded!.players.find((p) => p.isWinner)?.seat).toBe(4);
  });

  it('preserves the table name (was hard-coded to "Shared Hand")', () => {
    expect(decoded!.tableName).toBe('Diamond Lounge — Table 3');
  });

  it('preserves the untruncated player names, board, stakes and pot', () => {
    expect(decoded!.players.map((p) => p.name)).toEqual(['Dan', 'Villain', 'Ana']);
    expect(decoded!.flop!.cards).toEqual(HAND.flop!.cards);
    expect(decoded!.stakes).toBe('5/10');
    expect(decoded!.potTotal).toBe(12_800);
    expect(decoded!.buttonSeat).toBe(4);
    expect(decoded!.variant).toBe('PLO4');
    expect(decoded!.players[0].cards).toEqual(HAND.players[0].cards);
  });

  it('survives a non-Latin1 name instead of throwing in btoa', () => {
    const emoji = decodeHandFromUrl(
      encodeHand({ ...HAND, players: [{ ...HAND.players[0], name: '🐉 Ryū' }] })
    );
    expect(emoji?.players[0].name).toBe('🐉 Ryū');
  });

  it('produces a URL-safe payload', () => {
    expect(encodeHand(HAND)).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('rejects a truncated or foreign payload rather than rendering garbage', () => {
    expect(decodeHandFromUrl('not-a-real-payload')).toBeNull();
  });

  it('handles a hand that ended preflop', () => {
    const short = decodeHandFromUrl(
      encodeHand({ ...HAND, flop: undefined, turn: undefined, river: undefined, winners: [] })
    );
    expect(short).not.toBeNull();
    expect(short!.flop).toBeUndefined();
    expect(short!.turn).toBeUndefined();
    expect(short!.river).toBeUndefined();
    expect(short!.preflop).toHaveLength(3);
  });
});
