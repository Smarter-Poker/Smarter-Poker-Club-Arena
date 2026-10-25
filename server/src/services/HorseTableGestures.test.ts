/**
 * A HORSE THROWS SOMETIMES, LIKE A PERSON (Dan 2026-10-21)
 *
 * "HORSES SHOULD SOMETIMES THROW SOME EMOJI'S AT PLAYERS THAT BEAT THEM IN A
 * HAND, OR BEFORE THEY GO ALL IN CLICK OR SEND THE GOOD LUCK EMOJI" and "not
 * always just the good luck, and not every time before going all in."
 *
 * The throw is charged through the person's own RPC and broadcast in the
 * browser's own wire format; the roll is a hash that says no most of the time;
 * every item thrown is in the live client catalog.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    rpcAnswer: { data: { success: true }, error: null } as { data: unknown; error: unknown },
    sends: [] as Array<{ topic: string; event: string; payload: Record<string, unknown> }>,
    removed: 0,
    gate: { engine: true, mode: true },
    chatInserts: 0,
  };
  function builder(table: string) {
    const execute = () => {
      if (table === 'content_settings')
        return { data: [{ engine_enabled: state.gate.engine }], error: null };
      if (table === 'horse_post_modes')
        return { data: { mode: 'x', enabled: state.gate.mode }, error: null };
      return { data: [], error: null };
    };
    const b: Record<string, unknown> = {};
    for (const name of ['select', 'eq', 'in', 'is', 'gt', 'gte', 'lt', 'order', 'limit']) b[name] = () => b;
    b.insert = () => {
      if (table === 'table_chat') state.chatInserts++;
      return b;
    };
    b.maybeSingle = () => Promise.resolve(execute());
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve().then(execute).then(res, rej);
    return b;
  }
  const supabase = {
    from: (t: string) => builder(t),
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve(state.rpcAnswer);
    },
    channel: (topic: string) => ({
      topic,
      httpSend: (event: string, payload: Record<string, unknown>) => {
        state.sends.push({ topic, event, payload });
        return Promise.resolve({ success: true });
      },
    }),
    removeChannel: () => {
      state.removed++;
      return Promise.resolve('ok');
    },
  };
  return { state, supabase };
});

vi.mock('./supabase/client.js', () => ({ supabase: h.supabase }));
vi.mock('./errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String(e),
}));

import {
  ALL_IN_REACTIONS,
  GESTURE_CHANCE_PCT,
  GESTURE_ITEM_IDS,
  HORSE_GESTURES_PER_HOUR,
  _resetGesturesForTests,
  allInForm,
  buildAllInGestureInput,
  detectAfterHand,
  gestureAfterHand,
  gestureBeforeAllIn,
  rollsGesture,
  throwItem,
  type AllInGestureInput,
} from './HorseTableGestures.js';
import { _resetTableTalkGateForTests } from './HorseTableTalkGate.js';
import { _setAudienceForTests } from './HorseTableTalk.js';
import { _setHumanPacingForTests } from './horsePacing.js';
import {
  _setSpeakChanceForTests,
  type TableTalkInput,
  type TalkSeat,
  type TalkTable,
} from './HorseTableTalk.js';
import type { SeatedPlayer, TableInfo } from '../types.js';

const TABLE = '11111111-1111-4111-8111-111111111111';
const HORSE_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const HORSE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HUMAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function seat(userId: string, seatNo: number, isHorse: boolean): TalkSeat {
  return {
    userId,
    username: `p${seatNo}`,
    seat: seatNo,
    isHorse,
    horseProfile: { style: 'lag' },
    occupancyId: `occ-${userId}`,
  };
}

function table(over: Partial<TalkTable> = {}): TalkTable {
  return {
    tableId: TABLE,
    bigBlind: 2,
    maxPlayers: 9,
    banChat: false,
    isTournament: false,
    isDiamondCash: false,
    variant: 'nlh',
    ...over,
  };
}

/** HORSE_A (seat 1) loses a showdown to HUMAN (seat 3). */
function lostHand(handNumber: number): TableTalkInput {
  return {
    table: table(),
    handNumber,
    potSize: 40,
    communityCards: ['Ah', 'Kd', '2c', '7s', '9h'],
    winners: [{ userId: HUMAN, amount: 40 }],
    showdownResults: [
      { userId: HUMAN, handRanking: 3, handName: 'Two Pair' },
      { userId: HORSE_A, handRanking: 2, handName: 'Pair' },
    ],
    seated: [seat(HORSE_A, 1, true), seat(HORSE_B, 2, true), seat(HUMAN, 3, false)],
  };
}

