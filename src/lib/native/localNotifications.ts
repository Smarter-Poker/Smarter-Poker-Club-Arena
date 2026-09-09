/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LOCAL NOTIFICATIONS — what public/sw-bus.js did for a backgrounded tab
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Store readiness, tier 3 ("decide what happens to sw-bus.js"). On the web,
 * MasterBus forwards its CRITICAL_EVENTS to the service worker, which shows
 * a notification only when no tab is visible (public/sw-bus.js). The app
 * registers no service worker (App.tsx, IS_NATIVE_BUILD), so those events
 * come here instead and become @capacitor/local-notifications, shown only
 * when the app is NOT active - the same rule the worker applied.
 *
 * Permission is never requested from here. Local notifications share the OS
 * permission with push (src/lib/native/push.ts asks for it when the player
 * turns notifications on); if it is not granted, nothing is shown, exactly
 * as a browser without notification permission shows nothing.
 *
 * Reached only from MasterBus behind IS_NATIVE_BUILD (compile-time), so none
 * of this is in the web bundle.
 */

/* The worker's labels, without the emoji it prefixed them with (10.7). */
const TITLES: Record<string, string> = {
  BALANCE_UPDATED: 'Balance Updated',
  VIP_POINTS_UPDATED: 'VIP Points Updated',
  CLUB_JOINED: 'Club Joined',
  CLUB_LEFT: 'Left Club',
  TABLE_SEATED: 'Seated At Table',
  TABLE_LEFT: 'Left Table',
  FINANCIAL_ALERT: 'Financial Alert',
};

function titleCase(raw: string): string {
  return raw
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Pure: the worker's body rules, kept identical. Exported for tests. */
export function notificationBody(eventType: string, payload: unknown): string {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (eventType === 'BALANCE_UPDATED') return `Source: ${String(p.source || 'unknown')}`;
  if (eventType === 'CLUB_JOINED' || eventType === 'CLUB_LEFT') {
    return titleCase(String(p.clubName || p.clubId || ''));
  }
  if (eventType === 'TABLE_SEATED' || eventType === 'TABLE_LEFT') {
    return `Table: ${String(p.tableId || '')}`;
  }
  return '';
}

export function notificationTitle(eventType: string): string {
  return TITLES[eventType] || titleCase(eventType.replace(/_/g, ' '));
}

let nextId = 1;

/** Show one notification for a bus event, only if the app is in the background and allowed to. */
export async function notifyInBackground(eventType: string, payload: unknown): Promise<boolean> {
  const [{ App }, { LocalNotifications }] = await Promise.all([
    import('@capacitor/app'),
    import('@capacitor/local-notifications'),
  ]);
  const { isActive } = await App.getState();
  if (isActive) return false;
  const { display } = await LocalNotifications.checkPermissions();
  if (display !== 'granted') return false;
  nextId = (nextId % 100000) + 1;
  await LocalNotifications.schedule({
    notifications: [
      {
        id: nextId,
        title: notificationTitle(eventType),
        body: notificationBody(eventType, payload),
        // One banner per event type, replaced rather than stacked (the
        // worker used `tag` + `renotify` for the same effect).
        group: `bus-${eventType}`,
        extra: { url: '/hub/club-arena' },
      },
    ],
  });
  return true;
}
