/**
 * CLIP MODE (Phase 9.1, 2026-09-30; the share path since 2026-10-07): the pure
 * half of the hand clip renderer.
 *
 * - The hand (the share path): the payload becomes the same ShareableHand the
 *   archive's share button builds, through `shareableFromModel`. Every
 *   player's screen name and seat is kept, the hero is marked, the table name
 *   comes from the payload with the archive's "Club Arena" fallback, the hand
 *   number is carried, and the hero's private cards and discard travel into
 *   the model. Nothing is anonymised: a clip is the share page, by owner
 *   decision (Dan, 2026-10-07).
 * - The rate fit (contract C3) picks the slowest rate that fits the window,
 *   extends the end hold to reach the minimum, and refuses a hand that runs
 *   past the maximum at the fastest rate.
 * - A malformed payload reads as null; a payload without a table name reads
 *   with `tableName` null.
 */
import { describe, it, expect } from 'vitest';
import {
  CLIP_END_HOLD_MS,
  clipHandFrom,
  clipRunMs,
  fitClipRate,
  readClipPayload,
  type ClipRow,
} from '@/lib/clipMode';
import { buildReplay, replayInputFromRow } from '@/utils/handReplay';
import { buildReplayFrames, type ReplayFrame } from '@/utils/replayFrames';
import { replayFromShareable, shareableFromModel, shareUserId } from '@/lib/shareHandModel';
import { ACTION_BEAT_MS, REPLAY_RATES, STREET_BEAT_MS, replayBeatMs } from '@/utils/replayMotion';

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

/** The same hand folded around to the hero preflop: no showdown, no shown cards. */
function foldAroundRow(): ClipRow {
  const row = fixtureRow();
  row.actions = [
    { seat: 2, userId: SHOWN, action: 'fold', amount: 0, stage: 'preflop' },
    { seat: 3, userId: FOLDED, action: 'fold', amount: 0, stage: 'preflop' },
  ];
  row.community_cards = [];
  row.winners = [{ userId: HERO, amount: 3, potIndex: 0 }];
  row.hole_cards = null;
  row.showdown = null;
  row.pots = [{ index: 0, amount: 3, eligible: [HERO] }];
  row.pot_size = 3;
  return row;
}

function payloadFor(row: ClipRow, extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    style: 'felt-720p',
    heroId: HERO,
    row,
    tableName: 'Kingfish Club',
    privateHoleCards: {},
    discardedCards: {},
    minMs: 15000,
    maxMs: 40000,
    ...extra,
  };
}

const withPayload = (p: unknown): Window => ({ __SP_CLIP__: p }) as unknown as Window;

const read = (p: unknown) => {
  const payload = readClipPayload(withPayload(p));
  if (!payload) throw new Error('fixture payload did not read');
  return payload;
};

