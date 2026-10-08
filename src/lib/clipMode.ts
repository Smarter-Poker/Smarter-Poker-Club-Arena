/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLIP MODE: the arena's hand replayer as a camera subject (Phase 9.1, 2026-09-30)
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
 * A HAND CLIP IS THE HAND REPLAYER INSIDE CLUB ARENA, PIXEL FOR PIXEL (owner
 * decision, Dan, 2026-10-07, after a first cut that cloned the public share
 * page instead). The reference is `HandReplay` as the arena itself opens it
 * on a hand by id: the table's Previous Hand modal (TableModalsLayer), the
 * archive's replay (HandHistoryPage) and the by-id page (/share/hand/:id,
 * HandReplayerPage). All three read the record through the archive
 * (HandHistoryService.mapHandHistoryRow: `buildReplay(replayInputFromRow(
 * row, { discardedCards, privateHoleCards }))`, the table's name, the hand
 * number, the variant and the reveal record) and HandReplay folds it into
 * one `ReplaySource`. `clipSourceFrom` builds THAT source from the payload,
 * field for field, and the share route renders it inside the same 900px
 * column the by-id page holds the replayer in, and nothing else: no share
 * footer, because the arena's page has none. Until then the clip was first
 * a stripped felt of its own (seat numbers for names, no header), then the
 * share page, which rebuilds the hand from the link's wire, and the wire
 * does not carry where the pot went: its last frame left the sample's
 * winner at 119.20 where the arena shows 932.70, the pot pushed; and it
 * printed a "Shared From" footer the arena never shows. The renderer sets
 * a 4:5 portrait viewport, 1080x1350; the page
 * does nothing special for it except the camera contract (HandReplay's
 * `clip` prop). Everything the page needs is here, and none of it touches
 * React:
 *
 *   readClipPayload       the payload, validated, or null
 *   clipSourceFrom        the ReplaySource the arena's replayer renders, from
 *                         the payload
 *   fitClipRate           contract C3: the slowest replay rate that fits the
 *                         hand inside the clip window, or "too long"
 *
 * NO EMOJI, NO EM DASH, NO EN DASH in anything a viewer can read.
 */

import type { ReplayFrame } from '../utils/replayFrames';
import { replayBeatMs, type ReplayRate } from '../utils/replayMotion';
import { buildReplay, replayInputFromRow, type HandHistoryRowLike } from '../utils/handReplay';
import type { StoredCard } from '../utils/deckCards';
import type { ReplaySource } from '../components/replay/HandReplay';

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
   * The table the hand was played on (`tables.name`), printed in the
   * replayer's header exactly as the arena prints it. Null when the renderer
   * sent none or sent an empty string; the header then says "Table", which
   * is what the archive prints for a table row that has been recycled.
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
       still gets a clip, and the header says "Table", as the archive does. */
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

// ── The source: the arena's own replayer (2026-10-07) ────────────────────────

/**
 * The reveal record for one seat, as the archive maps `hand_history.showdown`
 * onto each player (`HandPlayer.showdown_reveal`, HandHistoryService). The
 * replayer reads `mucked`; the rest rides along so the source is the
 * arena's, field for field.
 */
interface ClipReveal {
  reveal_order: number;
  mucked: boolean;
  hand_name?: string;
  hand_description?: string;
}

/**
 * The `ReplaySource` a clip renders: the one HandReplay builds for a hand it
 * fetched by id, from the same record. Line for line, this is
 * HandHistoryService.mapHandHistoryRow feeding HandReplay's `source` memo:
 *
 *   model        buildReplay(replayInputFromRow(row, { discardedCards,
 *                privateHoleCards })), the one reconstruction, straight from
 *                the record. (The share page rebuilt it from the link's wire,
 *                which does not carry where the pot went, so its last
 *                frame left the winner's stack short by the pot.)
 *   tableName    the table's name, or "Table" when the renderer has none
 *   handNumber   Number(row.hand_number) || 1
 *   gameType     (row.game_variant || 'nlh').toUpperCase()
 *   reveals      every seated player's reveal record, keyed by user id;
 *                undefined for a seat the record has no entry for
 *   viewerId     the hero: the seat the felt is anchored on
 *   viewerFacts  null. In the arena they are the viewer's own all-in equity
 *                and EV, read only by the Rundown tab, which a clip never
 *                shows: the camera captures the Replay tab alone.
 */
export function clipSourceFrom(payload: ClipPayload): ReplaySource {
  const row = payload.row;
  const model = buildReplay(
    replayInputFromRow(row, {
      discardedCards: payload.discardedCards,
      privateHoleCards: payload.privateHoleCards,
    })
  );
  const showdownByUser = new Map<string, Record<string, unknown>>();
  if (Array.isArray(row.showdown)) {
    for (const e of row.showdown) {
      if (isRecord(e) && typeof e.user_id === 'string') showdownByUser.set(e.user_id, e);
    }
  }
  const reveals: Record<string, ClipReveal | undefined> = {};
  for (const p of row.players) {
    const uid = isRecord(p) && typeof p.userId === 'string' ? p.userId : '';
    const e = showdownByUser.get(uid);
    reveals[uid] = e
      ? {
          reveal_order: Number(e.reveal_order) || 0,
          mucked: e.mucked === true,
          hand_name: typeof e.hand_name === 'string' && e.hand_name ? e.hand_name : undefined,
          hand_description:
            typeof e.hand_description === 'string' && e.hand_description
              ? e.hand_description
              : undefined,
        }
      : undefined;
  }
  return {
    model,
    tableName: payload.tableName || 'Table',
    handNumber: Number(row.hand_number) || 1,
    gameType: (typeof row.game_variant === 'string' && row.game_variant
      ? row.game_variant
      : 'nlh'
    ).toUpperCase(),
    reveals,
    viewerId: payload.heroId,
    viewerFacts: null,
  };
}
