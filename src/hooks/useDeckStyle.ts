/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useDeckStyle — the player's four-colour-deck preference, everywhere
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *
 * The four-colour deck toggle only worked on the table felt. TablePage passed
 * `userSettings.fourColorDeck ? '4color' : '2color'` down to SeatSlot and
 * CommunityCards, but 27 of the 32 <CardImage> call sites in the app hardcoded
 * deckStyle="4color" instead - hand replay, insurance, run-it-twice, rabbit
 * hunt, share-hand, the tournament reveal, the odds display. Turning the
 * setting off changed the felt and nothing else, so a two-colour player still
 * met four-colour cards all over the app.
 *
 * Threading a prop through 27 sites would leave the same trap for the next
 * component someone adds. Instead CardImage resolves the preference itself
 * when no deckStyle is passed, and this hook is how it does that.
 *
 * SOURCE OF TRUTH
 *
 * useTableSettings owns the setting: it persists to STORAGE_KEYS.TABLE_SETTINGS
 * in localStorage and announces changes on the MasterBus as SETTINGS_CHANGED.
 * This hook reads that same key and listens to that same event, so a toggle
 * anywhere updates every card on screen without a reload. It deliberately does
 * NOT own state - it is a reader, so there is still exactly one source of
 * truth.
 */

import { useSyncExternalStore } from 'react';
import { masterBus } from '../core/MasterBus';
import { STORAGE_KEYS } from '../lib/storage';

export type DeckStyle = '4color' | '2color';

/** Matches DEFAULT_SETTINGS.fourColorDeck (false) in useTableSettings. */
const DEFAULT_DECK_STYLE: DeckStyle = '2color';

/**
 * Cached so getSnapshot stays cheap and referentially stable - React calls it
 * on every render, and re-parsing JSON out of localStorage once per card (52
 * of them) per render would be pure waste.
 */
let cached: DeckStyle | null = null;

function read(): DeckStyle {
  if (cached !== null) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.TABLE_SETTINGS);
    if (!raw) {
      cached = DEFAULT_DECK_STYLE;
      return cached;
    }
    const parsed = JSON.parse(raw) as { fourColorDeck?: unknown };
    cached = parsed?.fourColorDeck === true ? '4color' : '2color';
    return cached;
  } catch {
    // Corrupt or unavailable storage must never stop a card from rendering.
    cached = DEFAULT_DECK_STYLE;
    return cached;
  }
}

/** Non-reactive read, for code outside React. */
export function getDeckStyle(): DeckStyle {
  return read();
}

function subscribe(onChange: () => void): () => void {
  const invalidate = () => {
    cached = null;
    onChange();
  };

  // Drop the cache when the FIRST subscriber arrives, not only on change.
  // `cached` is module scope, but invalidation only runs while something is
  // subscribed - and a page that renders no cards has no subscribers.
  // SettingsPage is exactly such a page, and it is where the toggle lives:
  // toggling there wrote localStorage and invalidated nothing, so returning to
  // a table in the same SPA session served the pre-toggle value from cache
  // while the felt, which receives the value as an explicit prop, showed the
  // new one - two deck styles on screen at once until a reload. Re-reading on
  // subscribe closes that, and stops the cache leaking between vitest cases.
  cached = null;

  // In-tab: useTableSettings emits this whenever any table setting changes.
  const unsubBus = masterBus.subscribe('SETTINGS_CHANGED', invalidate);

  // Cross-tab: `storage` fires only in OTHER tabs, which is exactly what the
  // bus cannot reach. Together the two cover both cases.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === STORAGE_KEYS.TABLE_SETTINGS) invalidate();
  };
  window.addEventListener('storage', onStorage);

  return () => {
    unsubBus();
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * The deck style the player has chosen. Re-renders on change, in this tab and
 * in others. The server snapshot is the default, so prerender never touches
 * localStorage.
 */
export function useDeckStyle(): DeckStyle {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_DECK_STYLE);
}

export default useDeckStyle;
