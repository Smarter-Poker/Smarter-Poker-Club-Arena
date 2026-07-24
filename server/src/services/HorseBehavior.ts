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
