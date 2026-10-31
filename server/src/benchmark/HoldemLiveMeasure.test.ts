import { describe, expect, it } from 'vitest';
import {
  heapSlopes,
  isOnePairOnRiver,
  receiptCounts,
  renderMarkdown,
  riverCallFaced,
  riverOnePairCalls,
  riverOnePairFromRpc,
  RIVER_ONE_PAIR_RPC_SCHEMA,
  samplesFromPrometheus,
  sizeClassOf,
  threeBetShares,
  MIN_SLOPE_SAMPLES,
  type HealthSample,
  type ReviewAction,
} from './HoldemLiveMeasure.js';

const H = 3600000;
const sample = (at: number, heap: number, rss: number, instanceId = '1-aaaa', releaseSha = 'e'.repeat(40)): HealthSample => ({
  at,
  instanceId,
  releaseSha,
  heapUsedMb: heap,
  rssMb: rss,
});

describe('heap growth', () => {
  it('fits a GB/hour slope per instance and never spans a restart', () => {
    const a = [sample(0, 1000, 5000), sample(H / 2, 1150, 5200), sample(H, 1300, 5400)];
    const b = [sample(2 * H, 400, 3000, '2-bbbb'), sample(2.5 * H, 420, 3010, '2-bbbb'), sample(3 * H, 440, 3020, '2-bbbb')];
    const out = heapSlopes([...b, ...a]);
    expect(out.map((s) => s.instanceId)).toEqual(['1-aaaa', '2-bbbb']);
    expect(out[0].heapGbPerHour).toBeCloseTo(0.3, 3);
    expect(out[0].rssGbPerHour).toBeCloseTo(0.4, 3);
    expect(out[0].heapR2).toBe(1);
    expect(out[1].heapGbPerHour).toBeCloseTo(0.04, 3);
    expect(out[1].firstHeapMb).toBe(400);
    expect(out[1].lastHeapMb).toBe(440);
  });

  it('answers null with a reason, never zero, on too little evidence', () => {
    const few = heapSlopes([sample(0, 1000, 5000), sample(H, 1200, 5000)]);
    expect(few[0].heapGbPerHour).toBeNull();
    expect(few[0].reason).toContain(`${MIN_SLOPE_SAMPLES} needed`);
    const short = heapSlopes([sample(0, 1000, 5000), sample(60000, 1001, 5000), sample(120000, 1002, 5000)]);
    expect(short[0].heapGbPerHour).toBeNull();
    expect(short[0].reason).toContain('minutes');
    expect(heapSlopes([{ ...sample(0, 1, 1), heapUsedMb: Number.NaN }])).toEqual([]);
  });
});

describe('3-bet shares', () => {
  it('aggregates per format and overall, counting distinct horses', () => {
    const rows = [
      { horse_user_id: 'h1', day: '2026-10-30', format: 'cash', hands: 100, three_bets: 8, three_bet_opps: 40, faced_3bets: 10, fold_to_3bets: 6 },
      { horse_user_id: 'h1', day: '2026-10-31', format: 'cash', hands: 100, three_bets: 2, three_bet_opps: 10, faced_3bets: 0, fold_to_3bets: 0 },
      { horse_user_id: 'h2', day: '2026-10-30', format: 'tournament', hands: 50, three_bets: 1, three_bet_opps: 50, faced_3bets: 4, fold_to_3bets: 1 },
      { horse_user_id: 'h3', day: '2026-10-30', format: 'cash', hands: Number.NaN, three_bets: 1, three_bet_opps: 1, faced_3bets: 1, fold_to_3bets: 1 },
    ];
    const out = threeBetShares(rows);
    expect(out.map((s) => s.format)).toEqual(['cash', 'tournament', 'all']);
    const cash = out[0];
    expect(cash.horses).toBe(1);
    expect(cash.threeBetPct).toBe(20);
    expect(cash.foldTo3BetPct).toBe(60);
    expect(out[1].threeBetPct).toBe(2);
    expect(out[1].foldTo3BetPct).toBe(25);
    expect(out[2].horses).toBe(2);
    expect(out[2].hands).toBe(250);
    expect(out[2].threeBetPct).toBe(11);
  });

  it('is null without an opportunity rather than zero', () => {
    const out = threeBetShares([{ horse_user_id: 'h', day: 'd', format: 'cash', hands: 1, three_bets: 0, three_bet_opps: 0, faced_3bets: 0, fold_to_3bets: 0 }]);
    expect(out[0].threeBetPct).toBeNull();
    expect(out[0].foldTo3BetPct).toBeNull();
  });
});

