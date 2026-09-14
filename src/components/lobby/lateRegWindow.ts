/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LATE REGISTRATION WINDOW — extracted from lobbyEntries (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS IS ITS OWN FILE.
 *
 * TournamentStartingTicker mounts at the app root, outside <Routes>, so every
 * module it imports lands in the ENTRY chunk that every player downloads
 * before first paint. It needed exactly one function from lobbyEntries, and
 * that single named import dragged the whole 1,482-line lobby module and its
 * dependency tree into the initial bundle: measured at +12kB gzipped on the
 * entry chunk, paid by every visitor whether or not they ever open a lobby.
 *
 * The function depends on the blind-structure parser and the dependency-free
 * entry-window display projection. Both readers import this small module. lobbyEntries re-exports it so existing
 * callers are unchanged. The row type is imported type-only, which TypeScript
 * erases, so nothing at runtime crosses back.
 */
import { tournamentEntryWindow } from '../../utils/tournamentEntryWindow';
import { blindLevelMinutes, parseBlindStructure } from './tournamentFigures';
import type { LobbyTournamentRow } from './lobbyEntries';

/** Estimate the selected engine window, never the later of unrelated clocks. */
export function lateRegEndMs(t: LobbyTournamentRow): number | null {
  const window = tournamentEntryWindow(t);
  if (window.mode === 'minutes') {
    const begun = Date.parse(t.started_at ?? '');
    return Number.isFinite(begun) ? begun + window.minutes * 60000 : null;
  }
  if (window.mode !== 'levels' || window.current >= window.cap) return null;
  const structure = parseBlindStructure(t.blind_structure);
  const levelBegun = Date.parse(t.level_started_at ?? '');
  if (!structure || window.cap > structure.length || !Number.isFinite(levelBegun)) return null;
  let end = levelBegun;
  for (let index = window.current; index < window.cap; index++) {
    const minutes = blindLevelMinutes(structure, index + 1);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    end += minutes * 60000;
  }
  return end;
}
