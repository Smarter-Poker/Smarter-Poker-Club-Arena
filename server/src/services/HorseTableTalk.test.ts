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
    for (const name of ['select', 'eq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'order', 'limit']) {
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
  // The shared chat channel (HorseChatListener) opens through the same client.
  const channels: Array<{ on: unknown[] }> = [];
  const channel = () => {
    const rec = { on: [] as unknown[] };
    channels.push(rec);
    const ch = {
      on: (...args: unknown[]) => ((rec.on = args), ch),
      subscribe: () => ch,
    };
    return ch;
  };
  return {
    state,
    channels,
    supabase: {
      from: (t: string) => builder(t),
      channel,
      removeChannel: () => Promise.resolve(),
    },
  };
});

vi.mock('./supabase/client.js', () => ({ supabase: h.supabase }));
vi.mock('./errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String(e),
}));

import {
  BIG_POT_BB,
  GREETER_MIN_HANDS_SEATED,
  HORSE_LINES_PER_HOUR,
  HORSE_MIN_HANDS_BETWEEN_LINES,
  PHRASE_HORSE_WINDOW_MS,
  PHRASE_TABLE_WINDOW_MS,
  SPEAK_CHANCE_PCT,
  TABLE_MIN_HANDS_BETWEEN_LINES,
  _resetTableTalkForTests,
  _setSpeakChanceForTests,
  _setVoiceStylingForTests,
  _setAudienceForTests,
  STREAK_HANDS,
  speaksThisTime,
  chooseLine,
  detectEvents,
  fillLine,
  greetArrival,
  lineIndexFor,
  fitsTheHand,
  heardPhrases,
  replyKey,
  replyToPlayer,
  _setViewerProbesForTests,
  REPLIES_PER_TABLE_WINDOW,
  REPLY_MAX_AGE_MS,
  VIEWER_SEATS_LIMIT,
  type ReplyInput,
  normalizePhrase,
  pickCandidate,
  sanitizeLine,
  speakAtTheFelt,
  speakAsTheyShove,
  tableRefusal,
  voiceFor,
  type ArrivalInput,
  type TableTalkInput,
  type TalkSeat,
  type TalkTable,
} from './HorseTableTalk.js';
import { _resetTableTalkGateForTests } from './HorseTableTalkGate.js';
import { _resetChatListenerForTests, registerChatReplies } from './HorseChatListener.js';
import { LINE_NEEDS, LINES, TALK_EVENTS, TALK_VOICES } from './horseTableTalkLines.js';
import {
  _recordedBeatsForTests,
  _setHumanPacingForTests,
  humanBeatMs,
  TYPING_CPS,
  TYPING_MAX_MS,
  typingBeatMs,
  typingSpeedCps,
} from './horsePacing.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

function everyPoolLine(): Array<{
  event: (typeof TALK_EVENTS)[number];
  voice: (typeof TALK_VOICES)[number];
  line: string;
}> {
  return TALK_EVENTS.flatMap((event) =>
    TALK_VOICES.flatMap((voice) =>
      LINES[event][voice].lines.map((line) => ({ event, voice, line }))
    )
  );
}

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
  // The write path is tested with every qualifying horse speaking and no
  // human beat; the roll and the beat have their own tests below.
  _setSpeakChanceForTests(100);
  _setHumanPacingForTests(false);
  _setVoiceStylingForTests(false);
  _setAudienceForTests(() => true);
  h.state.calls = [];
  h.state.answers = {};
  h.state.gate = { engine: true, mode: true };
});

afterEach(() => {
  _setSpeakChanceForTests(null);
  _setHumanPacingForTests(true);
  _setVoiceStylingForTests(true);
  _setAudienceForTests(null);
  _setViewerProbesForTests(null);
  vi.useRealTimers();
});

// ─── pure: events, voice, line, door ─────────────────────────────────────────

