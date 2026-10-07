/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE LIGHTNING HAND, DEALT (Lightning Phase 6, 2026-09-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The engine's second dealing path. A Lightning hand is formed by the SQL
 * barrier across players whose chips sit on DIFFERENT physical anchor seats,
 * so no ServerTableEngine owns it. This host deals it, one host per formed
 * hand, by REUSING the hand engine rather than copying it:
 *
 *   - the poker is HandController's, untouched: blinds, betting, side pots,
 *     showdown, rake and BBJ are computed exactly as at a physical table;
 *   - what clients see is the shared presentation the physical engine now
 *     publishes through (src/engine/presentation): projectLiveHandState for
 *     the room snapshot and the handEventFrames builders for every frame, so
 *     the events a Lightning client animates from are the physical ones
 *     (Animation Law, CLAUDE.md 10.6);
 *   - the clock is PreciseActionTimer and TimeBankEngine, presence is
 *     DisconnectEngine, keyed by this hand alone (`lightning:<hand_id>`), so
 *     no timer can outlive the hand or be carried into another;
 *   - a horse acts through the same turn timer and the same action door as a
 *     human, its decision from the same live horse decision lane a physical
 *     table asks, with its own style, mods and mind (CLAUDE.md 10.5);
 *   - a qualifying bad beat pays the Bad Beat Jackpot exactly as at a
 *     physical table, after settlement (LightningJackpot).
 *
 * THE SEQUENCE. begin_dealing -> fn_next_hand_number -> bind_hand_number ->
 * the host table's rules -> HandController with the formation's seats (the
 * dealer is the 'btn' seat; the blinds are the barrier's, passed as
 * `blindSeats` and never re-derived) -> start -> hole cards to their owners
 * and insert_hole_cards -> play -> settle -> post-commit obligations.
 *
 * MONEY MOVES ONLY THROUGH SETTLEMENT. Nothing before fn_lightning_settle_hand
 * writes a chip. Any failure before it abandons the instance with a reason
 * (the reaper's void path: nothing moved). Settlement is retried with ONE
 * request id per hand, so a retry can never settle twice; an outcome that is
 * still unknown after the retries is left to the reaper, which voids only an
 * instance that never completed.
 *
 * CARDS REACH ONLY THEIR OWNERS. Each participant is shown the hand in their
 * own room, keyed by their pool_session_id (never the instance id). The room
 * snapshot is the physical live payload - nobody's hole cards before
 * showdown - and a player's own cards travel only in the private `hole_cards`
 * frame, sent to that player's room for that player's sockets.
 *
 * FOLDS. 'fast' and a normal fold free the player at once (fn_lightning_fast_fold)
 * while the hand plays on, and this host stops publishing the hand to their
 * room so the client can take the next one; 'fold_watch' folds and keeps
 * publishing until the hand ends. A fast fold before the player's turn is
 * accepted only while they face a bet (fold is a real option), and is
 * executed in the hand when the action reaches them; while anyone faces a
 * bet, the player who made it is still live, so a folded hand can never be
 * left alone to win.
 */
import { createHash } from 'node:crypto';
import { HandController } from '../engine/HandController.js';
import { PreciseActionTimer } from '../engine/PreciseActionTimer.js';
import { TimeBankEngine, type TimeBankEvent } from '../engine/TimeBankEngine.js';
import { DisconnectEngine } from '../engine/DisconnectEngine.js';
import { playerActionContext } from '../engine/PlayerActionContext.js';
import { PreActionEngine, type PreActionType } from '../engine/PreActionEngine.js';
import {
  getLiveHorseDecisionWorker,
  type LiveHorseDecisionLane,
} from '../engine/horseDecision/index.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { describeError } from '../services/errorReporter.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import { HAND_COMPLETION } from '../config/handCompletionSpec.js';
import {
  bettingStructureFor,
  fixedLimitBetSize,
  fixedLimitStreetBounds,
  isFixedLimitCapped,
  potLimitBettingPot,
} from '../engine/BettingStructure.js';
import { projectLiveHandState } from '../engine/presentation/projectHandState.js';
import {
  accumulateBoard,
  antesPostedFrame,
  blindsPostedFrame,
  communityCardsDealtFrame,
  handStartedFrame,
  normalizeShowdownResults,
  normalizeWinners,
  playerActionFrame,
  potDistributedFrame,
  potWinFrame,
  showdownCardsRevealedFrame,
  showdownFrame,
  turnChangeFrame,
  type ShowdownRecord,
  type WinnerRecord,
} from '../engine/presentation/handEventFrames.js';
import type {
  ActionType,
  Card,
  GameState,
  GameVariant,
  HandConfig,
  HandEvent,
  HandStage,
  SeatPlayer,
} from '../types.js';
import type {
  LightningFoldType,
  LightningHandBackend,
  LightningHostRules,
  LightningParticipant,
  LightningSettleResult,
} from './LightningHandBackend.js';
import { lightningMetrics, type LightningMetrics } from './LightningMetrics.js';
import type { LightningDecision } from './LightningRegistry.js';
import type { LightningWorkerLogger } from './LightningClusterWorker.js';
import { settleLightningJackpot, type LightningJackpotDeps } from './LightningJackpot.js';
import {
  decideLightningHorse,
  LIGHTNING_HORSE_MAX_BANK_BURN_MS,
  lightningHorseThinkTimeMs,
  shapeLightningHorseAction,
} from './LightningHorse.js';

/** One hand as fn_lightning_match_and_form returned it. */
export interface LightningFormedHand {
  clusterId: string;
  instanceId: string;
  handId: string;
  bb: string;
  sb: string;
  btn: string;
  /** The matcher order: big blind, small blind, seat 3 onward, button last. */
  players: string[];
  /** When the pass that formed it returned (for latency telemetry). */
  formedAtMs: number;
}

/** The slice of TableStateHub a host publishes through. */
export interface LightningHub {
  publish(roomId: string, payload: Record<string, unknown>): unknown;
  emitEvent(roomId: string, payload: Record<string, unknown>): void;
  sendToUser(roomId: string, userId: string, payload: Record<string, unknown>): number;
}

/** The host table's engine lease, which settlement fences on. */
export interface LightningLease {
  instance: string;
  generation: string;
}

/**
 * A player's time bank across Lightning hands (one per Cluster worker).
 *
 * TWO HANDS AT ONCE (2026-10-01 remediation). A player can be in two hands
 * (a fold frees them before the first settles), and each hand reads its bank
 * from here when it starts. So a record keeps the MINIMUM remaining it has
 * been told, never the last one written, and a folder's bank is recorded at
 * the fold (finish() skips anyone already recorded). Paid seconds are debited
 * under a deterministic request id per (hand, player), awaited with retry, so
 * a lost answer is asked again and can never charge twice.
 *
 * A RESTART DOES NOT REFILL. A bank first seen by this worker is seeded from
 * the durable bank: the paid allowance is already net of every debit
 * (fn_time_bank_allowance_v2), and the free part is capped by what the
 * player's anchor seat last persisted.
 */
export class LightningTimeBankLedger {
  static readonly BASE_SECONDS = 40;
  private readonly banks = new Map<
    string,
    {
      remainingSeconds: number;
      usesRemaining: number;
      unlimited: boolean;
      initialSeconds: number;
      consumedSeconds: number;
    }
  >();

  constructor(
    private readonly backend: Pick<
      LightningHandBackend,
      'timeBankAllowance' | 'consumeTimeBank' | 'durableTimeBanks'
    >,
    private readonly clusterId: string | null = null,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => {
        const t = setTimeout(r, ms);
        (t as { unref?: () => void }).unref?.();
      }),
    private readonly logger: LightningWorkerLogger = defaultLogger
  ) {}

  /** Make sure every player has a bank; unknown allowances fall back to the base. */
  async ensure(userIds: string[]): Promise<void> {
    const missing = userIds.filter((u) => !this.banks.has(u));
    if (missing.length === 0) return;
    let allowance = new Map<string, { extraSeconds: number; unlimitedActivations: boolean }>();
    try {
      allowance = await this.backend.timeBankAllowance(missing);
    } catch {
      /* the approved fallback: the base allowance, exactly as the engine */
    }
    let durable = new Map<
      string,
      { remainingSeconds: number | null; usesRemaining: number | null }
    >();
    if (this.clusterId && this.backend.durableTimeBanks) {
      try {
        durable = await this.backend.durableTimeBanks(this.clusterId, missing);
      } catch (err) {
        this.logger.warn(
          `[LightningTimeBank:${this.clusterId}] durable bank unreadable; seeding from the allowance (${describeError(err)})`
        );
      }
    }
    for (const u of missing) {
      if (this.banks.has(u)) continue;
      const a = allowance.get(u);
      const total = LightningTimeBankLedger.BASE_SECONDS + (a?.extraSeconds ?? 0);
      const seed = durable.get(u);
      const uses = Math.ceil(total / 20);
      this.banks.set(u, {
        remainingSeconds:
          seed?.remainingSeconds != null ? Math.min(total, seed.remainingSeconds) : total,
        usesRemaining: seed?.usesRemaining != null ? Math.min(uses, seed.usesRemaining) : uses,
        unlimited: a?.unlimitedActivations === true,
        initialSeconds: total,
        consumedSeconds: 0,
      });
    }
  }

  get(userId: string) {
    return this.banks.get(userId) ?? null;
  }

  /**
   * A hand is done with this player's bank (`remainingSeconds` left). The
   * smaller figure wins: another hand may already have spent more. Seconds
   * spent beyond the base are paid ones, consumed exactly as the engine does.
   */
  async record(
    userId: string,
    remainingSeconds: number,
    usesRemaining: number,
    handId: string,
    unlimitedSpent = 0
  ): Promise<void> {
    const bank = this.banks.get(userId);
    if (!bank) return;
    bank.remainingSeconds = Math.min(bank.remainingSeconds, remainingSeconds);
    bank.usesRemaining = Math.min(bank.usesRemaining, usesRemaining);
    const owed = bank.unlimited
      ? unlimitedSpent
      : Math.max(
          0,
          bank.initialSeconds - bank.remainingSeconds - LightningTimeBankLedger.BASE_SECONDS
        ) - bank.consumedSeconds;
    if (owed <= 0) return;
    if (!bank.unlimited) bank.consumedSeconds += owed;
    const requestId = lightningRequestId(handId, `tb/${userId}`);
    for (let attempt = 1; attempt <= RPC_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.backend.consumeTimeBank(userId, owed, requestId);
        return;
      } catch (err) {
        if (attempt === RPC_RETRY_ATTEMPTS) {
          // Unanswered: owed again, so the next record carries it (under its
          // own hand's id) rather than the debit being lost.
          if (!bank.unlimited) bank.consumedSeconds -= owed;
          this.logger.error(
            `[LightningTimeBank] debit of ${owed}s for ${userId} unconfirmed after ${attempt} attempts (request ${requestId})`,
            err
          );
          return;
        }
        await this.sleep(150 * attempt);
      }
    }
  }
}

