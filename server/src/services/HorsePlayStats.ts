/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HORSE PLAY STATS - the one measurement of how a horse plays (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure. No imports. This is the accumulator HorseSelfTuner has always used to
 * read VPIP / PFR / 3-bet / fold-to-3-bet / WWSF / postflop AF off a hand's
 * action log. It moved out of the tuner so the SAME code can run at
 * settlement (HorseHandReview.accumulateHorsePlay) and compile
 * horse_daily_play - a per-horse/day/format aggregate the tuner reads in a
 * few thousand rows instead of streaming 120,000 hand_history JSON rows a
 * night. That 120,000-row cap was the reason only 383 of 1,000 horses were
 * studied on 2026-09-04: the "7-day window" was really the newest eleven
 * hours of a fleet dealing 263,000 cash hands a day.
 *
 * One measurement, two readers. If the tuner and the settlement path ever
 * disagreed about what a 3-bet is, the nightly study would be tuning a horse
 * on a number the panel could not reproduce. Keeping it here, imported by
 * both, is what makes that impossible.
 *
 * NEVER refer to the horses as "bots" - they are HORSES only.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface RawAction {
  userId?: string;
  action?: string;
  amount?: number;
  stage?: string;
  seat?: number;
  /** V12.3: persisted as of this version; absent on older rows (see the
   *  fallback in playFromHand). A short all-in is NOT a raise. */
  isFullRaise?: boolean;
}

export interface HandRow {
  actions: RawAction[] | null;
  players: Array<{ userId?: string; seat?: number }> | null;
  winners: Array<{ userId?: string; amount?: number }> | null;
  big_blind: number | string | null;
  button_seat: number | null;
}

export interface PlayStats {
  hands: number;
  vpip: number;
  pfr: number;
  threeBets: number;
  threeBetOpps: number;
  openRaises: number;
  foldTo3Bets: number;
  faced3Bets: number;
  sawFlop: number;
  wonWhenSawFlop: number;
  postAggr: number;
  postPassive: number;
  netBB: number;
}

export const freshPlay = (): PlayStats => ({
  hands: 0,
  vpip: 0,
  pfr: 0,
  threeBets: 0,
  threeBetOpps: 0,
  openRaises: 0,
  foldTo3Bets: 0,
  faced3Bets: 0,
  sawFlop: 0,
  wonWhenSawFlop: 0,
  postAggr: 0,
  postPassive: 0,
  netBB: 0,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. MEASURE — pure, unit-tested
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate play statistics for the tracked ids across a batch of hands.
 * Mutates and returns `into` so pages can stream through without holding
 * every hand in memory.
 */
export function accumulatePlayStats(
  rows: HandRow[],
  tracked: Set<string>,
  into: Map<string, PlayStats>
): Map<string, PlayStats> {
  for (const row of rows) {
    try {
      accumulateOne(row, tracked, into);
    } catch {
      /* one malformed hand must never stop the study */
    }
  }
  return into;
}

function accumulateOne(row: HandRow, tracked: Set<string>, into: Map<string, PlayStats>): void {
  const actions = Array.isArray(row.actions) ? row.actions : [];
  if (actions.length === 0) return;
  const bb = Number(row.big_blind) > 0 ? Number(row.big_blind) : 2;

  const get = (id: string): PlayStats => {
    let s = into.get(id);
    if (!s) {
      s = freshPlay();
      into.set(id, s);
    }
    return s;
  };

  const inHand = new Set<string>();
  for (const p of row.players ?? []) {
    if (p && typeof p.userId === 'string') inHand.add(p.userId);
  }
  for (const a of actions) if (typeof a.userId === 'string') inHand.add(a.userId);

  // Per-hand per-player flags
  const didVpip = new Set<string>();
  const didPfr = new Set<string>();
  const did3Bet = new Set<string>();
  const openedBy = { id: null as string | null };
  const foldedPreflop = new Set<string>();
  const sawPostflop = new Set<string>();
  const contributed = new Map<string, number>();
  /** V12.3: blinds are already counted in `contributed`, and bet/raise amounts
   *  are STREET TOTALS — so a blind that later raises must have its blind
   *  seeded as its opening street bet, or the increment (amount - 0) charges
   *  the blind a second time. BB posts 2 and 3-bets to 20 was billed 22. */
  const blindPosted = new Map<string, number>();

  // Blind posts are not ActionRecords — reconstruct from the button.
  if (typeof row.button_seat === 'number' && row.players && row.players.length >= 2) {
    const seats = row.players
      .filter((p) => p && typeof p.seat === 'number' && typeof p.userId === 'string')
      .sort((a, b) => (a.seat as number) - (b.seat as number));
    if (seats.length >= 2) {
      const after = (seat: number) => {
        const higher = seats.filter((s) => (s.seat as number) > seat);
        return (higher.length > 0 ? higher : seats)[0];
      };
      const sbP =
        seats.length === 2
          ? (seats.find((s) => s.seat === row.button_seat) ?? after(row.button_seat))
          : after(row.button_seat);
      const bbP = after(sbP.seat as number);
      if (sbP.userId) {
        contributed.set(sbP.userId, (contributed.get(sbP.userId) || 0) + bb / 2);
        blindPosted.set(sbP.userId, bb / 2);
      }
      if (bbP.userId && bbP.userId !== sbP.userId) {
        contributed.set(bbP.userId, (contributed.get(bbP.userId) || 0) + bb);
        blindPosted.set(bbP.userId, bb);
      }
    }
  }

  let preflopRaises = 0;
  let curStreet = 'preflop';
  let streetBets = new Map<string, number>(blindPosted);
  /** highest street total posted so far — the bar an all-in must clear */
  let streetLevel = bb;

  for (const a of actions) {
    const id = typeof a.userId === 'string' ? a.userId : null;
    if (!id) continue;
    const stage = a.stage || 'preflop';
    const preflop = stage === 'preflop';
    // V12.3: a SHORT all-in is not aggression — it is a call for less. Every
    // other consumer in this codebase requires isFullRaise === true, and
    // treating a forced shove as an open made the next real opener look like a
    // 3-bettor, corrupting PFR, 3-bet, fold-to-3-bet and the opener attribution
    // all at once. `isFullRaise` is persisted as of V12.3; when it is absent
    // (rows written before that), fall back to the street-total test rather
    // than assuming aggression.
    const isAggr =
      a.action === 'bet' ||
      a.action === 'raise' ||
      (a.action === 'all_in' &&
        (a.isFullRaise === true ||
          (a.isFullRaise === undefined &&
            typeof a.amount === 'number' &&
            a.amount > streetLevel + 1e-9)));
    const amount = typeof a.amount === 'number' && isFinite(a.amount) ? a.amount : 0;

    if (stage !== curStreet) {
      curStreet = stage;
      streetBets = new Map();
      streetLevel = 0;
    }
    // Contribution replay: calls are increments; bet/raise/all_in are street totals.
    if (isAggr || a.action === 'call') {
      const prev = streetBets.get(id) || 0;
      const inc = a.action === 'call' ? amount : Math.max(0, amount - prev);
      contributed.set(id, (contributed.get(id) || 0) + inc);
      streetBets.set(id, prev + inc);
      if (prev + inc > streetLevel) streetLevel = prev + inc;
    }

    if (preflop) {
      const voluntary = isAggr || a.action === 'call';
      if (voluntary) didVpip.add(id);
      if (isAggr) {
        if (preflopRaises === 0) {
          didPfr.add(id);
          openedBy.id = id;
        } else {
          didPfr.add(id);
          if (preflopRaises === 1) did3Bet.add(id);
        }
        preflopRaises++;
      }
      if (a.action === 'fold') foldedPreflop.add(id);
    } else {
      sawPostflop.add(id);
      if (tracked.has(id)) {
        if (isAggr) get(id).postAggr++;
        else if (a.action === 'call') get(id).postPassive++;
      }
    }
  }

  // Fold-to-3-bet: the opener faced a 3-bet; did their NEXT preflop action fold?
  let opener3BetFaced = false;
  let opener3BetFolded = false;
  if (openedBy.id) {
    let seen3Bet = false;
    for (const a of actions) {
      if ((a.stage || 'preflop') !== 'preflop') break;
      const isAggr = a.action === 'bet' || a.action === 'raise' || a.action === 'all_in';
      if (isAggr && a.userId !== openedBy.id && didPfr.has(openedBy.id) && !seen3Bet) {
        // first re-raise after the open
        if (did3Bet.has(a.userId as string)) seen3Bet = true;
        continue;
      }
      if (seen3Bet && a.userId === openedBy.id) {
        opener3BetFaced = true;
        opener3BetFolded = a.action === 'fold';
        break;
      }
    }
  }

  // ── V12.3: RETURN THE UNCALLED BET ───────────────────────────────────────
  // HandController.completeHandInner() calls returnUncalledBet() BEFORE pots
  // and rake, so `winners[].amount` is the post-refund award — but the actions
  // array still carries the full posted amount. Charging the full bet while
  // crediting the reduced award scored EVERY uncontested pot as a loss, which
  // is the most common way a hand is won. Left unfixed, essentially every
  // horse lands under the `bb100 < -15` regression trigger and has all three
  // of its dials halved toward neutral, every night, erasing the fleet's
  // per-horse differentiation while writing an audit trail claiming it fixed
  // leaks. The refund is the excess of the top street contribution over the
  // second-highest on the FINAL betting street.
  {
    const finalStreetBets = new Map<string, number>();
    let street = 'preflop';
    let levelSeed = new Map<string, number>(blindPosted);
    let cur = new Map<string, number>(levelSeed);
    for (const a of actions) {
      const id = typeof a.userId === 'string' ? a.userId : null;
      if (!id) continue;
      const stg = a.stage || 'preflop';
      if (stg !== street) {
        street = stg;
        levelSeed = new Map();
        cur = new Map();
      }
      const amt = typeof a.amount === 'number' && isFinite(a.amount) ? a.amount : 0;
      if (a.action === 'call') cur.set(id, (cur.get(id) || 0) + amt);
      else if (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in')
        cur.set(id, Math.max(cur.get(id) || 0, amt));
      finalStreetBets.clear();
      for (const [k, v] of cur) finalStreetBets.set(k, v);
    }
    const sorted = [...finalStreetBets.entries()].sort((x, y) => y[1] - x[1]);
    if (sorted.length >= 2 && sorted[0][1] > sorted[1][1]) {
      const refund = sorted[0][1] - sorted[1][1];
      const id = sorted[0][0];
      contributed.set(id, Math.max(0, (contributed.get(id) || 0) - refund));
    } else if (sorted.length === 1 && sorted[0][1] > 0) {
      // Everyone else folded without matching a single chip of it.
      contributed.set(
        sorted[0][0],
        Math.max(0, (contributed.get(sorted[0][0]) || 0) - sorted[0][1])
      );
    }
  }

  const wonBy = new Map<string, number>();
  for (const w of row.winners ?? []) {
    if (w && typeof w.userId === 'string' && typeof w.amount === 'number') {
      wonBy.set(w.userId, (wonBy.get(w.userId) || 0) + w.amount);
    }
  }

  for (const id of inHand) {
    if (!tracked.has(id)) continue;
    const s = get(id);
    s.hands++;
    if (didVpip.has(id)) s.vpip++;
    if (didPfr.has(id)) s.pfr++;
    if (did3Bet.has(id)) s.threeBets++;
    // V12.3: the denominator used to exclude everyone in didPfr — which
    // includes the 3-bettor — so the numerator's own hands were never counted
    // and a horse that 3-bet every chance showed threeBetOpps = 0.
    if (preflopRaises >= 1 && (did3Bet.has(id) || !didPfr.has(id))) s.threeBetOpps++;
    if (openedBy.id === id) {
      s.openRaises++;
      if (opener3BetFaced) {
        s.faced3Bets++;
        if (opener3BetFolded) s.foldTo3Bets++;
      }
    }
    const saw = sawPostflop.has(id) || (!foldedPreflop.has(id) && sawPostflop.size > 0);
    if (saw) {
      s.sawFlop++;
      if (wonBy.has(id)) s.wonWhenSawFlop++;
    }
    s.netBB += ((wonBy.get(id) || 0) - (contributed.get(id) || 0)) / bb;
  }
}
