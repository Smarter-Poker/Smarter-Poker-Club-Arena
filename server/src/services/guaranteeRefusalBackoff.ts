/**
 * A REFUSED GUARANTEE IS ASKED AGAIN WHEN THE ANSWER CAN HAVE CHANGED
 * (2026-10-02).
 *
 * The database refuses a guaranteed event its funding bank cannot cover
 * (trg_tournaments_guarantee_affordable / trg_tournaments_publish_readiness,
 * errcode 55000), and the owners get the pop-up (#5777). Both are right.
 *
 * What was wrong is how often the scheduler asked. ScheduledTournamentService
 * polls every minute and, for a refused spawn, claimed the spawn key, sent the
 * INSERT, ate the refusal, released the key, reported the error and called
 * the notifier - every minute, for every refused occurrence inside its 72-hour
 * look-ahead. On 2026-10-02 Deep Stack Society's 2026-10-05 14:00 and 15:00
 * events did that ~45 times in 40 minutes against a bank (32,712.00) that had
 * not moved: two raised exceptions, four writes and two error reports a
 * minute that could not have had a different outcome.
 *
 * So a refused spawn is remembered, and the next attempt waits until either
 *   - the funding bank has grown by at least the shortfall the refusal named
 *     ("short by M") - the remedy the pop-up asks the owner for, noticed on the
 *     very next poll, so the event is created within a minute of the chips
 *     arriving; or
 *   - its recheck interval has passed (5 minutes, doubling to a 30-minute
 *     ceiling), because the other side of the sum - registrations filling
 *     other events' pools, events finishing and releasing their guarantees -
 *     moves too, and this file must not restate the database's coverage
 *     formula to predict it (CLAUDE.md 10.8: one definition, in SQL).
 * The database stays the only judge: this never decides an event IS covered,
 * only when it is worth asking again. A bank it cannot read means "ask"
 * (CLAUDE.md 10.86 rule 1: unknown is never folded into "no change").
 */

export const GUARANTEE_REFUSAL_FIRST_RECHECK_MS = 5 * 60 * 1000;
export const GUARANTEE_REFUSAL_MAX_RECHECK_MS = 30 * 60 * 1000;
/** A deferral nobody has asked about for this long belongs to a spawn that left the window. */
const FORGET_AFTER_MS = 8 * 24 * 60 * 60 * 1000;

/** The funding bank's balance, or null when it could not be read. */
export type FundingBankReader = (clubId: string) => Promise<number | null>;

/** The shortfall both refusal signatures name ("short by 4715.50"), or null. */
export function guaranteeShortfallFrom(message: string | null | undefined): number | null {
  const m = /short by (-?\d+(?:\.\d+)?)/i.exec(String(message ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface Deferral {
  clubId: string;
  bankAtRefusal: number | null;
  shortfall: number;
  delayMs: number;
  recheckAtMs: number;
  touchedAtMs: number;
}

export class GuaranteeRefusalBackoff {
  private readonly deferrals = new Map<string, Deferral>();

  constructor(private readonly now: () => number = Date.now) {}

  /** How many refused spawns are currently waiting. */
  get size(): number {
    return this.deferrals.size;
  }

  /** The refusal is recorded; the next attempt waits (see file header). */
  async refused(
    key: string,
    clubId: string,
    message: string,
    readBank: FundingBankReader
  ): Promise<void> {
    const nowMs = this.now();
    this.forgetStale(nowMs);
    const prior = this.deferrals.get(key);
    const delayMs = prior
      ? Math.min(prior.delayMs * 2, GUARANTEE_REFUSAL_MAX_RECHECK_MS)
      : GUARANTEE_REFUSAL_FIRST_RECHECK_MS;
    this.deferrals.set(key, {
      clubId,
      bankAtRefusal: await readSafely(readBank, clubId),
      shortfall: guaranteeShortfallFrom(message) ?? 0,
      delayMs,
      recheckAtMs: nowMs + delayMs,
      touchedAtMs: nowMs,
    });
  }

  /** Any outcome other than a guarantee refusal ends the deferral. */
  settled(key: string): void {
    this.deferrals.delete(key);
  }

  /** True when the spawn behind `key` should be attempted on this poll. */
  async shouldAttempt(key: string, readBank: FundingBankReader): Promise<boolean> {
    const d = this.deferrals.get(key);
    if (!d) return true;
    const nowMs = this.now();
    d.touchedAtMs = nowMs;
    if (nowMs >= d.recheckAtMs) return true;
    const bank = await readSafely(readBank, d.clubId);
    if (bank === null || d.bankAtRefusal === null) return true;
    // Cents, so a float sum cannot hide or invent a cent of growth.
    const grownCents = Math.round(bank * 100) - Math.round(d.bankAtRefusal * 100);
    return grownCents >= Math.max(1, Math.round(d.shortfall * 100));
  }

  private forgetStale(nowMs: number): void {
    for (const [key, d] of this.deferrals) {
      if (nowMs - d.touchedAtMs > FORGET_AFTER_MS) this.deferrals.delete(key);
    }
  }
}

async function readSafely(readBank: FundingBankReader, clubId: string): Promise<number | null> {
  try {
    const v = await readBank(clubId);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
