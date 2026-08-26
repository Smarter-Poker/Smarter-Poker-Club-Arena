/**
 * RUN IT TWICE — PokerBros parity pass (2026-08-26).
 *
 * Pins the wire behavior added for the reference-clone work
 * (docs/rit-pokerbros-parity.md):
 *
 *  1. rit_offer carries the CONFIGURED countdown (25s) and a wall-clock
 *     deadline_ts — one shared clock for chooser + responders.
 *  2. Every accept broadcasts rit_response_update with the accepted set
 *     (live checkmarks), and unanimous consent broadcasts rit_all_accepted.
 *  3. dealAndResolveRIT publishes the UNMERGED per-(run, pot) award
 *     breakdown through currentHandPerPotAwards / currentHandWinnersByBoard,
 *     with the RUN index as the board axis, so pot_win's pot_awards groups
 *     ship each board's pots individually — split pots included.
 *  4. rit_result carries base_board_count for the client reveal timeline.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

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

const cfg = (over: Partial<HandConfig> = {}): HandConfig =>
  ({
    tableId: TABLE,
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    rakeConfig: { percent: 5, cap: 100, noFlopNoDrop: true },
    ...over,
  }) as HandConfig;

function atAllIn(stacks = [500, 500], horses = false) {
  const players = mkPlayers(stacks);
  const events: HandEvent[] = [];
  const hc = new HandController(cfg(), players, 1);
  hc.onEvent((e) => events.push(e));
  hc.start();
  let guard = 0;
  while (!events.some((e) => e.type === 'ALL_IN_RUNOUT') && guard++ < 20) {
    const st = (hc as unknown as { state: { currentPlayerSeat: number } }).state;
    if (st.currentPlayerSeat <= 0) break;
    hc.performAction(st.currentPlayerSeat, 'all_in', 0);
  }
  const runoutEvent = events.find((e) => e.type === 'ALL_IN_RUNOUT');
  expect(runoutEvent, 'the hand must park at ALL_IN_RUNOUT').toBeTruthy();

  const e = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
  e.running = true;
  e.handCount = 1;
  e.handController = hc;
  e.tableInfo = { game_variant: 'nlh', big_blind: 10, tournament_id: null, game_type: 'cash' };
  e.seatedPlayers = players.map((p) => ({
    seat_number: p.seat,
    user_id: p.user_id,
    username: p.username,
    stack: p.stack,
    is_horse: horses,
  }));
  const emitted: Array<Record<string, unknown>> = [];
  e.hub = { emitEvent: (_t: string, p: Record<string, unknown>) => emitted.push(p) };
  e.broadcastCurrentState = vi.fn();
  e.broadcastAllInEquity = vi.fn().mockResolvedValue(undefined);
  e.sleep = vi.fn().mockResolvedValue(undefined);
  e.markProgress = vi.fn();
  e.runItTwiceEngine.configure(TABLE, {
    enabled: true,
    autoDeclineTimeout: 25,
    maxRuns: 3,
  });
  e.insuranceEngine.configure(TABLE, { enabled: false });

  return { e, hc, events, emitted, runoutEvent: runoutEvent as HandEvent, players };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('rit_offer — one shared 25s countdown on the wire', () => {
  it('carries the configured timeoutSeconds and a wall-clock deadline_ts', () => {
    vi.useFakeTimers();
    const { e, runoutEvent, emitted } = atAllIn();
    const before = Date.now();

    e.handleAllInRunout(runoutEvent, e.seatedPlayers);

    const offer = emitted.find((p) => p.type === 'rit_offer');
    expect(offer).toBeTruthy();
    expect(offer!.timeoutSeconds, 'the wire countdown must be the configured window').toBe(25);
    const deadline = Number(offer!.deadline_ts);
    expect(deadline).toBeGreaterThanOrEqual(before + 25_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 25_000 + 1_000);
  });
});

describe('consent progress — live checkmarks and the accept banner', () => {
  it('broadcasts rit_response_update per accept and rit_all_accepted on unanimity', () => {
    vi.useFakeTimers();
    const { e, runoutEvent, emitted } = atAllIn();

    e.handleAllInRunout(runoutEvent, e.seatedPlayers);
    const offer = emitted.find((p) => p.type === 'rit_offer')!;
    const chooser = offer.chooserPlayerId as string;
    const all = offer.allPlayerIds as string[];
    const responder = all.find((id) => id !== chooser)!;

    // Responder accepts BEFORE the chooser decides (consent-race path):
    // the check must broadcast immediately, with no completion yet.
    e.respondToRIT(responder, 'accept');
    const update = emitted.find((p) => p.type === 'rit_response_update');
    expect(update, 'an accept must broadcast rit_response_update').toBeTruthy();
    expect(update!.player_id).toBe(responder);
    expect(update!.accepted_ids as string[]).toContain(responder);
    expect(update!.accepted_ids as string[]).toContain(chooser);
    expect(
      emitted.find((p) => p.type === 'rit_all_accepted'),
      'no banner before the chooser decides'
    ).toBeFalsy();

    // Chooser picks 2 → that completes the acceptance → banner.
    e.respondToRIT(chooser, undefined, 2);
    const allAccepted = emitted.find((p) => p.type === 'rit_all_accepted');
    expect(allAccepted, 'unanimous consent must broadcast rit_all_accepted').toBeTruthy();
    expect(allAccepted!.runs).toBe(2);

    // The chooser-decided event carries the shared deadline for responders.
    const decided = emitted.find((p) => p.type === 'rit_chooser_decided');
    expect(decided).toBeTruthy();
    expect(Number(decided!.deadline_ts)).toBeGreaterThan(0);
  });
});

describe('per-run pot awards — the split-pot ship sequence', () => {
  function resolveRIT(stacks: number[], runs: 2 | 3) {
    const { e, hc, emitted } = atAllIn(stacks);
    const st = (hc as unknown as { state: { players: SeatPlayer[] } }).state;
    const ids = st.players.filter((p) => !p.is_folded).map((p) => p.user_id);
    e.runItTwiceEngine.offer(TABLE, `${TABLE}:1`, ids[0], ids, 0);
    e.runItTwiceEngine.chooserDecides(TABLE, ids[0], runs);
    for (const id of ids.slice(1)) e.runItTwiceEngine.accept(TABLE, id);
    const allIn = st.players.filter((p) => !p.is_folded);
    e.dealAndResolveRIT(allIn);
    return { e, hc, emitted, st };
  }

  it('publishes an UNMERGED (run, pot) breakdown whose shares sum to the net pot', () => {
    const { e, emitted } = resolveRIT([100, 300, 500], 2);

    const awards = e.currentHandPerPotAwards as Array<{
      board?: number;
      potIndex: number;
      amount: number;
      userId: string;
    }>;
    expect(awards.length, 'per-(run, pot) awards must exist on a RIT hand').toBeGreaterThan(0);

    // Both runs are represented on the board axis.
    const boardsSeen = [...new Set(awards.map((a) => a.board ?? 1))].sort();
    expect(boardsSeen).toEqual([1, 2]);

    // A 3-way all-in with 100/300/500 stacks has a main pot AND a side pot.
    const potsSeen = [...new Set(awards.map((a) => a.potIndex))].sort();
    expect(potsSeen.length, 'side pots must keep their own award groups').toBeGreaterThanOrEqual(2);

    // Display shares reconcile with the credited totals (both post-rake).
    const displayTotal = awards.reduce((s, a) => s + a.amount, 0);
    const credited = [...(e.currentHandWinners as Array<{ amount: number }>)].reduce(
      (s, w) => s + w.amount,
      0
    );
    expect(Math.abs(displayTotal - credited)).toBeLessThan(0.1);

    // And the groups pot_win will carry are ordered run 1 → run 2,
    // main pot before side pots within each run.
    const groups = (
      e as unknown as {
        buildPotAwardGroups(): Array<{ board: number; pot_index: number }>;
      }
    ).buildPotAwardGroups();
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < groups.length; i++) {
      const prev = groups[i - 1];
      const cur = groups[i];
      const ordered =
        cur.board > prev.board || (cur.board === prev.board && cur.pot_index >= prev.pot_index);
      expect(ordered, 'groups must sequence board → pot').toBe(true);
    }

    // winners_by_board labels every run.
    const byBoard = e.currentHandWinnersByBoard as Array<{ board: number }>;
    expect([...new Set(byBoard.map((w) => w.board))].sort()).toEqual([1, 2]);

    // rit_result tells the client where the reveal starts.
    const result = emitted.find((p) => p.type === 'rit_result');
    expect(result).toBeTruthy();
    expect(typeof result!.base_board_count).toBe('number');
    expect(result!.base_board_count as number).toBeGreaterThanOrEqual(0);
    expect(result!.base_board_count as number).toBeLessThanOrEqual(5);
  });

  it('three runs label boards 1, 2 and 3', () => {
    const { e } = resolveRIT([500, 500], 3);
    const awards = e.currentHandPerPotAwards as Array<{ board?: number }>;
    expect([...new Set(awards.map((a) => a.board ?? 1))].sort()).toEqual([1, 2, 3]);
  });
});
