/** Fixed PUBLIC warm histories produced by actual local physical simulations.
 * No production receipt, private card, counter snapshot or donor authority is
 * invented. The normal worker observer validates/hydrates these packets.
 */
import { createHash } from 'node:crypto';
import type { ActionRecord, Card, HandConfig, HandEvent, SeatPlayer } from '../types.js';
import { HandController } from '../engine/HandController.js';
import type { HorseGameStateV2 } from '../engine/HorseLogic.js';
import {
  makeOwnPublicHistoryPacket,
  ownPublicHistoryIsValid,
  type HorseOwnPublicHistoryPacket,
} from '../engine/horseDecision/ownPublicHistory.js';
import type { HorseObserverReadContext } from '../engine/HorseObserverReadContext.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import { referenceDeck } from './OmahaReference.js';
import { pressureOpponentDecision, V53_PRESSURE_VARIANTS } from './V53PressurePopulation.js';

export const FEATURE_ABLATION_HISTORY_VERSION = 'ablation-public-warm-hand-v1';
export const FEATURE_ABLATION_HISTORY_AVAILABLE_AT_MS = Date.UTC(2026, 9, 25, 23);
/** 48 is within the original 64-hand/256KiB packet bound, exceeds the scoped
 * forty-hand read floor, and rotates exactly at 2, 4 and 6 dealt seats. */
export const PRESSURE_PUBLIC_WARM_HANDS = 48;
const WARM_TABLE = '00000000-0000-4000-8000-000000000053';
export const featureAblationPlayerId = (seat: number): string =>
  `00000000-0000-4000-8000-${String(seat).padStart(12, '0')}`;
