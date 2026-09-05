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

describe('rit_offer - one shared 25s countdown on the wire', () => {
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

describe('consent progress - live checkmarks and the accept banner', () => {
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

describe('per-run pot awards - the split-pot ship sequence', () => {
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

    // EXACTNESS PASS 2026-08-26: every player's display shares sum EXACTLY
    // to their credited total, to the cent — the "+N" floats ride these
    // shares and the pot counter decrements by them, so a drifted cent
    // shows a player numbers that do not add up to what their stack rose.
    const credits = e.currentHandWinners as Array<{ userId: string; amount: number }>;
    for (const w of credits) {
      const displayCents = awards
        .filter((a) => a.userId === w.userId)
        .reduce((s, a) => s + Math.round(a.amount * 100), 0);
      expect(displayCents, `display shares for ${w.userId} must equal their credit`).toBe(
        Math.round(w.amount * 100)
      );
    }

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

  /**
   * THE POT BREAKDOWN SURVIVES A RIT HAND (2026-09-05).
   *
   * `currentHandPots` was captured only in the WINNERS handler, behind
   * `hasWinners && state.pots`. A RIT hand satisfies neither — it settles
   * through `finalizeRunout(true)` (WINNERS is emitted empty) and never
   * reaches `completeHandInner()`, the only place `state.pots` is assigned.
   *
   * So every multi-board hand ever played wrote `hand_history.pots` NULL and
   * shipped `pot_distributed` with `pots: []`. Measured on the live table
   * before the fix: 6,939 of 6,939 recorded RIT hands had `pots` NULL.
   */
  it('records the pot breakdown a RIT hand settles against', () => {
    const { e } = resolveRIT([100, 300, 500], 2);

    const pots = e.currentHandPots as Array<{
      index: number;
      amount: number;
      eligible: string[];
    }>;

    expect(pots.length, 'a RIT hand must record the pots it played for').toBeGreaterThan(0);
    // 100/300/500 all-in three ways: a main pot plus at least one side pot.
    expect(pots.length, 'side pots must be recorded, not merged away').toBeGreaterThanOrEqual(2);
    // Indexes are dense and in pot order — `winners[].potIndex` is an index
    // into exactly this array, and a gap makes it uninterpretable.
    expect(pots.map((p) => p.index)).toEqual(pots.map((_, i) => i));
    for (const p of pots) {
      expect(p.amount, 'a recorded pot must hold chips').toBeGreaterThan(0);
      expect(
        p.eligible.length,
        'eligibility is the whole point of the record — it is how a knockout is attributed'
      ).toBeGreaterThan(0);
    }
    // The main pot is contested by everyone; each side pot by strictly fewer.
    for (let i = 1; i < pots.length; i++) {
      expect(pots[i].eligible.length).toBeLessThanOrEqual(pots[i - 1].eligible.length);
    }
    // And the recorded pots account for the whole hand: their sum is the pot
    // the winners were paid out of, before rake.
    const potTotal = pots.reduce((s, p) => s + p.amount, 0);
    const credited = (e.currentHandWinners as Array<{ amount: number }>).reduce(
      (s, w) => s + w.amount,
      0
    );
    expect(potTotal).toBeGreaterThanOrEqual(credited - 0.01);
  });

  it('every per-(run, pot) award names a pot that was actually recorded', () => {
    const { e } = resolveRIT([100, 300, 500], 3);
    const pots = e.currentHandPots as Array<{ index: number }>;
    const awards = e.currentHandPerPotAwards as Array<{ potIndex: number; board?: number }>;
    const known = new Set(pots.map((p) => p.index));
    expect(awards.length).toBeGreaterThan(0);
    for (const a of awards) {
      expect(known.has(a.potIndex), `award cites pot ${a.potIndex} which was never recorded`).toBe(
        true
      );
    }
    // Three runs, and every run pays out of the pots on record.
    expect([...new Set(awards.map((a) => a.board ?? 1))].sort()).toEqual([1, 2, 3]);
  });
});

describe('RIT IS CASH-ONLY (Dan 2026-08-26) - with an integer backstop behind the gate', () => {
  it('the enable formula in Base refuses tournaments - MTT, Spins, heads-up SNG', async () => {
    // Dan's ruling: "run it twice or 3 times is a cash game only area. it
    // should never be in MTT, SPINS OR HEADS UP." The gate lives in
    // ServerTableEngineBase's configure block and must stay there.
    const { readFileSync } = await import('node:fs');
    const base = readFileSync(new URL('./ServerTableEngineBase.ts', import.meta.url), 'utf8');
    expect(base).toMatch(/!ritIsTournament\s*&&/);
    expect(base).toContain('CONFIRMED CASH-ONLY BY DAN 2026-08-26');
  });

  function tournamentHarness(stacks: number[], runs: 2 | 3) {
    const players = mkPlayers(stacks);
    const events: HandEvent[] = [];
    // Tournament pots are never raked (Dealing zeroes rakeConfig for
    // tournament tables) — mirror that here.
    const hc = new HandController(
      cfg({ rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: false } } as Partial<HandConfig>),
      players,
      1
    );
    hc.onEvent((e2) => events.push(e2));
    hc.start();
    let guard = 0;
    while (!events.some((e2) => e2.type === 'ALL_IN_RUNOUT') && guard++ < 20) {
      const st = (hc as unknown as { state: { currentPlayerSeat: number } }).state;
      if (st.currentPlayerSeat <= 0) break;
      hc.performAction(st.currentPlayerSeat, 'all_in', 0);
    }
    const e = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
    e.running = true;
    e.handCount = 1;
    e.handController = hc;
    e.tableInfo = {
      game_variant: 'nlh',
      big_blind: 10,
      tournament_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      game_type: 'tournament',
    };
    e.seatedPlayers = players.map((p) => ({
      seat_number: p.seat,
      user_id: p.user_id,
      username: p.username,
      stack: p.stack,
      is_horse: true,
    }));
    const emitted: Array<Record<string, unknown>> = [];
    e.hub = { emitEvent: (_t: string, p: Record<string, unknown>) => emitted.push(p) };
    e.broadcastCurrentState = vi.fn();
    e.broadcastAllInEquity = vi.fn().mockResolvedValue(undefined);
    e.sleep = vi.fn().mockResolvedValue(undefined);
    e.markProgress = vi.fn();
    e.runItTwiceEngine.configure(TABLE, { enabled: true, autoDeclineTimeout: 25, maxRuns: 3 });
    e.insuranceEngine.configure(TABLE, { enabled: false });
    const st = (hc as unknown as { state: { players: SeatPlayer[] } }).state;
    const ids = st.players.filter((p) => !p.is_folded).map((p) => p.user_id);
    e.runItTwiceEngine.offer(TABLE, `${TABLE}:1`, ids[0], ids, 0);
    e.runItTwiceEngine.chooserDecides(TABLE, ids[0], runs);
    for (const id of ids.slice(1)) e.runItTwiceEngine.accept(TABLE, id);
    e.dealAndResolveRIT(st.players.filter((p) => !p.is_folded));
    return { e, hc, st, emitted, totalBuyin: stacks.reduce((s, x) => s + x, 0) };
  }

  it('a tournament all-in gets NO offer - the engine is configured off, as Base does', () => {
    vi.useFakeTimers();
    const players = mkPlayers([500, 500]);
    const events: HandEvent[] = [];
    const hc = new HandController(cfg(), players, 1);
    hc.onEvent((e2) => events.push(e2));
    hc.start();
    let guard = 0;
    while (!events.some((e2) => e2.type === 'ALL_IN_RUNOUT') && guard++ < 20) {
      const st = (hc as unknown as { state: { currentPlayerSeat: number } }).state;
      if (st.currentPlayerSeat <= 0) break;
      hc.performAction(st.currentPlayerSeat, 'all_in', 0);
    }
    const runoutEvent = events.find((e2) => e2.type === 'ALL_IN_RUNOUT')!;
    const { e, emitted } = (() => {
      const eng = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
      eng.running = true;
      eng.handCount = 1;
      eng.handController = hc;
      eng.tableInfo = {
        game_variant: 'nlh',
        big_blind: 10,
        tournament_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        game_type: 'tournament',
        run_it_twice: true,
      };
      eng.seatedPlayers = players.map((p) => ({
        seat_number: p.seat,
        user_id: p.user_id,
        username: p.username,
        stack: p.stack,
        is_horse: true,
      }));
      const em: Array<Record<string, unknown>> = [];
      eng.hub = { emitEvent: (_t: string, p: Record<string, unknown>) => em.push(p) };
      eng.broadcastCurrentState = vi.fn();
      eng.broadcastAllInEquity = vi.fn().mockResolvedValue(undefined);
      eng.sleep = vi.fn().mockResolvedValue(undefined);
      eng.markProgress = vi.fn();
      // Base's configure evaluates ritIsTournament and passes enabled: false
      // for any tournament table — mirror that here (the source pin above
      // guards the formula itself).
      eng.runItTwiceEngine.configure(TABLE, { enabled: false, autoDeclineTimeout: 25, maxRuns: 3 });
      eng.insuranceEngine.configure(TABLE, { enabled: false });
      return { e: eng, emitted: em };
    })();
    e.handleAllInRunout(runoutEvent, e.seatedPlayers);
    expect(
      emitted.find((p) => p.type === 'rit_offer'),
      'a tournament all-in must NEVER receive a RIT offer (cash-only ruling)'
    ).toBeFalsy();
    expect(
      emitted.find((p) => p.type === 'rit_mandatory'),
      'mandatory modes must not fire on tournament tables either'
    ).toBeFalsy();
  });

  it('THE BACKSTOP: a direct resolver call on a tournament hand splits whole chips only', () => {
    // Unreachable in production while the Base gate holds — this drives
    // dealAndResolveRIT directly to prove the defense-in-depth branch keeps
    // the 41627f9a chip-destruction impossible even if the gate regresses.
    // The deal is random, so run the settlement several times per run count —
    // scoops and splits both land here, and the invariants must hold for all.
    for (const runs of [2, 3] as const) {
      for (let trial = 0; trial < 4; trial++) {
        const { e, st, totalBuyin } = tournamentHarness([500, 500], runs);
        const winners = e.currentHandWinners as Array<{ userId: string; amount: number }>;
        expect(winners.length).toBeGreaterThan(0);
        let paid = 0;
        for (const w of winners) {
          expect(
            Number.isInteger(w.amount),
            `runs=${runs} trial=${trial}: credit ${w.amount} must be a whole chip amount`
          ).toBe(true);
          paid += w.amount;
        }
        // No rake, no BBJ in tournaments: every chip in the pot is paid out.
        expect(paid).toBe(totalBuyin);
        // Engine stacks are whole chips — the INTEGER column sync cannot
        // floor anything away (the exact 41627f9a failure mode).
        for (const p of st.players) {
          expect(
            Number.isInteger(p.stack),
            `runs=${runs} trial=${trial}: stack ${p.stack} must be integer`
          ).toBe(true);
        }
        expect(st.players.reduce((s, p) => s + p.stack, 0)).toBe(totalBuyin);
        // Display shares are whole chips too — no fractional "+N" floats.
        const awards = e.currentHandPerPotAwards as Array<{ amount: number }>;
        for (const a of awards) {
          expect(
            Number.isInteger(a.amount),
            `runs=${runs} trial=${trial}: display share ${a.amount} must be integer`
          ).toBe(true);
        }
      }
    }
  });
});
