/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLIP MODE: the hand share page as a camera subject (Phase 9.1, 2026-09-30)
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
 * never the clock.
 *
 * A HAND CLIP IS THE HAND SHARE PAGE, PIXEL FOR PIXEL (owner decision, Dan,
 * 2026-10-07). Until then the clip was its own stripped felt: every seat that
 * was not the hero became "Seat N", there was no table name, no hand number,
 * no street tabs, no transport, no results strip and no footer, and the row
 * went into the model straight from the record. Now the payload goes through
 * exactly the path a share link goes through: `clipHandFrom` builds the
 * ShareableHand the archive's share button builds (`shareableFromModel`, as
 * `panelHandToShareable` in handHistoryAdapter.ts does), and the page renders
 * it with the same `sourceFrom` a link is rendered with. Every player's
 * screen name, the table name, the hand number, the starting stacks and the
 * showdown travel exactly as they do in a link. Nothing anonymises any more.
 * The renderer sets a 4:5 portrait viewport, 1080x1350; the page does nothing
 * special for it except the camera contract (HandReplay's `clip` prop).
 * Everything the page needs is here, and none of it touches React:
 *
 *   readClipPayload       the payload, validated, or null
 *   clipHandFrom          the ShareableHand a share link carries, from the payload
 *   fitClipRate           contract C3: the slowest replay rate that fits the
 *                         hand inside the clip window, or "too long"
 *
 * NO EMOJI, NO EM DASH, NO EN DASH in anything a viewer can read.
 */

import type { ReplayFrame } from '../utils/replayFrames';
import { replayBeatMs, type ReplayRate } from '../utils/replayMotion';
import { buildReplay, replayInputFromRow, type HandHistoryRowLike } from '../utils/handReplay';
import type { StoredCard } from '../utils/deckCards';
import type { ShareableHand } from '../components/table/ShareHand';
import { shareableFromModel } from './shareHandModel';

// ── Contract C1: the injected payload ────────────────────────────────────────

/* The job style key the queue, the renderer and this page agree on. The frame
   it names is history: since 2026-10-07 the renderer captures 4:5 portrait,
   1080x1350, and the key stays so no job row or cron has to be renamed. */
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
  /**
   * The table the hand was played on, printed in the share page's header
   * exactly as a link prints it. Null when the renderer sent none or sent an
   * empty string; the hand then says "Club Arena", as an archive share does.
   */
  tableName: string | null;
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
    /* Optional, unlike the rest: a renderer that does not know the table name
       still gets a clip, and the hand names the club instead. */
    tableName: nonEmptyString(raw.tableName) ? raw.tableName : null,
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

// ── The hand: the share path (2026-10-07) ────────────────────────────────────

/**
 * The ShareableHand a clip renders: the payload's row through the one
 * reconstruction every surface renders (`buildReplay`), then onto the wire
 * the way the archive's share button puts a hand there
 * (`panelHandToShareable` in handHistoryAdapter.ts: `shareableFromModel` with
 * the hand's id, the table name or "Club Arena", and the hero). The page
 * reads it back with `replayFromShareable`, exactly as it reads a link, so a
 * clip and a share of the same hand are the same page.
 */
export function clipHandFrom(payload: ClipPayload): ShareableHand {
  const model = buildReplay(
    replayInputFromRow(payload.row, {
      discardedCards: payload.discardedCards,
      privateHoleCards: payload.privateHoleCards,
    })
  );
  return shareableFromModel(model, {
    id: String(payload.row.id),
    tableName: payload.tableName || 'Club Arena',
    heroUserId: payload.heroId,
  });
}
