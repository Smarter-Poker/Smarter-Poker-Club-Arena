/**
 * LIGHTNING PHASE 6: ONE ROOM, MANY HANDS.
 *
 * A Lightning room keeps its id for the whole session while the hand inside it
 * changes every few seconds: new opponents, new cards, new position. Everything
 * here is a pure rule the table view applies to that stream, kept out of the
 * page so each rule is tested on its own:
 *
 *   - which hand is on the felt (`lightningHandKey`), from the engine's own id;
 *   - whether LIGHTNING FOLD and FOLD & WATCH can be offered right now;
 *   - whether an armed pre-action still belongs to the hand on the felt (it
 *     never survives into another hand);
 *   - what the felt prints about the game before and after the first snapshot,
 *     read from the Cluster and the engine, never from a `tables` row;
 *   - when a gap between hands is long enough to say "Next Hand...".
 */
import { cashBuyInRange } from '../lib/cashBuyIn';
import { formatGameTitle } from '../utils/formatGameTitle';
import type { LightningCapabilities } from './lightningCapabilities';
import type { LightningClusterMeta } from './lightningSession';

/** The action names the engine reads for the two Lightning controls. */
export const LIGHTNING_FAST_FOLD_ACTION = 'fast_fold';
export const LIGHTNING_FOLD_WATCH_ACTION = 'fold_watch';

/** The words on the controls. Approved player-visible terms only. */
export const LIGHTNING_FOLD_LABEL = 'LIGHTNING FOLD';
export const LIGHTNING_FOLD_WATCH_LABEL = 'FOLD & WATCH';
export const LIGHTNING_NEXT_HAND_TEXT = 'Next Hand...';

/** A quiet gap shorter than this says nothing at all. */
export const LIGHTNING_NEXT_HAND_NOTICE_MS = 2500;