const uuid = (text: string) => {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export interface FeatureAblationWarmHand {
  handId: string;
  tableId: string;
  handNumber: number;
  button: number;
  playersDealt: number;
  variant: string;
  playedAtMs: number;
  bigBlind: number;
  actions: Array<ActionRecord & { amount: number; userId: string; timestamp: number }>;
  results: Array<{ user_id: string; net: number }>;
}
function randomOf(seed: number): () => number {
  let value = seed >>> 0 || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x100000000;
  };
}
function position(seat: number, button: number, dealt: number): string {
  const offset = (seat - button + dealt) % dealt;
  if (dealt === 2) return offset === 0 ? 'SB' : 'BB';
  if (offset === 0) return 'BTN';
  if (offset === 1) return 'SB';
  if (offset === 2) return 'BB';
  if (offset === dealt - 1) return 'CO';
  return offset === 3 ? 'UTG' : 'MP';
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function featureAblationHistoryDigest(records: readonly FeatureAblationWarmHand[]): string {
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

export function buildPressureWarmRecords(input: {
  variant: (typeof V53_PRESSURE_VARIANTS)[number];
  seats: number;
  seed: number;
}): readonly FeatureAblationWarmHand[] {
  if (
    !V53_PRESSURE_VARIANTS.includes(input.variant) ||
    ![2, 4, 6].includes(input.seats) ||
    !Number.isSafeInteger(input.seed) ||
    input.seed < 1 ||
    input.seed > 0xffffffff
  )
    throw new Error('Invalid declared pressure warm-history domain');
  const { variant, seats, seed } = input;
  const full = getFullRakeConfig(1, 2, variant);
  const records: FeatureAblationWarmHand[] = [];
  for (let hand = 0; hand < PRESSURE_PUBLIC_WARM_HANDS; hand++) {
    const handNumber = 1000000 + hand;
    const button = (hand % seats) + 1;
    const dealtSeed = (seed ^ Math.imul(hand + 1, 2654435761)) >>> 0 || 1;
    const players: SeatPlayer[] = Array.from({ length: seats }, (_, i) => ({
      seat: i + 1,
      user_id: featureAblationPlayerId(i + 1),
      username: `Seat ${i + 1}`,
      stack: 200,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      is_horse: false,
    }));
    const config: HandConfig = {
      tableId: WARM_TABLE,
      handNumber,
      gameVariant: variant,
      smallBlind: 1,
      bigBlind: 2,
      ante: 0,
      isTournament: false,
      rakeConfig: {
        percent: full.rakePercent,
        cap: full.rakeCap,
        noFlopNoDrop: true,
        playerCountCaps: getPlayerCountCaps(full.rakeCap, 6),
      },
      bbjConfig: {
        enabled: full.bbjEnabled,
        feeBB: full.bbjFeeBB,
        minPotBB: full.rules.minPotBB,
        minPlayersDealt: full.rules.minPlayersDealt,
      },
    };
    const controller = new HandController(config, players, button);
    const deck = referenceDeck();
    const random = randomOf(dealtSeed);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const instance = controller.getState().deck as unknown as {
      deal(n?: number): Card[];
      dealOne(): Card;
      remaining(): number;
      getRemainingCards(): Card[];
    };
    instance.deal = (n = 1) => {
      if (deck.length < n) throw new Error('Warm deck exhausted');
      return deck.splice(0, n);
    };
    instance.dealOne = () => instance.deal(1)[0];
    instance.remaining = () => deck.length;
    instance.getRemainingCards = () => deck.slice();
    let completed = false,
      runout = false,
      rake = 0,
      bbj = 0;
    controller.onEvent((event: HandEvent) => {
      if (event.type === 'ALL_IN_RUNOUT') runout = true;
      if (event.type === 'HAND_COMPLETE') {
        completed = true;
        rake = event.rake ?? 0;
        bbj = event.bbjFee ?? 0;
      }
    });
    controller.start();
    for (let step = 0; step < 256 && !completed; step++) {
      if (runout) {
        runout = false;
        controller.continueRunout();
        continue;
      }
      const state = controller.getState();
      const actor = state.players.find((p) => p.seat === state.currentPlayerSeat);
      const menu = actor ? controller.getAuthoritativeActionState(actor.user_id) : null;
      if (!actor || !menu?.canAct) throw new Error(`Warm hand ${hand} has no authoritative actor`);
      const gs = {
        players: state.players.map((p) => ({ ...p, cards: [] })),
        communityCards: state.communityCards,
        pot: state.pot,
        currentBet: state.currentBet,
        minRaise: state.minRaise,
        stage: state.stage,
        gameVariant: variant,
        bigBlind: 2,
        dealerSeat: button,
        actionHistory: state.actionHistory,
        legalActions: menu.legalActions,
        toCall: menu.toCall,
        minRaiseTo: menu.minRaiseTo,
        maxRaiseTo: menu.maxRaiseTo,
      } as HorseGameStateV2;
      const policyRandom = randomOf(
        (dealtSeed ^ Math.imul(step + 1, 104729) ^ Math.imul(actor.seat, 1009)) >>> 0
      );
      const action = pressureOpponentDecision(actor, gs, policyRandom);
      if (!controller.performAction(actor.seat, action.action, action.amount))
        throw new Error(`Warm controller rejected ${action.action} on hand ${hand}`);
    }
    if (!completed) throw new Error(`Warm hand ${hand} did not complete`);
    const end = controller.getState();
    if (
      Math.abs(end.players.reduce((sum, p) => sum + p.stack, 0) + rake + bbj - seats * 200) > 0.01
    )
      throw new Error(`Warm hand ${hand} failed conservation`);
    const playedAtMs =
      FEATURE_ABLATION_HISTORY_AVAILABLE_AT_MS - (PRESSURE_PUBLIC_WARM_HANDS - hand) * 1000;
    records.push({
      handId: uuid(`${FEATURE_ABLATION_HISTORY_VERSION}:${variant}:${seats}:${seed}:${hand}`),
      tableId: WARM_TABLE,
      handNumber,
      button,
      playersDealt: seats,
      variant,
      playedAtMs,
      bigBlind: 2,
      actions: end.actionHistory.map((a, i) => ({
        seat: a.seat,
        userId: a.userId,
        action: a.action,
        amount: a.amount ?? 0,
        stage: a.stage,
        timestamp: playedAtMs - end.actionHistory.length + i,
        ...(a.isFullRaise === undefined ? {} : { isFullRaise: a.isFullRaise }),
      })),
      results: end.players.map((p) => ({
        user_id: p.user_id,
        net: Math.round((p.stack - 200) * 100) / 100,
      })),
    });
  }
  return freeze(records);
}

export function makeFeatureAblationOwnHistory(
  context: HorseObserverReadContext,
  observerSeat: number,
  records: readonly FeatureAblationWarmHand[] = [],
  availableAtMs = FEATURE_ABLATION_HISTORY_AVAILABLE_AT_MS
): HorseOwnPublicHistoryPacket {
  if (context.observerId !== featureAblationPlayerId(observerSeat))
    throw new Error('The warm observer is not its actual physical seat');
  const window = {
    version: 1 as const,
    source: 'original_dealt_public_v1' as const,
    context,
    capped: false,
    hands: records.map((h) => ({
      handId: h.handId,
      tableId: h.tableId,
      handNumber: h.handNumber,
      observerId: context.observerId,
      observerSeat,
      position: position(observerSeat, h.button, h.playersDealt),
      playersDealt: h.playersDealt,
      variant: h.variant,
      format: 'cash',
      playedAtMs: h.playedAtMs,
      bigBlind: h.bigBlind,
      actions: h.actions.map((a) => ({ ...a })),
      results: h.results.map((r) => ({ ...r })),
    })),
  };
  const packet = makeOwnPublicHistoryPacket(window, availableAtMs);
  if (!packet || !ownPublicHistoryIsValid(packet, context, availableAtMs))
    throw new Error('Original worker public-history validator refused warm records');
  return packet;
}