describe('the hand (the share path)', () => {
  it('is the ShareableHand the archive builds for a share of the same hand', () => {
    const hand = clipHandFrom(read(payloadFor(fixtureRow())));
    /* panelHandToShareable, src/lib/handHistoryAdapter.ts: the same call. */
    const reference = shareableFromModel(buildReplay(replayInputFromRow(fixtureRow())), {
      id: 'hand-uuid',
      tableName: 'Kingfish Club',
      heroUserId: HERO,
    });
    expect(hand).toEqual(reference);
    /* And the page reads it back as it reads a link: the one reconstruction. */
    const model = replayFromShareable(hand);
    const direct = buildReplay(replayInputFromRow(fixtureRow()));
    expect(model.players.map((p) => p.username)).toEqual(direct.players.map((p) => p.username));
    expect(model.potTotal).toBe(direct.potTotal);
    expect(buildReplayFrames(model).length).toBe(buildReplayFrames(direct).length);
  });

  it('keeps the name and the seat of every player, and marks the hero', () => {
    const hand = clipHandFrom(read(payloadFor(fixtureRow())));
    expect(hand.players.map((p) => [p.seat, p.name])).toEqual([
      [1, 'kingfish'],
      [2, 'Emerson'],
      [3, 'Folder'],
    ]);
    expect(hand.players.map((p) => p.isHero)).toEqual([true, false, false]);
    /* The hero's seat is the one the felt is anchored on, as a link's is. */
    expect(hand.players.find((p) => p.isHero)?.seat).toBe(1);
    const text = JSON.stringify(hand);
    expect(text).toContain('Emerson');
    expect(text).toContain('Folder');
    expect(text).not.toContain('Seat 2');
    expect(text).not.toContain('Seat 3');
  });

  it('carries the table name from the payload, and "Club Arena" when it sent none', () => {
    expect(clipHandFrom(read(payloadFor(fixtureRow()))).tableName).toBe('Kingfish Club');
    expect(clipHandFrom(read(payloadFor(fixtureRow(), { tableName: null }))).tableName).toBe(
      'Club Arena'
    );
    expect(clipHandFrom(read(payloadFor(fixtureRow(), { tableName: '' }))).tableName).toBe(
      'Club Arena'
    );
  });

  it('carries the hand number, the stakes, the variant and the showdown as a link does', () => {
    const hand = clipHandFrom(read(payloadFor(fixtureRow())));
    expect(hand.id).toBe('hand-uuid');
    expect(hand.handNumber).toBe(4242);
    expect(hand.stakes).toBe('1/2');
    expect(hand.variant).toBe('NLH');
    const hero = hand.players.find((p) => p.seat === 1);
    const shown = hand.players.find((p) => p.seat === 2);
    const folded = hand.players.find((p) => p.seat === 3);
    /* The cards the table saw are the shown cards, for the hero and the villain alike. */
    expect(hero?.cards).toEqual([
      { rank: '9', suit: 'c' },
      { rank: '9', suit: 'd' },
    ]);
    expect(hero?.privateCards).toBeUndefined();
    expect(shown?.cards).toEqual([
      { rank: 'A', suit: 'h' },
      { rank: 'K', suit: 'h' },
    ]);
    expect(folded?.cards).toBeUndefined();
    expect(hero?.isWinner).toBe(true);
    expect(hero?.won).toBe(200);
    expect(hero?.handName).toBe('Three Of A Kind');
    const model = replayFromShareable(hand);
    expect(model.showdown.map((r) => r.userId)).toEqual([shareUserId(1), shareUserId(2)]);
  });

  it("the hero's private cards travel into the model, marked private, as a link carries them", () => {
    const hand = clipHandFrom(
      read(
        payloadFor(foldAroundRow(), {
          privateHoleCards: {
            [HERO]: [
              { rank: 'A', suit: 'c' },
              { rank: 'K', suit: 'c' },
            ],
          },
        })
      )
    );
    const hero = hand.players.find((p) => p.isHero);
    expect(hero?.cards).toEqual([
      { rank: 'A', suit: 'c' },
      { rank: 'K', suit: 'c' },
    ]);
    expect(hero?.privateCards).toBe(true);
    expect(hand.players.filter((p) => !p.isHero).every((p) => p.cards === undefined)).toBe(true);
    const model = replayFromShareable(hand);
    const heroModel = model.players.find((p) => p.userId === shareUserId(1));
    expect(heroModel?.privateHole?.length).toBe(2);
    expect(heroModel?.hole ?? null).toBeNull();
    /* A fold-around has no showdown, so the private cards did not invent one. */
    expect(model.showdown).toEqual([]);
  });

  it("the hero's discard travels into the model as the discard street", () => {
    const row = fixtureRow();
    row.game_variant = 'pineapple';
    row.actions = [
      { seat: 3, userId: FOLDED, action: 'fold', amount: 0, stage: 'preflop' },
      { seat: 1, userId: HERO, action: 'raise', amount: 6, stage: 'preflop' },
      { seat: 2, userId: SHOWN, action: 'call', amount: 4, stage: 'preflop' },
      { seat: 1, userId: HERO, action: 'discard', amount: 0, stage: 'pineapple_discard' },
      { seat: 2, userId: SHOWN, action: 'discard', amount: 0, stage: 'pineapple_discard' },
      { seat: 2, userId: SHOWN, action: 'check', amount: 0, stage: 'flop' },
      { seat: 1, userId: HERO, action: 'all_in', amount: 94, stage: 'flop' },
      { seat: 2, userId: SHOWN, action: 'call', amount: 94, stage: 'flop' },
    ];
    const hand = clipHandFrom(
      read(payloadFor(row, { discardedCards: { [HERO]: { rank: '2', suit: 'd' } } }))
    );
    expect(hand.variant).toBe('Crazy Pineapple');
    expect(hand.discard?.actions).toEqual([
      { seat: 1, action: 'DISCARD' },
      { seat: 2, action: 'DISCARD' },
    ]);
    const model = replayFromShareable(hand);
    const discards = model.streets.find((s) => s.key === 'pineapple_discard');
    expect(discards?.rows.map((r) => [r.seat, r.verb])).toEqual([
      [1, 'discard'],
      [2, 'discard'],
    ]);
    /* The card itself never travels on the wire; it is the viewer's own. */
    expect(hand.discard).toEqual({
      actions: [
        { seat: 1, action: 'DISCARD' },
        { seat: 2, action: 'DISCARD' },
      ],
    });
    expect(discards?.rows.every((r) => r.discardedCard === null)).toBe(true);
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
    /* The camera's plan: one beat per frame, in frame order, summing to the run. */
    expect(fit.beats).toHaveLength(f.length);
    expect(fit.beats).toEqual(f.map((fr) => replayBeatMs(fr, 1, 0.5)));
    expect(fit.beats.reduce((a, b) => a + b, 0)).toBe(fit.runMs);
    expect(fit.beats.reduce((a, b) => a + b, 0) + fit.holdMs).toBe(fit.plannedMs);
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
    expect(p?.tableName).toBe('Kingfish Club');
    expect(p?.minMs).toBe(15000);
    expect(p?.maxMs).toBe(40000);
    expect(p?.style).toBe('felt-720p');
  });

  it('reads a payload without a table name, with tableName null', () => {
    const noTable: Record<string, unknown> = payloadFor(fixtureRow());
    delete noTable.tableName;
    expect(readClipPayload(withPayload(noTable))?.tableName).toBeNull();
    expect(
      readClipPayload(withPayload(payloadFor(fixtureRow(), { tableName: '' })))?.tableName
    ).toBeNull();
    expect(
      readClipPayload(withPayload(payloadFor(fixtureRow(), { tableName: '  ' })))?.tableName
    ).toBeNull();
    expect(
      readClipPayload(withPayload(payloadFor(fixtureRow(), { tableName: 42 })))?.tableName
    ).toBeNull();
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
