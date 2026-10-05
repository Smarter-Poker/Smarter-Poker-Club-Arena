/**
 * A SEAT THAT CLOSES A STREET IS HANDED THE NEXT ONE - WHAT THE ENGINE SENDS.
 *
 * Dan, 2026-10-04, after a human-versus-human match: "MY HUMAN OPPONENT [WAS]
 * CONSTANTLY BEING TIMED OUT OR DISCONNECTED." The opponent was the big blind
 * heads-up. Each time he called to close a street he was first to act on the
 * next, and his page showed no action bar: it refused, for 1500ms, every frame
 * naming the seat that had just acted, and the engine arms the next street
 * 500ms after dealing it. Two changes made that, a month apart and in two
 * places: this engine's street beat was cut to 500ms (2026-09-07) and the page
 * extended its refusal to turn_change (2026-09-09). Nothing bound the two.
 *
 * This file is that binding, from the engine's side. It plays one heads-up
 * hand on the real ServerTableEngine, HandController and TableStateHub, with a
 * subscriber where a browser would be, and holds two things:
 *
 *   1. THE FACTS THE PAGE'S RULE READS (src/lib/heroActedFence.ts). After a
 *      seat's own action closes a street, the engine goes on naming that seat
 *      on the turn clock it already had; the next street is armed by a later
 *      frame on a NEWER clock; and the turn_change that follows carries the
 *      decision context of that new turn.
 *   2. THE RECORDED WIRE IS STILL WHAT THE ENGINE SENDS. The same hand is
 *      committed, frame for frame, at tests/live-turn/wire/. The page's rule
 *      is tested against that recording (tests/unit/
 *      aSeatThatClosesAStreetIsShownItsTurn.test.ts) and the built app is
 *      played it in a browser (tests/live-turn/). If this engine's frames
 *      change shape, this test fails and says how to record them again, so
 *      the page is re-proved against what the engine does now.
 *
 * To record:  WRITE_LIVE_TURN_WIRE=1 npx vitest run \
 *               src/engine/aSeatThatClosesAStreetIsHandedTheNext.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import jsonPatch from 'fast-json-patch';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { TableStateHub } from '../transport/TableStateHub.js';

const WIRE = resolve(__dirname, '../../../tests/live-turn/wire/same-seat-street-boundary.json');
const TABLE = '7ab1e000-0000-4000-8000-0000000000aa';
/** The fixture player of the browser suites (tests/stale-client/mock-backend). */
const HERO = '5ca1ab1e-0000-4000-8000-000000000011';
const VILLAIN = '0bb0ffee-0000-4000-8000-000000000066';
const HERO_SEAT = 2;
const VILLAIN_SEAT = 6;
/** How long the script waits out a street beat (500ms) before its next move. */
const STREET_WAIT_MS = 1000;

interface Entry {
  at: number;
  kind: 'JOINED' | 'WIRE' | 'HERO_ACTS' | 'VILLAIN_ACTS' | 'RESULT' | 'END';
  frame?: Record<string, any>;
  who?: 'hero' | 'villain';
  action?: string;
  amount?: number;
  context?: string;
  result?: unknown;
}
interface Recording {
  t0: number;
  table: string;
  hero: string;
  villain: string;
  out: Entry[];
}

