/**
 * CLIP MODE (Phase 9.1, 2026-09-30; the arena's own replayer since
 * 2026-10-07): the pure half of the hand clip renderer.
 *
 * - The source: the payload becomes the `ReplaySource` HandReplay builds for
 *   a hand it fetched by id, from the same record. The reference is built
 *   here the way the arena builds it: the archive's own mapper
 *   (HandHistoryService.mapHandHistoryRow) on the row, folded into a source
 *   exactly as HandReplay's `source` memo folds a fetched record. Every
 *   player's screen name and seat is kept, the hero is the viewer, the table
 *   name comes from the payload with the archive's "Table" fallback, the
 *   hand number, the variant and the reveal record are carried, and the
 *   hero's private cards and discard travel into the model. A clip is the
 *   hand replayer inside Club Arena, by owner decision (Dan, 2026-10-07).
 * - The rate fit (contract C3) picks the slowest rate that fits the window,
 *   extends the end hold to reach the minimum, and refuses a hand that runs
 *   past the maximum at the fastest rate.
 * - A malformed payload reads as null; a payload without a table name reads
 *   with `tableName` null.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CLIP_END_HOLD_MS,
  clipSourceFrom,
  clipRunMs,
  fitClipRate,
  readClipPayload,
  type ClipRow,
} from '@/lib/clipMode';
import { buildReplay, replayInputFromRow } from '@/utils/handReplay';
import { buildReplayFrames, type ReplayFrame } from '@/utils/replayFrames';
import { ACTION_BEAT_MS, REPLAY_RATES, STREET_BEAT_MS, replayBeatMs } from '@/utils/replayMotion';
import type { ReplaySource } from '@/components/replay/HandReplay';

/* The archive's mapper is the reference; it is reached the way
   tests/unit/ritBoardsPersistence.test.ts reaches it, with the database
   client stubbed out, because the mapper itself never touches it. */
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({}), rpc: vi.fn() } }));
vi.mock('@/utils/retryAsync', () => ({ retryAsync: <T>(fn: () => Promise<T>) => fn() }));
import { handHistoryService } from '@/services/HandHistoryService';

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

/**
 * THE REFERENCE: the source the arena's replayer renders for this record.
 * The archive's mapper on the row (with the table's name, the viewer's own
 * discard and private cards, as the archive supplies them), folded into a
 * `ReplaySource` exactly as HandReplay's `source` memo folds a fetched
 * record (src/components/replay/HandReplay.tsx, `handId` mode).
 */
function arenaSourceFor(
  row: ClipRow,
  opts: {
    tableName?: string;
    discard?: { seat: number; card: { rank: string; suit: string } };
    privateCards?: { rank: string; suit: string }[];
  } = {}
): ReplaySource {
  const tableId = 'table-uuid';
  const tableNames = new Map<string, { name?: string }>();
  if (opts.tableName) tableNames.set(tableId, { name: opts.tableName });
  const discards = new Map<string, { seat: number; card: { rank: string; suit: string } }>();
  if (opts.discard) discards.set(`${tableId}:${row.hand_number}`, opts.discard);
  /* `facts` is required by the mapper's type and read only by the Rundown
     tab; the clip never shows it (see clipSourceFrom), so it is null here. */
  const privateByHand = new Map<string, { user_id: string; cards: unknown[]; facts: null }>();
  if (opts.privateCards) {
    privateByHand.set(row.id, { user_id: HERO, cards: opts.privateCards, facts: null });
  }
  const record = (handHistoryService as unknown as Record<string, any>).mapHandHistoryRow(
    { ...row, table_id: tableId },
    new Map(),
    discards,
    privateByHand,
    tableNames
  );
  if (!record) throw new Error('the archive did not map the fixture row');
  const reveals: Record<string, { mucked?: boolean } | undefined> = {};
  for (const p of record.players) reveals[p.user_id] = p.showdown_reveal;
  return {
    model: record.replay,
    tableName: record.table_name ?? null,
    handNumber: record.hand_number ?? null,
    gameType: record.game_type ?? null,
    reveals,
    viewerId: HERO,
    viewerFacts: record.players.find((p: any) => p.user_id === HERO)?.facts ?? null,
  };
}

