/**
 * CLIP MODE (Phase 9.1, 2026-09-30): the pure half of the hand clip renderer.
 *
 * - The anonymiser (contract C2 step 1) leaves the hero whole, turns every
 *   other seat into "Seat N", drops the winner name, keeps the cards of a
 *   villain the showdown record marks as shown and drops the cards of one who
 *   folded. The writer's own keys (server/src/services/supabase/handHistory.ts)
 *   are pinned here so a renamed column cannot quietly stop the scrub.
 * - The rate fit (contract C3) picks the slowest rate that fits the window,
 *   extends the end hold to reach the minimum, and refuses a hand that runs
 *   past the maximum at the fastest rate.
 * - A malformed payload reads as null.
 */
import { describe, it, expect } from 'vitest';
import {
  CLIP_END_HOLD_MS,
  anonymiseRowForClip,
  buildClipSource,
  clipRunMs,
  fitClipRate,
  readClipPayload,
  shownIdsFromShowdown,
  type ClipRow,
} from '@/lib/clipMode';
import { buildReplay, replayInputFromRow } from '@/utils/handReplay';
import { buildReplayFrames, type ReplayFrame } from '@/utils/replayFrames';
import { ACTION_BEAT_MS, REPLAY_RATES, STREET_BEAT_MS } from '@/utils/replayMotion';

const HERO = 'hero-uuid';
const SHOWN = 'shown-villain-uuid';
const FOLDED = 'folded-villain-uuid';

/** A `hand_history` row as the writer stores it: the writer's keys, nothing else. */
function fixtureRow(): ClipRow {
  return {
    id: 'hand-uuid',
    hand_number: 4242,
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    pot_size: 200,
    rake_amount: 0,
    bbj_amount: 0,
    button_seat: 1,
    started_at: '2026-09-30T12:00:00.000Z',
    community_cards: [
      { rank: '7', suit: 'c' },
      { rank: '2', suit: 'c' },
      { rank: '9', suit: 'h' },
      { rank: 'K', suit: 'd' },
      { rank: 'T', suit: 'c' },
    ],
    players: [
      { userId: HERO, username: 'kingfish', seat: 1, stack: 200, cards: [] },
      { userId: SHOWN, username: 'Emerson', seat: 2, stack: 0, cards: [] },
      { userId: FOLDED, username: 'Folder', seat: 3, stack: 100, cards: [] },
    ],
    actions: [
      { seat: 3, userId: FOLDED, action: 'fold', amount: 0, stage: 'preflop' },
      { seat: 1, userId: HERO, action: 'raise', amount: 6, stage: 'preflop' },
      { seat: 2, userId: SHOWN, action: 'call', amount: 4, stage: 'preflop' },
      { seat: 2, userId: SHOWN, action: 'check', amount: 0, stage: 'flop' },
      { seat: 1, userId: HERO, action: 'all_in', amount: 94, stage: 'flop' },
      { seat: 2, userId: SHOWN, action: 'call', amount: 94, stage: 'flop' },
    ],
    winners: [
      {
        userId: HERO,
        amount: 200,
        potIndex: 0,
        hand: { name: 'Three Of A Kind', ranking: 4, cards: ['9c', '9d', '9h', 'Kd', 'Tc'] },
      },
    ],
    winners_by_board: null,
    winner_name: 'kingfish',
    hole_cards: {
      [HERO]: [
        { rank: '9', suit: 'c' },
        { rank: '9', suit: 'd' },
      ],
      [SHOWN]: [
        { rank: 'A', suit: 'h' },
        { rank: 'K', suit: 'h' },
      ],
    },
    showdown: [
      { user_id: HERO, seat: 1, reveal_order: 0, mucked: false, hand_name: 'Three Of A Kind' },
      { user_id: SHOWN, seat: 2, reveal_order: 1, mucked: false, hand_name: 'Pair' },
    ],
    pots: [{ index: 0, amount: 200, eligible: [HERO, SHOWN] }],
  };
}

function payloadFor(row: ClipRow, extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    style: 'felt-720p',
    heroId: HERO,
    row,
    privateHoleCards: {},
    discardedCards: {},
    minMs: 15000,
    maxMs: 40000,
    ...extra,
  };
}

const withPayload = (p: unknown): Window => ({ __SP_CLIP__: p }) as unknown as Window;

