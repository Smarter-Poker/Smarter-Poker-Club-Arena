/**
 * RUN IT TWICE TELEMETRY IS COMPLETE (Horse Brain Phase 9 close-out, 2026-10-03).
 *
 * The Phase 9 natural evidence joined actual offers, consents and completed
 * hands from the `action_audit_logs` engine_rit_* rows, and had to guess:
 *   - single_run carried no reason;
 *   - all_accepted and result carried no run count;
 *   - chooser_decided carried no hand number (joined by table, chooser, time);
 *   - and one chooser_decided row "was missing" - in fact present, but its
 *     created_at was 13 s BEFORE its own offer row's (hand 20807344), because
 *     created_at is the database's insert time and fire-and-forget inserts
 *     land out of order.
 *
 * These tests drive the REAL offer path (handleAllInRunout -> respondToRIT ->
 * waitForRITResponse -> dealAndResolveRIT) and pass every hub event through
 * the REAL recorder (captureRitEvent, exactly where TableStateHub.emitEvent
 * calls it), then assert the rows that would be written. Every row must name
 * its hand and offer and carry the engine's own clock and order; every
 * outcome row must reconstruct the decision on its own; no row may carry a
 * card; and every pre-existing field keeps its old meaning.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; row: Record<string, any> }>,
}));

vi.mock('../services/supabase/client.js', () => {
  const settled = { data: null, error: null };
  // Any other query anywhere resolves empty; only inserts are recorded.
  const chain: any = new Proxy(() => chain, {
    get: (_t, k) => (k === 'then' ? (ok: (v: unknown) => void) => ok(settled) : chain),
    apply: () => chain,
  });
  const from = (table: string) =>
    new Proxy(
      {},
      {
        get: (_t, method) =>
          method === 'insert'
            ? (row: Record<string, any>) => {
                h.inserts.push({ table, row });
                return Promise.resolve(settled);
              }
            : chain,
      }
    );
  return {
    supabase: new Proxy({}, { get: (_t, k) => (k === 'from' ? from : chain) }),
  };
});

import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { captureRitEvent } from '../services/supabase/handFacts.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const OFFER_ID = `${TABLE}:1`;

function mkPlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
}

const cfg = (): HandConfig =>
  ({
    tableId: TABLE,
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
  }) as HandConfig;

/** A real 2-way all-in parked at ALL_IN_RUNOUT, HUMANS at every seat so the
 *  test answers the offer itself; hub events go through captureRitEvent. */
function atAllIn(mode?: 'mandatory_twice') {
  const players = mkPlayers([500, 500]);
  const events: HandEvent[] = [];
  const hc = new HandController(cfg(), players, 1);
  hc.onEvent((ev) => events.push(ev));
  hc.start();
  let guard = 0;
  while (!events.some((ev) => ev.type === 'ALL_IN_RUNOUT') && guard++ < 20) {
    const st = (hc as unknown as { state: { currentPlayerSeat: number } }).state;
    if (st.currentPlayerSeat <= 0) break;
    hc.performAction(st.currentPlayerSeat, 'all_in', 0);
  }
  const runoutEvent = events.find((ev) => ev.type === 'ALL_IN_RUNOUT') as HandEvent;
  expect(runoutEvent, 'the hand must park at ALL_IN_RUNOUT').toBeTruthy();

  const e = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
  e.running = true;
  e.handCount = 1;
  e.handController = hc;
  // handleAllInRunout re-reads the RIT configuration from tableInfo
  // (applyRunItTwiceConfig): run_it_mode is where a mandatory table says so,
  // and the shared offer window is 25 s.
  e.tableInfo = {
    game_variant: 'nlh',
    big_blind: 10,
    tournament_id: null,
    game_type: 'cash',
    ...(mode ? { run_it_mode: mode } : {}),
  };
  e.seatedPlayers = players.map((p) => ({
    seat_number: p.seat,
    user_id: p.user_id,
    username: p.username,
    stack: p.stack,
    is_horse: false,
  }));
  const emitted: Array<Record<string, unknown>> = [];
  e.hub = {
    emitEvent: (t: string, p: Record<string, unknown>) => {
      emitted.push(p);
      captureRitEvent(t, p); // exactly what TableStateHub.emitEvent does
    },
  };
  e.broadcastCurrentState = vi.fn();
  e.broadcastAllInEquity = vi.fn().mockResolvedValue(undefined);
  e.sleep = vi.fn().mockResolvedValue(undefined);
  e.markProgress = vi.fn();
  e.runItTwiceEngine.configure(TABLE, {
    enabled: true,
    autoDeclineTimeout: 10,
    maxRuns: 3,
    chooserTimeout: 5,
    responderTimeout: 10,
  });
  e.insuranceEngine.configure(TABLE, { enabled: false });
  e.handleAllInRunout(runoutEvent, e.seatedPlayers);

  const holeCards = (hc as unknown as { state: { players: SeatPlayer[] } }).state.players.flatMap(
    (p) => (p.cards ?? []).map((c) => `${c.rank}${c.suit}`)
  );
  return { e, emitted, holeCards };
}

