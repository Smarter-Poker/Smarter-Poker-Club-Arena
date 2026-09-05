/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REPLAY MOTION — what moves, what sounds, and what the acting seat was facing
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 3 of the Previous Hand build plan (2026-09-05): the replayer moves.
 *
 * Pure decisions off two frames - the one on screen and the one before it - so
 * the component stays a renderer and every rule here can be pinned:
 *
 *   - which seats' bets slide in, which sweep to the pot, which cards flip,
 *     which fold, and where the pot goes at the end (`frameMotion`);
 *   - the one sound cue a frame owes, from the table's own SoundService verbs
 *     (`frameCue`) - the replay uses the felt's sounds, never its own;
 *   - what the acting seat was FACING when it acted: chips to call and the
 *     pot odds at that moment (`facingAt`), read off the previous frame's pot
 *     and commitments, which is the state the player saw before deciding;
 *   - the replay's own speed (half, normal, double), a per-viewer convenience
 *     independent of the table's Animation Speed setting, which still scales
 *     every duration underneath it (`replayBeatMs`). Neither can switch motion
 *     off: the fastest setting is still motion (animation law, 10.6).
 *   - where the street jumps land (`streetJumps`).
 */

import type { DeckCard } from './deckCards';
import type { ReplayFrame } from './replayFrames';
import type { ReplayVerb } from './handReplay';

// ── Speed ────────────────────────────────────────────────────────────────────

/** Playback rates the control offers. 1 is the felt's own pace. */
export const REPLAY_RATES = [0.5, 1, 2] as const;
export type ReplayRate = (typeof REPLAY_RATES)[number];
export const REPLAY_RATE_KEY = 'ca_replay_rate';

export function isReplayRate(v: unknown): v is ReplayRate {
  return typeof v === 'number' && (REPLAY_RATES as readonly number[]).includes(v);
}