export interface LightningHandHostDeps {
  backend: LightningHandBackend;
  hub: LightningHub;
  /** The verified cash lease on the host table, if this process holds it. */
  leaseFor(hostTableId: string): LightningLease | null;
  keepaliveIntervalMs: number;
  dealWindowMs: number;
  timeBanks: LightningTimeBankLedger;
  metrics?: LightningMetrics;
  logger?: LightningWorkerLogger;
  /** Injected for tests; one per host otherwise. */
  timer?: PreciseActionTimer;
  /** Pacing waits (a turn's settle, a runout street, the showdown read). */
  sleep?: (ms: number) => Promise<void>;
  /** A live socket in the player's room (the registry's presence). */
  isConnected?(playerId: string, roomId: string): boolean;
  /** The player may be matched again (worker wake). */
  onPlayerReleased?(playerId: string, foldType: LightningFoldType | 'hand_end'): void;
  /** The participants and rooms are known and the deal is about to start. */
  onDealing?(host: LightningHandHost): void;
  /** The host is done, whatever the outcome. */
  onFinished?(host: LightningHandHost): void;
  /** Settlement found a conservation disagreement and FROZE the Cluster. */
  onClusterFrozen?(clusterId: string): void;
  /**
   * LIGHTNING PHASE 8: a human player owes a decision in this hand (with the
   * engine's deadline), or no longer does (`null`, with why). Horses owe no
   * one a queue entry: they have no browser.
   */
  onDecision?(playerId: string, decision: LightningDecision | null, reason?: string): void;
  now?: () => number;
  /** The live horse decision lane (injected for tests; the process lane otherwise). */
  horseLane?: () => LiveHorseDecisionLane;
  /** The jackpot payout doors (injected for tests; the physical ones otherwise). */
  jackpot?: Pick<LightningJackpotDeps, 'payMain' | 'payMini'>;
  /** How long the post-commit drain may keep trying while the lease is held. */
  postCommitBudgetMs?: number;
}

export type LightningHostState =
  | 'created'
  | 'starting'
  | 'dealing'
  | 'settling'
  | 'complete'
  | 'abandoned'
  | 'settlement_unknown'
  | 'frozen';

const BETTING_STAGES = new Set<string>(['preflop', 'flop', 'turn', 'river']);
const SETTLE_ATTEMPTS = 5;
const RPC_RETRY_ATTEMPTS = 3;
/**
 * The post-commit drain (the physical engine's, ServerTableEngineSettlement):
 * retried with backoff while the host lease is held, up to this budget, then
 * a five-second handover once it is not. The outbox row stays authoritative
 * and the projection worker is the successor either way.
 */
const POST_COMMIT_BUDGET_MS = 15_000;
const POST_COMMIT_HANDOVER_MS = 5_000;

/** A request id that is the same for the same (hand, purpose) on every retry. */
export function lightningRequestId(handId: string, purpose: string): string {
  const h = createHash('md5').update(`${handId}/${purpose}`).digest('hex');
  // RFC 4122 shape, version 4 / variant 10, so every uuid check accepts it.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const cents = (n: number) => Math.round(n * 100) / 100;

const defaultLogger: LightningWorkerLogger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m, err) => console.error(m, err ?? ''),
};

export class LightningHandHost {
  readonly instanceId: string;
  readonly clusterId: string;
  private state: LightningHostState = 'created';
  private handId: string;
  private handNumber = 0;
  private hostTableId = '';
  private rules: LightningHostRules | null = null;
  private hc: HandController | null = null;
  private participants = new Map<string, LightningParticipant>();
  /** Rooms still receiving this hand: player id -> room id. */
  private watching = new Map<string, string>();
  private foldTypes = new Map<string, LightningFoldType>();
  /** Folds requested before the player's turn, executed when it arrives. */
  private pendingFolds = new Map<string, LightningFoldType>();
  private holeCards = new Map<string, { seat: number; cards: Card[] }>();
  private actions: Array<Record<string, unknown>> = [];
  private boards: [string[], string[], string[]] = [[], [], []];
  private showdown: ShowdownRecord[] = [];
  private winners: WinnerRecord[] = [];
  private winnersByBoard: Array<{
    board: number;
    userId: string;
    amount: number;
    handName?: string;
  }> = [];
  private perPotAwards: unknown[] = [];
  private runoutRevealActive = false;
  private turnStartMs = 0;
  private turnDurationSec = 0;
  private turnUser: string | null = null;
  /** The player whose owed decision was announced (Lightning Phase 8), until retracted. */
  private decisionOpenFor: string | null = null;
  private timeBankActive = false;
  private lastStreetAtMs = 0;
  private handStartAtMs = 0;
  private startedAtMs = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private horseTimer: ReturnType<typeof setTimeout> | null = null;
  /** The horse turn in flight: aborted when the turn moves on (one lane job per turn). */
  private horseAbort: AbortController | null = null;
  private horseGeneration = 0;
  /** Players whose time bank this hand has already recorded (at a fold). */
  private readonly bankRecorded = new Set<string>();
  private readonly timerKey: string;
  private readonly timer: PreciseActionTimer;
  private readonly timeBank: TimeBankEngine;
  private readonly disconnect: DisconnectEngine;
  /** Pre-actions, bound to THIS hand: a new hand is a new host, with none. */
  private readonly preActions = new PreActionEngine();
  private readonly metrics: LightningMetrics;
  private readonly logger: LightningWorkerLogger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private actionLock = false;
  private finished: Promise<void>;
  private resolveFinished!: () => void;

  constructor(
    private readonly formed: LightningFormedHand,
    private readonly deps: LightningHandHostDeps
  ) {
    this.instanceId = formed.instanceId;
    this.clusterId = formed.clusterId;
    this.handId = formed.handId;
    this.timerKey = `lightning:${formed.handId}`;
    this.timer = deps.timer ?? new PreciseActionTimer();
    this.timeBank = new TimeBankEngine(this.timer, (e) => this.onTimeBankEvent(e));
    this.disconnect = new DisconnectEngine(this.timer);
    this.metrics = deps.metrics ?? lightningMetrics;
    this.logger = deps.logger ?? defaultLogger;
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ??
      ((ms) =>
        new Promise((r) => {
          const t = setTimeout(r, ms);
          (t as { unref?: () => void }).unref?.();
        }));
    this.finished = new Promise((r) => (this.resolveFinished = r));
  }

  get lifecycle(): LightningHostState {
    return this.state;
  }

  get currentHandId(): string {
    return this.handId;
  }

  /** Resolves when the host has settled, abandoned or given up. */
  whenFinished(): Promise<void> {
    return this.finished;
  }

  /** The room each player is shown this hand in. */
  roomOf(playerId: string): string | null {
    return this.participants.get(playerId)?.poolSessionId ?? null;
  }

  /** Is this player still being shown (and acting in) this hand? */
  isWatching(playerId: string): boolean {
    return this.watching.has(playerId);
  }

  participantIds(): string[] {
    return [...this.participants.keys()];
  }

  // ─── LIFECYCLE ──────────────────────────────────────────────────────────