/** The engine_rit_* rows that would be written, in emit order. */
function rows(type?: string) {
  return h.inserts
    .filter((i) => i.table === 'action_audit_logs')
    .map((i) => i.row)
    .filter((r) => (type ? r.action_type === `engine_rit_${type}` : true));
}
function one(type: string) {
  const r = rows(type);
  expect(r, `exactly one engine_rit_${type} row`).toHaveLength(1);
  return r[0];
}

function chooserAndResponder(emitted: Array<Record<string, unknown>>) {
  const offer = emitted.find((p) => p.type === 'rit_offer')!;
  const chooser = offer.chooserPlayerId as string;
  const responder = (offer.allPlayerIds as string[]).find((id) => id !== chooser)!;
  return { chooser, responder };
}

/** Every row: hand + offer identity, the engine's clock and order, no cards. */
function expectIdentityAndPrivacy(holeCards: string[]) {
  const all = rows();
  expect(all.length).toBeGreaterThan(0);
  let lastSeq = -Infinity;
  for (const r of all) {
    const d = r.details;
    expect(d.table_id, r.action_type).toBe(TABLE);
    expect(d.hand_number, r.action_type).toBe(1);
    expect(d.offer_id, r.action_type).toBe(OFFER_ID);
    expect(typeof d.event_at, r.action_type).toBe('string');
    expect(Number.isNaN(Date.parse(d.event_at)), r.action_type).toBe(false);
    expect(d.event_seq, r.action_type).toBeGreaterThan(lastSeq);
    lastSeq = d.event_seq;
    // Private-safe: no card ever reaches a telemetry row.
    for (const k of ['boards', 'cards', 'per_board_awards', 'per_board_winners', 'distribution']) {
      expect(d, `${r.action_type} must not copy ${k}`).not.toHaveProperty(k);
    }
    const json = JSON.stringify(r);
    for (const card of holeCards) {
      expect(json.includes(`"${card}"`), `${r.action_type} leaked hole card ${card}`).toBe(false);
    }
  }
}