/** The first hand number at or after `from` on which `moment` rolls yes for HORSE_A. */
function handThatRolls(moment: 'lost' | 'won' | 'all_in', from = 1): number {
  for (let n = from; n < from + 10_000; n++) if (rollsGesture(moment, HORSE_A, TABLE, n)) return n;
  throw new Error('no hand rolls');
}
function handThatDoesNot(moment: 'lost' | 'won' | 'all_in', from = 1): number {
  for (let n = from; n < from + 10_000; n++) if (!rollsGesture(moment, HORSE_A, TABLE, n)) return n;
  throw new Error('every hand rolls');
}

beforeEach(() => {
  _setSpeakChanceForTests(null);
  _resetGesturesForTests();
  _resetTableTalkGateForTests();
  _setHumanPacingForTests(false);
  _setAudienceForTests(() => true);
  h.state.rpcCalls = [];
  h.state.sends = [];
  h.state.removed = 0;
  h.state.chatInserts = 0;
  h.state.rpcAnswer = { data: { success: true }, error: null };
  h.state.gate = { engine: true, mode: true };
});

afterEach(() => {
  _setHumanPacingForTests(true);
  _setAudienceForTests(null);
});

describe('what a horse throws is what a person can throw', () => {
  it('every item is in the live client catalog and none is retired', () => {
    const catalog = readFileSync(
      join(process.cwd(), '..', 'src', 'services', 'ThrowableService.ts'),
      'utf8'
    );
    const live = new Set<string>();
    const re = /T\(\s*'([a-z0-9_]+)',\s*'[^']+',\s*'(\w+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(catalog))) live.add(m[1]);
    expect(live.size).toBeGreaterThan(40);
    for (const id of GESTURE_ITEM_IDS)
      expect(live.has(id), `${id} is not in the catalog`).toBe(true);
  });

  it('the all-in reactions are the TableReactions glyphs, Lucky most of all but never only', () => {
    const client = readFileSync(
      join(process.cwd(), '..', 'src', 'components', 'table', 'TableReactions.tsx'),
      'utf8'
    );
    for (const glyph of new Set(ALL_IN_REACTIONS)) {
      expect(client).toContain(`emoji: '${glyph}'`);
    }
    const lucky = String.fromCodePoint(0x2663);
    const n = ALL_IN_REACTIONS.filter((g) => g === lucky).length;
    expect(n).toBeGreaterThan(ALL_IN_REACTIONS.length / 2);
    expect(n).toBeLessThan(ALL_IN_REACTIONS.length);
  });
});