const engines: any[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) {
    try {
      engine.timeBankEngine.dispose(TABLE);
      engine.disconnectEngine.disposeAll();
      engine.preciseTimer.dispose();
    } catch {
      /* a test engine with no timers left */
    }
  }
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One heads-up hand, played on the real engine, as one subscriber saw it. */
async function playTheHand(): Promise<Recording> {
  const engine = new ServerTableEngine(TABLE) as any;
  engines.push(engine);
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.lifecycleCanMutate = () => true;
  engine.tableInfo = {
    action_time_seconds: 15,
    big_blind: 5,
    small_blind: 2,
    variant: 'nlh',
    game_variant: 'nlh',
    max_players: 6,
  };
  const hub = new TableStateHub();
  engine.hub = hub;
  engine.persistHoleCardsWithRetry = async () => undefined;
  engine.requestSnapshot = vi.fn();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});

  const t0 = Date.now();
  const out: Entry[] = [];
  const mark = (kind: Entry['kind'], extra: Partial<Entry> = {}) =>
    out.push({ at: Date.now() - t0, kind, ...extra });

  const seat = (seatNumber: number, userId: string, username: string) => ({
    seat: seatNumber,
    user_id: userId,
    username,
    stack: 1000,
    bet: 0,
    totalInvested: 0,
    deadInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  });
  const seats = [seat(HERO_SEAT, HERO, 'Danny'), seat(VILLAIN_SEAT, VILLAIN, 'KingFish')];
  // Button on seat 6. Heads-up the button is the small blind and acts first
  // preflop; seat 2 is the big blind, closes preflop and opens every street.
  const hc = new HandController(
    {
      tableId: TABLE,
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 2,
      bigBlind: 5,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true, playerCountCaps: [] },
    } as any,
    seats as any,
    VILLAIN_SEAT
  );
  engine.handController = hc;
  engine.handCount = 1;
  engine.seatedPlayers = seats.map((s) => ({ user_id: s.user_id, seat_number: s.seat }));
  engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20, autoActivate: true });
  for (const s of seats) {
    engine.timeBankEngine.initializePlayer(TABLE, s.user_id, {
      remainingSeconds: 40,
      usesRemaining: 2,
    });
    engine.disconnectEngine.registerPlayer(TABLE, s.user_id);
  }
  hc.onEvent((event: any) => {
    void engine.handleHandEvent(event, engine.seatedPlayers);
  });

  // The browser is at the table before the hand starts.
  mark('JOINED');
  hub.subscribe(TABLE, {
    id: 'browser',
    readyState: 1,
    userId: HERO,
    send(data: string) {
      out.push({ at: Date.now() - t0, kind: 'WIRE', frame: JSON.parse(data) });
    },
  } as any);

  const act = (who: 'hero' | 'villain', action: string, amount?: number) => {
    const context = engine.getActionContext();
    mark(who === 'hero' ? 'HERO_ACTS' : 'VILLAIN_ACTS', { action, amount, context });
    const result = engine.handlePlayerAction(
      who === 'hero' ? HERO : VILLAIN,
      action,
      amount,
      context
    );
    mark('RESULT', { who, action, result });
    expect(result, `${who} ${action}`).toMatchObject({ success: true });
  };

  hc.start();
  // Past the hand-start beat: an action inside the hand's first second is
  // paced by handStartSettleMs instead, which is a different story.
  await sleep(1500);
  act('villain', 'raise', 15);
  await sleep(300);
  act('hero', 'call'); // closes preflop; first to act on the flop
  await sleep(STREET_WAIT_MS);
  act('hero', 'check');
  await sleep(200);
  act('villain', 'bet', 10);
  await sleep(300);
  act('hero', 'call'); // closes the flop; first to act on the turn
  await sleep(STREET_WAIT_MS);
  act('hero', 'check');
  await sleep(200);
  act('villain', 'check'); // ANOTHER seat closes the turn; hero opens the river
  await sleep(STREET_WAIT_MS);
  mark('END');
  return { t0, table: TABLE, hero: HERO, villain: VILLAIN, out };
}

/**
 * One frame per line, so a re-recording reads as a diff of frames. The file
 * is in .prettierignore: a second formatter would only fight this one.
 */
function serialize(recording: Recording): string {
  const { out, ...head } = recording;
  const lines = out.map((entry) => `  ${JSON.stringify(entry)}`);
  return `${JSON.stringify(head).slice(0, -1)},"out":[\n${lines.join(',\n')}\n]}\n`;
}

interface StateFrame {
  at: number;
  /** Index of this frame in the recording. */
  index: number;
  actor: string | null;
  stage: string;
  context: string;
  clock: number;
}

/** Every published state, in order, rebuilt the way a client rebuilds it. */
function statesOf(recording: Recording): StateFrame[] {
  const states: StateFrame[] = [];
  let state: Record<string, any> | null = null;
  recording.out.forEach((entry, index) => {
    const frame = entry.frame;
    if (entry.kind !== 'WIRE' || !frame) return;
    if (frame.type === 'SNAPSHOT') state = structuredClone(frame.state);
    else if (frame.type === 'DELTA' && state) {
      state = jsonPatch.applyPatch(structuredClone(state), frame.patch).newDocument;
    } else return;
    states.push({
      at: entry.at,
      index,
      actor: (state?.current_player as string | null) ?? null,
      stage: String(state?.stage),
      context: String(state?.action_context ?? ''),
      clock: Number(state?.turn_start_time_ms ?? 0),
    });
  });
  return states;
}

/** A decision context without the engine incarnation it starts with. */
const decision = (context: string | undefined) =>
  String(context ?? '')
    .split(':')
    .slice(1)
    .join(':');

/**
 * What a recording says, with everything that legitimately differs between
 * two runs removed: the cards, the incarnation id, and the wall clock (each
 * turn clock becomes its ordinal).
 */