const c = (s: string) => ({ r: '23456789TJQKA'.indexOf(s[0]), s: s[1] });
const cards = (s: string) => s.split(' ').map(c);

describe('one pair on the river', () => {
  it('recognises top pair, overpair and underpair, and refuses sets, two pair, flushes and straights', () => {
    expect(isOnePairOnRiver(cards('As Kd'), cards('Ah 7c 2d 9s Jc'))).toBe(true);
    expect(isOnePairOnRiver(cards('Qs Qd'), cards('Jh 7c 2d 9s 3c'))).toBe(true);
    expect(isOnePairOnRiver(cards('5s 5d'), cards('Jh 7c 2d 9s 3c'))).toBe(true);
    expect(isOnePairOnRiver(cards('As Ad'), cards('Ah 7c 2d 9s Jc'))).toBe(false);
    expect(isOnePairOnRiver(cards('As 7d'), cards('Ah 7c 2d 9s Jc'))).toBe(false);
    expect(isOnePairOnRiver(cards('As Kd'), cards('Ah 7c 7d 9s Jc'))).toBe(false);
    expect(isOnePairOnRiver(cards('As 4s'), cards('Ah 7s 2s 9s Jc'))).toBe(false);
    expect(isOnePairOnRiver(cards('8s 4d'), cards('8h 7c 6d 5s Jc'))).toBe(false);
    expect(isOnePairOnRiver(cards('As 2d'), cards('Ah 3c 4d 5s Jc'))).toBe(false);
    expect(isOnePairOnRiver(cards('Ks Qd'), cards('Ah 7c 2d 9s Jc'))).toBe(false);
    // A board flush or board straight plays for everyone: not a one-pair call.
    expect(isOnePairOnRiver(cards('As Kd'), cards('Ah 7h 2h 9h Jh'))).toBe(false);
    expect(isOnePairOnRiver(cards('Ts 2d'), cards('6h 7c 8d 9s Tc'))).toBe(false);
  });
});

