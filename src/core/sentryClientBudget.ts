/**
 * ===============================================================================
 *  SENTRY CLIENT BUDGET - the browser cannot spend the org's error quota
 * ===============================================================================
 *
 * Sentry is on the free Developer plan (2026-09-04): 5,000 errors a MONTH for
 * the whole organisation, shared by the World Hub, this client and the engine.
 * That is ~166 a day. docs/SENTRY-FREE-TIER-POLICY.md section 3 gives this
 * client 40 of them, and section 4 says the budget is code, not intent.
 *
 * Clients are the quota risk. One bad deploy puts the same error in every open
 * browser at once, and ten thousand tabs each sending one event would burn two
 * months of the org's allowance before the publish-watchdog had finished its
 * first poll. So three caps stack, and every one of them is decided HERE, in
 * beforeSend, where no plan change can turn it off:
 *
 *   1. per session: 2 events. A crashing tab says so twice and then stops.
 *   2. per fingerprint: 3 a day. Sentry groups identical errors anyway; the
 *      fourth copy buys nothing.
 *   3. per day: 40 events, persisted in localStorage keyed by the UTC date so
 *      a reload does not reset it. Storage is best-effort: a private window or
 *      a blocked store falls back to the in-memory count for this page load.
 *
 * On top of these SentryInit sets `sampleRate: 0.25`, which Sentry applies
 * before beforeSend, so a wave of identical crashes reaches this budget at a
 * quarter of its size and then hits the caps.
 *
 * Nothing here is filtered by error class. The caps are about VOLUME; what
 * is and is not worth an event is decided by the context allowlist in
 * src/utils/errorReporter.ts.
 *
 * PURE on purpose: no Sentry import, no DOM import beyond the injected
 * storage, so the arithmetic is unit-testable and cannot drag the Sentry
 * chunk into the entry bundle.
 */

export const CLIENT_DAILY_BUDGET = 40;
export const CLIENT_PER_FINGERPRINT_DAILY = 3;
export const CLIENT_PER_SESSION = 2;

/** localStorage key. The value is one JSON object, replaced whole. */
export const CLIENT_BUDGET_STORAGE_KEY = 'ca-sentry-budget';

/** Bound on fingerprints remembered per day; past it, the oldest go. */
const MAX_FINGERPRINTS = 64;

export type ClientBudgetReason = 'session' | 'fingerprint' | 'daily';

export interface ClientBudgetVerdict {
  allow: boolean;
  reason?: ClientBudgetReason;
  /** Events sent so far today (including this one when allowed). */
  sentToday: number;
  /** Events dropped so far this page load, all reasons. */
  droppedThisSession: number;
}

interface DayRecord {
  day: string;
  sent: number;
  fp: Record<string, number>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ClientBudgetOptions {
  dailyLimit?: number;
  perFingerprintLimit?: number;
  perSessionLimit?: number;
  now?: () => number;
  /** Injected for tests; defaults to window.localStorage when present. */
  storage?: StorageLike | null;
}

/** UTC calendar day, e.g. `2026-09-04`. The reset boundary. */
export function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* access itself can throw (sandboxed iframe, blocked storage) */
  }
  return null;
}

export class SentryClientBudget {
  private readonly dailyLimit: number;
  private readonly perFingerprintLimit: number;
  private readonly perSessionLimit: number;
  private readonly now: () => number;
  private readonly storage: StorageLike | null;

  private sentThisSession = 0;
  private droppedThisSession = 0;
  /** In-memory copy of today's record; authoritative when storage is unusable. */
  private record: DayRecord | null = null;

  constructor(options: ClientBudgetOptions = {}) {
    this.dailyLimit = options.dailyLimit ?? CLIENT_DAILY_BUDGET;
    this.perFingerprintLimit = options.perFingerprintLimit ?? CLIENT_PER_FINGERPRINT_DAILY;
    this.perSessionLimit = options.perSessionLimit ?? CLIENT_PER_SESSION;
    this.now = options.now ?? (() => Date.now());
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
  }

