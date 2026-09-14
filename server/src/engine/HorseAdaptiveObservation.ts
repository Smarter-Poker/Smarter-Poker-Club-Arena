import { createHash } from 'node:crypto';
import type { CompletedHandObservation } from './horseDecision/protocol.js';
import type { HorsePublicActionNode } from './HorsePublicActionNode.js';
import { isKnownVariant } from './VariantRules.js';

type PublicNode = Extract<HorsePublicActionNode, { status: 'captured' }>;
export type AdaptiveAction = 'fold' | 'check' | 'call' | 'bet' | 'raise';
export type AdaptivePartition = 'training' | 'holdout';
export interface QualifiedAdaptiveObservation {
  readonly version: 1;
  readonly observationId: string;
  readonly handId: string;
  readonly actorKey: string;
  readonly sessionKey: string;
  readonly observedAtMs: number;
  readonly partition: AdaptivePartition;
  readonly scopeKey: string;
  readonly scope: readonly unknown[];
  readonly action: AdaptiveAction;
  readonly facedBet: boolean;
  /** Self-policy actions are identifiable; they cannot become opponent evidence. */
  readonly origin: 'player' | 'pre_action' | 'horse_policy';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_HAND_ACTIONS = 4096;
const STREETS = ['preflop', 'flop', 'turn', 'river'];
const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise', 'all_in'];
export const ADAPTIVE_OBSERVATION_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const amount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => amount(v) && Number.isSafeInteger(v);

/** Fixed by dealt session, never by outcome, observation order or worker. */
export function adaptiveSessionPartition(sessionKey: string): AdaptivePartition {
  if (typeof sessionKey !== 'string' || !SHA256.test(sessionKey))
    throw Error('Invalid adaptive session identity');
  return parseInt(sessionKey.slice(0, 8), 16) % 5 === 0 ? 'holdout' : 'training';
}

function band(value: number, boundaries: readonly number[]): number {
  const index = boundaries.findIndex((upper) => value < upper);
  return index < 0 ? boundaries.length : index;
}

/** Public structural features only, not hand strength or private cards. */
function boardFeatures(board: string, variant: string): readonly unknown[] {
  const ranks = new Map<number, number>(),
    suits = new Map<string, number>();
  for (let i = 0; i < board.length; i += 2) {
    const rank = '23456789TJQKA'.indexOf(board[i]) + 2;
    ranks.set(rank, (ranks.get(rank) ?? 0) + 1);
    suits.set(board[i + 1], (suits.get(board[i + 1]) ?? 0) + 1);
  }
  const unique = [...ranks.keys()],
    wheelAce = variant === 'short_deck' ? 5 : 1;
  const connectedRanks = unique.includes(14) ? [...unique, wheelAce] : unique;
  let connected = 0;
  for (const start of connectedRanks)
    connected = Math.max(
      connected,
      connectedRanks.filter((rank) => rank >= start && rank < start + 5).length
    );
  return Object.freeze([
    unique.length ? Math.max(...unique) : 0,
    unique.filter((rank) => rank <= 8 || rank === 14).length,
    Object.freeze([...ranks.values()].sort((a, b) => b - a)),
    Object.freeze([...suits.values()].sort((a, b) => b - a)),
    connected,
  ]);
}

/** Persisted JSON needs validation even though its producer already validates. */
function validateNode(node: PublicNode): void {
  if (
    !node ||
    node.version !== 1 ||
    node.status !== 'captured' ||
    typeof node.variant !== 'string' ||
    node.variant !== node.variant.toLowerCase() ||
    !isKnownVariant(node.variant) ||
    !STREETS.includes(node.street) ||
    !['cash', 'tournament'].includes(node.mode) ||
    !['chips', 'diamonds'].includes(node.asset) ||
    node.chipUnit !== (node.mode === 'tournament' || node.asset === 'diamonds' ? 1 : 0.01) ||
    !['per_player', 'big_blind'].includes(node.anteType) ||
    !['no_limit', 'pot_limit', 'fixed_limit'].includes(node.structure) ||
    ![node.allInOrFold, node.bombPot, node.wagersCapped].every((v) => typeof v === 'boolean') ||
    ![node.smallBlind, node.bigBlind, node.ante, node.pot, node.currentBet, node.toCall].every(
      amount
    ) ||
    node.bigBlind <= 0 ||
    node.smallBlind > node.bigBlind ||
    ![node.minRaiseTo, node.maxRaiseTo, node.fixedBetSize].every((v) => v === null || amount(v)) ||
    !Array.isArray(node.legalActions) ||
    !node.legalActions.length ||
    node.legalActions.length > 6 ||
    !node.legalActions.every((a) => ACTIONS.includes(a)) ||
    new Set(node.legalActions).size !== node.legalActions.length ||
    !Array.isArray(node.seats) ||
    node.seats.length < 2 ||
    node.seats.length > 10 ||
    !Array.isArray(node.boards) ||
    ![1, 2, 3].includes(node.boardCount) ||
    node.boards.length !== node.boardCount
  )
    throw Error('invalid public node');
  const sized = node.legalActions.includes('bet') || node.legalActions.includes('raise');
  if (
    (sized
      ? node.minRaiseTo === null || node.maxRaiseTo === null || node.minRaiseTo > node.maxRaiseTo
      : node.minRaiseTo !== null || node.maxRaiseTo !== null) ||
    (node.structure === 'fixed_limit'
      ? node.fixedBetSize === null || node.fixedBetSize <= 0
      : node.fixedBetSize !== null)
  )
    throw Error('invalid wager rights');
  const seats = new Set<number>();
  for (const seat of node.seats) {
    if (
      !Array.isArray(seat) ||
      seat.length !== 7 ||
      !count(seat[0]) ||
      seat[0] < 1 ||
      seat[0] > 10 ||
      seats.has(seat[0]) ||
      !seat.slice(1, 6).every(amount) ||
      !count(seat[6]) ||
      seat[6] > 7
    )
      throw Error('invalid seat');
    seats.add(seat[0]);
  }
  if (!seats.has(node.actorSeat) || !seats.has(node.dealerSeat)) throw Error('invalid position');
  const actor = node.seats.find((s) => s[0] === node.actorSeat)!;
  if (actor[6] !== 0 || actor[1] <= 0) throw Error('inactive actor');
  const expectedCards = [0, 3, 4, 5][STREETS.indexOf(node.street)],
    cards = new Set<string>();
  for (const board of node.boards) {
    if (
      typeof board !== 'string' ||
      board.length !== expectedCards * 2 ||
      !/^(?:[2-9TJQKA][cdhs]){0,5}$/.test(board)
    )
      throw Error('invalid board');
    for (let i = 0; i < board.length; i += 2) {
      const card = board.slice(i, i + 2);
      if (cards.has(card) || (node.variant === 'short_deck' && '2345'.includes(card[0])))
        throw Error('invalid physical card');
      cards.add(card);
    }
  }
}

function category(action: string, node: PublicNode): AdaptiveAction {
  if (action === 'all_in') {
    const actor = node.seats.find((seat) => seat[0] === node.actorSeat)!;
    // A zero call price does not mean the street has no wager: the big blind
    // can raise its own matched blind after a limp. Classify against the
    // existing wager, not the actor's remaining price to match it.
    return actor[1] <= node.toCall + node.chipUnit / 2
      ? 'call'
      : node.currentBet > 0
        ? 'raise'
        : 'bet';
  }
  if (!ACTIONS.includes(action)) throw Error('unsupported action');
  return action as AdaptiveAction;
}

function deductionKey(node: PublicNode): string {
  const d = node.deductions;
  if (!d || d.version !== 1 || d.status !== 'captured' || d.rules !== 'controller-rake-bbj-v1')
    throw Error('deductions unavailable');
  const r = d.rake,
    b = d.bbj;
  if (
    !r ||
    !amount(r.percent) ||
    r.percent > 100 ||
    !amount(r.cap) ||
    typeof r.noFlopNoDrop !== 'boolean' ||
    !Array.isArray(r.playerCountCaps) ||
    r.playerCountCaps.length > 10 ||
    !r.playerCountCaps.every(
      (t) =>
        Array.isArray(t) && t.length === 2 && count(t[0]) && t[0] >= 2 && t[0] <= 10 && amount(t[1])
    ) ||
    (b !== null &&
      (!b ||
        typeof b.enabled !== 'boolean' ||
        !amount(b.feeBB) ||
        !amount(b.minPotBB) ||
        !count(b.minPlayersDealt) ||
        b.minPlayersDealt < 2 ||
        b.minPlayersDealt > 10))
  )
    throw Error('invalid deduction rules');
  return digest([
    'controller-rake-bbj-v1',
    r.percent,
    r.cap,
    r.noFlopNoDrop,
    r.playerCountCaps.map((t) => [t[0], t[1]]),
    b ? [b.enabled, b.feeBB, b.minPlayersDealt, b.minPotBB] : null,
  ]);
}

function stageOf(node: PublicNode): readonly unknown[] {
  if (node.mode === 'cash') return Object.freeze(['cash']);
  const t = node.tournamentStage;
  if (
    !t ||
    t.version !== 1 ||
    t.status !== 'captured' ||
    t.rules !== 'tournament-stage-public-v1' ||
    !['mtt', 'sng', 'spin', 'hu_sng'].includes(t.format) ||
    !amount(t.ageMs) ||
    t.ageMs > 60_000 ||
    ![
      t.entrants,
      t.playersLeft,
      t.spotsPaid,
      t.seatsPerTable,
      t.currentLevel,
      t.satelliteSeats,
    ].every(count) ||
    t.playersLeft < 2 ||
    t.entrants < t.playersLeft ||
    t.spotsPaid > t.entrants ||
    t.seatsPerTable < 2 ||
    t.seatsPerTable > 10 ||
    t.currentLevel < 1 ||
    ![
      t.inMoney,
      t.nearBubble,
      t.finalTable,
      t.handForHand,
      t.onBreak,
      t.registrationOpen,
      t.lateRegistrationOpen,
      t.reentryOpen,
      t.rebuyOpen,
      t.addOnPeriodOpen,
      t.isPko,
      t.isBounty,
      t.isMysteryBounty,
      t.satellite,
    ].every((v) => typeof v === 'boolean') ||
    !['none', 'pending', 'active', 'complete'].includes(t.mysteryBountyStage)
  )
    throw Error('tournament stage unavailable');
  return Object.freeze([
    t.format,
    t.entrants,
    t.currentLevel,
    t.playersLeft,
    t.spotsPaid,
    t.seatsPerTable,
    t.inMoney,
    t.nearBubble,
    t.finalTable,
    t.handForHand,
    t.onBreak,
    t.registrationOpen,
    t.lateRegistrationOpen,
    t.reentryOpen,
    t.rebuyOpen,
    t.addOnPeriodOpen,
    t.isPko,
    t.isBounty,
    t.isMysteryBounty,
    t.mysteryBountyStage,
    t.satellite,
    t.satelliteSeats,
  ]);
}

interface Line {
  aggression: number;
  calls: number;
  actors: Set<number>;
  lastAggressor: number;
}
const emptyLine = (): Line => ({ aggression: 0, calls: 0, actors: new Set(), lastAggressor: -1 });

function scopeOf(node: PublicNode, lines: readonly Line[]): readonly unknown[] {
  const actor = node.seats.find((seat) => seat[0] === node.actorSeat)!;
  const seats = node.seats.map((seat) => seat[0]).sort((a, b) => a - b);
  const position = (seat: number) =>
    seat < 0
      ? -1
      : (seats.indexOf(seat) - seats.indexOf(node.dealerSeat) + seats.length) % seats.length;
  // Versioned structural scope. No action outcome, identity, partition or private object enters this key.
  return Object.freeze([
    'adaptive-public-node-v1',
    node.variant,
    node.asset,
    node.chipUnit,
    node.smallBlind,
    node.bigBlind,
    node.ante,
    node.anteType,
    node.structure,
    node.mode,
    seats.length,
    position(node.actorSeat),
    node.seats.filter((seat) => (seat[6] & 5) === 0).length,
    node.street,
    node.bombPot,
    node.allInOrFold,
    node.boardCount,
    Object.freeze(node.boards.map((board) => boardFeatures(board, node.variant))),
    band(actor[1] / node.bigBlind, [10, 20, 40, 80, 150, 300]),
    band(node.pot / node.bigBlind, [3, 8, 20, 50, 100]),
    band(
      node.toCall / Math.max(node.pot + node.toCall, node.bigBlind),
      [0.001, 0.1, 0.2, 0.33, 0.5]
    ),
    node.wagersCapped,
    node.fixedBetSize,
    Object.freeze([...node.legalActions].sort()),
    Object.freeze(
      lines.map((line) =>
        Object.freeze([
          line.aggression,
          line.calls,
          line.actors.has(node.actorSeat),
          position(line.lastAggressor),
        ])
      )
    ),
    // Relative contribution/cover topology prevents identical total pots from
    // pooling a heads-up side pot with an opponent who can contest all layers.
    Object.freeze(
      node.seats
        .slice()
        .sort((a, b) => position(a[0]) - position(b[0]))
        .map((seat) =>
          Object.freeze([
            position(seat[0]),
            ...seat
              .slice(1, 6)
              .map((value) =>
                band(value / node.bigBlind, [0.001, 1, 2, 4, 8, 16, 32, 64, 128, 256])
              ),
            seat[6],
          ])
        )
    ),
    Object.freeze(
      [node.currentBet, node.minRaiseTo, node.maxRaiseTo].map((value) =>
        value === null
          ? null
          : band(value / node.bigBlind, [0.001, 1, 2, 4, 8, 16, 32, 64, 128, 256])
      )
    ),
    stageOf(node),
    deductionKey(node),
  ]);
}

/** Already-committed observations only. Linear in bounded hand size; malformed
 * public action history excludes the suffix rather than inventing an empty line.
 * This does not apply updates or promise durable deduplication. */
export function qualifyAdaptiveHand(
  hand: Pick<CompletedHandObservation, 'committedHandId' | 'actions'>,
  nowMs: number
): Readonly<{
  observations: readonly QualifiedAdaptiveObservation[];
  rejected: Readonly<Record<string, number>>;
}> {
  const rejected: Record<string, number> = {},
    observations: QualifiedAdaptiveObservation[] = [];
  const reject = (reason: string) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };
  const finish = () =>
    Object.freeze({ observations: Object.freeze(observations), rejected: Object.freeze(rejected) });
  if (
    !hand ||
    !Number.isSafeInteger(nowMs) ||
    typeof hand.committedHandId !== 'string' ||
    !UUID.test(hand.committedHandId)
  ) {
    reject('missing_committed_hand_identity');
    return finish();
  }
  if (!Array.isArray(hand.actions) || hand.actions.length > MAX_HAND_ACTIONS) {
    reject('invalid_or_oversized_hand');
    return finish();
  }
  const lines = STREETS.map(emptyLine);
  let lineUnavailable = false,
    previousStreet = 0,
    handScope: string | undefined;
  for (let ordinal = 0; ordinal < hand.actions.length; ordinal++) {
    const action = hand.actions[ordinal];
    if (!action || typeof action !== 'object') {
      reject('invalid_action');
      lineUnavailable = true;
      continue;
    }
    if (!ACTIONS.includes(action.action)) {
      // These producer records do not represent voluntary betting choices.
      if (
        !['sb', 'bb', 'post', 'ante', 'straddle', 'bomb_ante', 'discard', 'return'].includes(
          action.action
        )
      )
        lineUnavailable = true;
      reject('non_betting_action');
      continue;
    }
    const node = action.publicNode;
    let decision: AdaptiveAction;
    try {
      if (!node || node.status !== 'captured') throw Error('missing node');
      validateNode(node);
      const capturedHandScope = JSON.stringify([
        node.variant,
        node.mode,
        node.asset,
        node.structure,
        node.dealerSeat,
        node.seats.map((s) => s[0]).sort((a, b) => a - b),
        node.smallBlind,
        node.bigBlind,
        node.ante,
        node.anteType,
        node.bombPot,
        node.boardCount,
        node.allInOrFold,
      ]);
      if (handScope !== undefined && handScope !== capturedHandScope)
        throw Error('hand scope changed');
      handScope = capturedHandScope;
      if (
        node.street !== action.stage ||
        !node.legalActions.includes(action.action as never) ||
        STREETS.indexOf(node.street) < previousStreet
      )
        throw Error('action node mismatch');
      previousStreet = STREETS.indexOf(node.street);
      decision = category(action.action, node);
    } catch {
      reject('unavailable_public_node');
      lineUnavailable = true;
      continue;
    }
    // Scope uses the public line BEFORE applying this action.
    try {
      if (lineUnavailable) {
        reject('unavailable_public_line');
        continue;
      }
      const origin = action.origin;
      if (origin !== 'player' && origin !== 'pre_action' && origin !== 'horse_policy') {
        reject('non_voluntary');
        continue;
      }
      const identity = action.observationIdentity;
      if (
        !identity ||
        identity.status !== 'bound' ||
        identity.version !== 1 ||
        identity.handId !== hand.committedHandId.toLowerCase() ||
        identity.actionOrdinal !== ordinal ||
        identity.observationId !== identity.handId + ':' + ordinal ||
        typeof identity.sessionKey !== 'string' ||
        !SHA256.test(identity.sessionKey) ||
        typeof action.userId !== 'string' ||
        !UUID.test(action.userId)
      ) {
        reject('invalid_identity');
        continue;
      }
      const at = action.timestamp;
      if (
        typeof at !== 'number' ||
        !Number.isSafeInteger(at) ||
        at < nowMs - ADAPTIVE_OBSERVATION_HORIZON_MS ||
        at > nowMs + 5000
      ) {
        reject('invalid_or_stale_time');
        continue;
      }
      const scope = scopeOf(node as PublicNode, lines);
      observations.push(
        Object.freeze({
          version: 1,
          observationId: identity.observationId,
          handId: identity.handId,
          actorKey: digest(['adaptive-actor-v1', action.userId.toLowerCase()]),
          sessionKey: identity.sessionKey,
          observedAtMs: at,
          partition: adaptiveSessionPartition(identity.sessionKey),
          scopeKey: digest(scope),
          scope,
          action: decision,
          facedBet: (node as PublicNode).toCall > 0,
          origin,
        })
      );
    } catch {
      reject('unavailable_scope');
    } finally {
      const n = node as PublicNode,
        line = lines[STREETS.indexOf(n.street)];
      line.actors.add(n.actorSeat);
      if (decision === 'bet' || decision === 'raise') {
        line.aggression = Math.min(line.aggression + 1, 4);
        line.lastAggressor = n.actorSeat;
      }
      if (decision === 'call') line.calls = Math.min(line.calls + 1, 4);
    }
  }
  return finish();
}
