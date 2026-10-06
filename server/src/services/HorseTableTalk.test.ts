/**
 * A HORSE SPEAKS ONCE, ON THE RECORD, AS A PLAYER (Phase 10, 2026-10-06)
 *
 * The events are read off the hand the engine captured; the voice is the dial
 * the seat carries; the line is a hash, never a roll; the claim is one INSERT
 * behind the owner's limits, and the chat row is the browser's own four
 * columns. Every "no" has a name and every refusal writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Filter = [string, ...unknown[]];
interface Call {
  table: string;
  op: 'select' | 'insert';
  filters: Filter[];
  payload?: Record<string, unknown>;
}
type Answer = { data: unknown; error: unknown };

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    /** table -> scripted answer, given the call (so a test can look at filters). */
    answers: {} as Record<string, (call: Call) => Answer>,
    gate: { engine: true, mode: true as boolean | null },
  };
  function builder(table: string) {
    const call: Call = { table, op: 'select', filters: [] };
    state.calls.push(call);
    const execute = (): Answer => {
      if (table === 'content_settings')
        return { data: [{ engine_enabled: state.gate.engine }], error: null };
      if (table === 'horse_post_modes') {
        return {
          data: state.gate.mode === null ? null : { mode: 'table_talk', enabled: state.gate.mode },
          error: null,
        };
      }
      const fn = state.answers[table];
      return fn ? fn(call) : { data: [], error: null };
    };
    const b: Record<string, unknown> = {};
    for (const name of ['select', 'eq', 'gt', 'gte', 'lt', 'lte', 'order', 'limit']) {
      b[name] = (...args: unknown[]) => (call.filters.push([name, ...args]), b);
    }
    b.insert = (payload: Record<string, unknown>) => {
      call.op = 'insert';
      call.payload = payload;
      return b;
    };
    b.maybeSingle = () => Promise.resolve(execute());
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve().then(execute).then(res, rej);
    return b;
  }
  return { state, supabase: { from: (t: string) => builder(t) } };
});

vi.mock('./supabase/client.js', () => ({ supabase: h.supabase }));
vi.mock('./errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String(e),
}));

import {
  BIG_POT_BB,
  GREETER_MIN_HANDS_SEATED,
  _resetTableTalkForTests,
  chooseLine,
  detectEvents,
  fillLine,
  greetArrival,
  lineIndexFor,
  normalizePhrase,
  pickCandidate,
  sanitizeLine,
  speakAtTheFelt,
  tableRefusal,
  voiceFor,
  type ArrivalInput,
  type TableTalkInput,
  type TalkSeat,
  type TalkTable,
} from './HorseTableTalk.js';
import { _resetTableTalkGateForTests } from './HorseTableTalkGate.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

const TABLE = '11111111-1111-4111-8111-111111111111';
const HORSE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HORSE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HUMAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = Date.parse('2026-10-06T12:00:00Z');