describe('the river call faced', () => {
  const act = (userId: string, action: string, stage: string, amount?: number, isFullRaise?: boolean): ReviewAction => ({ userId, action, stage, amount, isFullRaise });

  it('measures the bet against the pot before it, in the engine amount convention', () => {
    // Forced posts and bets/raises are street TOTALS; a call is the INCREMENT
    // (HandController.processAction). sb 0.5 / bb 1 / h opens to 6 (total) /
    // v (sb) calls 5.5 more = pot 12; flop: v bets 8, h calls 8 (28); turn
    // check/check; river: v bets 14 into 28 = 0.5, h calls.
    const actions = [
      act('v', 'sb', 'preflop', 0.5), act('h', 'bb', 'preflop', 1),
      act('h', 'raise', 'preflop', 6), act('v', 'call', 'preflop', 5.5),
      act('v', 'bet', 'flop', 8), act('h', 'call', 'flop', 8),
      act('v', 'check', 'turn'), act('h', 'check', 'turn'),
      act('v', 'bet', 'river', 14), act('h', 'call', 'river', 14),
    ];
    expect(riverCallFaced(actions, 'h')).toEqual({ betFraction: 0.5, raised: false });
    expect(sizeClassOf(0.5, false)).toBe('medium');
  });

  it('reads a raise as large, a hero check-call of a small bet as small, and no call as null', () => {
    const actions = [
      act('v', 'raise', 'preflop', 6), act('h', 'call', 'preflop', 6),
      act('h', 'bet', 'river', 4), act('v', 'raise', 'river', 20), act('h', 'call', 'river', 20),
    ];
    // 12 preflop + hero's 4 = 16 before the raise; the raise puts 20 in: 1.25 pot, raised.
    expect(riverCallFaced(actions, 'h')).toEqual({ betFraction: 1.25, raised: true });
    expect(sizeClassOf(1.25, true)).toBe('large');
    const small = [act('v', 'raise', 'preflop', 6), act('h', 'call', 'preflop', 6), act('h', 'check', 'river'), act('v', 'bet', 'river', 3), act('h', 'call', 'river', 3)];
    expect(riverCallFaced(small, 'h')).toEqual({ betFraction: 0.25, raised: false });
    expect(sizeClassOf(0.25, false)).toBe('small');
    expect(riverCallFaced([act('v', 'bet', 'river', 10), act('h', 'fold', 'river')], 'h')).toBeNull();
    // A blind defence: sb 0.5, bb 1, open to 3 (total), both blinds call the
    // increments (2.5 and 2): pot 9, not 7.5. A 3-chip river bet is 1/3 pot: small.
    const defence = [
      act('s', 'sb', 'preflop', 0.5), act('b', 'bb', 'preflop', 1), act('h', 'raise', 'preflop', 3),
      act('s', 'call', 'preflop', 2.5), act('b', 'call', 'preflop', 2),
      act('s', 'bet', 'river', 3), act('h', 'call', 'river', 3),
    ];
    expect(riverCallFaced(defence, 'h')).toEqual({ betFraction: 0.333, raised: false });
    expect(sizeClassOf(0.333, false)).toBe('small');
    // A dead ante adds to the pot without raising the street level.
    const ante = [
      { userId: 'v', action: 'ante', stage: 'preflop', amount: 1, dead: true } as ReviewAction,
      { userId: 'h', action: 'ante', stage: 'preflop', amount: 1, dead: true } as ReviewAction,
      act('v', 'raise', 'preflop', 4), act('h', 'call', 'preflop', 4),
      act('v', 'bet', 'river', 5), act('h', 'call', 'river', 5),
    ];
    expect(riverCallFaced(ante, 'h')).toEqual({ betFraction: 0.5, raised: false });
    // A live ante on top of the big blind (dead:false) joins the level: bb 1 +
    // ante 1 = 2; v raises to 6 total, h calls 4 more: 6 + 6 = 12; a 5 bet is
    // 5/12 of the pot.
    const liveAnte = [
      act('v', 'sb', 'preflop', 0.5), act('h', 'bb', 'preflop', 1),
      { userId: 'h', action: 'ante', stage: 'preflop', amount: 1, dead: false } as ReviewAction,
      act('v', 'raise', 'preflop', 6), act('h', 'call', 'preflop', 4),
      act('v', 'bet', 'river', 5), act('h', 'call', 'river', 5),
    ];
    expect(riverCallFaced(liveAnte, 'h')).toEqual({ betFraction: 0.417, raised: false });
    // Hero bet first and faces a raise: the raise is measured against the pot
    // including hero's own bet, and it is `raised`.
    const raisedAfterHeroBet = [
      act('v', 'sb', 'preflop', 0.5), act('h', 'bb', 'preflop', 1), act('v', 'call', 'preflop', 0.5),
      act('h', 'bet', 'river', 2), act('v', 'raise', 'river', 6), act('h', 'call', 'river', 4),
    ];
    // pot 2 + hero 2 = 4 before the raise; the raise puts 6 in: 1.5 pot.
    expect(riverCallFaced(raisedAfterHeroBet, 'h')).toEqual({ betFraction: 1.5, raised: true });
    // A short all-in call (no isFullRaise) is a call; a full-raise all-in is aggression.
    const jam = [act('v', 'raise', 'preflop', 6), act('h', 'call', 'preflop', 6), act('v', 'all_in', 'river', 30, true), act('h', 'all_in', 'river', 9)];
    expect(riverCallFaced(jam, 'h')).toEqual({ betFraction: 2.5, raised: false });
  });
});

