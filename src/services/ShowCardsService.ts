/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ShowCardsService — "show this card after the hand"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-18: "a user should be able to click on any card in their hand,
 * and when clicked that card or cards always get shown after the hand is over."
 *
 * The engine already had POST /showhand, but it was all-or-nothing and only
 * accepted during showdown. It now also takes `cardIndexes`, which records the
 * player's picks at any point in the hand and defers the reveal to hand end.
 *
 * Two things worth knowing about the contract:
 *
 *  - Send the FULL current selection every time, not a delta. The engine
 *    replaces the stored set, which is what makes un-clicking a card work.
 *  - There is no "clear" verb. An empty cardIndexes array is rejected by the
 *    engine ("no valid card indexes"), and omitting the field entirely falls
 *    through to the showdown-gated whole-hand path. So an empty selection is
 *    handled locally as a no-op: nothing is exposed until the hand ends, and
 *    the engine resets its picks every hand regardless.
 */

import { reportError } from '../utils/errorReporter';

const ENGINE_BASE_URL =
  (import.meta as unknown as { env: Record<string, string> }).env?.VITE_ENGINE_URL ??
  'https://engine.smarter.poker';

const AUTH_STORAGE_KEY = 'smarter-poker-auth';

function authHeader(): Record<string, string> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_STORAGE_KEY) : null;
    if (!raw) return {};
    const token = (JSON.parse(raw) as { access_token?: string })?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export interface ShowCardsResult {
  success: boolean;
  error?: string;
  shownCardIndexes?: number[];
}

/**
 * Record which of the hero's own hole cards should be turned face up once the
 * hand finishes. Pass the complete current selection.
 *
 * Returns `{ success: false }` rather than throwing: a failed pick is a
 * cosmetic loss, and it must never interrupt play or reach the table's error
 * boundary mid-hand.
 */
export async function setShownCards(
  tableId: string,
  cardIndexes: readonly number[]
): Promise<ShowCardsResult> {
  if (!tableId) return { success: false, error: 'Missing tableId' };
  if (cardIndexes.length === 0) {
    // Nothing to record - see the note above; intentionally a no-op.
    return { success: true, shownCardIndexes: [] };
  }

  try {
    const res = await fetch(`${ENGINE_BASE_URL}/showhand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ tableId, cardIndexes: [...cardIndexes] }),
    });

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}` };
    }
    return (await res.json()) as ShowCardsResult;
  } catch (err) {
    reportError(err, 'ShowCardsService.setShownCards');
    return { success: false, error: 'Network error' };
  }
}

export default { setShownCards };