describe('sometimes, never every time', () => {
  it('a non-gesturing horse never throws after a loss or sends an all-in reaction', async () => {
    const quiet = '44444444-4444-4444-8444-444444444444';
    const horse = seat(quiet, 1, true);
    for (let n = 1; n <= 100; n++) {
      const input = lostHand(n);
      input.seated = [horse, seat(HUMAN, 3, false)];
      input.showdownResults = input.showdownResults.map((r) =>
        r.userId === HORSE_A ? { ...r, userId: quiet } : r
      );
      expect(await gestureAfterHand(input)).toBe('no_gesture');
      expect(
        await gestureBeforeAllIn({
          table: table(),
          handNumber: n,
          horse,
          targetSeat: 3,
          seated: input.seated,
        })
      ).toBe('no_gesture');
    }
    expect(h.state.rpcCalls).toEqual([]);
    expect(h.state.sends).toEqual([]);
    expect(h.state.chatInserts).toBe(0);
  });

  it('a chat-only horse can say something all-in without throwing anything', async () => {
    const horse = seat('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, true);
    let spoken = 0;
    for (let n = 1; n <= 200; n++) {
      const outcome = await gestureBeforeAllIn({
        table: table(),
        handNumber: n,
        horse,
        targetSeat: 3,
        seated: [horse, seat(HUMAN, 3, false)],
      });
      if (outcome === 'spoken') spoken++;
    }
    expect(spoken).toBeGreaterThan(0);
    expect(spoken).toBeLessThan(30);
    expect(h.state.rpcCalls).toEqual([]);
    expect(h.state.sends).toEqual([]);
  });
  it.each(['lost', 'won', 'all_in'] as const)(
    '%s rolls the same way twice, near its rate across the fleet, and differently per horse',
    (moment) => {
      let yes = 0;
      let n = 0;
      const perHorse: number[] = [];
      for (let h = 0; h < 200; h++) {
        const horse = `horse-${h}`;
        let mine = 0;
        for (let hand = 1; hand <= 200; hand++) {
          const a = rollsGesture(moment, horse, TABLE, hand);
          expect(rollsGesture(moment, horse, TABLE, hand)).toBe(a);
          if (a) {
            yes++;
            mine++;
          }
          n++;
        }
        perHorse.push(mine);
      }
      const pct = (yes / n) * 100;
      expect(pct).toBeGreaterThan(GESTURE_CHANCE_PCT[moment] * 0.15);
      expect(pct).toBeLessThan(GESTURE_CHANCE_PCT[moment] * 0.6);
      expect(pct).toBeLessThan(50);
      expect(Math.max(...perHorse)).toBeGreaterThan(2 * Math.min(...perHorse) + 1);
    }
  );

  it('an all-in gesture is not always the same form: chat, a throw and a reaction all occur', () => {
    const forms = new Set<string>();
    for (let n = 1; n <= 400; n++) forms.add(allInForm(HORSE_A, n, true));
    expect([...forms].sort()).toEqual(['chat', 'reaction', 'throw']);
    // where chat is not allowed (a tournament), never chat
    for (let n = 1; n <= 400; n++) expect(allInForm(HORSE_A, n, false)).not.toBe('chat');
  });
});

describe('after a hand', () => {
  it('a horse that lost a showdown may throw at the winner seat', () => {
    const n = handThatRolls('lost');
    const pick = detectAfterHand(lostHand(n));
    expect(pick).toMatchObject({ moment: 'lost', targetSeat: 3 });
    expect(pick!.horse.userId).toBe(HORSE_A);
    expect(detectAfterHand(lostHand(handThatDoesNot('lost')))).toBeNull();
  });

  it('a hand with no showdown gives nobody anything to throw about', () => {
    const quiet = { ...lostHand(handThatRolls('lost')), showdownResults: [] };
    expect(detectAfterHand(quiet)).toBeNull();
  });

  it('charges through the person RPC, then broadcasts the browser THROW payload from the horse', async () => {
    const n = handThatRolls('lost');
    expect(await gestureAfterHand(lostHand(n))).toBe('thrown');
    expect(h.state.rpcCalls).toHaveLength(1);
    const { fn, args } = h.state.rpcCalls[0];
    expect(fn).toBe('fn_horse_use_throwable');
    expect(args.p_horse_id).toBe(HORSE_A);
    expect(GESTURE_ITEM_IDS).toContain(args.p_throwable_id);
    expect(h.state.sends).toHaveLength(1);
    const send = h.state.sends[0];
    expect(send.topic).toBe(`table:${TABLE}`);
    expect(send.event).toBe('game_event');
    expect(send.payload.type).toBe('CHAT');
    expect(send.payload.sender).toBe(HORSE_A);
    const body = send.payload.payload as { message: string; throwId: string };
    expect(body.message).toBe(`[THROW:${String(args.p_throwable_id)}:3]`);
    expect(body.throwId).toBe(args.p_request_id);
    expect(body.throwId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(h.state.removed).toBe(1);
  });

  it('a refused charge throws nothing', async () => {
    h.state.rpcAnswer = { data: { success: false, error: 'Please Wait' }, error: null };
    expect(await gestureAfterHand(lostHand(handThatRolls('lost')))).toBe('refused');
    expect(h.state.sends).toHaveLength(0);
  });

  it('the gate closed: nothing charged, nothing sent', async () => {
    h.state.gate = { engine: true, mode: false };
    expect(await gestureAfterHand(lostHand(handThatRolls('lost')))).toBe('gate_closed');
    expect(h.state.rpcCalls).toHaveLength(0);
    expect(h.state.sends).toHaveLength(0);
  });

  it('a table sees one gesture per spacing window, and a horse a few per hour', async () => {
    const first = handThatRolls('lost');
    expect(await gestureAfterHand(lostHand(first))).toBe('thrown');
    expect(await gestureAfterHand(lostHand(handThatRolls('lost', first + 1)))).toBe('limited');
    expect(HORSE_GESTURES_PER_HOUR).toBeLessThanOrEqual(6);
  });
});

describe('before an all in', () => {
  function input(handNumber: number, over: Partial<AllInGestureInput> = {}): AllInGestureInput {
    return {
      table: table(),
      handNumber,
      horse: seat(HORSE_A, 1, true),
      targetSeat: 3,
      seated: [seat(HORSE_A, 1, true), seat(HUMAN, 3, false)],
      ...over,
    };
  }

  it('most shoves carry nothing at all', async () => {
    expect(await gestureBeforeAllIn(input(handThatDoesNot('all_in')))).toBe('no_gesture');
    expect(h.state.rpcCalls).toHaveLength(0);
    expect(h.state.sends).toHaveLength(0);
    expect(h.state.chatInserts).toBe(0);
  });

  it('a throw form throws at the seat it faces; a reaction form floats from its own seat', async () => {
    let threw = false;
    let reacted = false;
    for (let n = 1; n < 3000 && !(threw && reacted); n++) {
      if (!rollsGesture('all_in', HORSE_A, TABLE, n)) continue;
      const form = allInForm(HORSE_A, n, false);
      _resetGesturesForTests();
      h.state.sends = [];
      const out = await gestureBeforeAllIn(input(n, { table: table({ isTournament: true }) }));
      const msg = (h.state.sends[0]?.payload.payload as { message?: string })?.message ?? '';
      if (form === 'throw') {
        expect(out).toBe('thrown');
        expect(msg).toMatch(/^\[THROW:[a-z0-9_]+:3\]$/);
        threw = true;
      } else {
        expect(out).toBe('reacted');
        expect(msg).toMatch(/^\[REACTION:.:1\]$/u);
        reacted = true;
      }
    }
    expect(threw && reacted).toBe(true);
  });

  it('the engine builds the input from the live hand: the bettor it calls, else a live opponent', () => {
    const info = {
      id: TABLE,
      big_blind: 2,
      max_players: 9,
      game_variant: 'nlh',
    } as unknown as TableInfo;
    const seated = [
      { user_id: HORSE_A, seat_number: 1, is_horse: true, username: 'p1' },
      { user_id: HUMAN, seat_number: 3, is_horse: false, username: 'p3' },
      { user_id: HORSE_B, seat_number: 5, is_horse: true, username: 'p5' },
    ] as unknown as SeatedPlayer[];
    const live = [
      { seat: 1, user_id: HORSE_A, is_folded: false },
      { seat: 3, user_id: HUMAN, is_folded: false },
      { seat: 5, user_id: HORSE_B, is_folded: true },
    ];
    const facing = buildAllInGestureInput(info, seated, HORSE_A, 9, false, live, 3, 40);
    expect(facing?.targetSeat).toBe(3);
    const opening = buildAllInGestureInput(info, seated, HORSE_A, 9, false, live, -1, 0);
    expect(opening?.targetSeat).toBe(3); // the folded seat is never the target
    expect(buildAllInGestureInput(null, seated, HORSE_A, 9, false, live, 3, 40)).toBeNull();
  });

  it('throwItem names the receipt id as the throw id', async () => {
    expect(await throwItem(TABLE, HORSE_A, 'horseshoe', 4)).toBe('thrown');
    const body = h.state.sends[0].payload.payload as { message: string; throwId: string };
    expect(body.message).toBe('[THROW:horseshoe:4]');
    expect(body.throwId).toBe(h.state.rpcCalls[0].args.p_request_id);
  });
});

describe('nobody watching', () => {
  it('throws nothing and charges nothing at a table nobody has open', async () => {
    _setAudienceForTests(() => false);
    expect(await gestureAfterHand(lostHand(handThatRolls('lost')))).toBe('no_audience');
    expect(h.state.rpcCalls).toHaveLength(0);
    expect(h.state.sends).toHaveLength(0);
  });
});