describe('river one-pair calls by size class', () => {
  it('counts Hold em one-pair river calls, wins by net, and keeps the big-pot caveat', () => {
    const base = (hole: string, board: string, river: ReviewAction[], net: number, variant = 'nlh') => ({
      horse_user_id: 'h',
      game_variant: variant,
      net_bb: net,
      hole_cards: hole.split(' '),
      board: board.split(' '),
      actions: [
        { userId: 'v', action: 'raise', stage: 'preflop', amount: 6 },
        { userId: 'h', action: 'call', stage: 'preflop', amount: 6 },
        ...river,
      ],
    });
    const bet = (amt: number) => [{ userId: 'v', action: 'bet', stage: 'river', amount: amt }, { userId: 'h', action: 'call', stage: 'river', amount: amt }];
    const rows = [
      base('As Kd', 'Ah 7c 2d 9s Jc', bet(3), 25), // small, won
      base('As Kd', 'Ah 7c 2d 9s Jc', bet(3), -25), // small, lost
      base('Qs Qd', 'Jh 7c 2d 9s 3c', bet(6), -30), // medium, lost
      base('Qs Qd', 'Jh 7c 2d 9s 3c', bet(12), 40), // large, won
      base('As 7d', 'Ah 7c 2d 9s Jc', bet(12), 40), // two pair: not counted
      base('As Kd', 'Ah 7c 2d 9s Jc', bet(12), 40, 'plo4'), // Omaha: skipped
      { horse_user_id: 'h', game_variant: 'nlh', net_bb: 1, hole_cards: null, board: null, actions: null }, // unreadable
      base('As Kd', 'Ah 7c 2d 9s Jc', bet(12), 40, ''), // no variant named: not assumed Hold em
    ];
    const out = riverOnePairCalls(rows);
    expect(out.unreadableRows).toBe(1);
    expect(out.consideredRows).toBe(5);
    expect(out.cells).toEqual([
      { sizeClass: 'small', calls: 2, won: 1, wonPct: 50 },
      { sizeClass: 'medium', calls: 1, won: 0, wonPct: 0 },
      { sizeClass: 'large', calls: 1, won: 1, wonPct: 100 },
    ]);
    expect(out.caveat).toContain('20bb');
  });

  it('reads card objects as well as strings', () => {
    const row = {
      horse_user_id: 'h',
      game_variant: 'nlh',
      net_bb: 30,
      hole_cards: [{ rank: 'A', suit: 'spades' }, { rank: 'K', suit: 'diamonds' }],
      board: [{ rank: 'A', suit: 'hearts' }, { rank: '7', suit: 'clubs' }, { rank: '2', suit: 'diamonds' }, { rank: '9', suit: 'spades' }, { rank: 'J', suit: 'clubs' }],
      actions: [
        { userId: 'v', action: 'bet', stage: 'river', amount: 10 },
        { userId: 'h', action: 'call', stage: 'river', amount: 10 },
      ],
    };
    const out = riverOnePairCalls([row]);
    expect(out.cells.reduce((n, c) => n + c.calls, 0)).toBe(1);
  });
});

