import { describe, it, expect } from 'vitest';
import { detectCollusion, buildPairTable, computeContributions } from './CollusionDetector.js';
import type { NormalizedAction, NormalizedHand } from './types.js';

let seq = 0;
function act(
  userId: string,
  action: NormalizedAction['action'],
  amount: number,
  street: NormalizedAction['street'],
  forced = false
): NormalizedAction {
  seq++;
  return {
    handId: '',
    tableId: 't1',
    userId,
    seat: 0,
    street,
    action,
    amount,
    timestamp: seq,
    latencyMs: 0,
    forced,
  };
}

function mkHand(
  id: string,
  players: string[],
  actions: NormalizedAction[],
  winners: { userId: string; amount: number }[]
): NormalizedHand {
  return {
    handId: id,
    tableId: 't1',
    gameVariant: 'nlhe',
    smallBlind: 5,
    bigBlind: 10,
    potSize: winners.reduce((s, w) => s + w.amount, 0),
    rake: 0,
    communityCards: [],
    startedAt: 0,
    endedAt: 0,
    players: players.map((u, i) => ({ userId: u, seat: i, startingStack: 1000, cards: [] })),
    winners,
    actions: actions.map((a) => ({ ...a, handId: id })),
  };
}

/** alice folds to bob's preflop raise every hand; alice's blind flows to bob. */
function colludingHand(i: number): NormalizedHand {
  return mkHand(
    `col${i}`,
    ['alice', 'bob'],
    [
      act('alice', 'post_blind', 5, 'preflop', true),
      act('bob', 'post_blind', 10, 'preflop', true),
      act('bob', 'raise', 40, 'preflop'),
      act('alice', 'fold', 0, 'preflop'),
    ],
    [{ userId: 'bob', amount: 55 }]
  );
}

/** three players, checked down, rotating winner — balanced, innocent. */
function cleanHand(i: number): NormalizedHand {
  const ps = ['carol', 'dave', 'erin'];
  const winner = ps[i % 3];
  return mkHand(
    `clean${i}`,
    ps,
    [
      act('carol', 'post_blind', 5, 'preflop', true),
      act('dave', 'post_blind', 10, 'preflop', true),
      act('erin', 'call', 10, 'preflop'),
      act('carol', 'call', 5, 'preflop'),
      act('dave', 'check', 0, 'preflop'),
      act('carol', 'check', 0, 'flop'),
      act('dave', 'check', 0, 'flop'),
      act('erin', 'check', 0, 'flop'),
    ],
    [{ userId: winner, amount: 30 }]
  );
}

describe('computeContributions', () => {
  it('sums chip-in actions per user', () => {
    const h = colludingHand(0);
    const c = computeContributions(h);
    expect(c.get('alice')).toBe(5); // just the blind
    expect(c.get('bob')).toBe(50); // blind 10 + raise 40
  });
});

describe('detectCollusion', () => {
  it('flags a chip-dumping / fold-to-partner pair', () => {
    const hands = Array.from({ length: 25 }, (_, i) => colludingHand(i));
    const flags = detectCollusion(hands);
    expect(flags).toHaveLength(1);
    expect(flags[0].userIds).toEqual(['alice', 'bob']);
    expect(flags[0].score).toBeGreaterThanOrEqual(0.55);
    const codes = flags[0].reasons.map((r) => r.code);
    expect(codes).toContain('fold_to_player');
    expect(codes).toContain('chip_transfer');
  });

  it('does NOT flag balanced innocent play', () => {
    const hands = Array.from({ length: 30 }, (_, i) => cleanHand(i));
    const flags = detectCollusion(hands);
    expect(flags).toHaveLength(0);
  });

  it('isolates the colluding pair within a mixed batch', () => {
    const hands = [
      ...Array.from({ length: 25 }, (_, i) => colludingHand(i)),
      ...Array.from({ length: 30 }, (_, i) => cleanHand(i)),
    ];
    const flags = detectCollusion(hands);
    expect(flags).toHaveLength(1);
    expect(flags[0].userIds).toEqual(['alice', 'bob']);
  });

  it('respects minSharedHands gating', () => {
    const hands = Array.from({ length: 5 }, (_, i) => colludingHand(i));
    expect(detectCollusion(hands)).toHaveLength(0);
  });

  it('buildPairTable counts heads-up checked-down soft-play hands', () => {
    const softHand = mkHand(
      's1',
      ['alice', 'bob'],
      [
        act('alice', 'post_blind', 5, 'preflop', true),
        act('bob', 'post_blind', 10, 'preflop', true),
        act('alice', 'call', 5, 'preflop'),
        act('bob', 'check', 0, 'preflop'),
        act('alice', 'check', 0, 'flop'),
        act('bob', 'check', 0, 'flop'),
      ],
      [{ userId: 'alice', amount: 20 }]
    );
    const pairs = buildPairTable([softHand]);
    const p = pairs.get('alice bob')!;
    expect(p.headsUpPostflop).toBe(1);
    expect(p.softPlayHands).toBe(1);
  });
});