/** Per-viewer remembered rate; 1 when nothing (or nonsense) is stored. */
export function readReplayRate(storage: Pick<Storage, 'getItem'> | null | undefined): ReplayRate {
  try {
    const v = Number(storage?.getItem(REPLAY_RATE_KEY));
    return isReplayRate(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function writeReplayRate(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  rate: ReplayRate
): void {
  try {
    storage?.setItem(REPLAY_RATE_KEY, String(rate));
  } catch {
    /* private mode, quota: the control still works for this visit */
  }
}

/** Base beat per frame kind, before either scale is applied. */
export const ACTION_BEAT_MS = 900;
export const STREET_BEAT_MS = 1400;

/**
 * How long a frame holds during playback. `animationSpeed` is the table's
 * duration multiplier (1 normal, 0.25 fastest, 3 slowest); `rate` is the
 * replay's own playback rate. Clamped so no setting can make a beat vanish.
 */
export function replayBeatMs(
  frame: ReplayFrame | null,
  animationSpeed: number,
  rate: ReplayRate
): number {
  const base = frame?.row ? ACTION_BEAT_MS : STREET_BEAT_MS;
  const speed = Number.isFinite(animationSpeed) && animationSpeed > 0 ? animationSpeed : 1;
  return Math.max(120, Math.round((base * speed) / rate));
}

// ── Motion ───────────────────────────────────────────────────────────────────

export interface FrameMotion {
  /** Seat whose chips slide from the seat to its bet spot on this frame. */
  chipsIn: number | null;
  /**
   * Seat posting DEAD money on this frame (an ante, a bomb-pot ante). It goes
   * from the seat straight to the pot - it is never in front of the player -
   * so it gets its own travel rather than a bet pill that should not exist.
   */
  deadIn: number | null;
  /** Seats whose street bets sweep into the pot on this frame (a new street). */
  sweep: number[];
  /** Seats whose hole cards turn face-up on this frame. */
  flip: number[];
  /** Seat whose cards go to the muck on this frame. */
  fold: number | null;
  /** Seats the pot travels to on the final frame. */
  potTo: number[];
}

const NO_MOTION: FrameMotion = {
  chipsIn: null,
  deadIn: null,
  sweep: [],
  flip: [],
  fold: null,
  potTo: [],
};

/**
 * What moves between `prev` and `frame`. Null `prev` (a jump, a scrub, the
 * first frame) moves nothing: motion is owed to a step FORWARD, and a scrub
 * to the river should not replay every bet on the way.
 */
export function frameMotion(
  prev: ReplayFrame | null,
  frame: ReplayFrame,
  winnerSeats: number[]
): FrameMotion {
  if (!prev) return NO_MOTION;
  const row = frame.row;
  const posted =
    row && frame.activeSeat !== null && row.amount > 0 && row.verb !== 'show' && row.verb !== 'muck'
      ? frame.activeSeat
      : null;
  const chipsIn = posted !== null && !row?.dead ? posted : null;
  const deadIn = posted !== null && row?.dead ? posted : null;
  // A street frame (and the final frame) clears every commitment into the
  // pot. A row frame never does, so a seat dropping to zero mid-street is a
  // returned uncalled bet, not a sweep.
  const sweep =
    frame.row === null || frame.isShowdown
      ? Object.entries(prev.committed)
          .filter(([, amt]) => amt > 0)
          .map(([seat]) => Number(seat))
      : [];
  const flip = frame.revealed.filter((s) => !prev.revealed.includes(s));
  const fold =
    row && (row.verb === 'fold' || row.verb === 'muck') && frame.activeSeat !== null
      ? frame.activeSeat
      : null;
  const potTo = frame.isShowdown && !prev.isShowdown ? winnerSeats : [];
  return { chipsIn, deadIn, sweep, flip, fold, potTo };
}

// ── Sound ────────────────────────────────────────────────────────────────────

export type ReplayCue =
  | 'deal'
  | 'community'
  | 'chips'
  | 'raise'
  | 'check'
  | 'fold'
  | 'all_in'
  | 'discard'
  | 'show'
  | 'win'
  | null;

const VERB_CUE: Partial<Record<ReplayVerb, ReplayCue>> = {
  sb: 'chips',
  bb: 'chips',
  ante: 'chips',
  straddle: 'chips',
  call: 'chips',
  bet: 'raise',
  raise: 'raise',
  all_in: 'all_in',
  check: 'check',
  fold: 'fold',
  muck: 'fold',
  discard: 'discard',
  show: 'show',
};

/** The cue a frame owes when it is STEPPED INTO. None for a jump or a scrub. */
export function frameCue(prev: ReplayFrame | null, frame: ReplayFrame): ReplayCue {
  if (!prev) return null;
  if (frame.isShowdown) return 'win';
  if (frame.row) {
    /* A verb this reader does not know still MOVED CHIPS if it carries an
       amount - `bomb_ante` is one, and it put 1.50 in the middle in silence
       until 2026-09-05. Money that moves is owed the chip cue whether or not
       we have a word for the action. A returned bet (negative) and a chipless
       unknown verb are owed nothing. */
    return VERB_CUE[frame.row.verb] ?? (frame.row.amount > 0 ? 'chips' : null);
  }
  if (frame.key === 'deal') return 'deal';
  return 'community';
}

// ── Facing ───────────────────────────────────────────────────────────────────

export interface Facing {
  seat: number;
  /** Chips the seat had to put in to continue. */
  toCall: number;
  /** Pot after the call, the denominator poker players quote. */
  potIfCalled: number;
  /** toCall / (pot + toCall), as a percentage to one decimal. */
  potOddsPct: number;
  /** "3.0 : 1" style ratio of what was in the middle to the price. */
  ratio: string;
}

const DECISION_VERBS = new Set<ReplayVerb>(['fold', 'call', 'raise', 'all_in', 'bet', 'check']);

/**
 * What the acting seat was facing when it acted, from the frame BEFORE the
 * action: the pot and commitments as they stood at the decision. Null on a
 * posting, a show, a returned bet, or when nothing was owed (an open, a check
 * with no bet in front).
 */
export function facingAt(prev: ReplayFrame | null, frame: ReplayFrame): Facing | null {
  if (!prev || !frame.row || frame.activeSeat === null) return null;
  if (!DECISION_VERBS.has(frame.row.verb)) return null;
  if (prev.streetKey !== frame.streetKey) return null;
  const seat = frame.activeSeat;
  const mine = prev.committed[seat] || 0;
  const high = Math.max(0, ...Object.values(prev.committed));
  const toCall = Math.round((high - mine) * 100) / 100;
  if (toCall <= 0) return null;
  const pot = prev.pot;
  const potIfCalled = Math.round((pot + toCall) * 100) / 100;
  const potOddsPct = Math.round((toCall / potIfCalled) * 1000) / 10;
  const ratio = `${(Math.round((pot / toCall) * 10) / 10).toFixed(1)} : 1`;
  return { seat, toCall, potIfCalled, potOddsPct, ratio };
}

// ── Street jumps ─────────────────────────────────────────────────────────────

export interface StreetJump {
  key: string;
  label: string;
  /** Frame index the jump lands on. */
  index: number;
}

/** One jump per street the hand reached: the deal, then the first frame of each street. */
export function streetJumps(frames: ReplayFrame[]): StreetJump[] {
  const out: StreetJump[] = [];
  const seen = new Set<string>();
  frames.forEach((f, i) => {
    const key = f.key === 'deal' ? 'deal' : f.streetKey;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, label: f.key === 'deal' ? 'Deal' : f.streetLabel, index: i });
  });
  return out;
}

// ── Hero hand label ──────────────────────────────────────────────────────────

const RANK_WORD: Record<string, string> = {
  '2': 'Deuce',
  '3': 'Three',
  '4': 'Four',
  '5': 'Five',
  '6': 'Six',
  '7': 'Seven',
  '8': 'Eight',
  '9': 'Nine',
  T: 'Ten',
  '10': 'Ten',
  J: 'Jack',
  Q: 'Queen',
  K: 'King',
  A: 'Ace',
};
const RANK_ORDER = '23456789TJQKA';

/**
 * Before the flop there is no made hand, so the label names the holding
 * itself: "Pocket Nines", "Ace King Suited". Only for two-card holdings;
 * an Omaha or Pineapple hand has too many pairs of stories to tell in a word.
 */
export function preflopHoleLabel(hole: DeckCard[] | null | undefined): string | null {
  if (!hole || hole.length !== 2) return null;
  const [a, b] = hole;
  const ra = String(a.rank).toUpperCase().replace('10', 'T');
  const rb = String(b.rank).toUpperCase().replace('10', 'T');
  const wa = RANK_WORD[ra];
  const wb = RANK_WORD[rb];
  if (!wa || !wb) return null;
  if (ra === rb) return `Pocket ${wa}s`;
  const [hi, lo] = RANK_ORDER.indexOf(ra) > RANK_ORDER.indexOf(rb) ? [wa, wb] : [wb, wa];
  return `${hi} ${lo} ${a.suit === b.suit ? 'Suited' : 'Offsuit'}`;
}
