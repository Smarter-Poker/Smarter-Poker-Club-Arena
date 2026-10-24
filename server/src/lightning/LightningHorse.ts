/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HORSE DECIDES A LIGHTNING TURN IN THE SAME LANE AS AT A TABLE (2026-10-01)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md 10.5: a horse is a player, and "is it identical" is the test.
 * Phase 6 first decided a Lightning horse's turn with a fixed synchronous
 * `HorseLogic.decide(me, gs, 'balanced', {}, {mind: false})` on the main
 * loop: every horse played the same style, without its mods or its mind, and
 * the CPU-heavy brain ran inside the event loop the physical engine moved it
 * out of on 2026-09-08.
 *
 * This builds the decision snapshot the physical engine builds
 * (ServerTableEngineTurns.scheduleHorseAction) - the hero's own cards only,
 * every other seat public, the controller's chip rules, legal menu, live pots
 * and contestable pot, the variant rules, the horse's OWN style and mods from
 * its horse_profile - and asks the one process-wide live horse decision lane
 * (`getLiveHorseDecisionWorker().decideFast`) under the same deadline rule
 * (the turn clock less the engine's margin). A failed job gets the physical
 * engine's liveness answer (check, or fold facing a bet) and nothing else:
 * there is deliberately no synchronous brain fallback, here as there.
 *
 * The think time is mapped exactly as the physical engine maps it, including
 * the time-bank burn for a "tank" decision when the horse's bank is usable.
 */
import { HorseLogic, resolveHorseStyle, type HorseGameStateV2 } from '../engine/HorseLogic.js';
import { horseVariantRulesFor } from '../engine/VariantRules.js';
import { captureHorseHandJournalContext } from '../engine/HorseDecisionHandBinding.js';
import {
  buildHorseDecisionKey,
  getLiveHorseDecisionWorker,
  type FastHorseDecisionResult,
  type LiveHorseDecisionLane,
  type LiveHorseDecisionSnapshot,
} from '../engine/horseDecision/index.js';
import { horseDecisionDeadlineMs } from '../engine/horseDecision/decisionDeadline.js';
import type { HandController } from '../engine/HandController.js';
import type { ActionType, SeatPlayer } from '../types.js';

/**
 * The physical engine's ceiling on how far a horse's "tank" runs into its
 * bank (ServerTableEngineTurns.HORSE_MAX_BANK_BURN_MS). A test pins the two
 * equal so they cannot drift apart.
 */
export const LIGHTNING_HORSE_MAX_BANK_BURN_MS = 9000;

export interface LightningHorseTurn {
  hc: HandController;
  userId: string;
  seat: number;
  horseProfile: unknown;
  variant: string;
  bigBlind: number;
  smallBlind: number;
  ante: number;
  bigBlindAnte: boolean;
  allInOrFold: boolean;
  actionTimeSeconds: number | null | undefined;
  /** Prior accepted actions of this hand (the hand journal binding). */
  actions: readonly unknown[];
  generation: number;
  fence: string;
  turnStartMs: number;
  now: number;
  /**
   * The early look (Dan 2026-10-24, "HORSES SHOULD FOLD RIGHT AWAY IF THEY
   * WERE ALREADY FOLDING"): the horse is not on the turn yet, and asks its
   * own policy what it does with the table exactly as it stands now, as a
   * person decides whether to press Lightning Fold. Read-only: the menu is
   * the one the seat would hold (HandController asIfToAct).
   */
  earlyLook?: boolean;
}

export interface LightningHorseDecision {
  action: string;
  amount?: number;
  /** The horse's requested think time (ms), before the table maps it. */
  thinkTime: number;
  /** The lane failed and this is the liveness answer, not a decision. */
  workerFallback: boolean;
  /** The lane's result, for committing plan effects once the wager lands. */
  fast: FastHorseDecisionResult | null;
}

/**
 * THE LIGHTNING TURN FENCE HAS THE PHYSICAL ENGINE'S FIVE PARTS (2026-10-24).
 *
 * The physical engine fences a horse turn as
 * `table:hand:seat:lease:turn` (ServerTableEngineTurns.scheduleHorseAction),
 * and every consumer of the fence reads exactly those five parts:
 * HorseMindHandIdentity.horseMindHandFromDecision (the in-hand opponent read
 * and the plan namespace), HorseDecisionHandBinding.anchorHorseDecisionHand
 * (the private journal and the committed-hand binding) and the lifecycle
 * journal keys. The Lightning host built `table:hand:seat:turn`, four parts,
 * so for every Lightning horse decision the worker refused the in-hand
 * HorseMind observation (explicit null identity), the barrel and raise plans
 * had no hand key, and the journal counted three capture gaps per decision:
 * production 2026-10-22..24 read 1,725,367 `phase15_hand_binding_invalid_turn_identity`
 * and 5,176,830 `phase15_journal_capture_unavailable` (three per refusal).
 *
 * The lease part is the host table's verified cash lease generation, the same
 * value Lightning settlement fences on (LightningHandHost.leaseFor). Without
 * one the part reads `unverified`, exactly as the physical engine writes it,
 * and the consumers refuse it by name rather than inventing an identity.
 */
export function lightningHorseDecisionFence(input: {
  hostTableId: string;
  handNumber: number;
  seat: number;
  leaseGeneration: string | null;
  generation: number;
}): string {
  return [
    input.hostTableId,
    input.handNumber,
    input.seat,
    input.leaseGeneration ?? 'unverified',
    input.generation,
  ].join(':');
}

/** The physical engine's snapshot of this turn, for this horse. */
export function buildLightningHorseSnapshot(turn: LightningHorseTurn): LiveHorseDecisionSnapshot {
  const hc = turn.hc;
  const state = hc.getState();
  const me = state.players.find((p) => p.seat === turn.seat);
  const auth = hc.getAuthoritativeActionState(turn.userId, { asIfToAct: turn.earlyLook === true });
  if (!me || !auth || !auth.canAct)
    throw new Error('horse seat has no authoritative decision state');
  const contestablePot = hc.getContestablePotForCall(turn.userId);
  if (contestablePot === null) throw new Error('horse seat has no contestable-pot state');
  // All-in-or-fold narrows the preflop menu, as applyAllInOrFoldActionState does.
  let legalActions: ActionType[] = [...auth.legalActions];
  let minRaiseTo = auth.minRaiseTo;
  let maxRaiseTo = auth.maxRaiseTo;
  if (turn.allInOrFold && state.stage === 'preflop') {
    const allowed = new Set<ActionType>(
      auth.toCall > 0.005 ? ['fold', 'all_in'] : ['check', 'all_in']
    );
    legalActions = legalActions.filter((a) => allowed.has(a));
    minRaiseTo = null;
    maxRaiseTo = null;
  }
  const { style, mods } = resolveHorseStyle(turn.horseProfile as never, turn.userId);
  const decisionPlayer: SeatPlayer = { ...me, cards: [...me.cards], knownDeadCards: [] };
  const publicPlayers: SeatPlayer[] = state.players.map((candidate) => {
    const { knownDeadCards: _private, ...pub } = candidate;
    // HIDDEN-INFORMATION FIREWALL: the hero's cards exist once, on decisionPlayer.
    return { ...pub, cards: [] };
  });
  const gameState = {
    stateSchemaVersion: 1,
    dealtSeatIds: state.players
      .filter((c) => c.cards.length > 0)
      .map((c) => c.seat)
      .sort((a, b) => a - b),
    blindSeats: hc.getBlindSeatsSnapshot?.() ?? null,
    ...hc.getChipRulesSnapshot(),
    heroSeat: auth.heroSeat,
    currentPlayerSeat: auth.currentPlayerSeat,
    legalActions,
    toCall: auth.toCall,
    minRaiseTo,
    maxRaiseTo,
    bettingStructure: auth.structure,
    fixedBetSize: auth.fixedBetSize,
    fixedLimitSmallBet: hc.getFixedLimitSmallBet?.() ?? null,
    wagersCapped: auth.wagersCapped,
    commitmentCapRemaining: null,
    pots: hc
      .computeLivePots()
      .map((pot) => ({ ...pot, eligiblePlayers: [...pot.eligiblePlayers] })),
    contestablePot,
    rakeConfig: hc.getRakeConfigSnapshot(),
    variantRules: horseVariantRulesFor(turn.variant),
    players: publicPlayers,
    communityCards: [...state.communityCards],
    communityCards2: [...(state.communityCards2 ?? [])],
    communityCards3: [...(state.communityCards3 ?? [])],
    bombPot: false,
    boardCount: hc.getActiveBoardCount(),
    pot: state.pot,
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    stage: state.stage,
    gameVariant: turn.variant,
    bigBlind: turn.bigBlind,
    dealerSeat: state.dealerSeat,
    lastRaise: state.lastRaise,
    actionHistory: state.actionHistory.map((a) => ({ ...a })),
    gameMode: 'cash' as const,
    ante: turn.ante,
    bigBlindAnte: turn.bigBlindAnte,
    allInOrFold: turn.allInOrFold,
    straddleActive: false,
    format: 'cash' as const,
  } as unknown as HorseGameStateV2;
  const snapshot: LiveHorseDecisionSnapshot = {
    handJournalContext: captureHorseHandJournalContext(turn.actions),
    generation: turn.generation,
    fence: turn.fence,
    decisionKey: '',
    decisionTimeMs: turn.now,
    player: decisionPlayer,
    gameState,
    style,
    mods,
  };
  snapshot.decisionKey = buildHorseDecisionKey(snapshot);
  return snapshot;
}

/**
 * Ask the lane. Never rejects except on an abort (the turn moved on): a
 * failed job resolves to the liveness answer, exactly as at a table.
 */
export async function decideLightningHorse(
  turn: LightningHorseTurn,
  signal: AbortSignal,
  lane: () => LiveHorseDecisionLane = getLiveHorseDecisionWorker,
  onWorkerFailure?: (err: unknown) => void
): Promise<LightningHorseDecision> {
  const toCall =
    turn.hc.getAuthoritativeActionState(turn.userId, { asIfToAct: turn.earlyLook === true })
      ?.toCall ?? 0;
  try {
    const snapshot = buildLightningHorseSnapshot(turn);
    const fast = await lane().decideFast(snapshot, signal, {
      deadlineMs: horseDecisionDeadlineMs({
        actionTimeSeconds: turn.actionTimeSeconds,
        elapsedMs: turn.now - turn.turnStartMs,
      }),
    });
    return {
      action: String(fast.decision.action),
      amount: fast.decision.amount,
      thinkTime: Number(fast.decision.thinkTime) || 0,
      workerFallback: false,
      fast,
    };
  } catch (err) {
    if (signal.aborted) throw err;
    onWorkerFailure?.(err);
    return {
      action: toCall > 0 ? 'fold' : 'check',
      thinkTime: 0,
      workerFallback: true,
      fast: null,
    };
  }
}

/**
 * The physical engine's think-time mapping, unchanged: a fallback acts at
 * once; a "tank" (THINK_TIMEBANK_SENTINEL) runs into a usable bank by at most
 * LIGHTNING_HORSE_MAX_BANK_BURN_MS, or stops 1.5 s short of the clock; any
 * other request is clamped inside the clock with the same tail.
 */
export function lightningHorseThinkTimeMs(input: {
  requested: number;
  actionTimeMs: number;
  workerFallback: boolean;
  bankUsable: boolean;
  random?: () => number;
}): number {
  const random = input.random ?? Math.random;
  const requested = input.requested || 2500;
  const actionTimeMs = input.actionTimeMs;
  if (input.workerFallback) return 0;
  if (requested >= HorseLogic.THINK_TIMEBANK_SENTINEL && input.bankUsable) {
    const intoBank = 2000 + (requested - HorseLogic.THINK_TIMEBANK_SENTINEL) * 0.55;
    return Math.round(actionTimeMs + Math.min(intoBank, LIGHTNING_HORSE_MAX_BANK_BURN_MS));
  }
  if (requested >= HorseLogic.THINK_TIMEBANK_SENTINEL)
    return Math.round(Math.max(2000, actionTimeMs - 1500));
  const cap = Math.max(2000, actionTimeMs - 1200);
  if (requested <= cap) return Math.round(Math.max(250, requested));
  const u = Math.max(1e-6, 1 - random());
  const backoff = Math.min(-Math.log(u) * 900, Math.max(0, cap - 2500));
  return Math.round(Math.max(250, cap - backoff));
}

/**
 * The physical engine's commit-side shaping of a horse's answer, unchanged
 * except that a Lightning hand has no table commitment cap: aliases, AoF,
 * check/call by what is owed, a fold with nothing owed is a check, a sized
 * wager is at least the minimum and becomes all-in at the stack, and a
 * capped fixed-limit street substitutes call/check.
 */
export function shapeLightningHorseAction(
  hc: HandController,
  userId: string,
  decision: { action: string; amount?: number },
  allInOrFold: boolean
): { action: ActionType; amount?: number } {
  const state = hc.getState();
  const me = state.players.find((p) => p.user_id === userId);
  const auth = hc.getAuthoritativeActionState(userId);
  let action = decision.action === 'allin' ? 'all_in' : decision.action;
  let amount = decision.amount;
  const toCall = Math.max(0, state.currentBet - (me?.bet ?? 0));
  if (allInOrFold && state.stage === 'preflop' && auth) {
    const allowed = new Set<ActionType>(toCall > 0.005 ? ['fold', 'all_in'] : ['check', 'all_in']);
    const legal = auth.legalActions.filter((a) => allowed.has(a));
    if (!legal.includes(action as ActionType)) {
      action =
        action !== 'fold' && legal.includes('all_in')
          ? 'all_in'
          : toCall > 0 && legal.includes('fold')
            ? 'fold'
            : legal.includes('check')
              ? 'check'
              : (legal[0] ?? 'fold');
      amount = undefined;
    }
  }
  if (action === 'check' && toCall > 0) action = 'call';
  if (action === 'call' && toCall === 0) action = 'check';
  if (action === 'call') amount = toCall;
  if (action === 'fold' && toCall === 0) action = 'check';
  if (action === 'raise' && state.currentBet === 0) action = 'bet';
  if (action === 'bet' && state.currentBet > 0) action = 'raise';
  const fixed = auth?.structure === 'fixed_limit';
  if (me && action === 'bet' && amount !== undefined) {
    amount = fixed ? (auth?.minRaiseTo ?? amount) : Math.max(state.minRaise, amount);
    if (amount >= me.stack) {
      action = 'all_in';
      amount = undefined;
    }
  } else if (me && action === 'raise' && amount !== undefined) {
    const minRaiseTo = state.currentBet + state.minRaise;
    amount = fixed ? (auth?.minRaiseTo ?? amount) : Math.max(minRaiseTo, amount);
    if (amount >= me.stack + me.bet) {
      action = 'all_in';
      amount = undefined;
    }
  }
  if (fixed && auth?.wagersCapped && (action === 'bet' || action === 'raise')) {
    action = toCall > 0.005 ? 'call' : 'check';
    amount = action === 'call' ? toCall : undefined;
  }
  return { action: action as ActionType, amount };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  "ALREADY FOLDING" (Dan 2026-10-24, verbatim: "YES, HORSES SHOULD FOLD
 *  RIGHT AWAY IF THEY WERE ALREADY FOLDING.")
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured 2026-10-24: a Lightning horse folded only on its own turn (UTG
 * p50 6.3 s after the deal, the button 15.6 s), so its seat freed last and the
 * pool waited for it. A person in the same seat presses Lightning Fold the
 * moment they look at a hand they will not play.
 *
 * A horse is ALREADY FOLDING on a street when, at its FIRST look at that
 * street with a price to pay - the first moment the fast fold is open to it
 * with chips owed (preflop: the deal; a later street: the first bet it
 * faces), or its own turn if the action reaches it first - its own policy,
 * asked through the same live decision lane with its own style and mods,
 * answers FOLD, and every one of these holds:
 *
 *   1. it owes chips (toCall > 0) and its menu has no check. A free check is
 *      NEVER fast folded: the big blind in an unraised pot, any seat checked
 *      to on a later street. This is the human Check/Fold rule, and the door
 *      re-checks it at the moment of the fold;
 *   2. the answer is the policy's own (`workerFallback` false and no
 *      `policyFallback`): a worker failure or a brain exception folds a bet
 *      only to keep the table alive, and is not a decision to fold;
 *   3. it is the street's FIRST priced look. A horse whose first answer was
 *      anything else waits for its turn and decides afresh on everything that
 *      happened in between, on its ordinary clock, exactly as before. So a
 *      fold to a later raise is never rushed: only the fold it had already
 *      decided on before any of that action is.
 *
 * WHY NOT "FOLDS WHATEVER THE OTHERS DO". The policy is stochastic (a
 * strength jitter, an hourly mood, solver mixing) and deliberately not
 * monotone: the maniac call-down (HorseLogic.maniacCallDown) turns a fold
 * into a call against a seat read as a maniac, and the VPIP floor call-down
 * calls small raises on a floored table. No proof that one sampled fold stays
 * a fold under every continuation exists in that code, so none is claimed.
 * What is proven instead is the human's own contract: the fold is the
 * player's decision on the information it has at the moment the button is
 * open, it is final, and it is never a free check. (The VPIP floor
 * call-down cannot fire here at all: the Lightning snapshot carries no
 * `vpipFloor`, see buildLightningHorseSnapshot.)
 */
export function lightningHorseIsAlreadyFolding(input: {
  decision: Pick<LightningHorseDecision, 'action' | 'workerFallback'> & {
    fast?: { decision?: { policyFallback?: unknown } } | null;
  };
  /** The seat's menu and price right now (asIfToAct when off the turn). */
  legalActions: readonly string[];
  toCall: number;
}): boolean {
  const { decision } = input;
  if (decision.workerFallback) return false;
  if (decision.fast?.decision?.policyFallback) return false;
  if (String(decision.action).toLowerCase() !== 'fold') return false;
  if (!(input.toCall > 0.005)) return false;
  if (input.legalActions.includes('check')) return false;
  return input.legalActions.includes('fold');
}
