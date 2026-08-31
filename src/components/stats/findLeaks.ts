/**
 * findLeaks — turn a stats page into a coach.
 *
 * WHY
 * ---
 * Everything else on this page tells a player WHAT their numbers are. None of
 * it tells them what to DO. A losing player looking at "VPIP 41.2%, PFR 9.8%"
 * has all the information they need and still no idea that those two numbers,
 * together, are the single most expensive habit in their game.
 *
 * This module is a pure function over stats the page has already loaded. No
 * fetch, no service, no new table — which also means it is exhaustively
 * testable, and every rule below is pinned by a test.
 *
 * DESIGN RULES, learned from how these features usually go wrong:
 *
 *  1. NEVER fire on a small sample. Every rule declares its own minimum, and a
 *     rule that cannot clear it stays silent rather than guessing. Telling
 *     somebody they have a leak on the evidence of 80 hands is worse than
 *     telling them nothing.
 *  2. Say the CONSEQUENCE, not the statistic. "You fold to 3-bets 78% of the
 *     time" is a number they already have. "Opponents can re-raise you with any
 *     two cards and show a profit" is a reason to change something.
 *  3. Rank by cost, not by how easy the leak was to detect.
 *  4. At most a handful at a time. A list of twelve problems gets closed.
 *  5. Say when nothing is wrong. Silence reads as a broken feature.
 */

export type LeakSeverity = 'high' | 'medium' | 'low';

export interface Leak {
  id: string;
  severity: LeakSeverity;
  /** Short, concrete. This is the headline. */
  title: string;
  /** What the data actually says, with the numbers that triggered it. */
  evidence: string;
  /** What to do differently. Always actionable, never "consider reviewing". */
  action: string;
}

export interface LeakOverall {
  total_hands: number;
  cash_hands: number;
  vpip: number; // fraction
  pfr: number; // fraction
  three_bet_percent: number; // fraction
  fold_to_three_bet: number; // fraction
  cbet_flop: number; // fraction
  wtsd: number; // fraction
  aggression_factor: number;
  showdowns_total: number;
  showdowns_won: number;
  bb_per_100: number;
}

export interface LeakPosition {
  position: string;
  hands_played: number;
  vpip_count: number;
  pfr_count: number;
  three_bet_count: number;
  hands_won: number;
  total_profit: number;
  bb100: number;
}

const SEVERITY_RANK: Record<LeakSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Nothing at all is claimed below this many hands. */
export const LEAK_MIN_HANDS = 500;

const pct = (fraction: number): number => fraction * 100;
const f1 = (n: number): string => n.toFixed(1);

/**
 * @param overall   `ca_player_stats_full.overall` — rates are FRACTIONS.
 * @param positions `ca_player_stats_full.positions` — raw COUNTS.
 */
