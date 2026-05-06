/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SIMULATOR FRAMEWORK
 * ═══════════════════════════════════════════════════════════════════════════════
 * Deterministic, in-process harness for exercising the server engine and
 * asserting on what the UI would render. See server/sim/README.md.
 */

import { HandController } from '../src/engine/HandController.js';
import type { HandConfig, HandEvent, SeatPlayer, ActionType } from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface SimPlayer {
  seat: number;
  userId: string;
  username: string;
  stack: number;
}

export interface SimStartOptions {
  players: number; // e.g. 4
  stacks: number; // starting stack per player
  sb: number;
  bb: number;
  seed?: number; // deck shuffle seed (deterministic replay)
  variant?: 'nlh' | 'plo' | 'short_deck';
}

export interface AssertionFailure {
  scenario: string;
  message: string;
  expected: unknown;
  actual: unknown;
}

// ─────────────────────────────────────────────────────────────────────────
// Mapped-snapshot shim — minimal engine-published-state shape that the
// client mapper expects. Computed from HandController.getState().
// ─────────────────────────────────────────────────────────────────────────

function buildPublishedState(hc: HandController) {
  // HandController exposes private state — we use a thin reflection hatch
  // so the sim can read it without adding a public accessor to production
  // code. See sim/README.md for the rationale.
  const state = (hc as any).state as any;
  return {
    stage: state.stage,
    dealer_seat: state.dealerSeat,
    pot: state.pot,
    community_cards: state.communityCards,
    current_player: state.players[state.currentPlayerSeat - 1]?.user_id ?? null,
    current_bet: state.currentBet,
    min_raise: state.minRaise,
    last_raise: state.lastRaise,
    pots: state.pots ?? [],
    action_history: (state.actionHistory ?? []).map((a: any) => ({
      seat: a.seat,
      userId: a.userId,
      action: a.action,
      amount: a.amount,
      timestamp: a.timestamp,
      stage: a.stage,
    })),
    players: state.players.map((p: any) => ({
      user_id: p.user_id,
      seat: p.seat,
      username: p.username,
      stack: p.stack,
      is_folded: p.is_folded,
      is_all_in: p.is_all_in,
      is_sitting_out: p.is_sitting_out,
      is_disconnected: false,
      cards: p.hole_cards ?? [],
      position: p.position ?? null,
      avatar_url: null,
    })),
    winners: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Simulator class
// ─────────────────────────────────────────────────────────────────────────

export class Sim {
  private hc: HandController | null = null;
  private players: SimPlayer[] = [];
  private events: HandEvent[] = [];
  public failures: AssertionFailure[] = [];

  constructor(
    public scenarioName: string,
    public verbose = false
  ) {}

  async startHand(opts: SimStartOptions): Promise<void> {
    this.players = Array.from({ length: opts.players }, (_, i) => ({
      seat: i + 1,
      userId: `user-seat-${i + 1}`,
      username: `Player${i + 1}`,
      stack: opts.stacks,
    }));

    const seatPlayers: SeatPlayer[] = this.players.map(
      (p) =>
        ({
          user_id: p.userId,
          seat: p.seat,
          username: p.username,
          stack: p.stack,
          hole_cards: [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
          bet: 0,
          total_invested: 0,
        }) as SeatPlayer
    );

    const config: HandConfig = {
      smallBlind: opts.sb,
      bigBlind: opts.bb,
      gameVariant: (opts.variant ?? 'nlh') as any,
      maxPlayers: opts.players,
    } as HandConfig;

    this.hc = new HandController(config, seatPlayers, 1);
    this.hc.onEvent((e) => {
      this.events.push(e);
      if (this.verbose) console.log(`[event]`, e.type, e);
    });
    // Start the hand — post blinds, deal hole cards, begin preflop betting.
    this.hc.start();
  }

  async act(seatRef: string | number, action: ActionType, amount = 0): Promise<void> {
    if (!this.hc) throw new Error('startHand() must be called first');
    const seat =
      typeof seatRef === 'number' ? seatRef : parseInt(String(seatRef).replace(/\D/g, ''), 10);
    const player = this.players.find((p) => p.seat === seat);
    if (!player) throw new Error(`seat ${seat} not in sim`);
    const ok = this.hc.performAction(seat, action, amount);
    if (!ok) {
      this.failures.push({
        scenario: this.scenarioName,
        message: `performAction returned false: seat=${seat} action=${action} amount=${amount}`,
        expected: 'true',
        actual: 'false',
      });
    }
  }

  published() {
    if (!this.hc) throw new Error('startHand() must be called first');
    return buildPublishedState(this.hc);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Assertions — richer matchers live here. Clients drive the mapper on
  // the caller side (see runner.ts) so tests can assert on UI shape.
  // ─────────────────────────────────────────────────────────────────────
  assert = {
    potEquals: (expected: number) => {
      const pot = this.published().pot;
      if (pot !== expected) {
        this.failures.push({
          scenario: this.scenarioName,
          message: 'pot mismatch',
          expected,
          actual: pot,
        });
      }
    },
    stageIs: (stage: string) => {
      const s = this.published().stage;
      if (s !== stage) {
        this.failures.push({
          scenario: this.scenarioName,
          message: 'stage mismatch',
          expected: stage,
          actual: s,
        });
      }
    },
    currentPlayerSeatIs: (seat: number) => {
      const s = this.published();
      const cp = s.players.find((p: any) => p.user_id === s.current_player);
      if (!cp || cp.seat !== seat) {
        this.failures.push({
          scenario: this.scenarioName,
          message: 'current player seat mismatch',
          expected: seat,
          actual: cp?.seat ?? null,
        });
      }
    },
    seatStackIs: (seat: number, stack: number) => {
      const p = this.published().players.find((x: any) => x.seat === seat);
      if (!p || p.stack !== stack) {
        this.failures.push({
          scenario: this.scenarioName,
          message: `seat ${seat} stack mismatch`,
          expected: stack,
          actual: p?.stack ?? null,
        });
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Scenario factory
// ─────────────────────────────────────────────────────────────────────────

export type ScenarioFn = (sim: Sim) => Promise<void>;
export interface Scenario {
  name: string;
  run: ScenarioFn;
}

export function scenario(name: string, run: ScenarioFn): Scenario {
  return { name, run };
}