describe('events are read off the captured hand', () => {
  it('a horse that wins a pot of 40 bb or more: big_pot_won with the pot and the street', () => {
    const c = detectEvents(bigPotHand(5));
    expect(c.map((x) => x.event)).toContain('big_pot_won');
    const win = c.find((x) => x.event === 'big_pot_won')!;
    expect(win.speakerId).toBe(HORSE_A);
    expect(win.facts).toEqual({ potBB: 60, street: 'river', showdown: true });
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
    expect(LINES.big_pot_won.needler.lines).toContain(a!.template);
    expect(a!.line).toBe(fillLine(a!.template, facts));
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
    // with only {hand} held, the chooser passes over every line that needs a street or a seat
    for (let hand = 1; hand <= 200; hand++) {
      const c = chooseLine('showdown_loss', 'friendly', HORSE_A, hand, { hand: 'two pair' })!;
      expect(c.template).not.toMatch(/\{(street|seat|potBB)\}/);
      expect(c.line).not.toContain('{');
    }
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
    expect(normalizePhrase('  GL  ')).toBe('good luck');
  });
  it('a phrase is what the player reads: the shorthand the styler swaps is the same phrase', () => {
    // horseVoiceStyle types "nice hand" as "nh" and "gl" as "good luck"; one horse's
    // "nh" and another's "nice hand" are the same line on the screen
    expect(normalizePhrase('nh')).toBe(normalizePhrase('nice hand'));
    expect(normalizePhrase('gl gl')).toBe(normalizePhrase('good luck good luck'));
    expect(normalizePhrase('ty ty')).toBe(normalizePhrase('thank you thank you'));
    expect(normalizePhrase("can't believe that got there")).toBe(
      normalizePhrase('cant believe that got there')
    );
    // idempotent: a ledger row written under the older identity folds the same way
    for (const { line } of everyPoolLine()) {
      expect(normalizePhrase(normalizePhrase(line))).toBe(normalizePhrase(line));
    }
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
    const expected = chooseLine('big_pot_won', 'friendly', HORSE_A, 30, {
      potBB: 60,
      street: 'river',
      showdown: true,
    })!;
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
      phrase_norm: normalizePhrase(expected.template),
    });
    const chat = inserts('table_chat')[0].payload!;
    expect(Object.keys(chat).sort()).toEqual(['message', 'message_type', 'table_id', 'user_id']);
    expect(chat).toEqual({
      table_id: TABLE,
      user_id: HORSE_A,
      message: expected.line,
      message_type: 'player',
    });
    // the reads before the claim: the horse's day, the table's day, where the
    // table's people are seated (their other tables' lines), the mute
    expect(tablesTouched()).toEqual(
      [
        'content_settings',
        'horse_post_modes',
        'horse_table_talk_ledger',
        'table_chat',
        'table_chat_mutes',
        'table_seats',
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

  it('the hourly cap: that many lines in the last hour, no claim', async () => {
    h.state.answers.horse_table_talk_ledger = (call) => {
      if (call.filters.some((f) => f[0] === 'eq' && f[1] === 'horse_id')) {
        const recent = (m: number) =>
          ledgerRow({ said_at: new Date(NOW - m * 60_000).toISOString(), table_id: 'other' });
        return {
          data: Array.from({ length: HORSE_LINES_PER_HOUR }, (_, i) => recent(5 + i * 8)),
          error: null,
        };
      }
      return { data: [], error: null };
    };
    expect(await speakAtTheFelt(bigPotHand(33))).toBe('hourly_cap');
    expect(inserts('horse_table_talk_ledger')).toHaveLength(0);
    expect(inserts('table_chat')).toHaveLength(0);
  });

  it('one short of the cap in the hour and one older is not the cap', async () => {
    h.state.answers.horse_table_talk_ledger = (call) => {
      if (call.filters.some((f) => f[0] === 'eq' && f[1] === 'horse_id')) {
        const at = (m: number) =>
          ledgerRow({ said_at: new Date(NOW - m * 60_000).toISOString(), table_id: 'other' });
        return {
          data: [
            ...Array.from({ length: HORSE_LINES_PER_HOUR - 1 }, (_, i) => at(5 + i * 8)),
            at(70),
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    };
    expect(await speakAtTheFelt(bigPotHand(34))).toBe('spoken');
  });

  it('fewer than the minimum hands since this horse last spoke at this table: no claim', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? { data: [ledgerRow({ hand_number: 1000, horse_id: HORSE_A })], error: null }
        : { data: [], error: null };
    // the table dealt (minimum - 2) hands since; this hand makes (minimum - 1)
    const between = HORSE_MIN_HANDS_BETWEEN_LINES - 2;
    const thisHand = 1000 + between + 1;
    h.state.answers.hand_history = () => ({
      data: Array.from({ length: between }, (_, i) => ({ hand_number: 1000 + between - i })),
      error: null,
    });
    expect(await speakAtTheFelt(bigPotHand(thisHand))).toBe('horse_too_soon');
    expect(inserts('horse_table_talk_ledger')).toHaveLength(0);
    const dealt = callsTo('hand_history')[0];
    expect(dealt.filters).toContainEqual(['eq', 'table_id', TABLE]);
    expect(dealt.filters).toContainEqual(['gt', 'hand_number', 1000]);
    expect(dealt.filters).toContainEqual(['lt', 'hand_number', thisHand]);
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

  it('the table cadence: a line by ANY horse within the table minimum: no claim', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? { data: [ledgerRow({ hand_number: 2000, horse_id: HORSE_B })], error: null }
        : { data: [], error: null };
    const between = TABLE_MIN_HANDS_BETWEEN_LINES - 2;
    h.state.answers.hand_history = () => ({
      data: Array.from({ length: between }, (_, i) => ({ hand_number: 2000 + between - i })),
      error: null,
    });
    expect(await speakAtTheFelt(bigPotHand(2000 + between + 1))).toBe('table_too_soon');
    expect(inserts('horse_table_talk_ledger')).toHaveLength(0);
  });

  it('hand numbers are global: a far-away number is not far away in hands', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? { data: [ledgerRow({ hand_number: 2000, horse_id: HORSE_B })], error: null }
        : { data: [], error: null };
    // the whole fleet dealt 9,000 hands; this table dealt none in between
    h.state.answers.hand_history = () => ({ data: [], error: null });
    expect(TABLE_MIN_HANDS_BETWEEN_LINES).toBeGreaterThan(1);
    expect(await speakAtTheFelt(bigPotHand(11000))).toBe('table_too_soon');
  });

  it('a phrase this horse used within 24 h is never chosen: it says a different line', async () => {
    const usual = chooseLine('big_pot_won', 'friendly', HORSE_A, 40, {
      potBB: 60,
      street: 'river',
      showdown: true,
    })!;
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'horse_id')
        ? {
            data: [
              ledgerRow({
                phrase_norm: normalizePhrase(usual.template),
                table_id: 'other',
                said_at: new Date(NOW - PHRASE_HORSE_WINDOW_MS + 60_000).toISOString(),
              }),
            ],
            error: null,
          }
        : { data: [], error: null };
    expect(await speakAtTheFelt(bigPotHand(40))).toBe('spoken');
    const claimed = inserts('horse_table_talk_ledger')[0].payload!.phrase_norm;
    expect(claimed).not.toBe(normalizePhrase(usual.template));
    expect(inserts('table_chat')[0].payload!.message).not.toBe(usual.line);
  });

  it('a phrase anyone used at this table inside the table window is never chosen here', async () => {
    // Dan 2026-10-24: two horses typed the same big-pot line 23 minutes apart.
    const usual = chooseLine('big_pot_won', 'friendly', HORSE_A, 1041, {
      potBB: 60,
      street: 'river',
      showdown: true,
    })!;
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? {
            data: [
              ledgerRow({
                phrase_norm: normalizePhrase(usual.template),
                horse_id: HORSE_B,
                hand_number: 1000,
                said_at: new Date(NOW - 23 * 60_000).toISOString(),
              }),
            ],
            error: null,
          }
        : { data: [], error: null };
    h.state.answers.hand_history = () => ({
      data: Array.from({ length: 11 }, (_, i) => ({ hand_number: 1040 - i })),
      error: null,
    });
    expect(PHRASE_TABLE_WINDOW_MS).toBeGreaterThanOrEqual(24 * 60 * 60_000);
    expect(await speakAtTheFelt(bigPotHand(1041))).toBe('spoken');
    const claimed = inserts('horse_table_talk_ledger')[0].payload!.phrase_norm;
    expect(claimed).not.toBe(normalizePhrase(usual.template));
  });

  it('when the table has heard every line of the voice, the horse says nothing rather than repeat', async () => {
    const spent = LINES.big_pot_won.friendly.lines.map((t, i) =>
      ledgerRow({
        phrase_norm: normalizePhrase(t),
        horse_id: HORSE_B,
        hand_number: 100 + i,
        said_at: new Date(NOW - 6 * 60 * 60_000).toISOString(),
      })
    );
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? { data: spent, error: null }
        : { data: [], error: null };
    expect(await speakAtTheFelt(bigPotHand(5000))).toBe('no_fresh_line');
    expect(h.state.calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('a history read that fills its cap could be missing a phrase: silence, never a guess', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? {
            data: Array.from({ length: 2_000 }, (_, i) =>
              ledgerRow({ horse_id: HORSE_B, hand_number: i, phrase_norm: `filler ${i}` })
            ),
            error: null,
          }
        : { data: [], error: null };
    expect(await speakAtTheFelt(bigPotHand(9000))).toBe('unreadable');
    expect(h.state.calls.filter((c) => c.op === 'insert')).toHaveLength(0);
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
    // the gate is cached, so not even that is re-read inside the TTL
    let n = 51;
    for (; n < 50 + TABLE_MIN_HANDS_BETWEEN_LINES; n++) {
      expect(await speakAtTheFelt(bigPotHand(n))).toBe('table_too_soon');
    }
    expect(h.state.calls).toEqual([]);
    // the same horse must wait its own minimum
    expect(await speakAtTheFelt(bigPotHand(n))).toBe('horse_too_soon');
    // and the table may hear the other horse
    expect(
      await speakAtTheFelt(bigPotHand(n + 1, { winners: [{ userId: HORSE_B, amount: 120 }] }))
    ).toBe('spoken');
    expect(inserts('table_chat')[0].payload!.user_id).toBe(HORSE_B);
  });

  it('a line never names a seated player: a username that collides with a word is refused', async () => {
    const line = chooseLine('big_pot_won', 'friendly', HORSE_A, 60, {
      potBB: 60,
      street: 'river',
      showdown: true,
    })!.line;
    const word = line.split(/[^a-z]+/i).find((w) => w.length >= 2)!;
    const named = bigPotHand(60, {
      seated: [
        seat(HORSE_A, 1, true),
        seat(HORSE_B, 2, true),
        seat(HUMAN, 3, false, { username: word }),
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

  it('a silent greeter stays silent even when the arriving player would talk', async () => {
    _setSpeakChanceForTests(null);
    const silent = '44444444-4444-4444-8444-444444444444';
    const seated = [seat(silent, 1, true)];
    for (let n = 1; n <= GREETER_MIN_HANDS_SEATED; n++)
      await speakAtTheFelt(quietHand(n, { seated }));
    h.state.calls = [];
    for (let n = 10; n < 110; n++) {
      expect(await greetArrival(arrival(n, [...seated, seat(HUMAN, 3, false)]))).toBe('no_event');
    }
    expect(h.state.calls).toEqual([]);
  });

  it('a silent horse never writes a shove line through the alternate entry point', async () => {
    _setSpeakChanceForTests(null);
    const horse = seat('44444444-4444-4444-8444-444444444444', 1, true);
    for (let n = 1; n <= 50; n++) {
      expect(
        await speakAsTheyShove({ table: table(), handNumber: n, horse, seated: [horse] })
      ).toBe('no_event');
    }
    expect(inserts('table_chat')).toEqual([]);
    expect(inserts('horse_table_talk_ledger')).toEqual([]);
  });

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
    const greetings = TALK_VOICES.flatMap((v) =>
      LINES.arrival[v].lines.map((t) => fillLine(t, { seat: 3 }))
    );
    expect(greetings).toContain(chat.message);
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

describe('a horse speaks sometimes, never every time (Dan 2026-10-21)', () => {
  it('ordinary hands qualify: any showdown loss is pot_lost, any won pot is pot_won', () => {
    const lost = quietHand(70, {
      winners: [{ userId: HUMAN, amount: 10 }],
      showdownResults: [
        { userId: HUMAN, handRanking: 2, handName: 'Pair' },
        { userId: HORSE_A, handRanking: 1, handName: 'High Card' },
      ],
    });
    const c = detectEvents(lost);
    expect(c).toContainEqual({
      event: 'pot_lost',
      speakerId: HORSE_A,
      facts: { street: 'flop', seat: 3 },
    });
    const won = quietHand(71, { winners: [{ userId: HORSE_B, amount: 10 }] });
    expect(detectEvents(won).map((x) => [x.event, x.speakerId])).toContainEqual([
      'pot_won',
      HORSE_B,
    ]);
  });

  it('the roll is a hash: the same hand answers the same way, and across the fleet the rate is near the table', () => {
    _setSpeakChanceForTests(null);
    for (const event of ['pot_lost', 'pot_won', 'all_in'] as const) {
      let yes = 0;
      let n = 0;
      const perHorse: number[] = [];
      for (let h = 0; h < 200; h++) {
        const horse = `horse-${h}`;
        let mine = 0;
        for (let hand = 1; hand <= 200; hand++) {
          const a = speaksThisTime(event, horse, TABLE, hand);
          expect(speaksThisTime(event, horse, TABLE, hand)).toBe(a);
          if (a) {
            yes++;
            mine++;
          }
          n++;
        }
        perHorse.push(mine);
      }
      const pct = (yes / n) * 100;
      // Silent personas and restrained active personas keep the fleet below the base.
      expect(pct).toBeGreaterThan(SPEAK_CHANCE_PCT[event] * 0.2);
      expect(pct).toBeLessThan(SPEAK_CHANCE_PCT[event] * 0.6);
      // and horses differ: the chattiest speaks far more than the quietest
      expect(Math.max(...perHorse)).toBeGreaterThan(2 * Math.min(...perHorse) + 1);
    }
  });

  it('with the real roll most ordinary losses stay silent, and nothing is read for them', async () => {
    _setSpeakChanceForTests(null);
    let spoke = 0;
    let silent = 0;
    for (let hand = 100; hand < 160; hand++) {
      const input = quietHand(hand, {
        winners: [{ userId: HUMAN, amount: 10 }],
        showdownResults: [
          { userId: HUMAN, handRanking: 2, handName: 'Pair' },
          { userId: HORSE_A, handRanking: 1, handName: 'High Card' },
        ],
        seated: [seat(HORSE_A, 1, true), seat(HUMAN, 3, false)],
      });
      if (speaksThisTime('pot_lost', HORSE_A, TABLE, hand)) spoke++;
      else {
        silent++;
        // a fresh table each hand, so no losing streak turns this into tilt
        _resetTableTalkForTests();
        h.state.calls = [];
        expect(await speakAtTheFelt(input)).toBe('no_event');
        expect(h.state.calls).toEqual([]);
      }
    }
    expect(silent).toBeGreaterThan(spoke);
  });

  it('a line lands a human beat after the hand: never instant, spread across a range', () => {
    const beats = Array.from({ length: 200 }, (_, i) =>
      typingBeatMs({ key: `k${i}`, horseId: `horse-${i}`, text: 'gg', kind: 'typed' })
    );
    expect(Math.min(...beats)).toBeGreaterThanOrEqual(1_500);
    expect(Math.max(...beats)).toBeLessThan(6_000);
    expect(new Set(beats).size).toBeGreaterThan(150);
    // the tap and shove beats for throws are unchanged
    const quick = Array.from({ length: 200 }, (_, i) => humanBeatMs(`k${i}`, 'quick'));
    expect(Math.max(...quick)).toBeLessThan(900);
  });
});

describe('who is listening, and how the night is going', () => {
  it('with nobody watching, most hands that would have a line stay silent and read nothing', async () => {
    _setAudienceForTests(() => false);
    let silent = 0;
    let spoken = 0;
    for (let n = 3000; n < 3100; n++) {
      _resetTableTalkForTests();
      h.state.calls = [];
      const out = await speakAtTheFelt(bigPotHand(n));
      if (out === 'no_audience') {
        silent++;
        expect(inserts('table_chat')).toHaveLength(0);
      } else spoken++;
    }
    expect(silent).toBeGreaterThan(75);
    expect(spoken).toBeGreaterThan(0);
  });

  it('a horse that loses showdown after showdown says it as tilt', async () => {
    const lost = (n: number) =>
      quietHand(n, {
        winners: [{ userId: HUMAN, amount: 10 }],
        showdownResults: [
          { userId: HUMAN, handRanking: 2, handName: 'Pair' },
          { userId: HORSE_A, handRanking: 1, handName: 'High Card' },
        ],
        seated: [seat(HORSE_A, 1, true), seat(HUMAN, 3, false)],
      });
    // the first hands build the streak; the gate and limits are not the point here
    h.state.gate = { engine: true, mode: false };
    for (let n = 1; n < STREAK_HANDS; n++) await speakAtTheFelt(lost(4000 + n));
    _resetTableTalkGateForTests();
    h.state.gate = { engine: true, mode: true };
    h.state.calls = [];
    expect(await speakAtTheFelt(lost(4000 + STREAK_HANDS))).toBe('spoken');
    expect(inserts('horse_table_talk_ledger')[0].payload).toMatchObject({ event: 'tilt' });
  });
});

describe('LAW: a table never hears the same line twice (Dan 2026-10-24)', () => {
  // "HORSES CAN NEVER EVER EVER BE REPEATING THE SAME LINES ... INSIDE OF CHAT!
  // ... THIS IS SCREAMING I AM A BOT!!" Two horses typed "N bb on the river,
  // somebody wanted to see my cards" 23 minutes apart at one table.
  const FULL = { potBB: 52, street: 'river' as const, hand: 'full house', seat: 7 };
  const FLEET = [
    HORSE_A,
    HORSE_B,
    '33333333-3333-4333-8333-333333333333',
    '55555555-5555-4555-8555-555555555555',
  ];

  it('every cell of the pool is deep enough that a voice is never stuck on one sentence', () => {
    for (const event of TALK_EVENTS) {
      for (const voice of TALK_VOICES) {
        const ids = new Set(LINES[event][voice].lines.map(normalizePhrase));
        expect(
          ids.size,
          `${event}/${voice} has only ${ids.size} distinct phrases`
        ).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it('horses taking turns at one table never repeat a phrase until the voice is spent, then fall silent', () => {
    for (const facts of [
      { ...FULL, showdown: true },
      { ...FULL, showdown: false },
    ]) {
      for (const event of TALK_EVENTS) {
        for (const voice of TALK_VOICES) {
          const heard = new Set<string>();
          const fitting = LINES[event][voice].lines.filter((t) => fitsTheHand(t, facts));
          const distinct = new Set(fitting.map(normalizePhrase)).size;
          let said = 0;
          for (let turn = 0; turn < distinct + 5; turn++) {
            const horse = FLEET[turn % FLEET.length];
            const c = chooseLine(event, voice, horse, 7000 + turn * 13, facts, heard);
            if (!c) break;
            const id = normalizePhrase(c.template);
            expect(heard.has(id), `${event}/${voice} repeated "${c.template}"`).toBe(false);
            heard.add(id);
            said++;
          }
          expect(said).toBe(distinct);
          expect(chooseLine(event, voice, HORSE_A, 99_999, facts, heard)).toBeNull();
        }
      }
    }
  });

  it('the ledger rows a table holds become the phrases it has heard, inside the windows only', () => {
    const recent = ledgerRow({
      phrase_norm: 'nh',
      said_at: new Date(NOW - 23 * 60_000).toISOString(),
    });
    const stale = ledgerRow({
      phrase_norm: 'stale line',
      said_at: new Date(NOW - PHRASE_TABLE_WINDOW_MS - 60_000).toISOString(),
    });
    const heard = heardPhrases({ horseRows: [], tableRows: [recent, stale] as never }, NOW);
    expect(heard.has(normalizePhrase('nice hand'))).toBe(true);
    expect(heard.has('stale line')).toBe(false);
  });
});

describe('a line is true of the hand it follows (Dan 2026-10-24)', () => {
  // "somebody wanted to see my cards" after a hand nobody called is a script, not a person.
  const WON: Array<'big_pot_won' | 'pot_won'> = ['big_pot_won', 'pot_won'];

  it('every tagged line exists in a pool, and only in an event that knows whether it was shown down', () => {
    const where = new Map<string, string[]>();
    for (const { event, line } of everyPoolLine()) {
      where.set(line, [...(where.get(line) ?? []), event]);
    }
    for (const t of Object.keys(LINE_NEEDS)) {
      expect(where.has(t), `LINE_NEEDS names "${t}", which is in no pool`).toBe(true);
      for (const e of where.get(t)!) expect(WON, `"${t}" is tagged but lives in ${e}`).toContain(e);
    }
  });

  it('either way a pot is won, every voice still has plenty to say', () => {
    for (const event of WON) {
      for (const voice of TALK_VOICES) {
        const lines = LINES[event][voice].lines;
        const calledDown = lines.filter((t) => fitsTheHand(t, { showdown: true }));
        const foldedOut = lines.filter((t) => fitsTheHand(t, { showdown: false }));
        expect(calledDown.length, `${event}/${voice} after a showdown`).toBeGreaterThanOrEqual(6);
        expect(foldedOut.length, `${event}/${voice} after a fold`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('the chooser never says a showdown line after a fold, nor a fold line after a showdown', () => {
    const FLEET = [HORSE_A, HORSE_B, '33333333-3333-4333-8333-333333333333'];
    for (const event of WON) {
      for (const voice of TALK_VOICES) {
        for (let hand = 1; hand <= 300; hand++) {
          const horse = FLEET[hand % FLEET.length];
          const folded = chooseLine(event, voice, horse, hand, {
            potBB: 60,
            street: 'flop',
            showdown: false,
          })!;
          expect(LINE_NEEDS[folded.template], `${event}/${voice} "${folded.template}"`).not.toBe(
            'showdown'
          );
          const called = chooseLine(event, voice, horse, hand, {
            potBB: 60,
            street: 'river',
            showdown: true,
          })!;
          expect(LINE_NEEDS[called.template], `${event}/${voice} "${called.template}"`).not.toBe(
            'no_showdown'
          );
        }
      }
    }
  });

  it('an event that does not say whether it was shown down uses neither kind of tagged line', () => {
    for (const t of Object.keys(LINE_NEEDS)) expect(fitsTheHand(t, {})).toBe(false);
    expect(fitsTheHand('gg', {})).toBe(true);
  });

  it('detectEvents marks a called-down pot as a showdown and a fold-out as not', () => {
    const called = detectEvents(bigPotHand(70)).filter((c) => c.speakerId === HORSE_A);
    for (const c of called.filter((c) => c.event === 'big_pot_won' || c.event === 'pot_won')) {
      expect(c.facts.showdown).toBe(true);
    }
    const folded = detectEvents(
      bigPotHand(71, { showdownResults: [], communityCards: ['Ah', 'Kd', '2c'] })
    ).filter((c) => c.speakerId === HORSE_A);
    expect(folded.map((c) => c.event)).toContain('big_pot_won');
    for (const c of folded.filter((c) => c.event === 'big_pot_won' || c.event === 'pot_won')) {
      expect(c.facts.showdown).toBe(false);
    }
  });
});

// ─── answering a player (2026-10-24) ─────────────────────────────────────────

const CHAT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OTHER2 = '33333333-3333-4333-8333-333333333333';
const RAIL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function remark(
  message: string,
  over: Partial<ReplyInput['chat']> = {},
  seated = roster()
): ReplyInput {
  return {
    table: table(),
    handNumber: 500,
    seated,
    chat: { id: CHAT_ID, userId: HUMAN, message, createdAt: new Date(NOW).toISOString(), ...over },
  };
}

const allLinesOf = (event: (typeof TALK_EVENTS)[number]) =>
  TALK_VOICES.flatMap((v) => LINES[event][v].lines);

describe('replyToPlayer: a horse answers a person, sometimes', () => {
  it('"nice hand" to the horse that just won is answered by that horse, keyed to the remark', async () => {
    await speakAtTheFelt(bigPotHand(499));
    h.state.calls = [];
    expect(await replyToPlayer(remark('Nice Hand'))).toBe('spoken');
    const claim = inserts('horse_table_talk_ledger')[0].payload!;
    expect(claim).toMatchObject({
      table_id: TABLE,
      horse_id: HORSE_A,
      event: 'reply_thanks',
      hand_number: replyKey(CHAT_ID),
    });
    const chat = inserts('table_chat')[0].payload!;
    expect(chat.user_id).toBe(HORSE_A);
    expect(allLinesOf('reply_thanks').map((t) => fillLine(t, {}))).toContain(chat.message);
    expect(Object.keys(chat).sort()).toEqual(['message', 'message_type', 'table_id', 'user_id']);
  });

  it('"unlucky" goes to the horse that lost the last showdown, not the winner', async () => {
    await speakAtTheFelt(
      bigPotHand(499, {
        showdownResults: [
          { userId: HORSE_A, handRanking: 3, handName: 'Two Pair' },
          { userId: HORSE_B, handRanking: 2, handName: 'Pair' },
        ],
      })
    );
    h.state.calls = [];
    expect(await replyToPlayer(remark('Unlucky'))).toBe('spoken');
    expect(inserts('horse_table_talk_ledger')[0].payload).toMatchObject({
      horse_id: HORSE_B,
      event: 'reply_sympathy',
    });
  });

  it('a remark aimed at nobody a horse can be is not answered', async () => {
    // the human won the last hand: "nh" is to the human, not to a horse
    await speakAtTheFelt(quietHand(499));
    h.state.calls = [];
    expect(await replyToPlayer(remark('nice hand'))).toBe('no_speaker');
    expect(h.state.calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('a horse named in the line answers, whoever won', async () => {
    const seated = [
      seat(HORSE_A, 1, true),
      seat(HORSE_B, 2, true, { username: 'Ingrid' }),
      seat(HUMAN, 3, false),
    ];
    expect(await replyToPlayer(remark('Hey Ingrid', {}, seated))).toBe('spoken');
    expect(inserts('table_chat')[0].payload!.user_id).toBe(HORSE_B);
    expect(inserts('horse_table_talk_ledger')[0].payload!.event).toBe('reply_hello');
  });

  it('"are you a bot" and its kin are never answered, and nothing is read or written', async () => {
    for (const line of ['Trey, you real?', 'are you a bot', 'this is rigged', 'hey ai']) {
      h.state.calls = [];
      expect(await replyToPlayer(remark(line))).toBe('no_event');
      expect(h.state.calls).toEqual([]);
    }
  });

  it('a horse never answers a horse (its own engine-written line comes back on the channel)', async () => {
    expect(await replyToPlayer(remark('nice hand', { userId: HORSE_A }))).toBe('no_speaker');
    expect(h.state.calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('only someone who can see the table is answered: seated, or watching it here', async () => {
    expect(await replyToPlayer(remark('hi all', { userId: RAIL }))).toBe('no_speaker');
    _setViewerProbesForTests((t) => (t === TABLE ? [RAIL] : []));
    expect(await replyToPlayer(remark('hi all', { userId: RAIL }))).toBe('spoken');
  });

  it('a remark the engine hears late (a replayed row) is not answered', async () => {
    const old = new Date(NOW - REPLY_MAX_AGE_MS - 1_000).toISOString();
    expect(await replyToPlayer(remark('hi all', { createdAt: old }))).toBe('no_event');
  });

  it('a tournament table answers nobody', async () => {
    expect(await replyToPlayer({ ...remark('hi all'), table: table({ isTournament: true }) })).toBe(
      'tournament'
    );
  });

  it('a table hears at most a few replies in a window', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? {
            data: Array.from({ length: REPLIES_PER_TABLE_WINDOW }, (_, i) =>
              ledgerRow({
                hand_number: -(100 + i),
                horse_id: HORSE_B,
                phrase_norm: `earlier reply ${i}`,
                said_at: new Date(NOW - (i + 1) * 60_000).toISOString(),
              })
            ),
            error: null,
          }
        : { data: [], error: null };
    expect(await replyToPlayer(remark('hi all'))).toBe('reply_too_soon');
    expect(inserts('table_chat')).toHaveLength(0);
  });

  it('a reply answers a person, so the hand cadence does not hold it back', async () => {
    // a horse line on this very hand, a moment ago
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? {
            data: [
              ledgerRow({
                hand_number: 500,
                horse_id: HORSE_B,
                said_at: new Date(NOW - 5_000).toISOString(),
              }),
            ],
            error: null,
          }
        : { data: [], error: null };
    expect(await replyToPlayer(remark('hi all'))).toBe('spoken');
  });

  it('the hand cadence reads hand lines only: a newer reply row cannot hide a recent hand line', async () => {
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'eq' && f[1] === 'table_id')
        ? {
            data: [
              ledgerRow({
                hand_number: -12345,
                horse_id: HORSE_B,
                said_at: new Date(NOW - 1_000).toISOString(),
              }),
              ledgerRow({
                hand_number: 2000,
                horse_id: HORSE_B,
                said_at: new Date(NOW - 60_000).toISOString(),
              }),
            ],
            error: null,
          }
        : { data: [], error: null };
    // this table dealt hands 1990..2000 and nothing since the hand line at
    // 2000; the answer honours the query's lower bound, as the database would
    h.state.answers.hand_history = (call) => {
      const gt = call.filters.find((f) => f[0] === 'gt' && f[1] === 'hand_number');
      const from = gt ? Number(gt[2]) : -Infinity;
      return {
        data: Array.from({ length: 11 }, (_, i) => ({ hand_number: 2000 - i })).filter(
          (r) => r.hand_number > from
        ),
        error: null,
      };
    };
    expect(await speakAtTheFelt(bigPotHand(2001))).toBe('table_too_soon');
  });

  it('replyKey is negative, stable, and distinct per remark', () => {
    expect(replyKey(CHAT_ID)).toBeLessThan(0);
    expect(replyKey(CHAT_ID)).toBe(replyKey(CHAT_ID));
    expect(replyKey(CHAT_ID)).not.toBe(replyKey(OTHER));
    expect(replyKey('not-a-uuid')).toBeLessThan(0);
    expect(Number.isSafeInteger(replyKey('ffffffff-ffff-4fff-8fff-ffffffffffff'))).toBe(true);
  });
});

describe('a line one person can see is spent at every table they can see (2026-10-24)', () => {
  const seatedAt = (tables: string[]) => () => ({
    data: tables.map((table_id) => ({ table_id })),
    error: null,
  });

  it('a seated player also at another table: a phrase said there is not said here', async () => {
    const usual = chooseLine('big_pot_won', 'friendly', HORSE_A, 40, {
      potBB: 60,
      street: 'river',
      showdown: true,
    })!;
    h.state.answers.table_seats = seatedAt([TABLE, OTHER]);
    h.state.answers.horse_table_talk_ledger = (call) =>
      call.op === 'select' && call.filters.some((f) => f[0] === 'in' && f[1] === 'table_id')
        ? {
            data: [
              ledgerRow({
                table_id: OTHER,
                phrase_norm: normalizePhrase(usual.template),
                said_at: new Date(NOW - 60_000).toISOString(),
              }),
            ],
            error: null,
          }
        : { data: [], error: null };
    expect(await speakAtTheFelt(bigPotHand(40))).toBe('spoken');
    expect(inserts('horse_table_talk_ledger')[0].payload!.phrase_norm).not.toBe(
      normalizePhrase(usual.template)
    );
    const seatRead = callsTo('table_seats')[0];
    expect(seatRead.filters).toContainEqual(['in', 'user_id', [HUMAN]]);
    expect(seatRead.filters).toContainEqual(['is', 'left_at', null]);
    const viewerRead = callsTo('horse_table_talk_ledger').find((c) =>
      c.filters.some((f) => f[0] === 'in' && f[1] === 'table_id')
    )!;
    expect(viewerRead.filters).toContainEqual(['in', 'table_id', [OTHER]]);
  });

  it('a table a player is only watching here counts too', async () => {
    _setViewerProbesForTests(
      (t) => (t === TABLE ? [RAIL] : []),
      (ids) => (ids.has(RAIL) ? [TABLE, OTHER2] : [])
    );
    await speakAtTheFelt(bigPotHand(41));
    const viewerRead = callsTo('horse_table_talk_ledger').find((c) =>
      c.filters.some((f) => f[0] === 'in' && f[1] === 'table_id')
    )!;
    expect(viewerRead.filters).toContainEqual(['in', 'table_id', [OTHER2]]);
    expect(callsTo('table_seats')[0].filters).toContainEqual(['in', 'user_id', [RAIL, HUMAN]]);
  });

  it('nobody who could read it: no seat read and no viewer read', async () => {
    const horsesOnly = [seat(HORSE_A, 1, true), seat(HORSE_B, 2, true)];
    expect(await speakAtTheFelt(bigPotHand(42, { seated: horsesOnly }))).toBe('spoken');
    expect(callsTo('table_seats')).toHaveLength(0);
  });

  it('a seat read that fills its cap could be missing a table: silence, never a guess', async () => {
    h.state.answers.table_seats = () => ({
      data: Array.from({ length: VIEWER_SEATS_LIMIT }, () => ({ table_id: OTHER })),
      error: null,
    });
    expect(await speakAtTheFelt(bigPotHand(43))).toBe('unreadable');
    expect(h.state.calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });
});

describe('end to end: a player types, the realtime row arrives, a horse answers', () => {
  afterEach(() => _resetChatListenerForTests());

  it('the channel callback reaches the real reply path and writes the claim and the chat row', async () => {
    _resetChatListenerForTests();
    const players = [
      {
        user_id: HORSE_A,
        username: 'plate1',
        seat_number: 1,
        is_horse: true,
        horse_profile: { style: 'balanced' },
      },
      { user_id: HUMAN, username: 'danny', seat_number: 3, is_horse: false },
    ];
    registerChatReplies(TABLE, {}, () => ({
      tableInfo: {
        id: TABLE,
        big_blind: 2,
        max_players: 9,
        ban_chat: false,
        game_variant: 'nlh',
      } as never,
      seatedPlayers: players as never,
      handCount: 600,
      isTournament: false,
    }));
    const opened = h.channels[h.channels.length - 1];
    expect(opened.on[1]).toMatchObject({ table: 'table_chat', event: 'INSERT' });
    const callback = opened.on[2] as (p: unknown) => void;
    callback({
      new: {
        id: CHAT_ID,
        table_id: TABLE,
        user_id: HUMAN,
        message: 'YOU GUYS PLAY HERE EVERY NIGHT?! LOL',
        message_type: 'player',
        created_at: new Date(NOW).toISOString(),
      },
    });
    await vi.waitFor(() => expect(inserts('table_chat')).toHaveLength(1));
    expect(inserts('horse_table_talk_ledger')[0].payload).toMatchObject({
      table_id: TABLE,
      horse_id: HORSE_A,
      event: 'reply_regular',
      hand_number: replyKey(CHAT_ID),
    });
    const chat = inserts('table_chat')[0].payload!;
    expect(chat.user_id).toBe(HORSE_A);
    expect(allLinesOf('reply_regular')).toContain(chat.message);
  });
});

describe('talk rates, retuned for deep pools (2026-10-24)', () => {
  it('the rare hand events speak more than they did on one line, and every rate stays a sometimes', () => {
    expect(SPEAK_CHANCE_PCT.big_pot_won).toBeGreaterThan(20);
    expect(SPEAK_CHANCE_PCT.showdown_loss).toBeGreaterThan(25);
    expect(SPEAK_CHANCE_PCT.big_hand_shown).toBeGreaterThan(20);
    for (const event of TALK_EVENTS) {
      expect(SPEAK_CHANCE_PCT[event], event).toBeGreaterThan(0);
      expect(SPEAK_CHANCE_PCT[event], event).toBeLessThanOrEqual(60);
    }
    // the hourly ceiling is unchanged: deeper pools do not make a horse chattier per hour
    expect(HORSE_LINES_PER_HOUR).toBe(6);
  });
});

describe('a sentence takes as long to arrive as a person needs to type it (Dan 2026-10-24)', () => {
  // "THEY CAN'T FIRE OFF FULL SENTENCES RIGHT AFTER A HAND IS OVER"
  const FLEET = Array.from({ length: 300 }, (_, i) => `horse-${i}`);
  const SCREENSHOT = `46 bb on the river, somebody wanted to see my cards ${String.fromCodePoint(0x1f60f, 0x1f44d)}`;

  it('the line from the screenshot never lands in under 10 seconds, even for the fastest typist', () => {
    for (const horseId of FLEET) {
      const ms = typingBeatMs({ key: `${horseId}|1`, horseId, text: SCREENSHOT, kind: 'typed' });
      expect(ms, horseId).toBeGreaterThanOrEqual(10_000);
      expect(ms).toBeLessThanOrEqual(TYPING_MAX_MS.typed);
    }
  });

  it('every typed line takes at least its characters at the fastest speed, plus noticing', () => {
    const fastest = TYPING_CPS[1] * 1.2;
    for (const { line } of everyPoolLine()) {
      const text = fillLine(line, { potBB: 52, street: 'river', hand: 'full house', seat: 7 })!;
      for (const horseId of FLEET.slice(0, 20)) {
        const ms = typingBeatMs({ key: `${horseId}|${text}`, horseId, text, kind: 'typed' });
        expect(ms).toBeGreaterThanOrEqual(1_500 + Math.floor((text.length / fastest) * 1_000));
      }
    }
  });

  it('a longer line always takes longer for the same horse and moment', () => {
    for (const horseId of FLEET.slice(0, 50)) {
      const at = (text: string) => typingBeatMs({ key: 'same', horseId, text, kind: 'typed' });
      expect(at('nice hand')).toBeLessThan(at('nice hand, you got me there'));
      expect(at('nice hand, you got me there')).toBeLessThan(
        at('ran two pair into a bigger one on the river, well played seat 4')
      );
    }
  });

  it('emoji cost a trip to the picker', () => {
    const plain = typingBeatMs({ key: 'k', horseId: 'h', text: 'gg', kind: 'typed' });
    const withEmoji = typingBeatMs({
      key: 'k',
      horseId: 'h',
      text: `gg ${String.fromCodePoint(0x1f602)}`,
      kind: 'typed',
    });
    expect(withEmoji - plain).toBeGreaterThanOrEqual(800);
  });

  it('a reply waits to read what was said first', () => {
    const base = { key: 'k', horseId: 'h', text: 'ty', kind: 'typed' as const };
    expect(typingBeatMs({ ...base, readChars: 40 }) - typingBeatMs(base)).toBe(2_000);
    expect(typingBeatMs({ ...base, readChars: 10_000 }) - typingBeatMs(base)).toBe(4_000);
  });

  it('every horse has its own typing speed, the same on every line', () => {
    const speeds = FLEET.map(typingSpeedCps);
    expect(new Set(speeds.map((v) => v.toFixed(3))).size).toBeGreaterThan(270);
    for (const v of speeds) {
      expect(v).toBeGreaterThanOrEqual(TYPING_CPS[0]);
      expect(v).toBeLessThan(TYPING_CPS[1]);
    }
    expect(typingSpeedCps('horse-7')).toBe(typingSpeedCps('horse-7'));
  });

  it('a line said as a horse shoves is quicker, never instant', () => {
    const quick = typingBeatMs({ key: 'k', horseId: 'h', text: 'good luck', kind: 'quick' });
    const typed = typingBeatMs({ key: 'k', horseId: 'h', text: 'good luck', kind: 'typed' });
    expect(quick).toBeLessThan(typed);
    expect(quick).toBeGreaterThanOrEqual(300 + 1_000 * (9 / (TYPING_CPS[1] * 1.2 * 1.25)));
  });

  it('the write path waits on the exact line it writes, styling included', async () => {
    _setVoiceStylingForTests(true);
    _setHumanPacingForTests(false);
    expect(await speakAtTheFelt(bigPotHand(4040))).toBe('spoken');
    const written = String(inserts('table_chat')[0].payload!.message);
    const beats = _recordedBeatsForTests();
    expect(beats).toHaveLength(1);
    expect(beats[0]).toBe(
      typingBeatMs({
        key: `${HORSE_A}|4040|big_pot_won`,
        horseId: HORSE_A,
        text: written,
        kind: 'typed',
      })
    );
  });

  it('a reply waits on its own line plus reading the remark', async () => {
    _setHumanPacingForTests(false);
    await speakAtTheFelt(bigPotHand(499));
    h.state.calls = [];
    _setHumanPacingForTests(false);
    const message = 'NICE BALUE BET CAPTAIN';
    expect(await replyToPlayer(remark(message))).toBe('spoken');
    const written = String(inserts('table_chat')[0].payload!.message);
    expect(_recordedBeatsForTests()[0]).toBe(
      typingBeatMs({
        key: `${HORSE_A}|${replyKey(CHAT_ID)}|reply_thanks`,
        horseId: HORSE_A,
        text: written,
        kind: 'typed',
        readChars: message.length,
      })
    );
  });
});
