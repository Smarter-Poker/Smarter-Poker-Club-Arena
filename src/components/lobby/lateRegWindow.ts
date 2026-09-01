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
 * The function itself depends only on the blind-structure parser, so it lives
 * here and both readers import it. lobbyEntries re-exports it so existing
 * callers are unchanged. The row type is imported type-only, which TypeScript
 * erases, so nothing at runtime crosses back.
 */
import { blindLevelMinutes, parseBlindStructure } from './tournamentFigures';
import type { LobbyTournamentRow } from './lobbyEntries';

/**
 * When does late registration CLOSE, in ms epoch — or null when the row does
 * not carry enough to know. Mirrors isInLateRegistration's OR: minutes and
 * levels each keep the door open, so the close is the LATER of the two
 * windows the row can prove.
 *
 * The level window is exact when the row carries blind_structure and
 * level_started_at: the remainder of the current level plus every remaining
 * late-reg level's configured duration. (Dan 2026-08-24: the late reg closing
 * needs a countdown timer, not a static "Thru Level N".)
 */
export function lateRegEndMs(t: LobbyTournamentRow): number | null {
  const candidates: number[] = [];

  const begun = new Date(t.started_at || t.start_time || '').getTime();
  const lateMins = Number(t.late_reg_mins) || 0;
  if (lateMins > 0 && Number.isFinite(begun)) candidates.push(begun + lateMins * 60000);

  const lateLevels = Number(t.late_reg_levels) || 0;
  if (lateLevels > 0) {
    const structure = parseBlindStructure(t.blind_structure);
    if (structure) {
      /**
       * INDEXES, NOT DISPLAY NUMBERS (2026-08-25).
       *
       * `late_reg_levels` counts 0-BASED indices: isInLateRegistration keeps
       * the door open while `current_level < late_reg_levels`, and
       * TournamentManagerBase closes it on `currentLevel >= cap`. This block
       * compared that cap against tournamentLevel(), the 1-based DISPLAY
       * number, so on the final late-reg level it added the remainder of the
       * current level PLUS an entire extra level that registration would
       * never see. The card counted down past the moment the RPC began
       * refusing entries, and Register was dead for the difference.
       */
      const curIdx = Math.max(0, Number(t.current_level) || 0);
      /* `|| t.started_at` measured the CURRENT level's remaining time from
         the tournament's start - hours in the past on level 5 - so the levels
         candidate returned a moment already gone and the card froze on
         "Late Reg 0:00 Left" beside a working Register button. levelRemainingMs
         already refuses to guess without level_started_at; this now agrees. */
      const levelBegun = new Date(t.level_started_at || '').getTime();
      if (Number.isFinite(levelBegun) && curIdx < lateLevels) {
        // Rest of the level now running, then every remaining level up to but
        // NOT including the cap. A level with no configured duration adds 0 —
        // the estimate degrades toward "sooner", never invents time.
        // blindLevelMinutes takes a 1-based level, hence the +1 on each index.
        let end = levelBegun + blindLevelMinutes(structure, curIdx + 1) * 60000;
        for (let idx = curIdx + 1; idx < lateLevels; idx++)
          end += blindLevelMinutes(structure, idx + 1) * 60000;
        candidates.push(end);
      }
    }
  }

  return candidates.length > 0 ? Math.max(...candidates) : null;
}
