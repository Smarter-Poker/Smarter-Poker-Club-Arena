/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  useNotificationsOverlayStore — who is allowed to open the notifications
 *  surface, and from where
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02: "WHEN YOU CLICK ON NOTIFICATIONS, IT SHOULDN'T OPEN TO ITS
 * OWN PAGE, IT SHOULD CREATE A FULL SCREEN POP UP SO YOU STAY ON THE PAGE YOU
 * WERE ON, AND NOT REDIRECT TO A WHOLE PAGE FOR NOTIFICATIONS. YOU SHOULD BE
 * ABLE TO X OFF THE NOTIFICATIONS POP UP AND STAY ON THE SAME PAGE YOU WERE
 * ON STILL."
 *
 * WHY A STORE RATHER THAN LOCAL STATE IN THE HEADER
 * ───────────────────────────────────────────────────────────────────────────
 * There is more than one door into notifications — the global header bell, the
 * hamburger menu, the account section rail, and any future surface that wants
 * one. If the open flag lived inside GlobalHeader, every other door would have
 * to keep navigating, which is the exact split the World Hub already has: its
 * bell opens an overlay while its bottom nav still hard-navigates to the page,
 * so the same word behaves two different ways in one app. One flag, read by
 * one mounted overlay, is what makes "click notifications" mean the same thing
 * everywhere.
 *
 * THE ROUTE IS NOT DELETED, AND MUST NOT BE
 * ───────────────────────────────────────────────────────────────────────────
 * `/notifications` still renders the same surface as a real page. Push payload
 * deep links, bookmarks, `everyRouteIsReachableLaw`, and cmd-clicking the bell
 * all land there. The overlay is an additional way in, not a replacement for
 * the address.
 */

import { create } from 'zustand';

interface NotificationsOverlayState {
  isOpen: boolean;
  /**
   * Where the player was standing when they opened it. Recorded for telemetry
   * and for the `data-opened-from` attribute on the overlay, so a bug report
   * that says "it opened over the wrong thing" can name the door that was used.
   */
  openedFrom: string | null;
  openNotifications: (source?: string) => void;
  closeNotifications: () => void;
}

export const useNotificationsOverlayStore = create<NotificationsOverlayState>((set) => ({
  isOpen: false,
  openedFrom: null,
  openNotifications: (source = 'unknown') => set({ isOpen: true, openedFrom: source }),
  closeNotifications: () => set({ isOpen: false, openedFrom: null }),
}));

/**
 * Imperative open, for call sites that are not React components (menu config
 * handlers, telemetry wrappers). Same store, same single overlay.
 */
export const openNotificationsOverlay = (source?: string): void =>
  useNotificationsOverlayStore.getState().openNotifications(source);

export const closeNotificationsOverlay = (): void =>
  useNotificationsOverlayStore.getState().closeNotifications();