function shapeOf(recording: Recording): string[] {
  const who = (id: string | null) =>
    id === recording.hero ? 'HERO' : id === recording.villain ? 'VILLAIN' : 'nobody';
  const clocks: number[] = [];
  const ordinal = (clock: number) => {
    if (!clock) return 'none';
    if (!clocks.includes(clock)) clocks.push(clock);
    return `clock${clocks.indexOf(clock) + 1}`;
  };
  const stateAt = new Map(statesOf(recording).map((s) => [s.index, s]));
  const lines: string[] = [];
  recording.out.forEach((entry, index) => {
    if (entry.kind === 'HERO_ACTS' || entry.kind === 'VILLAIN_ACTS') {
      lines.push(`> ${entry.kind === 'HERO_ACTS' ? 'HERO' : 'VILLAIN'} ${entry.action}`);
      return;
    }
    const frame = entry.frame;
    if (entry.kind !== 'WIRE' || !frame) return;
    if (frame.type === 'EVENT') {
      const type = String(frame.payload?.type);
      // The events the page's turn handling reads. Others may come and go.
      if (!['turn_change', 'player_action', 'community_cards_dealt'].includes(type)) return;
      const context = frame.payload?.action_context;
      lines.push(
        `EVENT ${type} seat ${frame.payload?.seat ?? '-'}${context ? ` ${decision(context)}` : ''}`
      );
      return;
    }
    const state = stateAt.get(index);
    if (!state) return;
    // A SNAPSHOT and a DELTA carry the same thing to the page: a state.
    const line = `STATE ${state.stage} ${who(state.actor)} ${decision(state.context) || '-'} ${ordinal(state.clock)}`;
    // A frame that changes none of these (the engine's clock ticking over,
    // say) tells the page's turn handling nothing new.
    if (lines.at(-1) !== line) lines.push(line);
  });
  return lines;
}

describe('a seat that closes a street is handed the next one', () => {
  it('the engine goes on naming it, arms the street on a newer clock, and says which decision', async () => {
    const recording = await playTheHand();

    if (process.env.WRITE_LIVE_TURN_WIRE === '1') {
      mkdirSync(dirname(WIRE), { recursive: true });
      writeFileSync(WIRE, serialize(recording));
    }

    const states = statesOf(recording);
    const heroActs = recording.out
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.kind === 'HERO_ACTS');
    expect(heroActs.map(({ entry }) => entry.action)).toEqual(['call', 'check', 'call', 'check']);

    // The two calls each close a street with the caller first to act next.
    for (const { entry: call, index } of [heroActs[0], heroActs[2]]) {
      const before = states.filter((s) => s.index < index).at(-1);
      expect(before?.actor, 'the call answers a turn the engine had armed').toBe(HERO);
      const answered = before?.context ?? '';
      const clockAtAct = before?.clock ?? 0;
      expect(call.context).toBe(answered);

      const after = states.filter((s) => s.index > index);
      const armedAt = after.findIndex((s) => s.clock !== clockAtAct);
      expect(armedAt, 'the engine armed a new turn').toBeGreaterThan(0);
      const between = after.slice(0, armedAt);
      const armed = after[armedAt];

      // (1) Until it arms the street, every frame still names the seat that
      //     acted, on the clock it acted on. This is what a page must not
      //     mistake for the turn coming back...
      for (const frame of between) {
        expect(frame.actor).toBe(HERO);
        expect(frame.clock).toBe(clockAtAct);
        expect(frame.context, 'a frame after the action is not the answered decision').not.toBe(
          answered
        );
      }
      // (2) ...and this is the turn: the same seat, a later clock, the street
      //     beat after the action (500ms; held loosely, it is a sleep).
      expect(armed.actor).toBe(HERO);
      expect(armed.clock).toBeGreaterThan(clockAtAct);
      expect(armed.context).not.toBe(answered);
      expect(armed.at - call.at).toBeGreaterThanOrEqual(400);
      expect(armed.at - call.at).toBeLessThan(STREET_WAIT_MS - 10);

      // (3) The turn_change that follows names the seat and carries the
      //     decision context of the turn it announces.
      const turnChange = recording.out
        .slice(armed.index + 1)
        .find((e) => e.kind === 'WIRE' && e.frame?.type === 'EVENT');
      expect(turnChange?.frame?.payload).toMatchObject({
        type: 'turn_change',
        seat: HERO_SEAT,
        action_context: armed.context,
      });
    }

    // The recording the page is proved against is this hand, frame for frame.
    expect(existsSync(WIRE), `the recorded wire is missing: ${WIRE}`).toBe(true);
    const recorded = JSON.parse(readFileSync(WIRE, 'utf8')) as Recording;
    expect(
      shapeOf(recorded),
      'The engine no longer sends the frames the page was proved against. Record them again ' +
        '(WRITE_LIVE_TURN_WIRE=1, see the top of this file), then run ' +
        'tests/unit/aSeatThatClosesAStreetIsShownItsTurn.test.ts and the live-turn browser suite.'
    ).toEqual(shapeOf(recording));
    expect(recorded.hero).toBe(HERO);
    expect(recorded.table).toBe(TABLE);
  }, 30_000);
});
