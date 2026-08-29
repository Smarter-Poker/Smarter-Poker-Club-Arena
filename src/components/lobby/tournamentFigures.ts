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
import { parseJsonCached } from '../../utils/parseJsonCached';

/**
 * Parse the TEXT column. Returns null for absent, malformed or non-array.
 *
 * Memoised on the string. The lobby calls this from `tournamentBlinds`,
 * `blindLevelMinutes`, `levelRemainingMs` and `lateRegEndMs` — four readers,
 * each once per card, on a board that re-renders on a timer. The row does not
 * change between them, so neither does the string, so neither does the parse.
 */
export function parseBlindStructure(raw: string | null | undefined): BlindLevel[] | null {
  if (!raw) return null;
  const parsed = parseJsonCached(raw);
  return Array.isArray(parsed) ? (parsed as BlindLevel[]) : null;
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
  /**
   * ── current_level IS 0-BASED. THIS ADDS THE ONE. ────────────────────────
   *
   * Verified against production 2026-08-25: a tournament with
   * `current_level = 8` indexes to a blind_structure element whose own
   * `level` field reads 9. Three other files in this repo already say so and
   * were fixed for it — tournamentFilters ("a 0-BASED index into
   * blind_structure"), TournamentInfoPanel ("blind_structure[current_level]
   * .level === current_level + 1"), TablePage ("const currentLevel = levelIdx
   * + 1; // display number").
   *
   * This function did not, so the lobby was permanently ONE LEVEL BEHIND from
   * the first level-up: it printed "Level 8" on a game that was on 9, and
   * blindLevelAt(levels, 8) then handed back level 8's blinds — the previous
   * level's. Both numbers on the card were wrong, and they were wrong
   * consistently enough to look right.
   *
   * The clamp survives so a registering row (0 or null) still reads Level 1,
   * which is the level it will open at.
   */
  return Math.max(1, (Number(t.current_level) || 0) + 1);
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

/**
 * Minutes configured for a level. 0 when unknown — never a guess.
 *
 * THREE spellings, not two (found 2026-08-25 while putting "3 Min Levels" on
 * a Spin card). Spins do not use either of the documented keys: createSpin
 * writes `duration` in SECONDS. So every Spin read 0 here, which meant
 * levelRemainingMs and lateRegEndMs returned null for the entire Spin board —
 * the level countdown on a running Spin was not merely unlabelled, it was
 * dead, and it looked exactly like a tournament with no structure. Reading
 * the seconds key last keeps the canonical spellings authoritative where a
 * row carries both.
 */
export function blindLevelMinutes(levels: BlindLevel[], level: number): number {
  const row = blindLevelAt(levels, level);
  const mins = Number(row?.duration_minutes ?? row?.durationMinutes ?? 0);
  if (Number.isFinite(mins) && mins > 0) return mins;
  const secs = Number(row?.duration ?? 0);
  if (Number.isFinite(secs) && secs > 0) return secs / 60;
  return 0;
}