  /** Deal the hand. Never throws; any failure abandons the instance. */
  async start(): Promise<void> {
    if (this.state !== 'created') return;
    this.state = 'starting';
    try {
      const begun = await this.deps.backend.beginDealing(
        this.instanceId,
        this.deps.dealWindowMs,
        new Date(this.now())
      );
      if (!begun.ok) return void (await this.abandon(`begin_dealing_refused:${begun.reason}`));
      if (begun.value.handId && begun.value.handId !== this.handId)
        return void (await this.abandon('begin_dealing_hand_mismatch'));

      this.handNumber = await this.deps.backend.nextHandNumber();
      const bound = await this.deps.backend.bindHandNumber(this.instanceId, this.handNumber);
      if (!bound.ok) return void (await this.abandon(`bind_refused:${bound.reason}`));
      if (bound.value.handId !== this.handId)
        return void (await this.abandon('bind_hand_mismatch'));
      this.hostTableId = bound.value.hostTableId;
      if (!this.deps.leaseFor(this.hostTableId))
        return void (await this.abandon('host_lease_not_held'));

      const participants = await this.deps.backend.loadParticipants(this.handId);
      const refusal = this.checkFormation(participants);
      if (refusal) return void (await this.abandon(refusal));
      for (const p of participants) {
        this.participants.set(p.playerId, p);
        this.watching.set(p.playerId, p.poolSessionId);
      }
      this.rules = await this.deps.backend.loadHostRules(this.hostTableId);
      const variantRefusal = this.checkVariant(this.rules);
      if (variantRefusal) return void (await this.abandon(variantRefusal));
      await this.deps.timeBanks.ensure([...this.participants.keys()]);
      if (this.state !== 'starting') return; // aborted while reading

      this.configureClocks(this.rules);
      const btn = participants.find((p) => p.position === 'btn')!;
      const sb = participants.find((p) => p.playerId === this.formed.sb)!;
      const bb = participants.find((p) => p.playerId === this.formed.bb)!;
      const seats: SeatPlayer[] = [...participants]
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          seat: p.seat,
          user_id: p.playerId,
          username: p.username,
          stack: p.stackBefore,
          bet: 0,
          totalInvested: 0,
          cards: [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
          is_horse: p.isHorse,
        }));
      this.hc = new HandController(
        this.buildHandConfig(this.rules, sb.seat, bb.seat),
        seats,
        btn.seat
      );
      this.hc.onEvent((e) => this.onHandEvent(e));
      this.state = 'dealing';
      this.deps.onDealing?.(this);
      this.startedAtMs = this.now();
      this.metrics.observeLatency('match_to_hand', this.startedAtMs - this.formed.formedAtMs);
      this.keepaliveTimer = setInterval(() => void this.keepalive(), this.deps.keepaliveIntervalMs);
      (this.keepaliveTimer as { unref?: () => void }).unref?.();
      this.hc.start();
      this.metrics.noteDealt([...this.participants.keys()], this.now());
      // Hole cards went to their owners synchronously at CARDS_DEALT; the
      // durable row the client re-reads goes in one batch, as the engine does.
      const rows = [...this.holeCards].map(([userId, h]) => ({
        user_id: userId,
        seat_number: h.seat,
        cards: h.cards,
      }));
      await this.withRetry(() =>
        this.deps.backend.insertHoleCards(this.hostTableId, this.handNumber, rows)
      );
    } catch (err) {
      this.logger.error(`[LightningHost:${this.instanceId}] could not deal`, err);
      await this.abandon('deal_failed');
    }
  }

  /** Leadership or lease lost: abandon unless settlement already started. */
  async abort(reason: string): Promise<void> {
    if (this.state === 'settling') return this.finished;
    await this.abandon(reason);
  }

  private checkFormation(participants: LightningParticipant[]): string | null {
    const ids = new Set(participants.map((p) => p.playerId));
    if (ids.size !== participants.length) return 'formation_player_repeated';
    if (ids.size !== this.formed.players.length || !this.formed.players.every((p) => ids.has(p)))
      return 'formation_participants_disagree';
    const seatsTaken = new Set(participants.map((p) => p.seat));
    if (seatsTaken.size !== participants.length) return 'formation_seat_repeated';
    const btn = participants.filter((p) => p.position === 'btn');
    if (btn.length !== 1 || btn[0].playerId !== this.formed.btn)
      return 'formation_button_disagrees';
    const sb = participants.find((p) => p.playerId === this.formed.sb);
    const bb = participants.find((p) => p.playerId === this.formed.bb);
    if (!sb || !bb || sb.blindRole !== 'sb' || bb.blindRole !== 'bb')
      return 'formation_blinds_disagree';
    if (participants.some((p) => !(p.stackBefore > 0))) return 'formation_stack_invalid';
    return null;
  }

  private checkVariant(rules: LightningHostRules): string | null {
    // Pineapple's discard round needs the physical discard pipeline (the live
    // horse-decision worker and the discard door); a Lightning Cluster of
    // those games is not dealt here, and the instance is voided unplayed.
    if (rules.game_variant === 'pineapple' || rules.pineapple_holdem === true)
      return 'variant_not_dealt_by_lightning_host';
    return null;
  }

  private buildHandConfig(rules: LightningHostRules, sbSeat: number, bbSeat: number): HandConfig {
    const sb = Number(rules.small_blind);
    const bb = Number(rules.big_blind);
    const variant = String(rules.game_variant || 'nlh');
    const pick = (a: unknown, b: unknown) => {
      const na = a === null || a === undefined ? NaN : Number(a);
      if (Number.isFinite(na) && na >= 0) return na;
      const nb = b === null || b === undefined ? NaN : Number(b);
      if (Number.isFinite(nb) && nb >= 0) return nb;
      return undefined;
    };
    const club = rules.club_rake_defaults as {
      rakePercent: number | null;
      rakeCapBB: number | null;
    } | null;
    const rakePercent = pick(rules.rake_percent, club?.rakePercent);
    const rakeCapBB = pick(rules.rake_cap_bb, club?.rakeCapBB);
    const full = getFullRakeConfig(
      sb,
      bb,
      variant,
      rakePercent === undefined && rakeCapBB === undefined ? undefined : { rakePercent, rakeCapBB }
    );
    return {
      asset: rules.arena?.asset ?? 'chips',
      tableId: this.hostTableId,
      handNumber: this.handNumber,
      isTournament: false,
      gameVariant: variant as GameVariant,
      smallBlind: sb,
      bigBlind: bb,
      // A cash table's ante follows its toggle, exactly as the engine's.
      ante: (rules.ante_enabled ?? true) ? rules.ante : undefined,
      bigBlindAnte: rules.big_blind_ante_enabled ?? false,
      allInOrFold: rules.all_in_or_fold ?? false,
      // OFF in Lightning: bomb pots, kill pots, straddles, run it twice, insurance.
      bombPot: undefined,
      killPot: undefined,
      straddles: undefined,
      ritEnabled: false,
      insuranceEnabled: false,
      // THE BARRIER'S BLINDS, never re-derived from the button.
      blindSeats: { smallBlind: sbSeat, bigBlind: bbSeat },
      rakeConfig: {
        percent: full.rakePercent,
        cap: full.rakeCap,
        noFlopNoDrop: true,
        playerCountCaps: getPlayerCountCaps(full.rakeCap, Number(rules.max_players) || null),
      },
      bbjConfig: {
        enabled: full.bbjEnabled && (rules.bbj_percent ?? 100) > 0,
        feeBB: full.bbjFeeBB,
        minPotBB: full.rules.minPotBB,
        minPlayersDealt: full.rules.minPlayersDealt,
      },
    };
  }

  private configureClocks(rules: LightningHostRules): void {
    this.timeBank.configure(this.timerKey, {
      totalBankSeconds: (rules.time_bank_max_uses ?? 120) * 20,
      maxUses: rules.time_bank_max_uses ?? 120,
      secondsPerUse: 20,
      autoActivate: rules.time_bank_enabled ?? true,
    });
    this.disconnect.configure(this.timerKey, {
      disconnectTimeoutSeconds: rules.disconnect_timeout_seconds ?? 30,
      maxConsecutiveTimeouts: rules.max_consecutive_timeouts ?? 3,
      preferCheckOverFold: rules.prefer_check_over_fold ?? true,
      reconnectGraceSeconds: 5,
    });
    for (const p of this.participants.values()) {
      const bank = this.deps.timeBanks.get(p.playerId);
      this.timeBank.initializePlayer(this.timerKey, p.playerId, {
        remainingSeconds: bank?.remainingSeconds,
        usesRemaining: bank?.usesRemaining,
        unlimitedActivations: bank?.unlimited === true,
      });
      this.disconnect.registerPlayer(this.timerKey, p.playerId);
      if (this.connected(p.playerId)) this.disconnect.heartbeat(this.timerKey, p.playerId);
    }
  }

  private connected(playerId: string): boolean {
    const p = this.participants.get(playerId);
    if (!p) return false;
    if (p.isHorse) return true; // the engine heartbeats a horse; a horse has no browser
    return this.deps.isConnected?.(playerId, p.poolSessionId) ?? false;
  }

  /** The registry saw a socket arrive or leave in this player's room. */
  notePresence(playerId: string, connected: boolean): void {
    if (!this.participants.has(playerId) || this.isTerminal()) return;
    if (connected) this.disconnect.heartbeat(this.timerKey, playerId);
    else this.disconnect.markTransportGone(this.timerKey, playerId);
  }

  private isTerminal(): boolean {
    return (
      this.state === 'complete' ||
      this.state === 'abandoned' ||
      this.state === 'settlement_unknown' ||
      this.state === 'frozen'
    );
  }

  // ─── PUBLISHING ─────────────────────────────────────────────────────────

  /** Every room still shown this hand, with its owner. */
  private rooms(): Array<[string, string]> {
    return [...this.watching];
  }

  private emitAll(frame: Record<string, unknown> | null): void {
    if (!frame) return;
    for (const [, room] of this.rooms())
      this.deps.hub.emitEvent(room, { ...frame, table_id: room });
  }

  private publishState(): void {
    const hc = this.hc;
    if (!hc || !this.rules) return;
    const state = hc.getState();
    const anonymous = this.rules.is_anonymous === true;
    const base = projectLiveHandState(state, {
      table_id: '',
      hand_number: this.handNumber,
      dealerSeatFallback: state.dealerSeat,
      hand_variant: String(this.rules.game_variant || 'nlh'),
      boardExtras: this.anteFields(),
      winnerIds: this.winners.map((w) => w.userId),
      winners: this.winners,
      bettingStructure: this.bettingFields(state),
      action_context: playerActionContext(hc),
      turn_start_time_ms: this.turnStartMs,
      turnDurationSeconds: this.turnDurationSec,
      server_time_ms: this.now(),
      pineappleFields: { discard_deadline_ms: null, discard_deadlines: {}, discard_duration_ms: 0 },
      time_bank_active: this.timeBankActive,
      disconnect_states: this.disconnect.getFsmStatesForTable(this.timerKey),
      max_seats: Number(this.rules.max_players) || 0,
      is_anonymous: anonymous,
      waitingForBB: new Set(),
      postBBWhenClear: new Set(),
      postingBBToEnter: new Set(),
      showdownResults: this.showdown,
      seats: {
        seatIdentity: (p) => {
          const part = this.participants.get(p.user_id);
          if (anonymous)
            return {
              username: `Player ${p.seat}`,
              avatar_url: '',
              equipped_frame: '',
              equipped_aura: '',
            };
          return {
            username: part?.username ?? p.username ?? '',
            avatar_url: part?.avatarUrl ?? '',
            equipped_frame: part?.equippedFrame ?? '',
            equipped_aura: part?.equippedAura ?? '',
          };
        },
        seatPresence: (p) => ({
          is_sitting_out: false,
          is_disconnected: !this.disconnect.isConnected(this.timerKey, p.user_id),
          time_bank_remaining: this.timeBank.getRemainingSeconds(this.timerKey, p.user_id),
          time_bank_uses_remaining: this.timeBank.getUsesRemaining(this.timerKey, p.user_id),
        }),
        seatContinuity: () => ({}),
      },
      reveal: {
        runoutRevealActive: this.runoutRevealActive,
        isMuckedAtShowdown: (userId) => this.isMucked(userId),
        showHandCards: null,
        handHasWinners: this.winners.length > 0,
      },
    });
    for (const [playerId, room] of this.rooms()) {
      this.deps.hub.publish(room, {
        ...base,
        table_id: room,
        hand_id: this.handId,
        lightning: this.lightningBlock(playerId, state),
      });
    }
  }

  /**
   * The client's Lightning block (phase 6 client contract). Never the
   * instance id. `fast_fold_available` is the host's own rule: whenever fold
   * is legal on the player's turn, or before it while they face a bet.
   */
  private lightningBlock(playerId: string, state: GameState | null): Record<string, unknown> {
    const rules = this.rules!;
    return {
      hand_id: this.handId,
      cluster_id: this.clusterId,
      name: rules.name ?? null,
      small_blind: Number(rules.small_blind),
      big_blind: Number(rules.big_blind),
      variant: String(rules.game_variant || 'nlh'),
      fast_fold_available: state ? this.foldAvailable(playerId, state) : false,
    };
  }

  /** May this player LIGHTNING FOLD (or FOLD & WATCH) right now? */
  foldAvailable(playerId: string, state: GameState): boolean {
    if (this.state !== 'dealing' || !this.hc) return false;
    const me = state.players.find((p) => p.user_id === playerId);
    if (!me || me.is_folded || me.is_all_in || this.pendingFolds.has(playerId)) return false;
    if (!this.watching.has(playerId) || !BETTING_STAGES.has(state.stage)) return false;
    if (state.currentPlayerSeat === me.seat) {
      return this.hc.getAuthoritativeActionState(playerId)?.legalActions.includes('fold') === true;
    }
    return state.currentBet - me.bet > 0;
  }

  /**
   * The idle shape: no hand in this room. Sent to a room this hand stops
   * publishing to - every room on an abandon, and a folder's room at the
   * fold - so the client shows the next-hand state rather than a frozen felt.
   */
  private idleShape(room: string): Record<string, unknown> {
    const rules = this.rules!;
    return {
      table_id: room,
      hand_id: null,
      lightning: {
        hand_id: null,
        cluster_id: this.clusterId,
        name: rules.name ?? null,
        small_blind: Number(rules.small_blind),
        big_blind: Number(rules.big_blind),
        variant: String(rules.game_variant || 'nlh'),
        fast_fold_available: false,
      },
      hand_number: this.handNumber,
      pot: 0,
      community_cards: [],
      community_cards2: [],
      community_cards3: [],
      hand_variant: String(rules.game_variant || 'nlh'),
      current_bet: 0,
      current_player: null,
      dealer_seat: 0,
      stage: 'waiting',
      winner_ids: [],
      winners: [],
      min_raise: 0,
      last_raise: 0,
      turn_start_time_ms: 0,
      turn_duration_ms: 0,
      server_time_ms: this.now(),
      turn_deadline_ms: 0,
      discard_deadline_ms: null,
      discard_deadlines: {},
      discard_duration_ms: 0,
      time_bank_active: false,
      disconnect_states: {},
      max_seats: Number(rules.max_players) || 0,
      is_anonymous: rules.is_anonymous === true,
      waiting_for_bb_user_ids: [],
      post_bb_deferred_user_ids: [],
      posting_bb_user_ids: [],
      pots: [],
      action_history: [],
      players: [],
    };
  }

  /** After an abandon: every room still shown the hand is told the felt is empty. */
  private publishIdle(): void {
    if (!this.rules) return;
    for (const [, room] of this.rooms()) this.deps.hub.publish(room, this.idleShape(room));
  }

  private anteFields(): Record<string, unknown> {
    const rules = this.rules!;
    const on = rules.ante_enabled ?? true;
    const ante = on ? Number(rules.ante ?? 0) : 0;
    if (!(ante > 0)) return { ante: 0, ante_mode: null };
    return { ante, ante_mode: rules.big_blind_ante_enabled === true ? 'big_blind' : 'per_player' };
  }

  /** The engine's bettingStructureFields, for this hand's variant. */
  private bettingFields(state: GameState): Record<string, unknown> {
    const structure = bettingStructureFor(String(this.rules?.game_variant || 'nlh'));
    if (structure === 'pot_limit') {
      return { betting_structure: structure, pot_limit_pot: potLimitBettingPot(state) };
    }
    if (structure !== 'fixed_limit') return { betting_structure: structure };
    const stage = state.stage ?? 'preflop';
    const streetBet = fixedLimitBetSize(
      this.hc?.getFixedLimitSmallBet?.() ?? Number(this.rules?.big_blind) ?? 2,
      stage
    );
    return {
      betting_structure: structure,
      fixed_bet_size: streetBet,
      fixed_raise_size: fixedLimitStreetBounds(
        state.actionHistory ?? [],
        stage,
        streetBet,
        state.currentBet
      ).raiseSize,
      wagers_capped: isFixedLimitCapped(state.actionHistory ?? [], stage, streetBet),
    };
  }

  /** The player's private copy of their cards, again (resync / reconnect). */
  rePushHoleCards(playerId: string): void {
    const h = this.holeCards.get(playerId);
    const room = this.watching.get(playerId);
    if (!h || !room || this.isTerminal()) return;
    this.sendHoleCards(playerId, room, h.seat, h.cards);
  }

  private sendHoleCards(playerId: string, room: string, seat: number, cards: Card[]): void {
    this.deps.hub.sendToUser(room, playerId, {
      kind: 'hole_cards',
      row: {
        table_id: room,
        user_id: playerId,
        seat_number: seat,
        hand_number: this.handNumber,
        cards,
      },
    });
  }

  // ─── HAND EVENTS ────────────────────────────────────────────────────────

  private onHandEvent(event: HandEvent): void {
    if (this.isTerminal()) return;
    const hc = this.hc!;
    const now = this.now();
    switch (event.type) {
      case 'HAND_START':
        this.handStartAtMs = now;
        this.emitAll(
          handStartedFrame({
            tableId: '',
            handNumber: this.handNumber,
            dealerSeat: hc.getState().dealerSeat ?? 0,
            timestamp: now,
          })
        );
        this.publishState();
        break;
      case 'BLINDS_POSTED' as any: {
        const postings = (
          event as unknown as { postings?: Array<{ seat: number; type: string; amount: number }> }
        ).postings;
        this.emitAll(
          blindsPostedFrame({ tableId: '', handNumber: this.handNumber, postings, timestamp: now })
        );
        break;
      }
      case 'FORCED_BETS_POSTED':
        if (Array.isArray(event.postings)) {
          this.emitAll(
            antesPostedFrame({
              tableId: '',
              handNumber: this.handNumber,
              postings: event.postings,
              timestamp: now,
            })
          );
          for (const p of event.postings) {
            if (!p || !(p.amount > 0)) continue;
            this.actions.push({
              seat: p.seat,
              userId: p.userId ?? '',
              action: p.kind,
              amount: p.amount,
              timestamp: now,
              stage: 'preflop',
              origin: 'forced',
              dead: p.dead === true,
            });
          }
        }
        break;
      case 'UNCALLED_BET_RETURNED':
        if (event.amount > 0) {
          this.actions.push({
            seat: event.seat,
            userId: event.userId,
            action: 'return',
            historyEvent: 'uncalled_bet_returned',
            amount: event.amount,
            timestamp: now,
            stage: hc.getState().stage,
          });
        }
        break;
      case 'CARDS_DEALT': {
        const player = hc.getState().players.find((p) => p.seat === event.seat);
        if (!player) break;
        this.holeCards.set(player.user_id, { seat: player.seat, cards: event.cards });
        const room = this.watching.get(player.user_id);
        // To this player's room, for this player's sockets. Never a hub event.
        if (room) this.sendHoleCards(player.user_id, room, player.seat, event.cards);
        break;
      }
      case 'TURN_CHANGE':
        void this.onTurn(event.seat);
        break;
      case 'PLAYER_ACTION': {
        const st = hc.getState();
        const stage = event.stage ?? st.stage;
        const actor =
          event.record?.userId ?? st.players.find((p) => p.seat === event.seat)?.user_id ?? '';
        this.actions.push({
          seat: event.seat,
          userId: actor,
          action: event.action,
          amount: event.amount,
          timestamp: event.record?.timestamp ?? now,
          stage,
          ...(event.origin ? { origin: event.origin } : {}),
        });
        this.emitAll(
          playerActionFrame({
            tableId: '',
            handNumber: this.handNumber,
            seat: event.seat,
            userId: actor,
            action: event.action,
            amount: event.amount,
            stage,
            timestamp: event.record?.timestamp ?? now,
          })
        );
        this.publishState();
        if (event.action === 'bet' || event.action === 'raise' || event.action === 'all_in') {
          this.preActions.onBetPlaced(this.timerKey, actor);
        }
        if (event.action === 'fold') this.afterFold(actor);
        break;
      }
      case 'COMMUNITY_CARDS': {
        this.lastStreetAtMs = now;
        this.timeBank.resetStreetActivations(this.timerKey);
        this.boards[0] = accumulateBoard(this.boards[0], event.stage, event.cards ?? []);
        if (event.cards2?.length)
          this.boards[1] = accumulateBoard(this.boards[1], event.stage, event.cards2);
        if (event.cards3?.length)
          this.boards[2] = accumulateBoard(this.boards[2], event.stage, event.cards3);
        this.emitAll(
          communityCardsDealtFrame({
            tableId: '',
            handNumber: this.handNumber,
            stage: event.stage,
            newCards: event.cards ?? [],
            board: this.boards[0],
            newCards2: event.cards2 ?? [],
            board2: this.boards[1],
            newCards3: event.cards3 ?? [],
            board3: this.boards[2],
            timestamp: now,
          })
        );
        this.publishState();
        break;
      }
      case 'ALL_IN_RUNOUT':
        this.clearTurn();
        this.runoutRevealActive = true;
        this.publishState();
        void this.runOut();
        break;
      case 'SHOWDOWN':
        this.showdown = normalizeShowdownResults(event.results);
        this.emitAll(
          showdownFrame({
            tableId: '',
            handNumber: this.handNumber,
            results: this.showdown,
            isMuckedAtShowdown: (u) => this.isMucked(u),
          })
        );
        this.publishState();
        break;
      case 'WINNERS': {
        if ((event.winners ?? []).length > 0) {
          this.winners = normalizeWinners(event.winners);
          this.winnersByBoard = (event.winnersByBoard ?? []) as typeof this.winnersByBoard;
          this.perPotAwards = event.perPotAwards ?? [];
        }
        this.publishState();
        break;
      }
      case 'HAND_COMPLETE':
        this.clearTurn();
        void this.complete(event.rake ?? 0, event.bbjFee ?? 0);
        break;
      default:
        break;
    }
  }

  private isMucked(userId: string): boolean {
    return this.showdown.some((r) => r.userId === userId && r.mucked === true);
  }

  // ─── TURNS, CLOCKS AND HORSES ───────────────────────────────────────────

  /** Announce the decision the turn's player owes, with the engine's clock. */
  private announceDecision(userId: string): void {
    const p = this.participants.get(userId);
    if (!p || p.isHorse || !this.deps.onDecision || this.turnUser !== userId) return;
    try {
      this.deps.onDecision(userId, {
        poolSessionId: p.poolSessionId,
        handId: this.handId,
        street: this.hc?.getState().stage ?? 'preflop',
        deadlineAt: this.turnStartMs + this.turnDurationSec * 1000,
      });
      this.decisionOpenFor = userId;
    } catch (err) {
      this.logger.error(`[LightningHost:${this.instanceId}] decision announce failed`, err);
    }
  }

  /** The announced decision is no longer owed: retract it, once. */
  private retractDecision(reason: string): void {
    const userId = this.decisionOpenFor;
    if (!userId) return;
    this.decisionOpenFor = null;
    try {
      this.deps.onDecision?.(userId, null, reason);
    } catch (err) {
      this.logger.error(`[LightningHost:${this.instanceId}] decision retract failed`, err);
    }
  }

  private clearTurn(): void {
    this.retractDecision('turn_moved');
    if (this.turnUser) {
      this.timer.cancelTimer(this.timerKey, this.turnUser);
      this.timeBank.disarm(this.timerKey, this.turnUser);
    }
    if (this.horseTimer) clearTimeout(this.horseTimer);
    this.horseTimer = null;
    this.horseAbort?.abort();
    this.horseAbort = null;
    this.turnUser = null;
    this.turnStartMs = 0;
    this.turnDurationSec = 0;
    this.timeBankActive = false;
  }

  private async onTurn(seat: number): Promise<void> {
    const hc = this.hc;
    if (!hc) return;
    const contextAtTurn = playerActionContext(hc);
    const player = hc.getState().players.find((p) => p.seat === seat);
    if (!player) return;
    this.clearTurn();
    // The physical turn settle: a just-dealt hand or street gets its beat first.
    const now = this.now();
    const settle =
      now - this.handStartAtMs < 1000 ? 400 : now - this.lastStreetAtMs < 1000 ? 500 : 0;
    // Always yields: the turn is never handled inside HandController's own emit.
    await this.sleep(settle);
    if (this.isTerminal() || this.hc !== hc || playerActionContext(hc) !== contextAtTurn) return;

    const userId = player.user_id;
    const pending = this.pendingFolds.get(userId);
    if (pending) {
      // Folded before the turn: executed now, no clock.
      this.applyAction(userId, 'fold', undefined, 'player', pending);
      return;
    }
    if (this.preActions.hasPreAction(this.timerKey, userId)) {
      // The seat lights up for a readable beat (the engine's 250 ms), then the
      // pre-action lands - armed for THIS hand only.
      await this.sleep(250);
      if (this.isTerminal() || this.hc !== hc || playerActionContext(hc) !== contextAtTurn) return;
      if (this.runPreAction(userId)) return;
    }
    const baseSec = Number(this.rules?.action_time_seconds) || 15;
    const grace = this.disconnect.isInReconnectGrace(this.timerKey, userId) ? 5 : 0;
    this.turnUser = userId;
    this.turnStartMs = this.now();
    this.turnDurationSec = baseSec + grace;
    this.timer.startTimer(this.timerKey, userId, this.turnDurationSec * 1000, () =>
      this.onClockExpired(userId, contextAtTurn)
    );
    this.publishState();
    this.emitAll(
      turnChangeFrame({
        actionContext: contextAtTurn,
        tableId: '',
        handNumber: this.handNumber,
        seat,
        userId,
        deadlineMs: this.turnStartMs + this.turnDurationSec * 1000,
        timestamp: this.now(),
      })
    );
    if (this.participants.get(userId)?.isHorse) this.scheduleHorse(userId, contextAtTurn);
    else this.announceDecision(userId);
  }

  /** Execute a queued pre-action now; true when it landed. */
  private runPreAction(userId: string): boolean {
    const st = this.hc?.getState();
    const me = st?.players.find((p) => p.user_id === userId);
    if (!st || !me) return false;
    const toCall = Math.max(0, st.currentBet - me.bet);
    const r = this.preActions.executePreAction(
      this.timerKey,
      userId,
      toCall === 0,
      toCall,
      me.stack
    );
    if (!r.executed || !r.action) return false;
    return this.applyAction(
      userId,
      r.action,
      r.amount,
      'pre_action',
      r.action === 'fold' ? 'normal' : undefined
    ).success;
  }

  /**
   * POST /preaction from a Lightning room. An arm names the hand it is for;
   * an arm for any other hand is refused, and a new hand starts with none.
   */
  setPreAction(
    userId: string,
    action: string,
    maxCallAmount?: number,
    handId?: string
  ): { success: boolean; error?: string; code?: string } {
    if (this.state !== 'dealing' || !this.hc) return { success: false, error: 'No active hand' };
    if (!this.watching.has(userId)) return { success: false, error: 'You have left this hand' };
    if (action === 'clear') {
      this.preActions.clearPreAction(this.timerKey, userId);
      return { success: true };
    }
    if (handId !== this.handId) {
      return { success: false, error: 'That hand is over', code: 'STALE_HAND' };
    }
    const valid = ['auto_fold', 'auto_check_fold', 'auto_check', 'auto_call', 'auto_call_any'];
    if (!valid.includes(action)) return { success: false, error: `Invalid pre-action: ${action}` };
    const st = this.hc.getState();
    const me = st.players.find((p) => p.user_id === userId);
    if (!me || me.is_folded) return { success: false, error: 'Player not found at this table' };
    this.preActions.setPreAction(
      this.timerKey,
      userId,
      action as PreActionType,
      maxCallAmount,
      Math.max(0, st.currentBet - me.bet)
    );
    // Armed during the player's own turn: it acts now, as at a physical table.
    if (st.currentPlayerSeat === me.seat && this.turnUser === userId) this.runPreAction(userId);
    return { success: true };
  }

  private onClockExpired(userId: string, context: string | null): void {
    if (this.isTerminal() || !this.hc || playerActionContext(this.hc) !== context) return;
    const banked = this.timeBank.onPrimaryTimerExpired(this.timerKey, userId, () =>
      this.timeoutAct(userId, context)
    );
    if (!banked) this.timeoutAct(userId, context);
  }

  private timeoutAct(userId: string, context: string | null): void {
    if (this.isTerminal() || !this.hc || playerActionContext(this.hc) !== context) return;
    if (this.decisionOpenFor === userId) this.retractDecision('timed_out');
    const auth = this.hc.getAuthoritativeActionState(userId);
    this.disconnect.recordConnectedTimeout(this.timerKey, userId);
    if (auth?.legalActions.includes('check'))
      this.applyAction(userId, 'check', undefined, 'unknown');
    else this.applyAction(userId, 'fold', undefined, 'unknown', 'normal');
  }

  private onTimeBankEvent(e: TimeBankEvent): void {
    if (e.type === 'TIME_BANK_ACTIVATED') {
      this.timeBankActive = true;
      const secs = Number(e.secondsGranted) || 0;
      this.turnDurationSec += secs;
      this.publishState();
      // The decision's deadline moved: every room hears the new one.
      if (this.decisionOpenFor === e.playerId) this.announceDecision(e.playerId);
    }
    const room = this.watching.get(e.playerId);
    if (!room) return;
    if (
      e.type === 'TIME_BANK_ACTIVATED' ||
      e.type === 'TIME_BANK_STOPPED' ||
      e.type === 'TIME_BANK_EXPIRED' ||
      e.type === 'TIME_BANK_DEPLETED'
    ) {
      // The engine's narrowed time-bank frame, to every room still shown the hand.
      for (const [, r] of this.rooms()) {
        this.deps.hub.emitEvent(r, {
          type: e.type,
          tableId: r,
          playerId: e.playerId,
          secondsUsed: e.secondsUsed,
          remainingSeconds: e.remainingSeconds,
          usesRemaining: e.usesRemaining,
        });
      }
    }
  }

  /**
   * A horse decides in the live horse decision lane (the physical tables'
   * own lane, with its own style, mods and mind) and acts inside the same
   * turn clock, through the same action door, after the physical engine's
   * think time. A failed job gets the liveness answer; an abort (the turn
   * moved on) does nothing.
   */
  private scheduleHorse(userId: string, context: string | null): void {
    const hc = this.hc!;
    const rules = this.rules!;
    const me = hc.getState().players.find((p) => p.user_id === userId);
    if (!me) return;
    this.horseAbort?.abort();
    const abort = new AbortController();
    this.horseAbort = abort;
    const generation = ++this.horseGeneration;
    const lane = this.deps.horseLane ?? getLiveHorseDecisionWorker;
    const decisionAt = this.now();
    const allInOrFold = rules.all_in_or_fold === true;
    const current = () =>
      !abort.signal.aborted &&
      !this.isTerminal() &&
      this.hc === hc &&
      this.turnUser === userId &&
      playerActionContext(hc) === context;
    void decideLightningHorse(
      {
        hc,
        userId,
        seat: me.seat,
        horseProfile: this.participants.get(userId)?.horseProfile,
        variant: String(rules.game_variant || 'nlh'),
        bigBlind: Number(rules.big_blind) || 2,
        smallBlind: Number(rules.small_blind) || 1,
        ante: (rules.ante_enabled ?? true) ? Number(rules.ante ?? 0) || 0 : 0,
        bigBlindAnte: rules.big_blind_ante_enabled === true,
        allInOrFold,
        actionTimeSeconds: Number(rules.action_time_seconds) || undefined,
        actions: this.actions,
        generation,
        fence: [this.hostTableId, this.handNumber, me.seat, generation].join(':'),
        turnStartMs: this.turnStartMs,
        now: decisionAt,
      },
      abort.signal,
      lane,
      (err) =>
        this.logger.error(`[LightningHost:${this.instanceId}] horse decision worker failed`, err)
    )
      .then((decision) => {
        if (!current()) return;
        const actionTimeMs = (Number(rules.action_time_seconds) || 15) * 1000;
        const bankSeconds = this.timeBank.getRemainingSeconds(this.timerKey, userId);
        const bankUses = this.timeBank.getUsesRemaining(this.timerKey, userId);
        const bankUsable =
          rules.time_bank_enabled !== false &&
          bankUses !== 0 &&
          bankSeconds * 1000 > LIGHTNING_HORSE_MAX_BANK_BURN_MS + 2000;
        const think = lightningHorseThinkTimeMs({
          requested: decision.thinkTime,
          actionTimeMs,
          workerFallback: decision.workerFallback,
          bankUsable,
        });
        const delay = Math.max(0, think - (this.now() - decisionAt));
        if (this.horseTimer) clearTimeout(this.horseTimer);
        this.horseTimer = setTimeout(() => {
          this.horseTimer = null;
          if (!current() || !this.hc) return;
          const shaped = shapeLightningHorseAction(this.hc, userId, decision, allInOrFold);
          const r = this.applyAction(
            userId,
            shaped.action,
            shaped.amount,
            decision.workerFallback ? 'horse_fallback' : 'horse_policy'
          );
          const fast = decision.fast;
          if (
            r.success &&
            fast &&
            fast.planBinding !== null &&
            fast.planIssueDisposition === 'issued' &&
            fast.effects.length > 0 &&
            (shaped.action === 'bet' || shaped.action === 'raise')
          ) {
            void lane()
              .commitDecisionEffects(fast)
              .catch((err) =>
                this.logger.error(
                  `[LightningHost:${this.instanceId}] horse decision effects not committed`,
                  err
                )
              );
          }
          if (!r.success && this.hc) {
            const auth = this.hc.getAuthoritativeActionState(userId);
            this.applyAction(
              userId,
              auth?.legalActions.includes('check') ? 'check' : 'fold',
              undefined,
              'horse_fallback'
            );
          }
        }, delay);
        (this.horseTimer as { unref?: () => void }).unref?.();
      })
      .catch(() => undefined /* aborted: the turn moved on */);
  }

  // ─── ACTIONS ────────────────────────────────────────────────────────────

  /**
   * The action door for a player (LightningSeatProxy). Same contract as the
   * engine's: the action context the client saw must still be current.
   */
  handlePlayerAction(
    userId: string,
    action: string,
    amount?: number,
    actionContext?: string | null
  ): { success: boolean; error?: string; code?: string } {
    const receivedAt = this.now();
    if (this.state !== 'dealing' || !this.hc)
      return { success: false, error: 'No active hand', code: 'NO_ACTIVE_HAND' };
    if (!this.participants.has(userId))
      return { success: false, error: 'Player not found at this table' };
    const normalized = String(action ?? '').toLowerCase();
    if (normalized === 'fast_fold' || normalized === 'fold_watch') {
      const out = this.requestFold(userId, normalized === 'fast_fold' ? 'fast' : 'fold_watch');
      if (out.success) this.metrics.observeLatency('fold_ack', this.now() - receivedAt);
      return out;
    }
    if (!this.watching.has(userId)) return { success: false, error: 'You have left this hand' };
    if (
      actionContext !== undefined &&
      (typeof actionContext !== 'string' || actionContext !== playerActionContext(this.hc))
    ) {
      return {
        success: false,
        code: actionContext === null ? 'ACTION_CONTEXT_REQUIRED' : 'STALE_ACTION',
        error:
          actionContext === null
            ? 'The table view is out of date. Reload to continue.'
            : 'The turn has changed. Review the table before acting again.',
      };
    }
    return this.applyAction(
      userId,
      normalized,
      amount,
      'player',
      normalized === 'fold' ? 'normal' : undefined
    );
  }

  /** FAST FOLD / FOLD & WATCH (spec FAST FOLD): validate, fold, free the player. */
  private requestFold(
    userId: string,
    type: 'fast' | 'fold_watch'
  ): { success: boolean; error?: string; code?: string } {
    const hc = this.hc!;
    const st = hc.getState();
    const me = st.players.find((p) => p.user_id === userId);
    if (!me || !this.watching.has(userId))
      return { success: false, error: 'You have left this hand' };
    if (me.is_folded || this.pendingFolds.has(userId))
      return { success: false, error: 'Already folded' };
    if (me.is_all_in) return { success: false, error: 'Fold is not available' };
    if (!BETTING_STAGES.has(st.stage)) return { success: false, error: 'Fold is not available' };
    if (!this.foldAvailable(userId, st)) return { success: false, error: 'Fold is not available' };
    if (st.currentPlayerSeat === me.seat)
      return this.applyAction(userId, 'fold', undefined, 'player', type);
    // Before the turn: only while facing a bet (foldAvailable), so the bettor stays live.
    this.pendingFolds.set(userId, type);
    this.afterFold(userId);
    return { success: true };
  }

  private applyAction(
    userId: string,
    action: string,
    amount: number | undefined,
    origin: 'player' | 'pre_action' | 'horse_policy' | 'horse_fallback' | 'unknown',
    foldType?: LightningFoldType
  ): { success: boolean; error?: string; code?: string } {
    const hc = this.hc;
    if (!hc || this.state !== 'dealing') return { success: false, error: 'No active hand' };
    if (this.actionLock)
      return { success: false, error: 'Action already being processed - try again' };
    const st = hc.getState();
    const player = st.players.find((p) => p.user_id === userId);
    if (!player) return { success: false, error: 'Player not found at this table' };
    if (st.currentPlayerSeat !== player.seat) return { success: false, error: 'Not your turn' };
    const toCall = Math.max(0, st.currentBet - player.bet);
    let a = action;
    if (a === 'allin' || a === 'all-in') a = 'all_in';
    if (a === 'check' && toCall > 0) a = 'call';
    if (a === 'call' && toCall === 0) a = 'check';
    if (a === 'raise' && st.currentBet === 0) a = 'bet';
    if (a === 'bet' && st.currentBet > 0) a = 'raise';
    // A wager of the whole stack is an all-in, as it is at every other table
    // door: the controller sizes it from the seat, not from the request.
    if (
      (a === 'raise' || a === 'bet') &&
      typeof amount === 'number' &&
      amount >= player.bet + player.stack - 0.005
    ) {
      a = 'all_in';
      amount = undefined;
    }
    if (a === 'call') amount = toCall;
    if (a === 'fold' && foldType) this.foldTypes.set(userId, foldType);
    this.actionLock = true;
    let ok = false;
    try {
      this.disconnect.recordPlayerActed(this.timerKey, userId);
      if (this.timeBankActive || this.timeBank.isArmed(this.timerKey, userId)) {
        this.timeBank.playerActed(this.timerKey, userId);
      }
      this.timer.cancelTimer(this.timerKey, userId);
      ok = hc.performAction(player.seat, a as ActionType, amount, origin);
    } finally {
      this.actionLock = false;
    }
    if (!ok) {
      if (a === 'fold' && foldType) this.foldTypes.delete(userId);
      // The clock keeps running for the decision that is still owed.
      if (this.turnUser === userId && !this.timer.getDeadline(this.timerKey, userId)) {
        const remaining = this.turnStartMs + this.turnDurationSec * 1000 - this.now();
        const context = playerActionContext(hc);
        this.timer.startTimer(this.timerKey, userId, Math.max(0, remaining), () =>
          this.onClockExpired(userId, context)
        );
      }
      return { success: false, error: 'Action rejected by engine', code: 'INVALID_ACTION' };
    }
    if (this.decisionOpenFor === userId) this.retractDecision(a === 'fold' ? 'folded' : 'acted');
    return { success: true };
  }

  /**
   * After a fold (or a fold requested ahead of the turn): record it, and for
   * 'fast' and 'normal' stop showing this hand to the player and free them.
   */
  private afterFold(userId: string): void {
    const type = this.pendingFolds.get(userId) ?? this.foldTypes.get(userId) ?? 'normal';
    this.foldTypes.set(userId, type);
    if (this.releasedOrRecorded.has(userId)) return;
    this.releasedOrRecorded.add(userId);
    // Their bank can change no further in this hand: record it now, so a
    // second hand they are dealt meanwhile reads what this one left.
    this.recordBank(userId);
    if (type !== 'fold_watch') {
      // The room stops hearing this hand: tell it so first (the idle shape),
      // or the client keeps the folded hand's felt until the next one deals.
      const room = this.watching.get(userId);
      if (room && this.rules) this.deps.hub.publish(room, this.idleShape(room));
      this.watching.delete(userId);
    }
    const ackAt = this.now();
    // What the folder has put in the pot: no more can follow a fold.
    const committed = cents(
      this.hc?.getState().players.find((p) => p.user_id === userId)?.totalInvested ?? 0
    );
    void this.withRetry(async () => {
      const out = await this.deps.backend.fastFold(
        this.handId,
        userId,
        lightningRequestId(this.handId, `fold/${userId}`),
        type,
        committed
      );
      if (!out.ok && out.transport) throw new Error(out.reason);
      return out;
    })
      .then((out) => {
        if (!out?.ok) return;
        this.metrics.recordFold(type);
        if (type !== 'fold_watch') {
          this.metrics.observeLatency('ack_to_idle_pool', this.now() - ackAt);
          this.metrics.noteIdle(userId, this.now(), type);
          this.deps.onPlayerReleased?.(userId, type);
        }
      })
      .catch((err) =>
        this.logger.error(
          `[LightningHost:${this.instanceId}] fast fold not recorded for ${userId}`,
          err
        )
      );
  }
  private releasedOrRecorded = new Set<string>();

  // ─── RUNOUT, COMPLETION AND SETTLEMENT ──────────────────────────────────

  private async runOut(): Promise<void> {
    const hc = this.hc!;
    const pace = HAND_COMPLETION.ALL_IN_STREET_REVEAL_MS + HAND_COMPLETION.ALL_IN_STREET_PAUSE_MS;
    for (let street = 0; street < 4; street++) {
      await this.sleep(pace);
      if (this.isTerminal() || this.hc !== hc) return;
      const before = hc.getState().communityCards.length;
      const r = hc.dealNextStreet();
      if (r.complete) {
        hc.finalizeRunout(false);
        return;
      }
      if (r.board.length === before) return void (await this.abandon('runout_stalled'));
    }
    if (!this.isTerminal() && this.hc === hc && this.state === 'dealing') hc.finalizeRunout(false);
  }

  private async complete(rake: number, bbj: number): Promise<void> {
    if (this.state !== 'dealing' || !this.hc) return;
    this.state = 'settling';
    const hc = this.hc;
    const state = hc.getState();
    const now = this.now();
    this.emitAll({
      type: 'table_locked',
      table_id: '',
      hand_number: this.handNumber,
      reason: 'settlement',
      timestamp: now,
    });
    this.emitAll({
      type: 'hand_complete',
      table_id: '',
      hand_number: this.handNumber,
      winner_ids: this.winners.map((w) => w.userId),
      timestamp: now,
    });
    const reveal = showdownCardsRevealedFrame({
      tableId: '',
      handNumber: this.handNumber,
      results: this.showdown,
      isMuckedAtShowdown: (u) => this.isMucked(u),
      timestamp: now,
    });
    this.emitAll(reveal);
    if (this.winners.length > 0) {
      if (this.showdown.length >= 2) await this.sleep(HAND_COMPLETION.SHOWDOWN_READ_BASE_MS);
      const capturedPots = state.pots.map((p) => ({
        amount: p.amount,
        eligiblePlayers: p.eligiblePlayers,
      }));
      this.emitAll(
        potWinFrame({
          tableId: '',
          emitHandNumber: this.handNumber,
          capturedWinnerIds: this.winners.map((w) => w.userId),
          capturedPotSize: state.pot,
          capturedBoard: state.communityCards,
          capturedWinners: this.winners,
          capturedShowdownResults: this.showdown,
          capturedWinnersByBoard: this.winnersByBoard,
          capturedPotAwards: this.perPotAwards,
        })
      );
      this.emitAll(
        potDistributedFrame({
          tableId: '',
          emitHandNumber: this.handNumber,
          capturedPotSize: state.pot,
          capturedPots,
          capturedWinners: this.winners,
          timestamp: this.now(),
        })
      );
    }
    await this.settle(state, rake, bbj);
  }

  /** The per-player results, proved to conserve chips before anything is sent. */
  buildResults(state: GameState, rake: number, bbj: number): LightningSettleResult[] | null {
    const wonBy = new Map<string, number>();
    for (const w of this.winners) wonBy.set(w.userId, cents((wonBy.get(w.userId) ?? 0) + w.amount));
    let before = 0;
    let after = 0;
    const results: LightningSettleResult[] = [];
    for (const p of state.players) {
      const part = this.participants.get(p.user_id);
      if (!part) return null;
      const contributed = cents(p.totalInvested ?? 0);
      const won = wonBy.get(p.user_id) ?? 0;
      if (Math.abs(cents(part.stackBefore - contributed + won) - cents(p.stack)) > 0.005)
        return null;
      before += part.stackBefore;
      after += p.stack;
      const shown = this.showdown.find((r) => r.userId === p.user_id);
      results.push({
        playerId: p.user_id,
        stackAfter: cents(p.stack),
        contributed,
        won,
        foldType: p.is_folded ? (this.foldTypes.get(p.user_id) ?? 'normal') : 'none',
        showed: !!shown && !this.isMucked(p.user_id),
      });
    }
    if (results.length !== this.participants.size) return null;
    if (Math.abs(cents(after + rake + bbj) - cents(before)) > 0.005) return null;
    return results;
  }

  private handRow(state: GameState, rake: number, bbj: number): Record<string, unknown> {
    const rules = this.rules!;
    const holeCardsByUser: Record<string, Array<{ rank: string; suit: string }>> = {};
    for (const sd of this.showdown) {
      if (!this.isMucked(sd.userId) && sd.holeCards?.length)
        holeCardsByUser[sd.userId] = sd.holeCards;
    }
    const btn = [...this.participants.values()].find((p) => p.position === 'btn');
    return {
      table_id: this.hostTableId,
      tournament_id: null,
      hand_number: this.handNumber,
      game_variant: rules.game_variant,
      small_blind: Number(rules.small_blind),
      big_blind: Number(rules.big_blind),
      pot_size: state.pot,
      rake_amount: rake,
      bbj_amount: bbj,
      community_cards: this.boards[0],
      community_cards2: null,
      community_cards3: null,
      bomb_pot: null,
      rit_boards: null,
      started_at: new Date(this.startedAtMs).toISOString(),
      ended_at: new Date(this.now()).toISOString(),
      winners: this.winners.map((w) => ({
        userId: w.userId,
        amount: w.amount,
        potIndex: w.potIndex ?? 0,
        ...(w.hand ? { hand: { name: w.hand.name, ranking: w.hand.ranking } } : {}),
      })),
      winners_by_board: null,
      pots: state.pots.map((p, index) => ({
        index,
        amount: cents(p.amount),
        eligible: p.eligiblePlayers,
      })),
      // Never a hole card here: the record keeps names and stacks only.
      players: state.players.map((p) => ({
        userId: p.user_id,
        username: this.participants.get(p.user_id)?.username ?? '',
        seat: p.seat,
        stack: p.stack,
        cards: [] as string[],
      })),
      actions: this.actions,
      hole_cards: Object.keys(holeCardsByUser).length > 0 ? holeCardsByUser : null,
      board: this.boards[0].length ? this.boards[0] : null,
      button_seat: btn?.seat ?? null,
      showdown: this.showdown.length
        ? this.showdown.map((r) => ({
            user_id: r.userId,
            seat: r.seat ?? -1,
            reveal_order: r.revealOrder ?? 0,
            mucked: this.isMucked(r.userId),
            hand_name: this.isMucked(r.userId) ? undefined : r.handName,
            hand_description: this.isMucked(r.userId) ? undefined : r.handDescription,
          }))
        : null,
      daily_mission_events: null,
      // Weighted contributed rake: the uncalled amounts returned, by player.
      returned_uncalled: Object.fromEntries(
        state.players
          .filter((p) => (p.returnedUncalled ?? 0) > 0)
          .map((p) => [p.user_id, cents(p.returnedUncalled ?? 0)])
      ),
      has_human: [...this.participants.values()].some((p) => !p.isHorse),
    };
  }

  private async settle(state: GameState, rake: number, bbj: number): Promise<void> {
    const results = this.buildResults(state, rake, bbj);
    if (!results) {
      this.state = 'dealing'; // let abandon() run: no settlement was attempted
      return void (await this.abandon('conservation_check_failed'));
    }
    const requestId = lightningRequestId(this.handId, 'settle');
    const handRow = this.handRow(state, rake, bbj);
    for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
      const lease = this.deps.leaseFor(this.hostTableId);
      if (!lease) {
        this.state = 'dealing';
        return void (await this.abandon('host_lease_lost_before_settlement'));
      }
      const out = await this.deps.backend.settle({
        handId: this.handId,
        requestId,
        hostTableId: this.hostTableId,
        leaseInstance: lease.instance,
        leaseGeneration: lease.generation,
        results,
        rake,
        bbj,
        handRow,
      });
      if (out.ok) {
        this.state = 'complete';
        await this.drainPostCommit(out.value.handHistoryId);
        this.emitAll({
          type: 'hand_history_saved',
          table_id: '',
          hand_number: this.handNumber,
          hand_id: out.value.handHistoryId,
          timestamp: this.now(),
        });
        this.metrics.recordHand('settled');
        // Captured before finish() clears who is watching: the jackpot is
        // every participant's, folded or not (the table share is the dealt-in).
        const jackpotHand = this.jackpotHand(state);
        this.finish('hand_end');
        await settleLightningJackpot(jackpotHand, {
          emit: (room, payload) => this.deps.hub.emitEvent(room, payload),
          logger: this.logger,
          now: this.now,
          ...(this.deps.jackpot ?? {}),
        });
        return;
      }
      if (out.reason === 'cluster_frozen') {
        // The Cluster was ALREADY frozen (by another hand's settlement): this
        // one moved nothing. Void the instance, and make sure the worker stops.
        this.state = 'dealing';
        await this.abandon('cluster_frozen');
        this.deps.onClusterFrozen?.(this.clusterId);
        return;
      }
      if (out.frozen) {
        // A conservation disagreement: the database FROZE the Cluster. Terminal:
        // never retried, never abandoned; the worker for the Cluster stops.
        this.state = 'frozen';
        this.metrics.recordHand('frozen');
        this.logger.error(
          `[LightningHost:${this.instanceId}] settlement froze the Cluster (${out.reason}); stopping its worker`
        );
        this.deps.onClusterFrozen?.(this.clusterId);
        this.finish('hand_end');
        return;
      }
      if (!out.transport) {
        // A definite refusal moved nothing: void the instance.
        this.state = 'dealing';
        return void (await this.abandon(`settlement_refused:${out.reason}`));
      }
      if (attempt < SETTLE_ATTEMPTS) await this.sleep(250 * attempt);
    }
    // UNKNOWN: it may have committed. Never abandon and never settle again
    // under another id; the reaper voids the instance only if it did not.
    this.state = 'settlement_unknown';
    this.metrics.recordHand('settlement_unknown');
    this.logger.error(
      `[LightningHost:${this.instanceId}] settlement outcome unknown; left to the reaper`
    );
    this.finish('hand_end');
  }

  /**
   * The physical engine's bounded post-commit drain: `ok !== true` is a
   * failure (predecessor_pending is common with several hands on one front
   * table), retried with backoff while the host lease is held, up to the
   * budget, then for a short handover once it is not. Giving up files the
   * critical financial alert the physical engine files; the outbox row stays
   * authoritative and the projection worker finishes it.
   */
  private async drainPostCommit(handHistoryId: string): Promise<boolean> {
    const started = this.now();
    const budget = this.deps.postCommitBudgetMs ?? POST_COMMIT_BUDGET_MS;
    let handoverEnds: number | null = null;
    let attempt = 0;
    let lastError: unknown = null;
    for (;;) {
      attempt++;
      try {
        const out = await this.deps.backend.postCommit(handHistoryId);
        if (out?.ok === true) return true;
        throw new Error(`post-commit obligations refused (${out?.reason ?? 'unknown'})`);
      } catch (err) {
        lastError = err;
        if (attempt === 1 || attempt % 10 === 0)
          this.logger.warn(
            `[LightningHost:${this.instanceId}] post-commit obligations pending (attempt ${attempt}): ${describeError(err)}`
          );
      }
      const now = this.now();
      if (!this.deps.leaseFor(this.hostTableId) && handoverEnds === null)
        handoverEnds = now + POST_COMMIT_HANDOVER_MS;
      const limit = Math.min(started + budget, handoverEnds ?? Infinity);
      if (now >= limit) break;
      const backoffMs = Math.min(150 * 2 ** Math.min(attempt - 1, 5), 5_000);
      await this.sleep(Math.min(backoffMs, Math.max(0, limit - now)));
    }
    void raiseFinancialAlert(
      'critical',
      'LightningHandHost.post_commit_obligations_pending',
      `Lightning hand ${this.hostTableId}#${this.handNumber} committed, but its host gave up its durable post-commit envelope after ${attempt} attempt(s); the outbox row remains authoritative and the projection worker is its successor`,
      {
        table_id: this.hostTableId,
        hand_number: this.handNumber,
        hand_id: handHistoryId,
        lightning_hand_id: this.handId,
        attempts: attempt,
        error: describeError(lastError),
      }
    ).catch((alertError) =>
      this.logger.error(
        `[LightningHost:${this.instanceId}] post-commit alert not filed`,
        alertError
      )
    );
    return false;
  }

  /** What the jackpot check reads: the settled hand's facts, every participant's room. */
  private jackpotHand(state: GameState) {
    const rules = this.rules!;
    return {
      hostTableId: this.hostTableId,
      clubId: (rules.club_id as string | null | undefined) ?? null,
      asset: (rules.arena?.asset as string | undefined) ?? null,
      bbjPercent: rules.bbj_percent as number | null | undefined,
      handNumber: this.handNumber,
      variant: String(rules.game_variant || 'nlh'),
      smallBlind: Number(rules.small_blind),
      bigBlind: Number(rules.big_blind),
      showdown: this.showdown,
      winnerIds: this.winners.map((w) => w.userId),
      potSize: state.pot,
      dealtInPlayerIds: state.players.map((p) => p.user_id),
      board: [...this.boards[0]],
      rooms: [...this.participants.values()].map(
        (p) => [p.playerId, p.poolSessionId] as [string, string]
      ),
      stacks: state.players.map((p) => ({ userId: p.user_id, stack: p.stack })),
    };
  }

  private async keepalive(): Promise<void> {
    if (this.state !== 'dealing') return;
    if (!this.deps.leaseFor(this.hostTableId)) return void (await this.abandon('host_lease_lost'));
    const out = await this.deps.backend.keepalive(
      this.instanceId,
      this.deps.keepaliveIntervalMs * 3,
      new Date(this.now())
    );
    if (!out.ok && !out.transport && this.state === 'dealing')
      await this.abandon(`keepalive_refused:${out.reason}`);
  }

  private async abandon(reason: string): Promise<void> {
    if (this.isTerminal() || this.state === 'settling') return;
    this.state = 'abandoned';
    this.clearTurn();
    this.metrics.recordHand('abandoned');
    this.logger.warn(`[LightningHost:${this.instanceId}] abandoned: ${reason}`);
    try {
      await this.withRetry(async () => {
        const out = await this.deps.backend.abandon(this.instanceId, reason, new Date(this.now()));
        if (!out.ok && out.transport) throw new Error(out.reason);
        return out;
      });
    } catch (err) {
      this.logger.error(
        `[LightningHost:${this.instanceId}] abandon not recorded; the reaper will void it`,
        err
      );
    }
    this.publishIdle();
    this.finish('hand_end');
  }

  private finish(why: 'hand_end'): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    this.clearTurn();
    for (const p of this.participants.values()) {
      this.recordBank(p.playerId);
      this.timer.cancelTimer(this.timerKey, p.playerId);
    }
    this.timeBank.dispose(this.timerKey);
    this.disconnect.dispose(this.timerKey);
    this.preActions.dispose(this.timerKey);
    // Everyone not already freed by a fold is free now (the instance ended).
    for (const p of this.participants.values()) {
      const type = this.foldTypes.get(p.playerId);
      if (type === 'fast' || type === 'normal') continue;
      this.metrics.noteIdle(
        p.playerId,
        this.now(),
        type === 'fold_watch' ? 'fold_watch' : 'hand_end'
      );
      this.deps.onPlayerReleased?.(p.playerId, why);
    }
    this.watching.clear();
    this.resolveFinished();
    this.deps.onFinished?.(this);
  }

  /** This hand is done with the player's bank: hand it back to the ledger, once. */
  private recordBank(playerId: string): void {
    if (!this.hc || this.bankRecorded.has(playerId)) return;
    this.bankRecorded.add(playerId);
    const remaining = this.timeBank.getRemainingSeconds(this.timerKey, playerId);
    const uses = this.timeBank.getUsesRemaining(this.timerKey, playerId);
    void this.deps.timeBanks
      .record(playerId, remaining, uses, this.handId)
      .catch((err) =>
        this.logger.error(`[LightningHost:${this.instanceId}] time bank not recorded`, err)
      );
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= RPC_RETRY_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        if (attempt < RPC_RETRY_ATTEMPTS) await this.sleep(150 * attempt);
      }
    }
    throw last;
  }

  /** For the law test and diagnostics: what the hand would settle right now. */
  peekState(): GameState | null {
    return this.hc?.getState() ?? null;
  }

  get stageName(): HandStage | null {
    return this.hc?.getState().stage ?? null;
  }
}