describe('the anonymiser (contract C2 step 1)', () => {
  const row = fixtureRow();
  const out = anonymiseRowForClip(row, HERO);
  const players = out.players as Array<Record<string, unknown>>;

  it('keeps the hero whole and turns every other seat into its seat number', () => {
    expect(players[0]).toEqual(row.players[0]);
    expect(players[1].username).toBe('Seat 2');
    expect(players[2].username).toBe('Seat 3');
    expect(players.map((p) => p.userId)).toEqual([HERO, SHOWN, FOLDED]);
    const text = JSON.stringify(out);
    expect(text).not.toContain('Emerson');
    expect(text).not.toContain('Folder');
    expect(text).toContain('kingfish');
  });

  it('drops the winner name', () => {
    expect(out.winner_name).toBeNull();
  });

  it("keeps the hero's cards and the shown villain's, and drops the folded villain's", () => {
    const leaky = fixtureRow();
    /* A row that somehow carried a folded seat's holding must still not show it. */
    (leaky.hole_cards as Record<string, unknown>)[FOLDED] = [
      { rank: 'A', suit: 's' },
      { rank: 'A', suit: 'd' },
    ];
    const scrubbed = anonymiseRowForClip(leaky, HERO);
    expect(Object.keys(scrubbed.hole_cards as object).sort()).toEqual([HERO, SHOWN].sort());
    expect((scrubbed.hole_cards as Record<string, unknown>)[HERO]).toEqual(
      (row.hole_cards as Record<string, unknown>)[HERO]
    );
    expect((scrubbed.hole_cards as Record<string, unknown>)[SHOWN]).toEqual(
      (row.hole_cards as Record<string, unknown>)[SHOWN]
    );
  });

  it('a mucked showdown entry is not a reveal', () => {
    const mucked = fixtureRow();
    (mucked.showdown as Array<Record<string, unknown>>)[1].mucked = true;
    expect([...shownIdsFromShowdown(mucked.showdown)]).toEqual([HERO]);
    const scrubbed = anonymiseRowForClip(mucked, HERO);
    expect(Object.keys(scrubbed.hole_cards as object)).toEqual([HERO]);
  });

  it('pins the writer keys: userId on players / winners / winners_by_board, user_id on showdown, hand.name kept', () => {
    /* server/src/services/supabase/handHistory.ts stores exactly these. */
    expect(Object.keys(row.players[0] as object).sort()).toEqual(
      ['cards', 'seat', 'stack', 'userId', 'username'].sort()
    );
    expect(Object.keys((row.winners as unknown[])[0] as object).sort()).toEqual(
      ['amount', 'hand', 'potIndex', 'userId'].sort()
    );
    /* hand_description rides beside hand_name on revealed entries; the fixture
       leaves it off, which the writer also does on a mucked entry. */
    expect(Object.keys((row.showdown as unknown[])[0] as object).sort()).toEqual(
      ['hand_name', 'mucked', 'reveal_order', 'seat', 'user_id'].sort()
    );
    const winners = out.winners as Array<Record<string, unknown>>;
    expect((winners[0].hand as Record<string, unknown>).name).toBe('Three Of A Kind');
    /* The hero's own winning hand keeps its cards; a seat that did not show loses them. */
    expect((winners[0].hand as Record<string, unknown>).cards).toBeDefined();
    const foldWin = fixtureRow();
    foldWin.winners = [
      {
        userId: FOLDED,
        amount: 10,
        potIndex: 0,
        hand: { name: 'High Card', ranking: 1, cards: ['As'] },
      },
    ];
    const scrubbed = anonymiseRowForClip(foldWin, HERO);
    const w = (scrubbed.winners as Array<Record<string, unknown>>)[0];
    expect((w.hand as Record<string, unknown>).name).toBe('High Card');
    expect('cards' in (w.hand as object)).toBe(false);
  });

  it('replaces a name-shaped field on a non-hero winner, per-board winner or showdown entry', () => {
    const named = fixtureRow();
    named.winners = [{ userId: SHOWN, username: 'Emerson', amount: 200, potIndex: 0 }];
    named.winners_by_board = [
      { board: 1, userId: SHOWN, name: 'Emerson', amount: 100, handName: 'Pair' },
      { board: 2, userId: HERO, name: 'kingfish', amount: 100, handName: 'Flush' },
    ];
    (named.showdown as Array<Record<string, unknown>>)[1].username = 'Emerson';
    const scrubbed = anonymiseRowForClip(named, HERO);
    expect((scrubbed.winners as Array<Record<string, unknown>>)[0].username).toBe('Seat 2');
    const byBoard = scrubbed.winners_by_board as Array<Record<string, unknown>>;
    expect(byBoard[0].name).toBe('Seat 2');
    expect(byBoard[0].handName).toBe('Pair');
    expect(byBoard[1].name).toBe('kingfish');
    expect((scrubbed.showdown as Array<Record<string, unknown>>)[1].username).toBe('Seat 2');
    expect(JSON.stringify(scrubbed)).not.toContain('Emerson');
  });

  it('leaves everything else on the row as it was', () => {
    expect(out.actions).toEqual(row.actions);
    expect(out.community_cards).toEqual(row.community_cards);
    expect(out.pots).toEqual(row.pots);
    expect(out.id).toBe(row.id);
    expect(out.hand_number).toBe(row.hand_number);
  });
});