describe("the source (the arena's own replayer)", () => {
  it('is the source HandReplay builds for the same hand fetched by id, field for field', () => {
    const source = clipSourceFrom(read(payloadFor(fixtureRow())));
    const arena = arenaSourceFor(fixtureRow(), { tableName: 'Kingfish Club' });
    expect(source).toEqual(arena);
    /* The model is the record's own reconstruction, not a wire round trip. */
    expect(source.model).toEqual(buildReplay(replayInputFromRow(fixtureRow())));
    expect(buildReplayFrames(source.model).length).toBe(buildReplayFrames(arena.model).length);
  });

  it('keeps the name and the seat of every player, and anchors the felt on the hero', () => {
    const source = clipSourceFrom(read(payloadFor(fixtureRow())));
    expect(source.model.players.map((p) => [p.seat, p.username])).toEqual([
      [1, 'kingfish'],
      [2, 'Emerson'],
      [3, 'Folder'],
    ]);
    expect(source.viewerId).toBe(HERO);
    const text = JSON.stringify(source);
    expect(text).toContain('Emerson');
    expect(text).toContain('Folder');
    expect(text).not.toContain('Seat 2');
    expect(text).not.toContain('Seat 3');
  });

  it('carries the table name from the payload, and "Table" when it sent none, as the archive does', () => {
    expect(clipSourceFrom(read(payloadFor(fixtureRow()))).tableName).toBe('Kingfish Club');
    expect(clipSourceFrom(read(payloadFor(fixtureRow(), { tableName: null }))).tableName).toBe(
      'Table'
    );
    expect(clipSourceFrom(read(payloadFor(fixtureRow(), { tableName: '' }))).tableName).toBe(
      'Table'
    );
    expect(arenaSourceFor(fixtureRow()).tableName).toBe('Table');
    expect(clipSourceFrom(read(payloadFor(fixtureRow(), { tableName: null })))).toEqual(
      arenaSourceFor(fixtureRow())
    );
  });

  it('carries the hand number, the variant, the stakes and the reveal record as the arena does', () => {
    const source = clipSourceFrom(read(payloadFor(fixtureRow())));
    expect(source.handNumber).toBe(4242);
    expect(source.gameType).toBe('NLH');
    expect(source.model.smallBlind).toBe(1);
    expect(source.model.bigBlind).toBe(2);
    expect(source.reveals).toEqual({
      [HERO]: { reveal_order: 0, mucked: false, hand_name: 'Three Of A Kind' },
      [SHOWN]: { reveal_order: 1, mucked: false, hand_name: 'Pair' },
      [FOLDED]: undefined,
    });
    expect(Object.keys(source.reveals ?? {})).toEqual([HERO, SHOWN, FOLDED]);
    /* The cards the table saw are in the model for the hero and the villain alike. */
    const hero = source.model.players.find((p) => p.userId === HERO);
    const shown = source.model.players.find((p) => p.userId === SHOWN);
    const folded = source.model.players.find((p) => p.userId === FOLDED);
    expect(hero?.hole?.length).toBe(2);
    expect(shown?.hole?.length).toBe(2);
    expect(folded?.hole ?? null).toBeNull();
    expect(hero?.won).toBe(200);
    expect(source.model.showdown.map((r) => r.userId)).toEqual([HERO, SHOWN]);
    /* A mucked seat is marked as the record marks it. */
    const row = fixtureRow();
    row.showdown = [
      { user_id: HERO, seat: 1, reveal_order: 0, mucked: false, hand_name: 'Three Of A Kind' },
      { user_id: SHOWN, seat: 2, reveal_order: 1, mucked: true },
    ];
    const mucked = clipSourceFrom(read(payloadFor(row)));
    expect(mucked.reveals?.[SHOWN]).toEqual({ reveal_order: 1, mucked: true });
    expect(mucked).toEqual(arenaSourceFor(row, { tableName: 'Kingfish Club' }));
    /* A hand that never reached showdown has a key for every seat and no record. */
    const quiet = clipSourceFrom(read(payloadFor(foldAroundRow())));
    expect(quiet.reveals).toEqual({ [HERO]: undefined, [SHOWN]: undefined, [FOLDED]: undefined });
    expect(quiet).toEqual(arenaSourceFor(foldAroundRow(), { tableName: 'Kingfish Club' }));
  });

  it("the hero's private cards travel into the model, marked private, as the archive carries them", () => {
    const cards = [
      { rank: 'A', suit: 'c' },
      { rank: 'K', suit: 'c' },
    ];
    const source = clipSourceFrom(
      read(payloadFor(foldAroundRow(), { privateHoleCards: { [HERO]: cards } }))
    );
    const hero = source.model.players.find((p) => p.userId === HERO);
    expect(hero?.privateHole?.length).toBe(2);
    expect(hero?.hole ?? null).toBeNull();
    expect(source.model.players.filter((p) => p.userId !== HERO).every((p) => !p.privateHole)).toBe(
      true
    );
    /* A fold-around has no showdown, so the private cards did not invent one. */
    expect(source.model.showdown).toEqual([]);
    expect(source).toEqual(
      arenaSourceFor(foldAroundRow(), { tableName: 'Kingfish Club', privateCards: cards })
    );
  });

  it("the hero's discard travels into the model as the discard street, card and all", () => {
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
    const card = { rank: '2', suit: 'd' };
    const source = clipSourceFrom(read(payloadFor(row, { discardedCards: { [HERO]: card } })));
    expect(source.gameType).toBe('PINEAPPLE');
    const discards = source.model.streets.find((s) => s.key === 'pineapple_discard');
    expect(discards?.rows.map((r) => [r.seat, r.verb])).toEqual([
      [1, 'discard'],
      [2, 'discard'],
    ]);
    /* The hero's own card is in the model, as it is in the arena; nobody else's is. */
    expect(discards?.rows.find((r) => r.seat === 1)?.discardedCard).toEqual(card);
    expect(discards?.rows.find((r) => r.seat === 2)?.discardedCard ?? null).toBeNull();
    expect(source).toEqual(
      arenaSourceFor(row, { tableName: 'Kingfish Club', discard: { seat: 1, card } })
    );
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
