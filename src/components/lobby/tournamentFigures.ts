/* ═══════════════════════════════════════════════════════════════════════════
   TOURNAMENT FIGURES — one reader for the blind structure
   ───────────────────────────────────────────────────────────────────────────
   `blind_structure` is a TEXT column holding a JSON array, and BlindLevel
   declares every field under two spellings: `small_blind` / `big_blind` /
   `duration_minutes` are canonical and `smallBlind` / `bigBlind` /
   `durationMinutes` are legacy. All 22,175 rows stored today use the legacy
   spelling, which is exactly why the readers drifted: three separate parsers
   grew up in this folder (the lobby table's blinds cell, the late-reg
   estimator in lobbyEntries, and the game panel's structure tab) and each
   one happened to read only the spelling it was written against. The first
   row written in the canonical shape would have gone blank in some of them
   and not others, silently — a `catch` that returns null looks identical to
   a tournament that simply has no structure.

   One parser, both spellings, no throw. Everything in the lobby reads the
   blind structure through here.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { BlindLevel } from '../../types/database.types';

/** Parse the TEXT column. Returns null for absent, malformed or non-array. */
export function parseBlindStructure(raw: string | null | undefined): BlindLevel[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BlindLevel[]) : null;
  } catch {
    return null;
  }
}

/** The row for a level: matched by its own `level` field, else by position. */
export function blindLevelAt(levels: BlindLevel[], level: number): BlindLevel | undefined {
  return levels.find((l) => Number(l?.level) === level) || levels[level - 1];
}

/**
 * The level a tournament is on.
 *
 * `current_level` is only written once a tournament starts running, so every
 * row still in registration carries 0 or null. A game that has not dealt a
 * hand is on level 1 by definition — that is the level it will open at, and
 * it is what a player deciding whether to register wants to read.
 */
export function tournamentLevel(t: { current_level?: number | null }): number {
  return Math.max(1, Number(t.current_level) || 1);
}

/** "100/200" for the current level, or null when the structure cannot say. */
export function tournamentBlinds(t: {
  current_level?: number | null;
  blind_structure?: string | null;
}): string | null {
  const levels = parseBlindStructure(t.blind_structure);
  if (!levels) return null;
  const lv = blindLevelAt(levels, tournamentLevel(t));
  const sb = Number(lv?.small_blind ?? lv?.smallBlind ?? 0);
  const bb = Number(lv?.big_blind ?? lv?.bigBlind ?? 0);
  if (!sb || !bb) return null;
  return `${sb.toLocaleString()}/${bb.toLocaleString()}`;
}

/** Minutes configured for a level. 0 when unknown — never a guess. */
export function blindLevelMinutes(levels: BlindLevel[], level: number): number {
  const row = blindLevelAt(levels, level);
  const mins = Number(row?.duration_minutes ?? row?.durationMinutes ?? 0);
  return Number.isFinite(mins) && mins > 0 ? mins : 0;
}