describe('the rate fit (contract C3)', () => {
  const action = { row: { verb: 'call' } } as unknown as ReplayFrame;
  const street = { row: null } as unknown as ReplayFrame;
  /** n action frames and m street frames. */
  const frames = (n: number, m: number): ReplayFrame[] => [
    ...Array.from({ length: m }, () => street),
    ...Array.from({ length: n }, () => action),
  ];

  it('sums the beats at animation speed 1, the way playback pays them', () => {
    expect(clipRunMs(frames(2, 1), 1)).toBe(2 * ACTION_BEAT_MS + STREET_BEAT_MS);
    expect(clipRunMs(frames(2, 1), 2)).toBe(2 * (ACTION_BEAT_MS / 2) + STREET_BEAT_MS / 2);
  });

  it('picks the slowest rate whose run plus the end hold fits the maximum', () => {
    /* 10 actions + 5 streets: 16,000 ms at 1x, 32,000 ms at half speed. */
    const f = frames(10, 5);
    const fit = fitClipRate(f, REPLAY_RATES, 15000, 40000);
    expect(fit.tooLong).toBe(false);
    if (fit.tooLong) return;
    expect(fit.rate).toBe(0.5);
    expect(fit.runMs).toBe(32000);
    expect(fit.holdMs).toBe(CLIP_END_HOLD_MS);
    expect(fit.plannedMs).toBe(33500);
    /* 20 actions + 5 streets: 50,000 ms at half, 25,000 ms at 1x. */
    const g = fitClipRate(frames(20, 5), REPLAY_RATES, 15000, 40000);
    expect(g.tooLong).toBe(false);
    if (!g.tooLong) expect(g.rate).toBe(1);
    /* 40 actions + 5 streets: 43,000 ms at 1x, 21,500 ms at double. */
    const h = fitClipRate(frames(40, 5), REPLAY_RATES, 15000, 40000);
    expect(h.tooLong).toBe(false);
    if (!h.tooLong) expect(h.rate).toBe(2);
  });

  it('extends the end hold so a short hand still reaches the minimum', () => {
    /* 3 actions + 2 streets at half speed: 5,400 + 5,600 = 11,000 ms. */
    const fit = fitClipRate(frames(3, 2), REPLAY_RATES, 15000, 40000);
    expect(fit.tooLong).toBe(false);
    if (fit.tooLong) return;
    expect(fit.rate).toBe(0.5);
    expect(fit.runMs).toBe(11000);
    expect(fit.holdMs).toBe(4000);
    expect(fit.plannedMs).toBe(15000);
  });

  it('refuses a hand that runs past the maximum even at the fastest rate', () => {
    /* 90 actions + 5 streets at double: 40,500 + 3,500 = 44,000 ms. */
    const fit = fitClipRate(frames(90, 5), REPLAY_RATES, 15000, 40000);
    expect(fit.tooLong).toBe(true);
    expect(fit.rate).toBe(2);
    expect(fit.plannedMs).toBe(44000 + CLIP_END_HOLD_MS);
  });

  it('reads the rates in ascending order whatever order they arrive in', () => {
    const fit = fitClipRate(frames(10, 5), [2, 1, 0.5], 15000, 40000);
    expect(fit.tooLong).toBe(false);
    if (!fit.tooLong) expect(fit.rate).toBe(0.5);
  });
});

