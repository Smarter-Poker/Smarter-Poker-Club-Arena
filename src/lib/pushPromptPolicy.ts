/**
 * pushPromptPolicy.ts - WHEN a push enrolment offer may appear, and WHICH one.
 *
 * Pure decisions over an explicit environment, so every surface (the one-time
 * FirstRunPushPrompt, the always-available banner on the Notifications page,
 * and the contextual banners in the cashier, on a cashier receipt and after a
 * tournament registration) asks the same question the same way, and the
 * answers are testable without a browser (tests/unit/pushPromptPolicy.test.ts).
 *
 * THE CONTEXTUAL RULES (2026-09-27)
 * - A contextual offer appears only where the moment makes the value obvious:
 *   right after money moved, or right after a registration whose start time
 *   the player will want to be told about.
 * - It is never modal and never blocks: it is the PushEnableBanner inked on
 *   the surface's own console glass.
 * - It appears only when there is something to offer: supported, not
 *   subscribed, not explicitly switched off, and not blocked (a blocked
 *   browser cannot be fixed from a receipt; the Notifications page keeps that
 *   instruction).
 * - On an iPhone outside an installed Home Screen app there is no web push at
 *   all, so the offer is the Add To Home Screen instruction instead.
 * - Each surface has its own cooldown, started the moment it is shown, so one
 *   player sees each nudge at most once per window, and a No on one surface
 *   never silences the others.
 */

export type PushPromptSurface =
  | 'first_run'
  | 'notifications_page'
  | 'cashier'
  | 'cashier_receipt'
  | 'tournament_registration'
  | 'settings'
  | 'unknown';

/** Surfaces that appear in context, with a cooldown, rather than on demand. */
export type ContextualPushSurface = 'cashier' | 'cashier_receipt' | 'tournament_registration';

export type PushOffer = null | 'ask' | 'install' | 'blocked';

export interface PushEnvironment {
  /** isWebPushSupported(): the device can hold a subscription at all. */
  supported: boolean;
  /** iOS in a browser tab: web push exists only once installed to the Home Screen. */
  iosNeedsInstall: boolean;
  /** The player explicitly switched push off (shared sp_push_opt_out key). */
  optedOut: boolean;
  permission: NotificationPermission | 'unsupported';
  /** hasLocalSubscription(): this device already holds a live subscription. */
  subscribed: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Per-surface cooldowns. The cashier is a page a player visits often, so it
 * asks at most weekly; a receipt or a registration is an event, and three
 * days lets the next one ask again without it becoming a habit.
 */
export const CONTEXTUAL_COOLDOWN_MS: Record<ContextualPushSurface, number> = {
  cashier: 7 * DAY_MS,
  cashier_receipt: 3 * DAY_MS,
  tournament_registration: 3 * DAY_MS,
};

export function isContextualSurface(surface: PushPromptSurface): surface is ContextualPushSurface {
  return Object.prototype.hasOwnProperty.call(CONTEXTUAL_COOLDOWN_MS, surface);
}

/**
 * Which offer, if any. `contextual` surfaces never show the blocked
 * instruction; the Notifications page, where a player goes to find out why
 * their phone is quiet, does.
 */
export function decidePushOffer(env: PushEnvironment, contextual: boolean): PushOffer {
  if (!env.supported) return env.iosNeedsInstall ? 'install' : null;
  if (env.optedOut) return null;
  if (env.permission === 'denied') return contextual ? null : 'blocked';
  if (env.subscribed) return null;
  return 'ask';
}

export function cooldownKey(surface: ContextualPushSurface, userId: string): string {
  return `sp_push_ctx_${surface}_${userId}`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** True while this surface's last showing is inside its cooldown window. */
export function isCoolingDown(
  surface: ContextualPushSurface,
  userId: string,
  now: number = Date.now(),
  storage: StorageLike | null = defaultStorage()
): boolean {
  if (!storage) return false;
  let last = 0;
  try {
    last = Number(storage.getItem(cooldownKey(surface, userId)) || 0);
  } catch {
    return false;
  }
  if (!Number.isFinite(last) || last <= 0) return false;
  // A clock that moved backwards must not freeze the offer forever.
  if (last > now) return false;
  return now - last < CONTEXTUAL_COOLDOWN_MS[surface];
}

/** Start this surface's cooldown. Private mode simply never cools down. */
export function startCooldown(
  surface: ContextualPushSurface,
  userId: string,
  now: number = Date.now(),
  storage: StorageLike | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(cooldownKey(surface, userId), String(now));
  } catch {
    /* private mode */
  }
}

/**
 * The telemetry outcome of one enablePush() result. `supported` is read
 * before the call. A permission prompt the player closed without answering is
 * a decline, not a fault; anything else that did not end in a subscription is
 * a failure.
 */
export type PushPromptEvent = 'shown' | 'accepted' | 'declined' | 'failed' | 'unsupported';

export function enableOutcome(
  result: { ok: boolean; permission?: string; error?: string },
  supported: boolean
): { event: PushPromptEvent; detail: string | null } {
  if (!supported) return { event: 'unsupported', detail: null };
  if (result.ok) return { event: 'accepted', detail: null };
  if (result.permission === 'denied') return { event: 'declined', detail: 'permission_denied' };
  if (result.permission === 'default') return { event: 'declined', detail: 'permission_dismissed' };
  return { event: 'failed', detail: failureDetail(result.error) };
}

/**
 * A bounded category for a failure, never the message itself: a message can
 * carry an endpoint or a device detail, and the column only accepts
 * [a-z0-9:_-].
 */
export function failureDetail(error: string | undefined): string {
  const e = (error || '').toLowerCase();
  if (e.includes('timed out')) return 'timeout';
  if (e.includes('not configured')) return 'not_configured';
  if (e.includes('another account')) return 'device_owned';
  if (e.includes('service worker') || e.includes('worker')) return 'service_worker';
  if (e.includes('vapid') || e.includes('key')) return 'vapid_key';
  if (e.includes('subscrib')) return 'subscribe';
  if (e.includes('save') || e.includes('sign') || e.includes('401') || e.includes('403')) {
    return 'persist';
  }
  return 'unknown';
}