export function findLeaks(
  overall: LeakOverall | null | undefined,
  positions: LeakPosition[] | null | undefined
): { leaks: Leak[]; analysed: boolean; handsShort: number } {
  if (!overall || !Number.isFinite(overall.total_hands)) {
    return { leaks: [], analysed: false, handsShort: LEAK_MIN_HANDS };
  }
  if (overall.total_hands < LEAK_MIN_HANDS) {
    return {
      leaks: [],
      analysed: false,
      handsShort: LEAK_MIN_HANDS - overall.total_hands,
    };
  }

  const leaks: Leak[] = [];
  const vpip = pct(overall.vpip);
  const pfr = pct(overall.pfr);
  const f3b = pct(overall.fold_to_three_bet);
  const cbet = pct(overall.cbet_flop);

  // ── 1. Position played backwards ────────────────────────────────────────
  // The most expensive structural error there is, and completely invisible in
  // a table of numbers. Requires a real sample in BOTH positions.
  const byPos = new Map((positions ?? []).map((p) => [p.position, p]));
  const utg = byPos.get('UTG');
  const btn = byPos.get('BTN');
  if (utg && btn && utg.hands_played >= 100 && btn.hands_played >= 100) {
    const utgVpip = (utg.vpip_count / utg.hands_played) * 100;
    const btnVpip = (btn.vpip_count / btn.hands_played) * 100;
    if (utgVpip >= btnVpip) {
      leaks.push({
        id: 'position_inverted',
        severity: 'high',
        title: 'You Are Playing Position Backwards',
        evidence: `You enter ${f1(utgVpip)}% of hands from under the gun but only ${f1(
          btnVpip
        )}% on the button, over ${utg.hands_played.toLocaleString()} and ${btn.hands_played.toLocaleString()} hands.`,
        action:
          vpip > 35
            ? 'Fold far more from early position. Your overall volume is already high, so fix the shape first - the button should be your widest position, not your tightest.'
            : 'Fold more from early position and open far wider on the button. Acting last for the whole hand is worth more than any two cards you can be dealt.',
      });
    } else if (btnVpip - utgVpip < 8) {
      leaks.push({
        id: 'position_flat',
        severity: 'medium',
        title: 'Your Range Barely Changes With Position',
        evidence: `Button ${f1(btnVpip)}% versus under the gun ${f1(
          utgVpip
        )}% is only ${f1(btnVpip - utgVpip)} points of difference.`,
        action:
          vpip > 35
            ? 'Tighten under the gun sharply. With your overall volume already high, the gain is in cutting early position rather than in adding more buttons.'
            : 'Widen the button and tighten under the gun. Most of the money in a session comes from playing many more hands in late position than in early.',
      });
    }
  }

  // ── 2. Calling far more than raising ────────────────────────────────────
  const gap = vpip - pfr;
  if (gap > 15 && vpip > 25) {
    leaks.push({
      id: 'passive_preflop',
      severity: 'high',
      title: 'You Call Far More Often Than You Raise',
      evidence: `You play ${f1(vpip)}% of hands but raise only ${f1(
        pfr
      )}% of them, a gap of ${f1(gap)} points.`,
      action:
        'Turn the weakest hands you are calling with into folds, and the strongest into raises. Calling gives up the chance to win before the flop and builds pots out of position.',
    });
  }

  // ── 3. Too loose / too tight ────────────────────────────────────────────
  if (vpip > 35) {
    leaks.push({
      id: 'too_loose',
      severity: 'high',
      title: 'You Are Playing Too Many Hands',
      evidence: `${f1(vpip)}% VPIP against the 18-28% most winning players hold.`,
      action:
        'Cut the weakest third of what you enter with, especially from early position and the small blind. This is the most common and most expensive leak in low-stakes poker.',
    });
  } else if (vpip < 14) {
    leaks.push({
      id: 'too_tight',
      severity: 'medium',
      title: 'You Are Folding Too Much',
      evidence: `${f1(vpip)}% VPIP is below the 18-28% range.`,
      action:
        'Open more from late position. Playing this tight means the blinds cost you more than the hands you win make back.',
    });
  }

  // ── 4. Exploitable fold to 3-bet ────────────────────────────────────────
  // Only meaningful once the player raises preflop often enough to face them.
  if (pfr >= 8 && overall.total_hands >= 1000) {
    if (f3b > 70) {
      leaks.push({
        id: 'folds_to_3bet',
        severity: 'high',
        title: 'You Give Up Too Easily When Re-Raised',
        evidence: `You fold to ${f1(f3b)}% of 3-bets.`,
        action:
          'Defend more of your strong opens by calling or 4-betting. At this rate an opponent can re-raise you with any two cards and show an immediate profit.',
      });
    } else if (f3b > 0 && f3b < 30) {
      leaks.push({
        id: 'calls_3bets_too_wide',
        severity: 'medium',
        title: 'You Defend Too Wide Against Re-Raises',
        evidence: `You fold to only ${f1(f3b)}% of 3-bets.`,
        action:
          'Fold the bottom of your opening range when re-raised. Continuing this often means playing big pots out of position with hands that are behind.',
      });
    }
  }

  // ── 5. Passive after the flop ───────────────────────────────────────────
  if (
    overall.aggression_factor > 0 &&
    overall.aggression_factor < 1 &&
    overall.total_hands >= 1000
  ) {
    leaks.push({
      id: 'passive_postflop',
      severity: 'high',
      title: 'You Check And Call Far More Than You Bet',
      evidence: `Aggression factor ${overall.aggression_factor.toFixed(
        2
      )} - you take a passive action more often than an aggressive one.`,
      action:
        'Bet your strong hands for value instead of trapping, and give up outright on the weak ones instead of calling. Calling wins only when you are ahead; betting can also win when you are behind.',
    });
  }

  // ── 6. C-betting on autopilot ───────────────────────────────────────────
  if (cbet > 0 && overall.total_hands >= 1000) {
    if (cbet > 85) {
      leaks.push({
        id: 'cbet_too_high',
        severity: 'medium',
        title: 'You Continuation Bet Almost Every Flop',
        evidence: `${f1(cbet)}% c-bet on the flop.`,
        action:
          'Check back the flops that miss your range. Betting every time makes you easy to raise off the hand and turns your bet into no information at all.',
      });
    } else if (cbet < 35) {
      leaks.push({
        id: 'cbet_too_low',
        severity: 'low',
        title: 'You Give Up On The Flop Too Often',
        evidence: `${f1(cbet)}% c-bet on the flop.`,
        action:
          'Bet more flops after raising preflop, especially heads-up and on boards that favour your range. You are passing up pots nobody wanted.',
      });
    }
  }

  // ── 7. Showdown discipline ──────────────────────────────────────────────
  //
  // DENOMINATOR TRAP: `overall.wtsd` from the RPC is showdowns / hands DEALT,
  // not the industry statistic (showdowns / flops SEEN). Measured on live
  // data it runs around 5% for a human and 16% field-wide, so thresholds
  // calibrated for the industry version (24-30%) could NEVER fire and both
  // rules here were silently dead.
  //
  // Showdowns over hands VOLUNTARILY PLAYED is computable from what we already
  // have and is far closer to the real denominator, so that is what is used -
  // and the evidence sentence now names the denominator it actually measured.
  const handsPlayed = overall.vpip * overall.total_hands;
  const showdownRate = handsPlayed > 0 ? (overall.showdowns_total / handsPlayed) * 100 : 0;

  if (overall.showdowns_total >= 100 && handsPlayed >= 200) {
    if (showdownRate > 45) {
      leaks.push({
        id: 'wtsd_high',
        severity: 'medium',
        title: 'You Pay Off Too Often',
        evidence: `You reach showdown on ${f1(
          showdownRate
        )}% of the hands you choose to play, across ${overall.showdowns_total.toLocaleString()} showdowns.`,
        action:
          'Fold more on the river when the story does not add up. Paying to see it is the single most expensive habit at low stakes.',
      });
    }

    const wsd = (overall.showdowns_won / overall.showdowns_total) * 100;
    if (wsd < 45) {
      leaks.push({
        id: 'losing_showdowns',
        severity: 'medium',
        title: 'You Are Arriving At Showdown Behind',
        evidence: `You win ${f1(
          wsd
        )}% of the showdowns you reach, across ${overall.showdowns_total.toLocaleString()} of them.`,
        action:
          'Get to fewer showdowns with marginal hands. Losing more than half of them means the hands you are calling down with are not good enough.',
      });
    }
  }

  // ── 8. A position that is bleeding ──────────────────────────────────────
  // Deliberately last and capped at one: a per-position win rate is noisy, so
  // only the worst offender is reported, and only with a real sample.
  const bleeding = (positions ?? [])
    .filter((p) => p.hands_played >= 200 && p.bb100 < -25)
    .sort((a, b) => a.bb100 - b.bb100)[0];
  if (bleeding) {
    leaks.push({
      id: `position_losing_${bleeding.position}`,
      severity: 'medium',
      title: `You Are Losing Heavily From ${bleeding.position}`,
      evidence: `${bleeding.bb100.toFixed(
        0
      )} bb/100 over ${bleeding.hands_played.toLocaleString()} hands from ${bleeding.position}.`,
      action:
        bleeding.position === 'BB' || bleeding.position === 'SB'
          ? 'Some loss from the blinds is unavoidable, since the money is already in. If it is this steep, defend fewer hands rather than more.'
          : `Tighten your opening range from ${bleeding.position} substantially, and review whether you are continuing too far after the flop from there.`,
    });
  }

  leaks.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  // Five is already more than anyone will act on in one session.
  return { leaks: leaks.slice(0, 5), analysed: true, handsShort: 0 };
}