describe('the payload (contract C1)', () => {
  it('reads a well-formed payload', () => {
    const p = readClipPayload(withPayload(payloadFor(fixtureRow())));
    expect(p).not.toBeNull();
    expect(p?.heroId).toBe(HERO);
    expect(p?.minMs).toBe(15000);
    expect(p?.maxMs).toBe(40000);
    expect(p?.style).toBe('felt-720p');
  });

  it('returns null for a malformed payload', () => {
    expect(readClipPayload(withPayload(undefined))).toBeNull();
    expect(readClipPayload(withPayload('nope'))).toBeNull();
    expect(readClipPayload(withPayload(payloadFor(fixtureRow(), { v: 2 })))).toBeNull();
    expect(
      readClipPayload(withPayload(payloadFor(fixtureRow(), { style: 'portrait' })))
    ).toBeNull();
    expect(readClipPayload(withPayload(payloadFor(fixtureRow(), { heroId: '' })))).toBeNull();
    expect(readClipPayload(withPayload(payloadFor({ ...fixtureRow(), id: '' })))).toBeNull();
    expect(
      readClipPayload(withPayload(payloadFor({ ...fixtureRow(), players: 'three' } as never)))
    ).toBeNull();
    expect(readClipPayload(withPayload(payloadFor(fixtureRow(), { row: null })))).toBeNull();
    expect(readClipPayload(null)).toBeNull();
  });

  it('falls back to the default window when the limits are missing or inside out', () => {
    const missing = readClipPayload(
      withPayload(payloadFor(fixtureRow(), { minMs: undefined, maxMs: undefined }))
    );
    expect(missing?.minMs).toBe(15000);
    expect(missing?.maxMs).toBe(40000);
    const inverted = readClipPayload(
      withPayload(payloadFor(fixtureRow(), { minMs: 50000, maxMs: 20000 }))
    );
    expect(inverted?.minMs).toBe(15000);
    expect(inverted?.maxMs).toBe(40000);
  });
});

describe('the source (contract C2 step 2)', () => {
  it('builds the one model from the anonymised row, anchored on the hero, with no table name', () => {
    const payload = readClipPayload(withPayload(payloadFor(fixtureRow())));
    expect(payload).not.toBeNull();
    const source = buildClipSource(payload!);
    expect(source.tableName).toBeNull();
    expect(source.viewerId).toBe(HERO);
    expect(source.viewerFacts).toBeNull();
    expect(source.handNumber).toBe(4242);
    expect(source.gameType).toBe('nlh');
    expect(source.model.players.map((p) => p.username)).toEqual(['kingfish', 'Seat 2', 'Seat 3']);
    expect(source.reveals).toEqual({ [HERO]: { mucked: false }, [SHOWN]: { mucked: false } });
    /* The same reconstruction the archive renders, with the names scrubbed. */
    const reference = buildReplay(replayInputFromRow(anonymiseRowForClip(fixtureRow(), HERO)));
    expect(source.model.pots).toEqual(reference.pots);
    expect(buildReplayFrames(source.model).length).toBe(buildReplayFrames(reference).length);
    const text = JSON.stringify(source);
    expect(text).not.toContain('Emerson');
    expect(text).not.toContain('Folder');
  });

  it("only the hero's private cards and discard travel into the model", () => {
    const payload = readClipPayload(
      withPayload(
        payloadFor(fixtureRow(), {
          privateHoleCards: {
            [HERO]: [
              { rank: '9', suit: 'c' },
              { rank: '9', suit: 'd' },
            ],
            [FOLDED]: [
              { rank: 'A', suit: 's' },
              { rank: 'A', suit: 'd' },
            ],
          },
        })
      )
    );
    const source = buildClipSource(payload!);
    const folded = source.model.players.find((p) => p.userId === FOLDED);
    expect(folded).toBeDefined();
    expect(folded?.hole ?? null).toBeNull();
    expect(folded?.privateHole ?? null).toBeNull();
    const hero = source.model.players.find((p) => p.userId === HERO);
    expect((hero?.hole ?? hero?.privateHole ?? []).length).toBe(2);
  });
});