describe('receipt counts and the report', () => {
  it('counts the four receipts by day and renders every section', () => {
    const rows = [
      { day: '2026-10-31', feature: 'v62_river_bettor_polarity', fires: 12 },
      { day: '2026-10-30', feature: 'v62_river_bettor_polarity', fires: '3' },
      { day: '2026-10-30', feature: 'v61_river_one_pair_shade', fires: 40 },
      { day: '2026-10-30', feature: 'unrelated', fires: 99 },
    ];
    const counts = receiptCounts(rows);
    expect(counts.map((r) => r.feature)).toEqual(['v61_river_one_pair_shade', 'v62_river_bettor_polarity', 'v38_river_call', 'v38_river_fold']);
    expect(counts[1].total).toBe(15);
    expect(counts[1].byDay.map((d) => d.day)).toEqual(['2026-10-30', '2026-10-31']);
    expect(counts[2].total).toBe(0);
    const md = renderMarkdown({
      generatedAt: '2026-10-31T00:00:00Z',
      servingReleaseSha: 'abc',
      heap: heapSlopes([sample(0, 1000, 5000)]),
      threeBet: threeBetShares([]),
      riverOnePair: riverOnePairCalls([]),
      receipts: counts,
    });
    for (const heading of ['## 1. Heap growth', '## 2. 3-bet shares', '## 3. River one-pair calls', '## 4. Receipt counts']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('Serving release: abc');
    expect(md).toContain('n/a');
    expect(md).toContain('v62_river_bettor_polarity | 15 |');
  });
});

describe('the database function answer', () => {
  const good = {
    schema: RIVER_ONE_PAIR_RPC_SCHEMA,
    since: '2026-10-30T00:00:00Z',
    limit: 20000,
    consideredRows: 11262,
    unreadableRows: 958,
    cells: [
      { sizeClass: 'medium', calls: 301, won: 53 },
      { sizeClass: 'small', calls: 106, won: 35 },
      { sizeClass: 'large', calls: 618, won: 83 },
    ],
    caveat: 'horse_hand_reviews holds only hands with |net| >= 20bb, so these are big-pot river calls',
  };

  it('is adopted in size-class order with percentages and its source named', () => {
    const r = riverOnePairFromRpc(good);
    expect(r?.source).toBe('fn_horse_river_one_pair_calls');
    expect(r?.cells.map((c) => c.sizeClass)).toEqual(['small', 'medium', 'large']);
    expect(r?.cells[2]).toEqual({ sizeClass: 'large', calls: 618, won: 83, wonPct: 13.4 });
    expect(r?.consideredRows).toBe(11262);
    expect(r?.caveat).toContain('20bb');
  });

  it('is refused (null, so the caller fetches rows) outside the contract', () => {
    expect(riverOnePairFromRpc(null)).toBeNull();
    expect(riverOnePairFromRpc({ ...good, schema: 'other' })).toBeNull();
    expect(riverOnePairFromRpc({ ...good, cells: good.cells.slice(0, 2) })).toBeNull();
    expect(riverOnePairFromRpc({ ...good, cells: [{ sizeClass: 'small', calls: 1, won: 2 }, good.cells[0], good.cells[2]] })).toBeNull();
    expect(riverOnePairFromRpc({ ...good, consideredRows: -1 })).toBeNull();
  });

  it('renders which side computed the cells', () => {
    const fromRows = riverOnePairCalls([]);
    expect(fromRows.source).toBe('rows');
    const md = renderMarkdown({ generatedAt: 'x', servingReleaseSha: null, heap: [], threeBet: [], riverOnePair: riverOnePairFromRpc(good)!, receipts: [] });
    expect(md).toContain('computed by fn_horse_river_one_pair_calls in the database');
  });
});

describe('samples from Prometheus', () => {
  const range = (metric: Record<string, string>, values: Array<[number, number]>) => ({
    status: 'success',
    data: { resultType: 'matrix', result: [{ metric, values: values.map(([t, v]) => [t, String(v)] as [number, string]) }] },
  });

  it('labels each heap point with the instance serving at that instant and drops unknown instants', () => {
    const t0 = 1_793_400_000;
    const heap = range({ __name__: 'poker_engine_heap_used_bytes' }, [[t0, 3.0e9], [t0 + 60, 3.1e9], [t0 + 120, 0.4e9], [t0 + 180, 0.45e9], [t0 + 240, 0.5e9]]);
    const rss = range({}, [[t0, 15e9], [t0 + 60, 15.2e9], [t0 + 120, 2e9], [t0 + 180, 2.1e9], [t0 + 240, 2.2e9]]);
    const info = {
      status: 'success',
      data: {
        resultType: 'matrix',
        result: [
          { metric: { instance_id: '1-old', version: 'eed06fe5' }, values: [[t0, '1'], [t0 + 60, '1']] as Array<[number, string]> },
          { metric: { instance_id: '2-new', version: '034e2a21' }, values: [[t0 + 120, '1'], [t0 + 180, '1']] as Array<[number, string]> },
        ],
      },
    };
    const samples = samplesFromPrometheus(heap, rss, info);
    // t0+240 has no presence point within 30 s: dropped, never guessed.
    expect(samples.map((s) => s.instanceId)).toEqual(['1-old', '1-old', '2-new', '2-new']);
    expect(samples[2]).toEqual({ at: (t0 + 120) * 1000, instanceId: '2-new', releaseSha: '034e2a21', heapUsedMb: 400, rssMb: 2000 });
    const slopes = heapSlopes(samples);
    expect(slopes.map((s) => s.instanceId)).toEqual(['1-old', '2-new']);
    expect(slopes[0].reason).toContain('needed'); // two points per instance: not enough
  });

  it('is empty on a non-success or malformed answer', () => {
    expect(samplesFromPrometheus({ status: 'error' }, { status: 'error' }, { status: 'error' })).toEqual([]);
    expect(samplesFromPrometheus({} as never, {} as never, {} as never)).toEqual([]);
  });
});
