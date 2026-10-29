/**
 * WHAT A CASH SESSION WAS BOUGHT IN FOR, AFTER A RELOAD (launch audit 2026-10-05).
 *
 * The Session Summary subtracts "total bought in" from the chips returned.
 * The page keeps that total in memory, and after a reload or remount it could
 * only re-seed it with the stack it found, so a player down 300 whose phone
 * slept was shown roughly break-even. The platform keeps the real figure (the
 * cash session's baseline: buy-in plus every add-on and rebuy that landed)
 * and `fn_my_cash_session_baseline` hands the player their own.
 *
 * The answer arrives a moment after it was asked for, and the player may have
 * added chips in this tab in between. Whatever this tab added since the ask
 * is not yet in an answer computed before it, so it is carried over.
 */
export function sessionBuyInTotal(input: {
  /** The server's baseline, or anything else when it could not be read. */
  serverBaseline: unknown;
  carriedAdjustment?: number;
  /** The page's total when the question was asked. */
  totalAtAsk: number;
  /** The page's total now. */
  totalNow: number;
}): number {
  const baseline = Number(input.serverBaseline);
  if (input.serverBaseline === null || input.serverBaseline === undefined) return input.totalNow;
  if (!Number.isFinite(baseline) || baseline <= 0) return input.totalNow;
  const addedSinceAsk = Math.max(0, input.totalNow - input.totalAtAsk);
  const adjustment = Number.isFinite(input.carriedAdjustment) ? input.carriedAdjustment! : 0;
  const total = baseline + adjustment + addedSinceAsk;
  return total > 0 ? Math.round(total * 100) / 100 : input.totalNow;
}

/**
 * THE REST OF THE CARD, FROM THE SERVER (Dan 2026-10-12: "THE END OF SESSION
 * RECAP WAS NOT ACCURATE, I 100% LOST, AND ITS SAYING I WON ... AMOUNT OF
 * HANDS PLAYED, EVERYTHING IS 100% WRONG").
 *
 * The page counts hands, wins, the peak and the start time from the moment it
 * MOUNTED, so a reload or a reconnect restarted all four. The server keeps
 * the whole open session (`fn_my_table_session_facts`). Merge rule, applied
 * once per table: the server's figure as of the ask, plus whatever this tab
 * has counted SINCE the ask, so nothing is lost and nothing is counted twice.
 * Anything unreadable leaves the page's own figure alone.
 */
export interface SessionFactsSeed {
  startMs: number;
  handsPlayed: number;
  handsWon: number;
  peakStack: number;
}

export function mergeSessionFacts(input: {
  serverFacts: unknown;
  carried?: { handsPlayed: number; handsWon: number };
  atAsk: SessionFactsSeed;
  now: SessionFactsSeed;
}): SessionFactsSeed {
  const f = input.serverFacts as {
    started_at?: unknown;
    hands_played?: unknown;
    hands_won?: unknown;
    peak_stack?: unknown;
  } | null;
  if (!f || typeof f !== 'object') return input.now;
  const count = (v: unknown): number | null => {
    if (
      v === null ||
      v === undefined ||
      (typeof v !== 'number' && typeof v !== 'string') ||
      (typeof v === 'string' && !v.trim())
    )
      return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  const started = typeof f.started_at === 'string' ? Date.parse(f.started_at) : Number.NaN;
  const played = count(f.hands_played);
  const won = count(f.hands_won);
  const peak = Number(f.peak_stack);
  const playedSince = Math.max(0, input.now.handsPlayed - input.atAsk.handsPlayed);
  const wonSince = Math.max(0, input.now.handsWon - input.atAsk.handsWon);
  return {
    startMs:
      Number.isFinite(started) && started > 0
        ? Math.min(started, input.now.startMs)
        : input.now.startMs,
    handsPlayed:
      played === null
        ? input.now.handsPlayed
        : played + (input.carried?.handsPlayed ?? 0) + playedSince,
    handsWon: won === null ? input.now.handsWon : won + (input.carried?.handsWon ?? 0) + wonSince,
    peakStack:
      Number.isFinite(peak) && peak > 0 ? Math.max(peak, input.now.peakStack) : input.now.peakStack,
  };
}