function seat(
  userId: string,
  seatNo: number,
  isHorse: boolean,
  over: Partial<TalkSeat> = {}
): TalkSeat {
  return {
    userId,
    username: userId === HUMAN ? 'danny' : `plate${seatNo}`,
    seat: seatNo,
    isHorse,
    horseProfile: { style: 'balanced' },
    occupancyId: `occ-${userId}`,
    ...over,
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

const roster = () => [seat(HORSE_A, 1, true), seat(HORSE_B, 2, true), seat(HUMAN, 3, false)];

/** A quiet hand: nobody qualifies for anything. */
function quietHand(handNumber: number, over: Partial<TableTalkInput> = {}): TableTalkInput {
  return {
    table: table(),
    handNumber,
    potSize: 10,
    communityCards: ['Ah', 'Kd', '2c'],
    winners: [{ userId: HUMAN, amount: 10 }],
    showdownResults: [],
    seated: roster(),
    ...over,
  };
}

/** Horse A drags a 60 bb pot on the river. */
function bigPotHand(handNumber: number, over: Partial<TableTalkInput> = {}): TableTalkInput {
  return quietHand(handNumber, {
    potSize: 60 * 2,
    communityCards: ['Ah', 'Kd', '2c', '7s', '9h'],
    winners: [{ userId: HORSE_A, amount: 120, hand: { name: 'Two Pair', ranking: 3 } }],
    showdownResults: [
      { userId: HORSE_A, handRanking: 3, handName: 'Two Pair' },
      { userId: HUMAN, handRanking: 2, handName: 'Pair' },
    ],
    ...over,
  });
}

const callsTo = (t: string) => h.state.calls.filter((c) => c.table === t);
const inserts = (t: string) => callsTo(t).filter((c) => c.op === 'insert');
const tablesTouched = () => [...new Set(h.state.calls.map((c) => c.table))].sort();
const GATE_TABLES = ['content_settings', 'horse_post_modes'];

const ledgerRow = (over: Record<string, unknown> = {}) => ({
  table_id: TABLE,
  horse_id: HORSE_A,
  hand_number: 1,
  phrase_norm: 'something else',
  said_at: new Date(NOW - 3 * 60 * 60_000).toISOString(),
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW) });
  _resetTableTalkForTests();
  _resetTableTalkGateForTests();
  h.state.calls = [];
  h.state.answers = {};
  h.state.gate = { engine: true, mode: true };
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── pure: events, voice, line, door ─────────────────────────────────────────

describe('events are read off the captured hand', () => {
  it('a horse that wins a pot of 40 bb or more: big_pot_won with the pot and the street', () => {
    const c = detectEvents(bigPotHand(5));
    expect(c.map((x) => x.event)).toContain('big_pot_won');
    const win = c.find((x) => x.event === 'big_pot_won')!;
    expect(win.speakerId).toBe(HORSE_A);
    expect(win.facts).toEqual({ potBB: 60, street: 'river' });
    expect(BIG_POT_BB).toBe(40);
    // 39 bb is not a big pot
    expect(detectEvents(bigPotHand(5, { potSize: 39 * 2 })).map((x) => x.event)).not.toContain(
      'big_pot_won'
    );
  });

  it('a horse that shows two pair or better and does not win: showdown_loss with ITS OWN hand', () => {
    const input = quietHand(6, {
      communityCards: ['Ah', 'Kd', '2c', '7s'],
      winners: [{ userId: HUMAN, amount: 40, hand: { name: 'Flush', ranking: 6 } }],
      showdownResults: [
        { userId: HUMAN, handRanking: 6, handName: 'Flush' },
        { userId: HORSE_A, handRanking: 3, handName: 'Two Pair' },
        { userId: HORSE_B, handRanking: 2, handName: 'Pair' },
      ],
    });
    const c = detectEvents(input).filter((x) => x.event === 'showdown_loss');
    expect(c).toHaveLength(1);
    expect(c[0].speakerId).toBe(HORSE_A);
    expect(c[0].facts).toEqual({ hand: 'two pair', street: 'turn', seat: 3 });
  });

  it('a mucked hand is not a shown hand: no showdown_loss for it', () => {
    const input = quietHand(7, {
      winners: [{ userId: HUMAN, amount: 40, hand: { name: 'Flush', ranking: 6 } }],
      showdownResults: [
        { userId: HUMAN, handRanking: 6, handName: 'Flush' },
        { userId: HORSE_A, handRanking: 4, handName: 'Three of a Kind', mucked: true },
      ],
    });
    expect(detectEvents(input).map((x) => x.event)).not.toContain('showdown_loss');
  });

  it('a winner that showed a full house or better: big_hand_shown from a non-winning horse, seat only', () => {
    const input = quietHand(8, {
      winners: [{ userId: HUMAN, amount: 50, hand: { name: 'Full House', ranking: 7 } }],
      showdownResults: [
        { userId: HUMAN, handRanking: 7, handName: 'Full House' },
        { userId: HORSE_A, handRanking: 1, handName: 'High Card' },
      ],
    });
    const c = detectEvents(input).filter((x) => x.event === 'big_hand_shown');
    expect(c.map((x) => x.speakerId).sort()).toEqual([HORSE_A, HORSE_B].sort());
    for (const x of c) expect(x.facts).toEqual({ hand: 'full house', seat: 3, street: 'flop' });
    expect(JSON.stringify(c)).not.toContain('danny');
  });

  it('a fold-win that carries an evaluated hand was never shown: no big_hand_shown', () => {
    const input = quietHand(9, {
      winners: [{ userId: HUMAN, amount: 50, hand: { name: 'Full House', ranking: 7 } }],
      showdownResults: [],
    });
    expect(detectEvents(input)).toEqual([]);
  });

  it('one candidate per hand: a won pot outranks a loss, and the pick is deterministic', () => {
    const input = bigPotHand(10, {
      winners: [
        { userId: HORSE_A, amount: 60 },
        { userId: HORSE_B, amount: 60 },
      ],
      showdownResults: [
        { userId: HORSE_A, handRanking: 3, handName: 'Two Pair' },
        { userId: HORSE_B, handRanking: 3, handName: 'Two Pair' },
        { userId: HUMAN, handRanking: 7, handName: 'Full House' },
      ],
    });
    const c = detectEvents(input);
    const pick = pickCandidate(c, TABLE, 10)!;
    expect(pick.event).toBe('big_pot_won');
    expect(pickCandidate(c, TABLE, 10)).toEqual(pick);
    expect(pickCandidate([], TABLE, 10)).toBeNull();
  });
});

describe('the voice is the dial the seat already carries', () => {
  it.each([
    ['grinder', 'quiet'],
    ['tag', 'quiet'],
    ['nit', 'quiet'],
    ['lag', 'needler'],
    ['tricky', 'needler'],
    ['maniac', 'needler'],
    ['balanced', 'friendly'],
    ['fish', 'friendly'],
  ])('%s speaks as %s', (style, voice) => {
    expect(voiceFor({ style }, HORSE_A)).toBe(voice);
    expect(voiceFor(style, HORSE_A)).toBe(voice);
  });

  it('an empty profile still has a voice, the same one every time', () => {
    expect(voiceFor({}, HORSE_A)).toBe(voiceFor(null, HORSE_A));
    expect(['quiet', 'needler', 'friendly']).toContain(voiceFor(undefined, HORSE_B));
  });
});

describe('the line is a hash, never a roll', () => {
  it('the same inputs give the same line', () => {
    const facts = { potBB: 52, street: 'river' as const };
    const a = chooseLine('big_pot_won', 'needler', HORSE_A, 4242, facts);
    const b = chooseLine('big_pot_won', 'needler', HORSE_A, 4242, facts);
    expect(a).toEqual(b);
    expect(a?.line).toBe('52 bb on the river, somebody wanted to see my cards');
  });

  it('over 1,000 hand numbers the choice covers every line of a pool and favours none', () => {
    const seen = new Map<number, number>();
    for (let hand = 1; hand <= 1000; hand++) {
      const i = lineIndexFor(HORSE_A, hand, 'showdown_loss', 8);
      seen.set(i, (seen.get(i) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const n of seen.values()) expect(n).toBeLessThan(300);
    // two horses on the same hand do not move together
    const a = Array.from({ length: 50 }, (_, i) => lineIndexFor(HORSE_A, i, 'arrival', 8));
    const b = Array.from({ length: 50 }, (_, i) => lineIndexFor(HORSE_B, i, 'arrival', 8));
    expect(a).not.toEqual(b);
  });

  it('a template with a fact the engine does not hold is never written with a hole', () => {
    expect(fillLine('{hand} no good, fair enough', {})).toBeNull();
    expect(fillLine('{hand} no good, fair enough', { hand: 'two pair' })).toBe(
      'two pair no good, fair enough'
    );
    expect(fillLine('welcome to the table seat {seat}, good luck', { seat: 4 })).toBe(
      'welcome to the table seat 4, good luck'
    );
    expect(chooseLine('showdown_loss', 'friendly', HORSE_A, 1, { hand: 'two pair' })).toBeNull();
  });
});

describe('the one door every line passes', () => {
  const names = ['danny', 'Plate2', null, undefined];
  it('accepts a plain filled line', () => {
    expect(sanitizeLine('nice pot, 52 bb, gg', names)).toEqual({
      ok: true,
      line: 'nice pot, 52 bb, gg',
    });
  });
  it('refuses a banned dash, built from the code point so this file holds none', () => {
    for (const cp of [0x2012, 0x2013, 0x2014, 0x2015]) {
      expect(sanitizeLine(`nice pot ${String.fromCodePoint(cp)} gg`, names)).toEqual({
        ok: false,
        reason: 'dash',
      });
    }
    expect(sanitizeLine('nice pot - gg', names).ok).toBe(true);
  });
  it('refuses an emoji and a variation selector', () => {
    expect(sanitizeLine(`gg ${String.fromCodePoint(0x1f600)}`, names)).toEqual({
      ok: false,
      reason: 'emoji',
    });
    expect(sanitizeLine(`gg ${String.fromCodePoint(0x2660, 0xfe0f)}`, names)).toEqual({
      ok: false,
      reason: 'emoji',
    });
  });
  it('refuses an at sign, an unfilled placeholder, an empty line and a long one', () => {
    expect(sanitizeLine('gg @danny', [])).toEqual({ ok: false, reason: 'at_sign' });
    expect(sanitizeLine('{hand} no good', [])).toEqual({ ok: false, reason: 'placeholder' });
    expect(sanitizeLine('   ', [])).toEqual({ ok: false, reason: 'empty' });
    expect(sanitizeLine('x'.repeat(121), [])).toEqual({ ok: false, reason: 'too_long' });
    expect(sanitizeLine('x'.repeat(120), []).ok).toBe(true);
  });
  it('refuses any token equal to a seated username, whatever the case or punctuation', () => {
    expect(sanitizeLine('nice hand Danny', names)).toEqual({ ok: false, reason: 'names_a_player' });
    expect(sanitizeLine('gg plate2, nice', names)).toEqual({ ok: false, reason: 'names_a_player' });
    expect(sanitizeLine('gg dan_b!', ['Dan_B'])).toEqual({ ok: false, reason: 'names_a_player' });
    expect(sanitizeLine('gg dan.b', ['dan.b'])).toEqual({ ok: false, reason: 'names_a_player' });
    expect(sanitizeLine('nice hand seat 3', names).ok).toBe(true);
  });
  it('a phrase is its template: numbers fold, punctuation and braces drop', () => {
    expect(normalizePhrase('nice pot, {potBB} bb, gg')).toBe('nice pot potbb bb gg');
    expect(normalizePhrase('nice pot, 52 bb, gg')).toBe('nice pot n bb gg');
    expect(normalizePhrase('  GL  ')).toBe('gl');
  });
});

describe('where a horse may speak at all', () => {
  it('names the refusal: tournament, diamond cash, ban_chat, heads-up', () => {
    expect(tableRefusal(table())).toBeNull();
    expect(tableRefusal(table({ isTournament: true }))).toBe('tournament');
    expect(tableRefusal(table({ isDiamondCash: true }))).toBe('diamond_cash');
    expect(tableRefusal(table({ banChat: true }))).toBe('ban_chat');
    expect(tableRefusal(table({ maxPlayers: 2 }))).toBe('heads_up');
  });
});

// ─── the write path ──────────────────────────────────────────────────────────

describe('speakAtTheFelt', () => {
  it('with the gate closed the only work is the gate read: no ledger, no chat', async () => {
    h.state.gate = { engine: true, mode: false };
    expect(await speakAtTheFelt(bigPotHand(20))).toBe('gate_closed');
    expect(tablesTouched()).toEqual(GATE_TABLES);
    h.state.calls = [];
    h.state.gate = { engine: false, mode: true };
    _resetTableTalkGateForTests();
    expect(await speakAtTheFelt(bigPotHand(21))).toBe('gate_closed');
    expect(tablesTouched()).toEqual(GATE_TABLES);
  });

  it('with no qualifying event nothing at all is read', async () => {
    expect(await speakAtTheFelt(quietHand(22))).toBe('no_event');
    expect(h.state.calls).toEqual([]);
  });

  it('a tournament, a heads-up table, a banned chat and diamond cash write nothing and read nothing', async () => {
    expect(await speakAtTheFelt(bigPotHand(23, { table: table({ isTournament: true }) }))).toBe(
      'tournament'
    );
    expect(await speakAtTheFelt(bigPotHand(24, { table: table({ maxPlayers: 2 }) }))).toBe(
      'heads_up'
    );
    expect(await speakAtTheFelt(bigPotHand(25, { table: table({ banChat: true }) }))).toBe(
      'ban_chat'
    );
    expect(await speakAtTheFelt(bigPotHand(26, { table: table({ isDiamondCash: true }) }))).toBe(
      'diamond_cash'
    );
    expect(h.state.calls).toEqual([]);
  });

  it('claims the hand in the ledger BEFORE writing the chat row, and the row is the browser shape', async () => {
    expect(await speakAtTheFelt(bigPotHand(30))).toBe('spoken');
    const order = h.state.calls.filter((c) => c.op === 'insert').map((c) => c.table);
    expect(order).toEqual(['horse_table_talk_ledger', 'table_chat']);
    const claim = inserts('horse_table_talk_ledger')[0].payload!;
    expect(claim).toEqual({
      table_id: TABLE,
      hand_number: 30,
      horse_id: HORSE_A,
      event: 'big_pot_won',
      voice: 'friendly',
      phrase_norm: 'nice pot potbb bb gg',
    });
    const chat = inserts('table_chat')[0].payload!;
    expect(Object.keys(chat).sort()).toEqual(['message', 'message_type', 'table_id', 'user_id']);
    expect(chat).toEqual({
      table_id: TABLE,
      user_id: HORSE_A,
      message: 'nice pot, 60 bb, gg',
      message_type: 'player',
    });
    // the reads before the claim: the horse's day, the table's newest lines, the mute
    expect(tablesTouched()).toEqual(
      [
        'content_settings',
        'horse_post_modes',
        'horse_table_talk_ledger',
        'table_chat',
        'table_chat_mutes',
      ].sort()
    );
    const mute = callsTo('table_chat_mutes')[0];
    expect(mute.filters).toContainEqual(['eq', 'user_id', HORSE_A]);
    expect(mute.filters).toContainEqual(['eq', 'table_id', TABLE]);
  });

  it('a ledger conflict on (table, hand) is silence: no chat insert, no retry', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'insert'
        ? { data: null, error: { code: '23505', message: 'duplicate key' } }
        : { data: [], error: null };
    expect(await speakAtTheFelt(bigPotHand(31))).toBe('hand_taken');
    expect(inserts('horse_table_talk_ledger')).toHaveLength(1);
    expect(inserts('table_chat')).toHaveLength(0);
  });

  it('never two horses in one hand: a split big pot produces one claim and one line', async () => {
    const split = bigPotHand(32, {
      winners: [
        { userId: HORSE_A, amount: 60 },
        { userId: HORSE_B, amount: 60 },
      ],
    });
    expect(await speakAtTheFelt(split)).toBe('spoken');
    expect(inserts('horse_table_talk_ledger')).toHaveLength(1);
    expect(inserts('table_chat')).toHaveLength(1);
    const who = inserts('table_chat')[0].payload!.user_id;
    expect([HORSE_A, HORSE_B]).toContain(who);
    // and the same hand picks the same horse again
    _resetTableTalkForTests();
    h.state.calls = [];
    expect(await speakAtTheFelt(split)).toBe('spoken');
    expect(inserts('table_chat')[0].payload!.user_id).toBe(who);
  });

  it('three lines in the last hour is the hourly cap: no claim', async () => {
    h.state.answers.horse_table_talk_ledger = (call) => {
      if (call.filters.some((f) => f[0] === 'eq' && f[1] === 'horse_id')) {
        const recent = (m: number) =>
          ledgerRow({ said_at: new Date(NOW - m * 60_000).toISOString(), table_id: 'other' });
        return { data: [recent(5), recent(20), recent(50)], error: null };
      }
      return { data: [], error: null };
    };
    expect(await speakAtTheFelt(bigPotHand(33))).toBe('hourly_cap');
    expect(inserts('horse_table_talk_ledger')).toHaveLength(0);
    expect(inserts('table_chat')).toHaveLength(0);
  });

  it('two lines in the hour and one older is not the cap', async () => {
    h.state.answers.horse_table_talk_ledger = (call) => {
      if (call.filters.some((f) => f[0] === 'eq' && f[1] === 'horse_id')) {
        const at = (m: number) =>
          ledgerRow({ said_at: new Date(NOW - m * 60_000).toISOString(), table_id: 'other' });
        return { data: [at(5), at(20), at(70)], error: null };
      }
      return { data: [], error: null };
    };
    expect(await speakAtTheFelt(bigPotHand(34))).toBe('spoken');
  });

  it('fewer than 12 hands since this horse last spoke at this table: no claim', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? { data: [ledgerRow({ hand_number: 1000, horse_id: HORSE_A })], error: null }
        : { data: [], error: null };
    // the table dealt hands 1001..1005 since; this hand is 1006 -> 6 hands since
    h.state.answers.hand_history = () => ({
      data: [1005, 1004, 1003, 1002, 1001].map((n) => ({ hand_number: n })),
      error: null,
    });
    expect(await speakAtTheFelt(bigPotHand(1006))).toBe('horse_too_soon');
    expect(inserts('horse_table_talk_ledger')).toHaveLength(0);
    const dealt = callsTo('hand_history')[0];
    expect(dealt.filters).toContainEqual(['eq', 'table_id', TABLE]);
    expect(dealt.filters).toContainEqual(['gt', 'hand_number', 1000]);
    expect(dealt.filters).toContainEqual(['lt', 'hand_number', 1006]);
  });

  it('twelve hands since this horse last spoke here is enough', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? { data: [ledgerRow({ hand_number: 1000, horse_id: HORSE_A })], error: null }
        : { data: [], error: null };
    h.state.answers.hand_history = () => ({
      data: Array.from({ length: 11 }, (_, i) => ({ hand_number: 1011 - i })),
      error: null,
    });
    expect(await speakAtTheFelt(bigPotHand(1050))).toBe('spoken');
  });

  it('the table cadence: a line by ANY horse within the last 4 hands at this table: no claim', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? { data: [ledgerRow({ hand_number: 2000, horse_id: HORSE_B })], error: null }
        : { data: [], error: null };
    h.state.answers.hand_history = () => ({
      data: [2002, 2001].map((n) => ({ hand_number: n })),
      error: null,
    });
    expect(await speakAtTheFelt(bigPotHand(2003))).toBe('table_too_soon');
    expect(inserts('horse_table_talk_ledger')).toHaveLength(0);
  });

  it('hand numbers are global: a far-away number is not far away in hands', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? { data: [ledgerRow({ hand_number: 2000, horse_id: HORSE_B })], error: null }
        : { data: [], error: null };
    // the whole fleet dealt 9,000 hands; this table dealt one
    h.state.answers.hand_history = () => ({ data: [{ hand_number: 7000 }], error: null });
    expect(await speakAtTheFelt(bigPotHand(11000))).toBe('table_too_soon');
  });

  it('a phrase this horse used within 24 h is not said again', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'horse_id')
        ? {
            data: [ledgerRow({ phrase_norm: 'nice pot potbb bb gg', table_id: 'other' })],
            error: null,
          }
        : { data: [], error: null };
    expect(await speakAtTheFelt(bigPotHand(40))).toBe('phrase_horse_24h');
    expect(inserts('horse_table_talk_ledger')).toHaveLength(0);
  });

  it('a phrase anyone used at this table within 2 h is not said again here', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? {
            data: [
              ledgerRow({
                phrase_norm: 'nice pot potbb bb gg',
                horse_id: HORSE_B,
                hand_number: 5,
                said_at: new Date(NOW - 90 * 60_000).toISOString(),
              }),
            ],
            error: null,
          }
        : { data: [], error: null };
    expect(await speakAtTheFelt(bigPotHand(41))).toBe('phrase_table_2h');
  });

  it('a muted horse writes nothing', async () => {
    h.state.answers.table_chat_mutes = () => ({ data: [{ id: 'm1' }], error: null });
    expect(await speakAtTheFelt(bigPotHand(42))).toBe('silenced');
    expect(inserts('horse_table_talk_ledger')).toHaveLength(0);
    expect(inserts('table_chat')).toHaveLength(0);
  });

  it('an unreadable ledger is a no, named, and writes nothing', async () => {
    h.state.answers.horse_table_talk_ledger = () => ({ data: null, error: { message: 'timeout' } });
    expect(await speakAtTheFelt(bigPotHand(43))).toBe('unreadable');
    expect(h.state.calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('a chat insert that fails leaves the claim and retries nothing', async () => {
    h.state.answers.table_chat = () => ({ data: null, error: { message: 'refused' } });
    expect(await speakAtTheFelt(bigPotHand(44))).toBe('lost_words');
    expect(inserts('horse_table_talk_ledger')).toHaveLength(1);
    expect(inserts('table_chat')).toHaveLength(1);
  });

  it('after a line, this process refuses the next hands at that table without a read', async () => {
    expect(await speakAtTheFelt(bigPotHand(50))).toBe('spoken');
    h.state.calls = [];
    expect(await speakAtTheFelt(bigPotHand(51))).toBe('table_too_soon');
    expect(h.state.calls).toEqual([]);
    // the gate is cached, so not even that is re-read inside the TTL
    for (const n of [52, 53]) expect(await speakAtTheFelt(bigPotHand(n))).toBe('table_too_soon');
    // the fourth hand after the line may speak again at the table, but the
    // same horse must wait twelve: the other horse takes it
    expect(
      await speakAtTheFelt(bigPotHand(54, { winners: [{ userId: HORSE_B, amount: 120 }] }))
    ).toBe('spoken');
    expect(inserts('table_chat')[0].payload!.user_id).toBe(HORSE_B);
  });

  it('a line never names a seated player: a username that collides with a word is refused', async () => {
    const named = bigPotHand(60, {
      seated: [
        seat(HORSE_A, 1, true),
        seat(HORSE_B, 2, true),
        seat(HUMAN, 3, false, { username: 'gg' }),
      ],
    });
    expect(await speakAtTheFelt(named)).toBe('unsafe_line');
    expect(h.state.calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('never throws: a broken input is reported, not raised', async () => {
    const broken = bigPotHand(61);
    (broken as { seated: unknown }).seated = null;
    await expect(speakAtTheFelt(broken)).resolves.toBe('unwritable');
  });
});

describe('greetArrival', () => {
  function arrival(handNumber: number, seated = roster(), arrivedUserId = HUMAN): ArrivalInput {
    return { table: table(), handNumber, arrivedUserId, arrivedSeat: 3, seated };
  }

  it('a horse seated fewer than 10 hands does not greet, and nothing is read', async () => {
    for (let n = 1; n < GREETER_MIN_HANDS_SEATED; n++) await speakAtTheFelt(quietHand(n));
    expect(await greetArrival(arrival(9))).toBe('no_speaker');
    expect(h.state.calls).toEqual([]);
  });

  it('after ten hands one seated horse greets the arrival, deterministically, and the arrival never speaks', async () => {
    const seatedBefore = [seat(HORSE_A, 1, true), seat(HORSE_B, 2, true)];
    for (let n = 1; n <= GREETER_MIN_HANDS_SEATED; n++)
      await speakAtTheFelt(quietHand(n, { seated: seatedBefore }));
    expect(await greetArrival(arrival(10, [...seatedBefore, seat(HUMAN, 3, false)]))).toBe(
      'spoken'
    );
    expect(inserts('table_chat')).toHaveLength(1);
    const chat = inserts('table_chat')[0].payload!;
    expect([HORSE_A, HORSE_B]).toContain(chat.user_id);
    expect(chat.message).toBe('welcome to the table seat 3, good luck');
    expect(inserts('horse_table_talk_ledger')[0].payload).toMatchObject({
      event: 'arrival',
      hand_number: 10,
    });
    // a horse that just arrived is not a greeter, even of a later arrival
    _resetTableTalkForTests();
    h.state.calls = [];
    for (let n = 1; n <= GREETER_MIN_HANDS_SEATED; n++)
      await speakAtTheFelt(quietHand(n, { seated: [seat(HORSE_A, 1, true)] }));
    expect(
      await greetArrival(arrival(10, [seat(HORSE_A, 1, true), seat(HORSE_B, 2, true)], HORSE_B))
    ).toBe('spoken');
    expect(inserts('table_chat')[0].payload!.user_id).toBe(HORSE_A);
  });

  it('with the gate closed the greeting costs the gate read and nothing else', async () => {
    h.state.gate = { engine: true, mode: false };
    for (let n = 1; n <= GREETER_MIN_HANDS_SEATED; n++) await speakAtTheFelt(quietHand(n));
    expect(await greetArrival(arrival(10))).toBe('gate_closed');
    expect(tablesTouched()).toEqual(GATE_TABLES);
  });

  it('a tournament table greets nobody', async () => {
    for (let n = 1; n <= GREETER_MIN_HANDS_SEATED; n++) await speakAtTheFelt(quietHand(n));
    expect(await greetArrival({ ...arrival(10), table: table({ isTournament: true }) })).toBe(
      'tournament'
    );
    expect(h.state.calls).toEqual([]);
  });
});
