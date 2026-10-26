import { createHash } from 'node:crypto';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HORSE TAKES A HUMAN MOMENT TO REBUY (2026-10-24)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md 10.5: "TIMING IS PART OF THE TREATMENT." A human answers a
 * tournament rebuy offer by reading the popup and clicking inside its window
 * (tournament_knockout_candidates.rebuy_prompt_until, written with the bust,
 * 30 s). The horse input device (#7911) answered within milliseconds of the
 * bust and the old sweep path within a second or two.
 *
 * Measured on production 2026-10-24 (every `rebought` knockout candidate ever
 * recorded, claim time of the purchase receipt minus the bust row):
 *
 *   - humans, inside the window: 9.0 s, 14.5 s, 14.5 s (n = 3 - the whole
 *     record). Three more humans bought after their prompt had closed (32.9,
 *     36.2, 39.5 s), i.e. some humans take longer than the window entirely.
 *   - horses, last 7 days: p5 1.2 s, p50 2.3 s, p95 8.2 s (n = 31,812). A
 *     table that watched a horse busts saw it back in faster than any human
 *     has ever bought back in.
 *
 * So a horse that CHOOSES to rebuy now answers at a deterministic moment drawn
 * from a triangular distribution over [3.5 s, 16 s] (mode 9.75 s): the mean of
 * two hash-derived uniforms. The bulk sits where the measured human clicks sit
 * (9-15 s), a decisive horse can still be quick (3.5 s - a human who has
 * already decided), and the top of the range leaves 6 s of a 30 s window
 * before the safety margin, room for three transient-error retries.
 *
 * The draw is bound to (tournament, horse, busting hand), like the choice
 * itself (horseChoosesTournamentRebuy): a retry, restart or second path asks
 * the same question and gets the same moment. A later bust gets a fresh one.
 *
 * The moment never passes the window's safety margin: the answer is due no
 * later than 8 s before rebuy_prompt_until, so a busy event loop or a
 * transient retry still lands inside the offer (the 2026-10-24 incident was
 * answers arriving after expiry). For a window shorter than 16 s the margin is
 * half the window, so the horse still answers inside it, never before the bust.
 */
export const HORSE_REBUY_DECISION_MIN_MS = 3_500;
export const HORSE_REBUY_DECISION_MAX_MS = 16_000;
/** The answer is due no later than this long before rebuy_prompt_until. */
export const HORSE_REBUY_WINDOW_SAFETY_MARGIN_MS = 8_000;

/** The horse's deterministic think time for one bust, in ms. */
export function horseRebuyDecisionDelayMs(
  tournamentId: string,
  userId: string,
  bustHandNumber: number
): number {
  const digest = createHash('sha256')
    .update(
      JSON.stringify(['horse-tournament-rebuy-delay-v1', tournamentId, userId, bustHandNumber])
    )
    .digest();
  const a = digest.readUInt32BE(0) / 0x1_0000_0000;
  const b = digest.readUInt32BE(4) / 0x1_0000_0000;
  const span = HORSE_REBUY_DECISION_MAX_MS - HORSE_REBUY_DECISION_MIN_MS;
  return Math.round(HORSE_REBUY_DECISION_MIN_MS + span * ((a + b) / 2));
}

/**
 * When the horse's answer is due, in epoch ms, or null when the bust moment is
 * unknown (an unknown bust is never answered early - it keeps its decision
 * grace, exactly like an undecided human).
 *
 * due = bust + delay, capped at rebuy_prompt_until - margin, where margin is
 * 8 s or half the window, whichever is smaller; never before the bust. A
 * missing deadline (an old pod's zero, opened later by the decision RPC) is
 * not capped.
 */
export function horseRebuyAnswerDueAtMs(
  tournamentId: string,
  userId: string,
  bustHandNumber: number,
  bustAtMs: number | null | undefined,
  promptUntilMs: number | null | undefined
): number | null {
  if (typeof bustAtMs !== 'number' || !Number.isFinite(bustAtMs)) return null;
  const due = bustAtMs + horseRebuyDecisionDelayMs(tournamentId, userId, bustHandNumber);
  if (typeof promptUntilMs !== 'number' || !Number.isFinite(promptUntilMs)) return due;
  const windowMs = Math.max(0, promptUntilMs - bustAtMs);
  const margin = Math.min(HORSE_REBUY_WINDOW_SAFETY_MARGIN_MS, windowMs / 2);
  return Math.max(bustAtMs, Math.min(due, promptUntilMs - margin));
}

/** The bust moment and offer deadline of one knockout generation. */
export interface HorseRebuyOfferTiming {
  /** The busting hand this timing belongs to. */
  handNumber: number;
  /** tournament_knockout_candidates.created_at, epoch ms. */
  bustAtMs: number | null;
  /** tournament_knockout_candidates.rebuy_prompt_until, epoch ms. */
  promptUntilMs: number | null;
}

function epochMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Read one knockout candidate row's timing (created_at, rebuy_prompt_until). */
export function horseRebuyOfferTimingOf(row: {
  hand_number?: unknown;
  created_at?: unknown;
  rebuy_prompt_until?: unknown;
}): HorseRebuyOfferTiming | null {
  const handNumber = Number(row.hand_number);
  if (!Number.isSafeInteger(handNumber) || handNumber <= 0) return null;
  return {
    handNumber,
    bustAtMs: epochMs(row.created_at),
    promptUntilMs: epochMs(row.rebuy_prompt_until),
  };
}
