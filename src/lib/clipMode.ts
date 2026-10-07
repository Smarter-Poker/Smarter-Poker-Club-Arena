/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLIP MODE — the replay page as a camera subject (Phase 9.1, 2026-09-30)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The hand clip renderer (World Hub, `/api/cron/render-hand-clips`) opens
 * `/hub/club-arena/replay?clip=1` in a headless browser with the hand injected
 * as `window.__SP_CLIP__` before any script runs, waits for the stage to say
 * `ready`, reads the plan off `window.__spClip` (one beat per frame and the
 * end hold), then takes ONE STILL PER FRAME: `seek(i)`, `data-clip-step`
 * confirming the commit, a screenshot, and the frame's own beat as its
 * duration. A wall-clock screencast of `start()` playback was the first
 * capture (2026-10-01); on the renderer's starved CPU it dropped frames and
 * lost the river and the showdown, so the camera now reads the plan and
 * never the clock. Everything the page needs to turn that payload into a
 * replay is here, and none of it touches React:
 *
 *   readClipPayload       the payload, validated, or null
 *   anonymiseRowForClip   contract C2 step 1: every seat that is not the hero
 *                         becomes "Seat N", no winner name, no villain cards
 *                         the showdown record does not mark as shown
 *   fitClipRate           contract C3: the slowest replay rate that fits the
 *                         hand inside the clip window, or "too long"
 *   buildClipSource       contract C2 step 2: the ReplaySource HandReplay plays
 *
 * WHY THE ANONYMISER PINS THE WRITER'S KEYS. `server/src/services/supabase/
 * handHistory.ts` stores `players[]` as {userId, username, seat, stack, cards},
 * `winners[]` as {userId, amount, potIndex, hand:{name, ranking, cards}},
 * `winners_by_board[]` as {board, userId, amount, handName, low}, `showdown[]`
 * as {user_id, seat, reveal_order, mucked, hand_name, hand_description} and
 * `hole_cards` as {<user id>: [{rank, suit}]} - showdown-revealed holdings
 * only. A clip is PUBLIC and may be a horse's; a horse never names a human
 * player, so every name that is not the hero's is replaced by the seat
 * number, and any name-shaped field a future writer might add to the winner
 * or showdown records is replaced the same way. `hand.name` is a HAND name
 * ("Two Pair") and stays; `hand.cards` of a seat that did not show is dropped
 * because the model never reads it and a public clip has no business carrying
 * it.
 *
 * NO EMOJI, NO EM DASH, NO EN DASH in anything a viewer can read.
 */

import type { ReplayFrame } from '../utils/replayFrames';
import { replayBeatMs, type ReplayRate } from '../utils/replayMotion';
import { buildReplay, replayInputFromRow, type HandHistoryRowLike } from '../utils/handReplay';
import type { StoredCard } from '../utils/deckCards';
import type { ReplaySource } from '../components/replay/HandReplay';

// ── Contract C1: the injected payload ────────────────────────────────────────

export const CLIP_STYLE = 'felt-720p' as const;
export const CLIP_PAYLOAD_KEY = '__SP_CLIP__' as const;
export const CLIP_MIN_MS_DEFAULT = 15000;
export const CLIP_MAX_MS_DEFAULT = 40000;
export const CLIP_END_HOLD_MS = 1500;

/** A `hand_history` row as the renderer injects it: every jsonb as objects. */
export interface ClipRow extends HandHistoryRowLike {
  id: string;
  players: unknown[];
  winner_name?: string | null;
  [column: string]: unknown;
}

export interface ClipPayload {
  v: 1;
  style: typeof CLIP_STYLE;
  /** The seat the felt is anchored on; the author of the clip. */
  heroId: string;
  row: ClipRow;
  /** The hero's `ca_hand_facts.hole_cards` when the row holds none for them. */
  privateHoleCards: Record<string, StoredCard[]>;
  /** The hero's `hand_discards` row when any (draw variants). */
  discardedCards: Record<string, StoredCard>;
  minMs: number;
  maxMs: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const positiveMs = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;

/**
 * `window.__SP_CLIP__`, validated. Null when it is absent or malformed: the
 * page then behaves exactly as it does for every other visitor, and a
 * renderer that injected nonsense sees "not readable" rather than a felt
 * built from it.
 */
export function readClipPayload(win: Window | null | undefined): ClipPayload | null {
  if (!win) return null;
  const raw = (win as unknown as Record<string, unknown>)[CLIP_PAYLOAD_KEY];
  if (!isRecord(raw)) return null;
  if (raw.v !== 1) return null;
  if (raw.style !== CLIP_STYLE) return null;
  if (!nonEmptyString(raw.heroId)) return null;
  const row = raw.row;
  if (!isRecord(row)) return null;
  if (!nonEmptyString(row.id)) return null;
  if (!Array.isArray(row.players)) return null;
  const minMs = positiveMs(raw.minMs, CLIP_MIN_MS_DEFAULT);
  const maxMs = positiveMs(raw.maxMs, CLIP_MAX_MS_DEFAULT);
  return {
    v: 1,
    style: CLIP_STYLE,
    heroId: raw.heroId,
    row: row as ClipRow,
    privateHoleCards: isRecord(raw.privateHoleCards)
      ? (raw.privateHoleCards as Record<string, StoredCard[]>)
      : {},
    discardedCards: isRecord(raw.discardedCards)
      ? (raw.discardedCards as Record<string, StoredCard>)
      : {},
    /* A window that is inside out is the defaults, not a clip that can never fit. */
    minMs: minMs <= maxMs ? minMs : CLIP_MIN_MS_DEFAULT,
    maxMs: minMs <= maxMs ? maxMs : CLIP_MAX_MS_DEFAULT,
  };
}

// ── Contract C2 step 1: the anonymiser ───────────────────────────────────────

/** The user id a winner / showdown entry carries, under either spelling. */
function entryUserId(entry: Record<string, unknown>): string | null {
  const id = entry.userId ?? entry.user_id;
  return nonEmptyString(id) ? id : null;
}

/** The seat label every non-hero name becomes. */
export function seatLabel(seat: number | null | undefined): string {
  return Number.isFinite(seat) && (seat as number) > 0 ? `Seat ${seat}` : 'Player';
}

/**
 * The user ids the showdown record marks as SHOWN: an entry for the id with
 * `mucked` not true. A mucked entry, or no entry at all, is not a reveal.
 */
export function shownIdsFromShowdown(showdown: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(showdown)) return out;
  for (const e of showdown) {
    if (!isRecord(e)) continue;
    const id = entryUserId(e);
    if (id && e.mucked !== true) out.add(id);
  }
  return out;
}

export function anonymiseRowForClip<R extends HandHistoryRowLike>(row: R, heroId: string): R {
  const players = Array.isArray(row.players) ? row.players : [];
  const seatOf = new Map<string, number>();
  for (const p of players) {
    if (!isRecord(p)) continue;
    const id = entryUserId(p);
    const seat = Number(p.seat);
    if (id && Number.isFinite(seat)) seatOf.set(id, seat);
  }
  const shown = shownIdsFromShowdown(row.showdown);
  const isHero = (id: string | null) => id !== null && id === heroId;
  const nameFor = (id: string | null, own: unknown): string =>
    seatLabel(id !== null ? seatOf.get(id) : Number(own));

  /* Every name-shaped field on a non-hero entry becomes the seat label. The
     writer stores none today on winners / winners_by_board / showdown (pinned
     in tests/unit/clipMode.test.ts); this is what happens if one appears. */
  const scrubEntry = (entry: unknown): unknown => {
    if (!isRecord(entry)) return entry;
    const id = entryUserId(entry);
    if (isHero(id)) return entry;
    const out: Record<string, unknown> = { ...entry };
    const label = nameFor(id, entry.seat);
    for (const key of ['username', 'name', 'user_name', 'display_name', 'displayName']) {
      if (typeof out[key] === 'string') out[key] = label;
    }
    /* `hand.cards` is a holding the model never reads. It leaves the row
       unless the table saw this seat's cards face up. */
    if (isRecord(out.hand) && 'cards' in out.hand && !(id && shown.has(id))) {
      const hand: Record<string, unknown> = { ...out.hand };
      delete hand.cards;
      out.hand = hand;
    }
    return out;
  };
  const scrubList = (v: unknown): unknown => (Array.isArray(v) ? v.map(scrubEntry) : v);

  const anonPlayers = players.map((p) => {
    if (!isRecord(p)) return p;
    const id = entryUserId(p);
    if (isHero(id)) return p;
    const out: Record<string, unknown> = { ...p, username: seatLabel(Number(p.seat)) };
    /* `players[].cards` is written as [] on every row; a non-empty one on a
       seat that did not show would be a leak, so it is emptied regardless. */
    if ('cards' in out && !(id && shown.has(id))) out.cards = [];
    return out;
  });

  const holeCards: Record<string, unknown> = {};
  if (isRecord(row.hole_cards)) {
    for (const [id, cards] of Object.entries(row.hole_cards)) {
      if (id === heroId || shown.has(id)) holeCards[id] = cards;
    }
  }

  const out: HandHistoryRowLike & { winner_name: null } = {
    ...row,
    players: anonPlayers,
    winner_name: null,
    winners: scrubList(row.winners),
    winners_by_board: scrubList(row.winners_by_board),
    showdown: scrubList(row.showdown),
    hole_cards: isRecord(row.hole_cards) ? holeCards : row.hole_cards,
  };
  return out as unknown as R;
}

// ── Contract C3: the rate that fits the window ───────────────────────────────

export type ClipFit =
  | {
      tooLong: false;
      rate: ReplayRate;
      /** The beat of every frame at `rate`, animation speed 1, in frame order. */
      beats: number[];
      /** The beats summed: what playback pays before the end hold. */
      runMs: number;
      /** The end hold: 1,500 ms, longer when the run alone is shorter than minMs. */
      holdMs: number;
      /** runMs + holdMs: what the clip will last. */
      plannedMs: number;
    }
  | {
      tooLong: true;
      /** The fastest rate offered, which still did not fit. */
      rate: ReplayRate;
      /** What the clip would have lasted at that rate, end hold included. */
      plannedMs: number;
    };

/** The beat of every frame at `rate`, as playback will pay them, in order. */
export function clipBeats(frames: readonly ReplayFrame[], rate: ReplayRate): number[] {
  return frames.map((f) => replayBeatMs(f, 1, rate));
}

/** The beats of every frame at `rate`, summed. */
export function clipRunMs(frames: readonly ReplayFrame[], rate: ReplayRate): number {
  let total = 0;
  for (const b of clipBeats(frames, rate)) total += b;
  return total;
}

/**
 * The SLOWEST rate whose run plus the end hold fits inside `maxMs`, trying
 * the rates ascending. A run that ends before `minMs` keeps its hold open
 * until the clip reaches it. When even the fastest rate runs past `maxMs`
 * the hand is refused before anything is captured.
 */
export function fitClipRate(
  frames: readonly ReplayFrame[],
  rates: readonly ReplayRate[],
  minMs: number,
  maxMs: number,
  endHoldMs: number = CLIP_END_HOLD_MS
): ClipFit {
  const ascending = [...rates].sort((a, b) => a - b);
  let fastest: { rate: ReplayRate; plannedMs: number } | null = null;
  for (const rate of ascending) {
    const beats = clipBeats(frames, rate);
    const runMs = beats.reduce((a, b) => a + b, 0);
    const natural = runMs + endHoldMs;
    if (natural <= maxMs) {
      const holdMs = Math.max(endHoldMs, minMs - runMs);
      return { tooLong: false, rate, beats, runMs, holdMs, plannedMs: runMs + holdMs };
    }
    fastest = { rate, plannedMs: natural };
  }
  return { tooLong: true, rate: fastest?.rate ?? ascending[0], plannedMs: fastest?.plannedMs ?? 0 };
}

// ── Contract C2 step 2: the source ───────────────────────────────────────────

/** Only the hero's own entries travel: a clip carries nobody else's private cards. */
function heroOnly<T>(map: Record<string, T> | null | undefined, heroId: string): Record<string, T> {
  const out: Record<string, T> = {};
  if (isRecord(map) && heroId in map) out[heroId] = map[heroId];
  return out;
}

/**
 * The ReplaySource for a clip: the anonymised row through the one
 * reconstruction every surface renders, anchored on the hero, with no table
 * name (so no club or person name can appear) and no viewer facts.
 */
export function buildClipSource(payload: ClipPayload): ReplaySource {
  const row = anonymiseRowForClip(payload.row, payload.heroId);
  const model = buildReplay(
    replayInputFromRow(row, {
      discardedCards: heroOnly(payload.discardedCards, payload.heroId),
      privateHoleCards: heroOnly(payload.privateHoleCards, payload.heroId),
    })
  );
  const reveals: Record<string, { mucked?: boolean }> = {};
  if (Array.isArray(row.showdown)) {
    for (const e of row.showdown) {
      if (!isRecord(e)) continue;
      const id = entryUserId(e);
      if (id) reveals[id] = { mucked: e.mucked === true };
    }
  }
  return {
    model,
    tableName: null,
    handNumber: (row.hand_number as string | number | null | undefined) ?? null,
    gameType: row.game_variant ?? null,
    viewerId: payload.heroId,
    reveals,
    viewerFacts: null,
  };
}