/** The part of an engine snapshot these rules read. Every field is optional. */
export interface LightningSnapshotFields {
  hand_id?: unknown;
  hand_number?: unknown;
  /** 'waiting' between hands: the idle snapshot after a fold carries it. */
  stage?: unknown;
  /** Empty in the idle snapshot after a fold: the folder holds no seat in any hand. */
  players?: unknown;
  lightning?: {
    cluster_id?: unknown;
    hand_id?: unknown;
    name?: unknown;
    small_blind?: unknown;
    big_blind?: unknown;
    variant?: unknown;
    /** The engine's own answer: may the hero LIGHTNING FOLD right now. */
    fast_fold_available?: unknown;
    /**
     * LIGHTNING PHASE 13: whether the Cluster offers each control at all (an
     * operator can switch either off). Absent on an older engine: both offered.
     */
    fast_fold_enabled?: unknown;
    fold_watch_enabled?: unknown;
  } | null;
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function positive(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The engine's own id of the hand on the felt, when it sends one. */
export function lightningHandId(
  snapshot: LightningSnapshotFields | null | undefined
): string | null {
  if (!snapshot) return null;
  return nonEmpty(snapshot.hand_id) ?? nonEmpty(snapshot.lightning?.hand_id);
}

/**
 * The identity of the hand on the felt. The engine's hand id when it sends
 * one (every Lightning hand has its own), otherwise the hand number, otherwise
 * nothing (between hands, before the first snapshot).
 */
export function lightningHandKey(
  snapshot: LightningSnapshotFields | null | undefined
): string | null {
  if (!snapshot || isLightningIdleSnapshot(snapshot)) return null;
  const id = lightningHandId(snapshot);
  if (id) return `id:${id}`;
  const n = positive(snapshot.hand_number);
  return n ? `n:${n}` : null;
}

/**
 * The snapshot the engine publishes to a folder's room the moment they fold:
 * stage 'waiting', no players, no hand id, LIGHTNING FOLD off. Nothing is on
 * the felt for this player until their next hand is dealt, however long the
 * folded hand goes on without them.
 */
export function isLightningIdleSnapshot(
  snapshot: LightningSnapshotFields | null | undefined
): boolean {
  if (!snapshot) return false;
  if (snapshot.stage === 'waiting') return true;
  return (
    Array.isArray(snapshot.players) && snapshot.players.length === 0 && !lightningHandId(snapshot)
  );
}

/** A hand this player is in is on the felt right now. */
export function lightningHandOnFelt(snapshot: LightningSnapshotFields | null | undefined): boolean {
  return lightningHandKey(snapshot) !== null;
}

/** The engine's LIGHTNING FOLD flag, or null when the snapshot does not carry it. */
export function lightningFastFoldFlag(
  snapshot: LightningSnapshotFields | null | undefined
): boolean | null {
  const v = snapshot?.lightning?.fast_fold_available;
  return typeof v === 'boolean' ? v : null;
}

/**
 * LIGHTNING PHASE 13: which controls the Cluster offers, from the engine's
 * snapshot. Only an explicit false switches one off; null when the snapshot
 * carries neither field (an older engine), which offers both as before.
 */
export function lightningFoldFlags(
  snapshot: LightningSnapshotFields | null | undefined
): { fastFold: boolean; foldWatch: boolean } | null {
  const l = snapshot?.lightning;
  if (!l || (l.fast_fold_enabled === undefined && l.fold_watch_enabled === undefined)) return null;
  return { fastFold: l.fast_fold_enabled !== false, foldWatch: l.fold_watch_enabled !== false };
}

/**
 * LIGHTNING PHASE 13: the room's words while its Cluster drains back to MUST
 * MOVE (an operator's drain, or the pool thinning out). Every hand in the air
 * finishes first; the player's seat is kept. Popup rules: Title Case, no dashes.
 */
export const LIGHTNING_ENDING_TEXT =
  'Lightning Is Ending. Your Game Returns To MUST MOVE After This Hand.';

// ─── The two Lightning controls ────────────────────────────────────────────

export interface LightningFoldInput {
  /** The hero holds a seat in the hand on the felt. */
  heroSeated: boolean;
  /** A hand is being played. */
  handInProgress: boolean;
  /** The hand has stopped taking action (settling, showdown hold). */
  handSettling: boolean;
  /** The hero's status in this hand, as the seat shows it. */
  heroStatus: string | null | undefined;
  /**
   * `snapshot.lightning.fast_fold_available`, when the engine publishes it.
   * It is the authority (before the hero's turn the engine allows the fold
   * only while the hero faces a bet); the local rule is the fallback only.
   */
  engineFastFoldAvailable?: boolean | null;
  /**
   * `lightningHandOnFelt(snapshot)`. False on the idle snapshot after a fold
   * (and before the first hand): there is nothing to fold, whatever any other
   * input still says from the hand that just ended.
   */
  handOnFelt?: boolean;
  /**
   * LIGHTNING PHASE 13: `lightningFoldFlags(snapshot)`. A control the Cluster
   * switched off is never offered (the engine's door would refuse it). Null or
   * absent offers both, as before.
   */
  engineFoldFlags?: { fastFold: boolean; foldWatch: boolean } | null;
}

export interface LightningFoldAvailability {
  fastFold: boolean;
  foldWatch: boolean;
}

/**
 * Folding is available when the hero is live in a hand that is still taking
 * action: on their turn AND before it, which is what a pre-action fold already
 * offers. LIGHTNING FOLD follows it exactly. FOLD & WATCH follows it too, and
 * then only where the platform's capability row allows it.
 */
export function lightningFoldAvailability(
  input: LightningFoldInput,
  caps: Pick<LightningCapabilities, 'fast_fold' | 'fold_and_watch'>
): LightningFoldAvailability {
  const foldable =
    input.handOnFelt === false
      ? false
      : typeof input.engineFastFoldAvailable === 'boolean'
        ? input.heroSeated && input.engineFastFoldAvailable
        : input.heroSeated &&
          input.handInProgress &&
          !input.handSettling &&
          String(input.heroStatus ?? '') === 'active';
  const flags = input.engineFoldFlags ?? null;
  return {
    fastFold: foldable && caps.fast_fold === true && flags?.fastFold !== false,
    foldWatch: foldable && caps.fold_and_watch === true && flags?.foldWatch !== false,
  };
}

export interface LightningActionPayload {
  tableId: string;
  action: typeof LIGHTNING_FAST_FOLD_ACTION | typeof LIGHTNING_FOLD_WATCH_ACTION;
  amount: number;
}

/** POST /action body for a Lightning control: the room is the pool session. */
export function lightningActionPayload(
  poolSessionId: string,
  kind: 'fast_fold' | 'fold_watch'
): LightningActionPayload {
  return {
    tableId: poolSessionId,
    action: kind === 'fold_watch' ? LIGHTNING_FOLD_WATCH_ACTION : LIGHTNING_FAST_FOLD_ACTION,
    amount: 0,
  };
}

// ─── Pre-action safety ─────────────────────────────────────────────────────

/**
 * An armed pre-action belongs to the hand it was armed in. It survives only
 * while that same hand is on the felt: a new hand id, or no hand at all, drops
 * it. An arm with no known hand never survives.
 */
export function preActionBelongsToHand(
  armedHandKey: string | null,
  currentHandKey: string | null
): boolean {
  if (armedHandKey === null) return false;
  return armedHandKey === currentHandKey;
}

// ─── What the felt prints about the game ───────────────────────────────────

export interface LightningTableSeed {
  tableName: string;
  gameType: string;
  blinds: string;
  maxPlayers: number;
  minBuyIn: number;
  maxBuyIn: number;
  isTournament: false;
}

function figure(n: number): string {
  return String(Number(n));
}

/** The felt's game description from the Cluster row, before any snapshot. */
export function lightningTableSeed(meta: LightningClusterMeta): LightningTableSeed {
  const range = cashBuyInRange({ big_blind: meta.bigBlind, min_buy_in: null, max_buy_in: null });
  return {
    tableName: formatGameTitle(meta.name) || 'Lightning',
    gameType: meta.variant,
    blinds:
      meta.smallBlind > 0 && meta.bigBlind > 0
        ? `${figure(meta.smallBlind)}/${figure(meta.bigBlind)}`
        : '?/?',
    maxPlayers: meta.maxPlayers,
    minBuyIn: range.min,
    maxBuyIn: range.max,
    isTournament: false,
  };
}

/**
 * What the engine's snapshot says about the game, which wins over the Cluster
 * row the moment it arrives. Only the fields the snapshot actually carries.
 * The seat count is not here: the snapshot's `max_seats` already reaches the
 * felt through mapEngineSnapshot, exactly as at a table.
 */
export function lightningSnapshotPatch(
  snapshot: LightningSnapshotFields | null | undefined
): Partial<Pick<LightningTableSeed, 'tableName' | 'gameType' | 'blinds'>> {
  const out: Partial<Pick<LightningTableSeed, 'tableName' | 'gameType' | 'blinds'>> = {};
  const meta = snapshot?.lightning ?? null;
  if (!meta) return out;
  const name = nonEmpty(meta.name);
  if (name) out.tableName = formatGameTitle(name) || name;
  const variant = nonEmpty(meta.variant);
  if (variant) out.gameType = variant;
  const sb = positive(meta.small_blind);
  const bb = positive(meta.big_blind);
  if (sb && bb) out.blinds = `${figure(sb)}/${figure(bb)}`;
  return out;
}

// ─── Between hands ─────────────────────────────────────────────────────────

/**
 * Say "Next Hand..." only when the quiet has lasted longer than the threshold.
 * A normal Lightning gap is shorter than that and says nothing at all.
 */
export function nextHandNoticeDue(input: {
  handInProgress: boolean;
  quietSinceMs: number | null;
  nowMs: number;
  thresholdMs?: number;
}): boolean {
  if (input.handInProgress || input.quietSinceMs === null) return false;
  return input.nowMs - input.quietSinceMs >= (input.thresholdMs ?? LIGHTNING_NEXT_HAND_NOTICE_MS);
}
