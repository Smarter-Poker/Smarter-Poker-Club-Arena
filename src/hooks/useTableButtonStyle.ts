/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE BOOLEAN, READ-ONLY, SHARED — the button-skin selector
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `useButtonImage` needs exactly one thing: `blue_buttons_enabled`. To get it,
 * it used to mount the whole of `useUserTableSettings` — which is a settings
 * ENGINE, not a selector. Per call site that is:
 *
 *   - a full row of React state plus five mutation refs (`writeTailsRef`,
 *     `durableValueRef`, `pendingEchoRef`, `mutationRevisionRef`,
 *     `pendingWriteCountRef`), none of which a read-only consumer can use;
 *   - TWO MasterBus subscriptions (`SETTINGS_CHANGED` and
 *     `CUSTOMIZATION_MUTATION_STATE`);
 *   - and a re-render on EVERY settings change, not just this one flag.
 *
 * Six components call `useButtonImage` — TableMenu, PreviousHandCard,
 * MiniStatsCard, RabbitHunt, TableChat, TimebankCounter — plus two more calls
 * inside TablePage. That is eight per table, and MultiTablePage keeps four
 * tables mounted: **32 settings engines, 64 bus subscriptions, and 32
 * components re-rendering when any unrelated setting changes** — all to pick
 * between two words in a URL.
 *
 * ─── WHY THIS IS A SEPARATE STORE AND NOT A REFACTOR OF THAT HOOK ──────────
 *
 * `useUserTableSettings` synchronises its instances through MasterBus, with an
 * `origin` identity to skip your own echo and `pendingEchoRef` to suppress a
 * postgres echo while a local write is in flight. Collapsing those instances
 * onto one shared state would delete the meaning of "my own echo" and rewrite
 * the synchronisation model of a hook whose own notes describe a latch that
 * "swallows the next genuine cross-component change" — a bug that is
 * intermittent and cross-component, which is precisely the kind unit tests do
 * not catch.
 *
 * A read-only consumer does not need any of that. This store subscribes ONCE
 * per user, holds ONE boolean, and never writes. The settings panel's write
 * path is untouched, and this store simply hears the same broadcast it does.
 *
 * ─── HOW IT STAYS CORRECT ─────────────────────────────────────────────────
 *
 *   - first value comes from the same `readCachedSettings` cache the real hook
 *     seeds from, so the icon is right on the first paint;
 *   - it then awaits `fetchUserTableSettingsRow`, which is de-duplicated per
 *     user, so this adds NO query — it rides the one the real hook already
 *     issues;
 *   - and it listens to the same `SETTINGS_CHANGED` broadcast the real hook
 *     emits on every toggle, so flipping the setting still repaints every icon
 *     immediately.
 *
 * `useSyncExternalStore` is what binds it: React subscribes each component to
 * the store and re-renders it only when the boolean actually changes.
 */

import { useSyncExternalStore } from 'react';
import { masterBus } from '../core/MasterBus';
import {
  DEFAULT_USER_TABLE_SETTINGS,
  fetchUserTableSettingsRow,
  readCachedSettings,
} from './useUserTableSettings';

type Listener = () => void;

interface BlueButtonStore {
  value: boolean;
  listeners: Set<Listener>;
  /** Whether the one-time row read has been kicked off for this user. */
  hydrated: boolean;
  /** Unsubscribe for this user's single MasterBus listener. */
  unsubscribe: (() => void) | null;
}

const stores = new Map<string, BlueButtonStore>();

/** The value used before any user is known, and for signed-out viewers. */
const FALLBACK = DEFAULT_USER_TABLE_SETTINGS.blue_buttons_enabled;

function emit(store: BlueButtonStore, next: boolean) {
  // Bail on an unchanged value: useSyncExternalStore re-renders every
  // subscriber on notify, and this store exists to STOP needless renders.
  if (store.value === next) return;
  store.value = next;
  for (const l of store.listeners) l();
}

function storeFor(userId: string): BlueButtonStore {
  let store = stores.get(userId);
  if (store) return store;

  store = {
    value: Boolean(readCachedSettings(userId).blue_buttons_enabled),
    listeners: new Set(),
    hydrated: false,
    unsubscribe: null,
  };
  stores.set(userId, store);
  return store;
}

function hydrate(userId: string, store: BlueButtonStore) {
  if (store.hydrated) return;
  store.hydrated = true;

  // Rides the de-duplicated read — this adds no query of its own.
  void fetchUserTableSettingsRow(userId)
    .then(({ data, error }) => {
      if (error || !data) return;
      const row = data as Record<string, unknown>;
      const v = row.blue_buttons_enabled;
      emit(store, typeof v === 'boolean' ? v : FALLBACK);
    })
    .catch(() => {
      /* The cached value already on screen is the right thing to keep. Failing
         to hydrate must never blank an icon. */
    });

  store.unsubscribe = masterBus.subscribe('SETTINGS_CHANGED', (event) => {
    const payload = event.payload as
      | { userId?: string; setting?: string; value?: unknown }
      | undefined;
    if (!payload) return;
    if (payload.userId && payload.userId !== userId) return;
    if (payload.setting !== 'blue_buttons_enabled') return;
    emit(store, Boolean(payload.value));
  });
}

/**
 * True when the player has chosen the blue button skin.
 *
 * Read-only. To CHANGE the setting, use `useUserTableSettings().toggleSetting`
 * — that hook owns every write, and this store hears the broadcast it makes.
 */
export function useBlueButtonsEnabled(userId: string | null | undefined): boolean {
  const store = userId ? storeFor(userId) : null;
  if (userId && store) hydrate(userId, store);

  return useSyncExternalStore(
    (onChange) => {
      if (!store) return () => {};
      store.listeners.add(onChange);
      return () => {
        store.listeners.delete(onChange);
      };
    },
    () => (store ? store.value : FALLBACK),
    // Server snapshot: no localStorage during SSR/prerender, so the canonical
    // default is the only honest answer.
    () => FALLBACK
  );
}

/** Test seam — the number of live per-user stores. */
export function __blueButtonStoreCount(): number {
  return stores.size;
}

/** Test seam — drop all stores so each test starts clean. */
export function __resetBlueButtonStores(): void {
  for (const s of stores.values()) s.unsubscribe?.();
  stores.clear();
}
