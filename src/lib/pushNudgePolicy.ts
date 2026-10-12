/**
 * WHEN MAY WE ASK A PLAYER TO TURN NOTIFICATIONS ON? (2026-09-27)
 *
 * Pure decision logic, identical in behaviour to the World Hub's
 * src/lib/push/enrollment-nudge.mjs. Both apps are served from smarter.poker
 * and read ONE localStorage, so the two copies read and write the SAME ledger
 * key: a Not Now in one app is honoured by the other. Change both together.
 *
 * The old rule was "ask once per account per browser, forever". Measured on
 * production 2026-09-27: 218 human profiles, 4 accounts ever enrolled. One ask
 * twenty seconds after landing, recorded permanently whatever the answer, is
 * not a sign-up flow. This replaces it with:
 *
 *   - asks tied to moments where a notification is obviously useful (joining a
 *     club, a rakeback receipt, the invoice workspace), plus the first-visit ask;
 *   - Not Now starts a cool-down (7 days, then 30) instead of closing the door;
 *     three Not Nows stop the contextual asks for good. Settings stays the
 *     re-enable path in every state;
 *   - at most one ask per day, whatever the moment;
 *   - never an ask when this device is already on, when the person turned
 *     notifications off themselves, or when the browser blocked them;
 *   - the OS permission dialog is only raised by the person's own tap.
 *
 * OWNER EXCEPTION. Dan's accounting copies route to Production Alerts
 * (PR #5428), so he is never nudged to enroll FOR RECEIPTS. This module does
 * not touch that routing.
 */

export const OWNER_USER_ID = '47965354-0e56-43ef-931c-ddaab82af765';

export const NUDGE_MOMENTS = [
  'first_run',
  'club_joined',
  'rakeback_receipt',
  'invoice_workspace',
] as const;
export type NudgeMoment = (typeof NUDGE_MOMENTS)[number];
const RECEIPT_MOMENTS = new Set<string>(['rakeback_receipt', 'invoice_workspace']);

const DAY = 24 * 60 * 60 * 1000;
export const COOLDOWNS_MS = [7 * DAY, 30 * DAY] as const;
export const MAX_DISMISSALS = 3;
export const MIN_GAP_BETWEEN_ASKS_MS = DAY;

export const ledgerKey = (userId: string) => `sp_push_nudge_v1_${userId}`;
/** Written by the original one-time prompt in both apps; read for continuity. */
export const legacyAskedKey = (userId: string) => `sp_firstrun_notif_v2_${userId}`;
export const legacyInstallKey = (userId: string) => `sp_firstrun_ios_install_${userId}`;

export interface NudgeLedger {
  dismissals: number;
  lastDismissedAt: number;
  lastShownAt: number;
}

export interface NudgeDevice {
  supported: boolean;
  iosNeedsInstall: boolean;
  permission: string;
  subscribed: boolean;
  optedOut: boolean;
}

export type NudgeDecision =
  | { show: true; variant: 'ask' | 'install' }
  | { show: false; reason: string };

const EMPTY: NudgeLedger = Object.freeze({ dismissals: 0, lastDismissedAt: 0, lastShownAt: 0 });

function finite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

export function sameUser(a: unknown, b: unknown): boolean {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.trim().toLowerCase() === b.trim().toLowerCase()
  );
}

export function isNudgeMoment(value: unknown): value is NudgeMoment {
  return typeof value === 'string' && (NUDGE_MOMENTS as readonly string[]).includes(value);
}

/** Parse a stored ledger defensively: a corrupt value is an empty ledger. */
export function parseLedger(raw: string | null | undefined): NudgeLedger {
  if (!raw) return { ...EMPTY };
  try {
    const v = JSON.parse(raw) as Partial<NudgeLedger> | null;
    if (!v || typeof v !== 'object') return { ...EMPTY };
    return {
      dismissals: Math.min(Math.max(Math.floor(finite(v.dismissals)), 0), MAX_DISMISSALS),
      lastDismissedAt: finite(v.lastDismissedAt),
      lastShownAt: finite(v.lastShownAt),
    };
  } catch {
    return { ...EMPTY };
  }
}

