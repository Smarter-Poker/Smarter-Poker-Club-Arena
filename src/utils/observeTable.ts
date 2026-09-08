/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OBSERVE A TABLE IN A NEW SCREEN — one door, used by the whole lobby
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25. The tournament lobby lets a player watch any table in the
 * event from two places — a player row in Ranking, and a table row in Tables.
 * Both must behave identically, and both must obey one rule:
 *
 *     WATCHING A TABLE NEVER COSTS YOU A SCREEN YOU ARE ALREADY USING.
 *
 * so this ADDS a screen (the same thing the tab strip's "+" does) instead of
 * replacing the one in front of you, and every other screen keeps dealing.
 *
 * WHY BOTH AN EVENT AND A NAVIGATE, and why that is not belt-and-braces:
 *
 *   MultiTablePage is mounted for every signed-in player but it is LAZY, so on
 *   a cold tournament-lobby load its chunk may not have arrived yet and there
 *   is nobody subscribed to the bus. Emitting alone would be a dead button in
 *   exactly the case a player is most likely to hit — first click of a session.
 *   Navigating alone would work, but only because MultiTablePage's route effect
 *   silently rescues it, and that effect CONVERTS a parked lobby tab rather
 *   than adding, which is the wrong shape for "watch this too".
 *
 *   So: emit first (adds the screen, keeps the tournament lobby where it is
 *   when it is itself a tab), then navigate (makes the table layer visible and
 *   covers the cold-chunk case). Both paths are keyed on the table id and
 *   MultiTablePage de-duplicates by id — the second one to arrive FOCUSES the
 *   tab the first one created. Running both can therefore only ever produce
 *   one screen, never two.
 *
 * REFUSAL: at the screen cap MultiTablePage raises the standard cap notice and
 * declines. It does not close a screen for you, and it does not fail silently.
 */

import { masterBus } from '../core/MasterBus';
import { warmTable } from '../services/tableWarmup';

export interface ObserveTableRequest {
  tableId: string;
  /** Cosmetic tab label until the engine reports the real one. */
  tableName?: string;
  stakes?: string;
}

/**
 * The bus half. Safe to call from anywhere; a no-op on a falsy id so callers
 * do not each need their own guard around an optional `table_id`.
 */
export function requestObserveTable(request: ObserveTableRequest): boolean {
  if (!request?.tableId) return false;
  warmTable(request.tableId);
  masterBus.emit('OPEN_OBSERVE_TABLE', {
    tableId: request.tableId,
    tableName: request.tableName,
    stakes: request.stakes,
  });
  return true;
}

/**
 * The whole gesture, for components that hold a `navigate` from react-router.
 *
 *   openTableAsObserver(navigate, { tableId, tableName })
 *
 * Returns false when there is nothing to open — a player with no seat yet, a
 * table row missing its id — so the caller can tell the player why instead of
 * appearing to do nothing.
 */
export function openTableAsObserver(
  navigate: (path: string) => void,
  request: ObserveTableRequest
): boolean {
  if (!requestObserveTable(request)) return false;
  navigate(`/table/${request.tableId}`);
  return true;
}
