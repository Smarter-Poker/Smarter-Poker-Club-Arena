/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE BEHAVIOR — Deterministic Per-Horse Personality Helpers (V8 — 2026-07-24)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pure functions (no imports, no I/O) that give each horse a stable identity
 * for HOW it shows up to play, shared by HorseFleetManager (joining) and
 * HorseSessionRotator (leaving):
 *  - buy-in profile: 15% short-stackers (40-60bb), 60% standard (80-120bb),
 *    25% deep (140-200bb), jittered per sitting
 *  - daily activity window: hash-derived start hour + 10-17h length, so the
 *    floor population rotates through the whole stable with a human-looking
 *    daily rhythm (~55% of horses active at any hour)
 *
 * Deliberately dependency-free so unit tests can import it without touching
 * the supabase client (which fatals without env credentials).
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

/** Deterministic 32-bit hash of a horse id (same scheme as the style hash). */
export function horseHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Buy-in in big blinds for this horse THIS sitting: profile from the id hash,
 * jittered per sitting. Caller clamps to the table's real min/max buy-in.
 */
export function buyInBBFor(horseId: string): number {
  const h = horseHash(horseId);
  const bucket = h % 100;
  const r = Math.random();
  if (bucket < 15) return 40 + r * 20; // short-stacker: 40-60bb
  if (bucket < 75) return 80 + r * 40; // standard: 80-120bb
  return 140 + r * 60; // deep: 140-200bb
}

/**
 * Is this horse inside its daily activity window right now? Window start and
 * length (10-17h) derive from the id hash — stable day to day.
 */
export function isActiveNow(horseId: string, hourUTC: number): boolean {
  const h = horseHash(horseId);
  const start = h % 24;
  const len = 10 + ((h >>> 5) % 8);
  const rel = (hourUTC - start + 24) % 24;
  return rel < len;
}

// ═══════════════════════════════════════════════════════════════════════════════
// V14 TABLE OCCUPANCY (Dan 2026-08-23, binding)
// ═══════════════════════════════════════════════════════════════════════════════
// "SOME TABLES SHOULD BE FULL WITH HORSES WAITING, SOME SHOULD HAVE 2-3 OPEN
//  SEATS, HORSES SHOULD BE RANDOMLY LEAVING GAMES, AND GOING TO OTHERS. THIS
//  IS A MUST TO MAKE IT SEEM MORE REAL."
//
// Every table used to carry ONE fixed target (`horsesPerTable`), so the lobby
// looked identical hour after hour: the same games at the same counts, every
// one of them a seat or two short of full, none of them ever with a queue.
// A real floor is lopsided — one game is the game everybody wants and has a
// list, another is three-handed and looking for players.
//
// A table's popularity therefore DRIFTS. It is deterministic per (table, time
// bucket) rather than random per cycle, because a target that re-rolls every
// 30 seconds would make seats thrash: horses would sit down and stand up
// again for no visible reason. Slow drift reads as a table warming up or
// dying off, which is what actually happens.

export type TableVibe = 'hot' | 'busy' | 'steady' | 'quiet';

/** How long a table keeps its current popularity before drifting. */
export const VIBE_BUCKET_MS = 22 * 60_000;

/**
 * A table's popularity right now. Deterministic in (tableId, bucket) so every
 * engine instance agrees and the value holds still long enough to be read.
 */
export function tableVibe(tableId: string, nowMs: number = Date.now()): TableVibe {
  const bucket = Math.floor(nowMs / VIBE_BUCKET_MS);
  const h = horseHash(`${tableId}:${bucket}`);
  const roll = h % 100;
  if (roll < 22) return 'hot'; // full, with a list
  if (roll < 52) return 'busy'; // full or one off it
  if (roll < 82) return 'steady'; // a couple of open seats
  return 'quiet'; // short-handed, visibly looking for players
}

/**
 * How many horses this table wants seated right now, and how many should be
 * queued behind it. `humanSeated` pins a table to at least a playable game —
 * a human's table never goes quiet underneath them.
 */
export function occupancyTargetFor(
  tableId: string,
  maxPlayers: number,
  humanSeated: boolean = false,
  nowMs: number = Date.now()
): { seatTarget: number; waitTarget: number; vibe: TableVibe } {
  const vibe = tableVibe(tableId, nowMs);
  const h = horseHash(`${tableId}:${Math.floor(nowMs / VIBE_BUCKET_MS)}:seats`);
  let seatTarget: number;
  let waitTarget = 0;
  switch (vibe) {
    case 'hot':
      seatTarget = maxPlayers;
      waitTarget = 1 + (h % 3); // 1-3 waiting
      break;
    case 'busy':
      seatTarget = maxPlayers - (h % 2); // full or one open
      break;
    case 'steady':
      seatTarget = maxPlayers - (2 + (h % 2)); // 2-3 open
      break;
    default:
      seatTarget = Math.max(3, maxPlayers - (3 + (h % 3))); // 3-5 open
      break;
  }
  if (humanSeated) seatTarget = Math.max(seatTarget, Math.min(maxPlayers, 4));
  return { seatTarget: Math.max(2, Math.min(maxPlayers, seatTarget)), waitTarget, vibe };
}

/**
 * Should this horse pick up and move to a different game right now?
 *
 * Session-end departures are HorseSessionRotator's job and are about the
 * session ending. This is the other half of what a floor looks like: a player
 * who is still playing but does not like THIS game — the table went quiet, or
 * they just fancy a change — and walks to another one. Without it the only
 * movement on the floor is people arriving and people quitting, and the same
 * faces sit at the same table until they log off.
 *
 * Rare per horse per cycle, so the floor churns steadily rather than churning
 * all at once.
 */
export function wantsTableChange(
  horseId: string,
  tableId: string,
  seatedCount: number,
  minutesAtTable: number,
  nowMs: number = Date.now()
): boolean {
  // Nobody table-hops the moment they sit down.
  if (minutesAtTable < 12) return false;
  const h = horseHash(`${horseId}:${tableId}:${Math.floor(nowMs / 60_000)}`);
  const roll = (h % 10_000) / 10_000;
  // A short-handed game empties faster: the fewer players, the likelier the
  // remaining ones leave, which is exactly how a dying table dies.
  const base = seatedCount <= 3 ? 0.055 : seatedCount <= 5 ? 0.018 : 0.008;
  // Restlessness is a trait: some players never move, some are always moving.
  const restless = 0.5 + ((horseHash(horseId) >>> 9) % 1000) / 1000;
  return roll < base * restless;
}