export function decideNudge(input: {
  userId: string | null | undefined;
  moment: string;
  now: number;
  ledger?: NudgeLedger;
  legacyAskedAt?: number;
  legacyInstallAt?: number;
  device: NudgeDevice;
}): NudgeDecision {
  const {
    userId,
    moment,
    now,
    ledger = EMPTY,
    legacyAskedAt = 0,
    legacyInstallAt = 0,
    device,
  } = input;
  if (!userId) return { show: false, reason: 'signed_out' };
  if (!isNudgeMoment(moment)) return { show: false, reason: 'unknown_moment' };
  if (RECEIPT_MOMENTS.has(moment) && sameUser(userId, OWNER_USER_ID)) {
    return { show: false, reason: 'owner_receipts_route_to_production_alerts' };
  }
  if (device.optedOut) return { show: false, reason: 'opted_out' };
  if (device.permission === 'denied') return { show: false, reason: 'blocked' };
  if (device.subscribed) return { show: false, reason: 'already_on' };

  let variant: 'ask' | 'install' = 'ask';
  if (!device.supported) {
    if (!device.iosNeedsInstall) return { show: false, reason: 'unsupported' };
    variant = 'install';
  }

  // A legacy "asked once" mark counts as one earlier Not Now at that time. The
  // original prompt wrote it for success, denial and Not Now alike; success and
  // denial are excluded above, so what remains is a person who deferred.
  let { dismissals, lastDismissedAt } = ledger;
  const legacy = finite(legacyAskedAt);
  if (dismissals === 0 && legacy) {
    dismissals = 1;
    lastDismissedAt = legacy;
  }
  if (variant === 'install') lastDismissedAt = Math.max(lastDismissedAt, finite(legacyInstallAt));

  if (moment === 'first_run' && (dismissals > 0 || ledger.lastShownAt > 0)) {
    return { show: false, reason: 'first_run_already_asked' };
  }
  if (dismissals >= MAX_DISMISSALS) return { show: false, reason: 'declined_repeatedly' };
  if (dismissals > 0) {
    const wait = COOLDOWNS_MS[Math.min(dismissals - 1, COOLDOWNS_MS.length - 1)];
    if (now - lastDismissedAt < wait) return { show: false, reason: 'cooling_down' };
  } else if (variant === 'install' && lastDismissedAt && now - lastDismissedAt < COOLDOWNS_MS[0]) {
    return { show: false, reason: 'cooling_down' };
  }
  if (ledger.lastShownAt && now - ledger.lastShownAt < MIN_GAP_BETWEEN_ASKS_MS) {
    return { show: false, reason: 'asked_recently' };
  }
  return { show: true, variant };
}

export function recordShown(ledger: NudgeLedger, now: number): NudgeLedger {
  return { ...ledger, lastShownAt: now };
}

export function recordDismissed(ledger: NudgeLedger, now: number, legacyAskedAt = 0): NudgeLedger {
  const base = ledger.dismissals === 0 && finite(legacyAskedAt) ? 1 : ledger.dismissals;
  return { ...ledger, dismissals: Math.min(base + 1, MAX_DISMISSALS), lastDismissedAt: now };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

/** Private windows throw on localStorage; never let that escape. */
export function readNudgeState(storage: StorageLike, userId: string) {
  const read = (k: string) => {
    try {
      return storage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  };
  return {
    ledger: parseLedger(read(ledgerKey(userId))),
    legacyAskedAt: Number(read(legacyAskedKey(userId)) || 0) || 0,
    legacyInstallAt: Number(read(legacyInstallKey(userId)) || 0) || 0,
  };
}

export function writeLedger(storage: StorageLike, userId: string, ledger: NudgeLedger): void {
  try {
    storage?.setItem(ledgerKey(userId), JSON.stringify(ledger));
  } catch {
    /* private mode */
  }
}

/** The one call a feature makes at its meaningful moment. Fire and forget. */
export const NUDGE_EVENT = 'sp:push-nudge';

type PendingNudgeWindow = Window & { __spPendingPushNudge?: { moment: string; at: number } | null };

export function requestPushNudge(moment: NudgeMoment): void {
  if (typeof window === 'undefined') return;
  try {
    // Kept for a prompt host that mounts after the moment (lazy chunks).
    (window as PendingNudgeWindow).__spPendingPushNudge = { moment, at: Date.now() };
    window.dispatchEvent(new CustomEvent(NUDGE_EVENT, { detail: { moment } }));
  } catch {
    /* a nudge is optional; the feature that asked must never fail */
  }
}

export function takePendingNudge(maxAgeMs = 60_000): NudgeMoment | null {
  if (typeof window === 'undefined') return null;
  const w = window as PendingNudgeWindow;
  const p = w.__spPendingPushNudge;
  w.__spPendingPushNudge = null;
  return p && Date.now() - p.at <= maxAgeMs && isNudgeMoment(p.moment) ? p.moment : null;
}