beforeEach(() => {
  h.inserts.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('engine_rit_* telemetry rows are complete', () => {
  it('AGREED: offer, chooser decided, responder accepted, all accepted (with runs) and result (with runs dealt)', async () => {
    const { e, emitted, holeCards } = atAllIn();
    const { chooser, responder } = chooserAndResponder(emitted);

    expect(e.respondToRIT(chooser, undefined, 2).success).toBe(true);
    expect(e.respondToRIT(responder, 'accept').success).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);

    const offer = one('offer');
    expect(offer.user_id).toBe(chooser);
    expect(offer.details).toMatchObject({
      chooser,
      chooser_id: chooser,
      max_runs: 3,
    });
    expect(offer.details.all_players).toEqual(expect.arrayContaining([chooser, responder]));

    const decided = one('chooser_decided');
    expect(decided.user_id).toBe(chooser);
    expect(decided.details).toMatchObject({
      hand_number: 1, // was null: joined by table, chooser and time
      offer_id: OFFER_ID,
      actor: chooser,
      decision: 'runs',
      requested_runs: 2,
      chosen_runs: 2,
      chooser,
    });

    const accepted = one('response_update');
    expect(accepted.user_id).toBe(responder);
    expect(accepted.details).toMatchObject({
      actor: responder,
      decision: 'accept',
      chooser_id: chooser,
    });
    expect(accepted.details.accepted_ids).toEqual(expect.arrayContaining([chooser, responder]));

    const all = one('all_accepted');
    expect(all.user_id, 'no user on the outcome row, as before').toBeNull();
    expect(all.details).toMatchObject({
      outcome_reason: 'all_accepted',
      agreed_runs: 2, // was not recorded (payload field was `runs`)
      chosen_runs: 2,
      chooser_id: chooser,
    });
    expect(all.details.accepted_ids).toEqual(expect.arrayContaining([chooser, responder]));

    const result = one('result');
    expect(result.user_id).toBeNull();
    expect(result.details).toMatchObject({
      outcome_reason: 'all_accepted',
      agreed_runs: 2,
      runs_dealt: 2, // was not recorded
      boards_dealt: 2,
      chooser_id: chooser,
    });

    expect(rows('single_run')).toHaveLength(0);
    expectIdentityAndPrivacy(holeCards);
  });

  it('CHOOSER PICKS ONE: single_run carries the reason, the actor and the decision', async () => {
    const { e, emitted, holeCards } = atAllIn();
    const { chooser } = chooserAndResponder(emitted);

    e.respondToRIT(chooser, undefined, 1);
    await vi.advanceTimersByTimeAsync(20_000);

    const single = one('single_run');
    expect(single.user_id).toBe(chooser);
    expect(single.details).toMatchObject({
      reason: 'chooser_chose_one', // was not recorded
      outcome_reason: 'chooser_chose_one',
      actor: chooser,
      decision: 'runs',
      requested_runs: 1,
      chooser_id: chooser,
      agreed_runs: 1,
      runs_dealt: 1,
    });
    expect(rows('chooser_decided')).toHaveLength(0);
    expect(rows('result')).toHaveLength(0);
    expectIdentityAndPrivacy(holeCards);
  });

  it('RESPONDER DECLINES: single_run names the decliner, the decline and what the chooser had picked', async () => {
    const { e, emitted, holeCards } = atAllIn();
    const { chooser, responder } = chooserAndResponder(emitted);

    e.respondToRIT(chooser, undefined, 3);
    e.respondToRIT(responder, 'decline');
    await vi.advanceTimersByTimeAsync(20_000);

    expect(one('chooser_decided').details).toMatchObject({ chosen_runs: 3, hand_number: 1 });
    const single = one('single_run');
    expect(single.user_id).toBe(responder);
    expect(single.details).toMatchObject({
      reason: 'player_declined',
      outcome_reason: 'player_declined',
      actor: responder,
      decision: 'decline',
      chooser_id: chooser,
      chooser_runs: 3,
      agreed_runs: 1,
      runs_dealt: 1,
    });
    expect(rows('all_accepted')).toHaveLength(0);
    expectIdentityAndPrivacy(holeCards);
  });

  it('NOBODY ANSWERS: single_run is recorded as a timeout, with no actor', async () => {
    const { emitted, holeCards } = atAllIn();
    const { chooser } = chooserAndResponder(emitted);

    // Past the 25 s shared window and the wait's 5 s safety margin.
    await vi.advanceTimersByTimeAsync(40_000);

    const single = one('single_run');
    expect(single.user_id).toBeNull();
    expect(single.details).toMatchObject({
      reason: 'no_agreement',
      outcome_reason: 'timeout',
      actor: null,
      decision: null,
      chooser_id: chooser,
      chooser_runs: null,
      agreed_runs: 1,
      runs_dealt: 1,
    });
    expectIdentityAndPrivacy(holeCards);
  });

  it('MANDATORY: the forced run count and reason are on the mandatory and result rows', async () => {
    const { holeCards } = atAllIn('mandatory_twice');
    await vi.advanceTimersByTimeAsync(20_000);

    expect(rows('offer')).toHaveLength(0);
    expect(one('mandatory').details).toMatchObject({
      outcome_reason: 'mandatory',
      agreed_runs: 2,
    });
    expect(one('result').details).toMatchObject({
      outcome_reason: 'mandatory',
      agreed_runs: 2,
      runs_dealt: 2,
      chooser_id: null,
    });
    expectIdentityAndPrivacy(holeCards);
  });
});
