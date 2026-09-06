/**
 * PREVIOUS HAND - PHASE 2 (2026-09-05): equity and EV on the rundown.
 *
 * - `computeEquity` is exact where the runout can be enumerated (turn, flop),
 *   sampled preflop and says so, refuses a record with a card in two places,
 *   prices hi-lo for the high half only and says so.
 * - The model names each known hand's made hand per street and knows who was
 *   still in when the street began.
 * - The rundown shows the viewer's engine-recorded all-in equity and EV, and
 *   the per-street facts, and shows nothing when a contender's cards are unknown.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { computeEquity, remainingDeck } from '@/utils/equity';
import { buildReplay } from '@/utils/handReplay';
import HandDetailView from '@/components/handdetail/HandDetailView';
import type { HeroHandFacts } from '@/services/HandHistoryService';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

afterEach(cleanup);

const c = (s: string) => ({ rank: s[0] as never, suit: s[1] as never });
const cards = (s: string) => s.split(' ').map(c);

describe('computeEquity', () => {
  it('a decided river is 100 / 0', () => {
    const r = computeEquity({
      players: [
        { userId: 'a', hole: cards('Ah Kh') },
        { userId: 'b', hole: cards('2c 7d') },
      ],
      board: cards('As Kd 9c 4s 3h'),
      variant: 'nlh',
    })!;
    expect(r.exact).toBe(true);
    expect(r.equities).toEqual([
      { userId: 'a', pct: 100 },
      { userId: 'b', pct: 0 },
    ]);
  });

  it('a flush draw on the turn is exactly 8 outs of 44', () => {
    // b holds 6h Jh against a's Ah Kd on Ks 8h 2h 4c. b wins only on a heart,
    // and the ace of hearts is in a's hand: 8 hearts remain of 44 = 18.2%.
    // (First draft of this test said 9; the evaluator was right and it was not.)
    const r = computeEquity({
      players: [
        { userId: 'a', hole: cards('Ah Kd') },
        { userId: 'b', hole: cards('6h Jh') },
      ],
      board: cards('Ks 8h 2h 4c'),
      variant: 'nlh',
    })!;
    expect(r.exact).toBe(true);
    expect(r.runouts).toBe(44);
    // A jack or a six pairs b below a's kings. Hearts only.
    expect(r.equities.find((e) => e.userId === 'b')!.pct).toBe(18.2);
    expect(r.equities.find((e) => e.userId === 'a')!.pct).toBe(81.8);
  });

  it('a flop is enumerated exactly over 990 runouts', () => {
    const r = computeEquity({
      players: [
        { userId: 'a', hole: cards('Ah Ad') },
        { userId: 'b', hole: cards('Kc Kd') },
      ],
      board: cards('2s 7h Tc'),
      variant: 'nlh',
    })!;
    expect(r.exact).toBe(true);
    expect(r.runouts).toBe(990);
    const a = r.equities.find((e) => e.userId === 'a')!.pct;
    expect(a).toBeGreaterThan(88);
    expect(a).toBeLessThan(96);
  });

  it('preflop is sampled, says so, and lands where the maths lands', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const r = computeEquity({
      players: [
        { userId: 'a', hole: cards('Ah Ad') },
        { userId: 'b', hole: cards('Kc Kd') },
      ],
      board: [],
      variant: 'nlh',
      samples: 3000,
      random: rnd,
    })!;
    expect(r.exact).toBe(false);
    expect(r.runouts).toBe(3000);
    const a = r.equities.find((e) => e.userId === 'a')!.pct;
    // AA vs KK is 81.9% hot-and-cold.
    expect(a).toBeGreaterThan(78);
    expect(a).toBeLessThan(86);
  });

  it('a chop is split', () => {
    const r = computeEquity({
      players: [
        { userId: 'a', hole: cards('Ah Kh') },
        { userId: 'b', hole: cards('Ad Kd') },
      ],
      board: cards('2c 7s 9c Tc 3d'),
      variant: 'nlh',
    })!;
    expect(r.equities.map((e) => e.pct)).toEqual([50, 50]);
  });

  it('refuses a record with one card in two places', () => {
    expect(
      computeEquity({
        players: [
          { userId: 'a', hole: cards('Ah Kh') },
          { userId: 'b', hole: cards('Ah 2c') },
        ],
        board: [],
        variant: 'nlh',
      })
    ).toBeNull();
  });

  it('needs two known hands', () => {
    expect(
      computeEquity({ players: [{ userId: 'a', hole: cards('Ah Kh') }], board: [], variant: 'nlh' })
    ).toBeNull();
  });

  it('prices Omaha by Omaha rules and hi-lo for the high half only', () => {
    const r = computeEquity({
      players: [
        { userId: 'a', hole: cards('Ah Ad Kh Kd') },
        { userId: 'b', hole: cards('2c 3c 4d 5d') },
      ],
      board: cards('As 8h 9c Td'),
      variant: 'plo8',
    })!;
    expect(r.exact).toBe(true);
    expect(r.runouts).toBe(40);
    expect(r.highOnly).toBe(true);
  });

  it('the short deck has 36 cards', () => {
    expect(remainingDeck([], 'short_deck')).toHaveLength(36);
    expect(remainingDeck([], 'nlh')).toHaveLength(52);
    expect(remainingDeck(cards('Ah Kh'), 'nlh')).toHaveLength(50);
  });
});

const HAND = {
  handNumber: 1,
  playedAt: '2026-09-05T20:00:00.000Z',
  gameVariant: 'nlh',
  smallBlind: 1,
  bigBlind: 2,
  potSize: 200,
  rakeAmount: 0,
  bbjAmount: 0,
  buttonSeat: 1,
  board: ['7c', '2c', '9h', 'Kd', 'Tc'],
  players: [
    { seat: 1, userId: 'h', username: 'kingfish', stack: 200 },
    { seat: 2, userId: 'v', username: 'Emerson', stack: 0 },
    { seat: 3, userId: 'f', username: 'Folder', stack: 100 },
  ],
  actions: [
    { seat: 3, userId: 'f', action: 'fold', amount: 0, stage: 'preflop' },
    { seat: 1, userId: 'h', action: 'raise', amount: 6, stage: 'preflop' },
    { seat: 2, userId: 'v', action: 'call', amount: 4, stage: 'preflop' },
    { seat: 2, userId: 'v', action: 'check', amount: 0, stage: 'flop' },
    { seat: 1, userId: 'h', action: 'all_in', amount: 94, stage: 'flop' },
    { seat: 2, userId: 'v', action: 'call', amount: 94, stage: 'flop' },
  ],
  winners: [{ userId: 'h', amount: 200, potIndex: 0, hand: { name: 'Pair' } }],
  holeCards: { h: ['9c', '9d'], v: ['Ah', 'Kh'] },
  showdown: [
    { user_id: 'h', seat: 1, mucked: false, reveal_order: 0, hand_name: 'Three Of A Kind' },
    { user_id: 'v', seat: 2, mucked: false, reveal_order: 1, hand_name: 'Pair' },
  ],
};

describe('the model knows who was in, and what each known hand had made', () => {
  const m = buildReplay(HAND as never);
  it('contenders drop out as they fold', () => {
    const pre = m.streets.find((s) => s.key === 'preflop')!;
    const flop = m.streets.find((s) => s.key === 'flop')!;
    expect(pre.contenders).toEqual(['h', 'v', 'f']);
    expect(flop.contenders).toEqual(['h', 'v']);
  });

  it('names the made hand on each street for every known holding, none preflop', () => {
    const pre = m.streets.find((s) => s.key === 'preflop')!;
    const flop = m.streets.find((s) => s.key === 'flop')!;
    const river = m.streets.find((s) => s.key === 'river')!;
    expect(pre.madeHands).toEqual([]);
    expect(flop.madeHands).toEqual([
      { userId: 'h', name: 'Three Of A Kind' },
      { userId: 'v', name: 'High Card' },
    ]);
    expect(river.madeHands.find((x) => x.userId === 'v')?.name).toBe('Pair');
  });
});

describe('the rundown', () => {
  const FACTS: HeroHandFacts = {
    was_all_in: true,
    all_in_street: 'flop',
    all_in_at_risk: 94,
    all_in_equity: 0.7885,
    ev_returned: 157.7,
    ev_net: 57.7,
    invested: 100,
    returned: 200,
    net: 100,
    vpip: true,
    pfr: true,
    saw_flop: true,
    went_to_showdown: true,
    won_at_showdown: true,
  };

  it("shows the viewer's all-in equity, EV and the gap between EV and the result", () => {
    const m = buildReplay(HAND as never);
    render(<HandDetailView model={m} currentUserId="h" viewerFacts={FACTS} />);
    const block = document.querySelector('.hdv__allin')!;
    expect(block.textContent).toContain('All In On The Flop');
    expect(block.textContent).toContain('78.9%');
    expect(block.textContent).toContain('157.70');
    expect(block.textContent).toContain('+57.70');
    expect(block.textContent).toContain('+100.00');
    expect(block.querySelector('.hdv__allin-luck')?.textContent).toBe(
      'Ran Above Expectation By 42.30'
    );
  });

  it('shows no all-in block when the hand had none', () => {
    const m = buildReplay(HAND as never);
    render(
      <HandDetailView
        model={m}
        currentUserId="h"
        viewerFacts={{ ...FACTS, was_all_in: false, all_in_equity: null }}
      />
    );
    expect(document.querySelector('.hdv__allin')).toBeNull();
  });

  it('prices each street exactly once both hands are known, and names the made hands', () => {
    const m = buildReplay(HAND as never);
    render(<HandDetailView model={m} currentUserId="h" />);
    const flop = [...document.querySelectorAll('.hdv__street')].find(
      (s) => s.querySelector('.hdv__street-name')?.textContent === 'Flop'
    )!;
    const facts = flop.querySelectorAll('.hdv__fact');
    expect(facts).toHaveLength(2);
    expect(facts[0].textContent).toContain('kingfish');
    expect(facts[0].textContent).toContain('Three Of A Kind');
    // Exact (990 runouts): no tilde, a real percentage.
    expect(facts[0].querySelector('.hdv__fact-eq')?.textContent).toMatch(/^\d+(\.\d)?%$/);
    // The preflop three-way street has an unknown holding (the folder): no price.
    const pre = [...document.querySelectorAll('.hdv__street')].find(
      (s) => s.querySelector('.hdv__street-name')?.textContent === 'PreFlop'
    )!;
    expect(pre.querySelector('.hdv__fact-eq')).toBeNull();
  });

  it('prices nothing when a contender is unknown', () => {
    const m = buildReplay({ ...HAND, holeCards: { h: ['9c', '9d'] } } as never);
    render(<HandDetailView model={m} currentUserId="h" />);
    expect(document.querySelector('.hdv__fact-eq')).toBeNull();
    // ...but still names the known hand.
    expect(document.querySelector('.hdv__fact-hand')?.textContent).toBe('Three Of A Kind');
  });
});

describe('every rundown surface passes the viewer facts through', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
  it.each([
    ['src/components/table/HandHistoryPanel.tsx', 'viewerFacts={hand.heroFacts}'],
    ['src/components/table/HandDetailModal.tsx', 'viewerFacts={hand.heroFacts}'],
    ['src/pages/HandHistoryPage.tsx', 'viewerFacts={hand.heroFacts}'],
    /* PHASE 4 2026-09-05: the replayer reads one `source` whichever door the
       hand came through, and the facts are picked off the fetched row when it
       builds that source. Same facts, one hop earlier. */
    ['src/components/replay/HandReplay.tsx', 'viewerFacts={source.viewerFacts}'],
    [
      'src/components/replay/HandReplay.tsx',
      'viewerFacts: handData.players.find((p) => p.user_id === authId)?.facts ?? null,',
    ],
  ])('%s', (file, needle) => {
    expect(read(file)).toContain(needle);
  });
});