  /** Decide whether one event with this fingerprint may be sent right now. */
  admit(fingerprint: string): ClientBudgetVerdict {
    const rec = this.load();
    const key = fingerprint || '(empty)';

    if (this.sentThisSession >= this.perSessionLimit) {
      return this.drop('session', rec);
    }
    if ((rec.fp[key] ?? 0) >= this.perFingerprintLimit) {
      return this.drop('fingerprint', rec);
    }
    if (rec.sent >= this.dailyLimit) {
      return this.drop('daily', rec);
    }

    rec.sent += 1;
    rec.fp[key] = (rec.fp[key] ?? 0) + 1;
    this.trimFingerprints(rec);
    this.sentThisSession += 1;
    this.save(rec);
    return { allow: true, sentToday: rec.sent, droppedThisSession: this.droppedThisSession };
  }

  /** Events sent today, as far as this page can tell. */
  get sentToday(): number {
    return this.load().sent;
  }

  get dropped(): number {
    return this.droppedThisSession;
  }

  private drop(reason: ClientBudgetReason, rec: DayRecord): ClientBudgetVerdict {
    this.droppedThisSession += 1;
    return {
      allow: false,
      reason,
      sentToday: rec.sent,
      droppedThisSession: this.droppedThisSession,
    };
  }

  private load(): DayRecord {
    const today = utcDayOf(this.now());
    // Re-read storage every time: another tab on the same origin shares the
    // day's budget and may have spent some of it since we last looked.
    const stored = this.read();
    if (stored && stored.day === today) {
      this.record = stored;
    } else if (!this.record || this.record.day !== today) {
      this.record = { day: today, sent: 0, fp: {} };
    }
    return this.record;
  }

  private read(): DayRecord | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(CLIENT_BUDGET_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<DayRecord>;
      if (
        !parsed ||
        typeof parsed.day !== 'string' ||
        typeof parsed.sent !== 'number' ||
        !Number.isFinite(parsed.sent) ||
        typeof parsed.fp !== 'object' ||
        parsed.fp === null
      ) {
        return null;
      }
      const fp: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed.fp)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) fp[k] = v;
      }
      return { day: parsed.day, sent: Math.max(0, Math.floor(parsed.sent)), fp };
    } catch {
      // Corrupt or unreadable: treat as empty. Hostile localStorage is the
      // normal case, not the exception.
      return null;
    }
  }

  private save(rec: DayRecord): void {
    this.record = rec;
    if (!this.storage) return;
    try {
      this.storage.setItem(CLIENT_BUDGET_STORAGE_KEY, JSON.stringify(rec));
    } catch {
      /* quota exceeded, private mode, blocked: the in-memory copy stands */
    }
  }

  private trimFingerprints(rec: DayRecord): void {
    const keys = Object.keys(rec.fp);
    if (keys.length <= MAX_FINGERPRINTS) return;
    // Insertion order is oldest-first for string keys; drop the oldest.
    for (const k of keys.slice(0, keys.length - MAX_FINGERPRINTS)) delete rec.fp[k];
  }
}

/**
 * Derive the fingerprint for an event from what Sentry hands beforeSend.
 * Prefers the reportError context (the `[Context]` prefix) plus the head of the
 * message with per-instance identifiers normalised away, so a loop over
 * "table 42 stalled" and "table 43 stalled" is ONE fingerprint.
 */
export function clientFingerprintOf(message: string, source?: string): string {
  const msg = String(message ?? '');
  const m = msg.match(/^\[([^\]]{1,120})\]/);
  const ctx = (source && String(source)) || (m ? m[1] : '');
  const tail = (m ? msg.slice(m[0].length) : msg)
    .trim()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  return ctx ? `${ctx}|${tail}` : tail || '(empty)';
}
