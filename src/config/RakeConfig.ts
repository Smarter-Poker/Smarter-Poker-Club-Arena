/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Rake & BBJ Configuration
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Consolidated from World Hub `lib/poker-engine/RakeConfig.js`.
 *
 * OFFICIAL RAKE SCHEDULE (all cash games):
 *   - All stakes: 10% rake
 *   - Caps are FIXED DOLLAR AMOUNTS per stakes level (not BB-based)
 *   - BBJ fee is in BB units per qualifying hand
 *   - BBJ pool allocation: Main 40% / BackUp 30% / Promotional 30%
 *
 * BBJ RULES (Dan 2026-08-29 — collection vs payout are DIFFERENT rules):
 *   - COLLECTION: the drop is taken on every flop with 3+ players dealt in,
 *     regardless of pot size
 *   - PAYOUT: pot must be >= 10BB and 3+ players dealt in preflop
 *   - Not available for Double/Triple Board games
 *   - If run it multiple times, only first runout counts
 *   - If multiple losers qualify, prize split proportionally
 *
 * QUALIFYING HANDS (minimum losing hand):
 *   NLH/FLH: AAAJJ (full house, Aces full of Jacks)
 *   PLO4/FLO4: KKKK2 (four Kings)
 *   PLO5/FLO5: 87654 (eight-high straight flush)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RakeScheduleEntry {
  sb: number;
  bb: number;
  rakePercent: number;
  rakeCap: number;
  bbjFeeBB: number;
}

export interface StakesTier {
  label: string;
  blindRange: string;
  minBB: number;
  maxBB: number;
  rakePercent: number;
  rakeCap: number;
  rakeCapBB: number;
  bbjFeeBB: number;
  /** % of the BBJ main pool paid when the jackpot hits at this tier.
   *  Present so getBBJPayoutPercentForBB can READ the table instead of
   *  hand-mirroring a second cascade beside it. */
  bbjPayoutTotalPercent: number;
}

export interface BBJQualifyingHand {
  label: string;
  minLosingHand: string | null;
  description: string;
  rules: string[];
  handRank?: string;
  minRankValue?: string;
  eligible?: boolean;
  /* THE MINI'S OWN BAR FOR THIS VARIANT (Dan, 2026-09-12).

     The mini used to derive its bar from the MAIN rule's family: `full_house`
     meant hold'em, so aces-full-or-better; anything else meant Omaha, so ANY
     quads. That is a two-value guess standing in for a per-game decision, and
     Dan made the decision: PLO5/FLO5 is Quad Tens or better, Pineapple is Quad
     Deuces. Where `miniMinQuadRank` is set it is the lowest QUAD rank that
     clears the mini bar (A=14 ... 2=2) and it replaces the family default;
     where it is absent the family default still applies, so every other game
     is untouched. `miniBarLabel` is what a player is told, and it lives beside
     the number so the two cannot drift. */
  miniMinQuadRank?: number;
  miniBarLabel?: string;
}

export interface RakeConfigResult {
  tier: string;
  blindRange: string;
  rakePercent: number;
  rakeCap: number;
  rakeCapBB: number;
  rakeCapDollars: number;
  bbjEnabled: boolean;
  bbjFeeBB: number;
  bbjPoolAllocation: typeof BBJ_POOL_ALLOCATION;
  bbjPayoutTotal: number;
  bbjPayoutLoser: number;
  bbjPayoutWinner: number;
  bbjPayoutTable: number;
  qualifyingHand: BBJQualifyingHand;
  rules: typeof BBJ_RULES;
  _exactMatch: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OFFICIAL RAKE SCHEDULE — Per-stakes lookup table
// rakeCap is an ABSOLUTE DOLLAR AMOUNT (not BB-based).
// ═══════════════════════════════════════════════════════════════════════════════

export const RAKE_SCHEDULE: RakeScheduleEntry[] = [
  { sb: 0.1, bb: 0.2, rakePercent: 10, rakeCap: 3, bbjFeeBB: 0.6 },
  { sb: 0.2, bb: 0.4, rakePercent: 10, rakeCap: 3, bbjFeeBB: 0.6 },
  { sb: 0.25, bb: 0.5, rakePercent: 10, rakeCap: 3, bbjFeeBB: 0.6 },
  { sb: 0.3, bb: 0.6, rakePercent: 10, rakeCap: 5, bbjFeeBB: 0.6 },
  { sb: 0.5, bb: 1.0, rakePercent: 10, rakeCap: 5, bbjFeeBB: 0.25 },
  { sb: 1, bb: 2, rakePercent: 10, rakeCap: 5, bbjFeeBB: 0.25 },
  { sb: 2, bb: 4, rakePercent: 10, rakeCap: 7.5, bbjFeeBB: 0.12 },
  { sb: 2, bb: 5, rakePercent: 10, rakeCap: 7.5, bbjFeeBB: 0.12 },
  // A 5/5 row sat here until 2026-09-01 (sb 5, bb 5). Nothing could ever
  // match it: fn_tables_creation_guard refuses a cash table whose big blind
  // does not exceed its small blind, so no 5/5 table has ever existed and no
  // hand was ever priced by it. It also sorted out of order, between 2/5 and
  // 3/6, which is the tell that it was a typo placed by big blind. Dan ruled
  // it a typo; deleted, not legalised. Do not re-add it - if a 5-small-blind
  // stake is wanted, 5/10 already exists and 2.5/5 would fit the ladder.
  // Removed from the DB mirror by
  // supabase/migrations/20260901050000_the_rake_row_no_table_can_match.sql.
  { sb: 3, bb: 6, rakePercent: 10, rakeCap: 8, bbjFeeBB: 0.12 },
  { sb: 4, bb: 8, rakePercent: 10, rakeCap: 10, bbjFeeBB: 0.12 },
  { sb: 5, bb: 10, rakePercent: 10, rakeCap: 12.5, bbjFeeBB: 0.06 },
  { sb: 10, bb: 20, rakePercent: 10, rakeCap: 15, bbjFeeBB: 0.06 },
  { sb: 10, bb: 25, rakePercent: 10, rakeCap: 15, bbjFeeBB: 0.06 },
  // ── ADDED 2026-08-31 (Dan, binding) ──────────────────────────────────────
  // Dan: "WE HAVE A SCALE THAT WE USE FOR THE CASH GAME FOR RAKE AND BBJ, USE
  // THE SAME PERCENTAGES WE USE FOR THE OTHER GAMES, IF YOU DON'T HAVE A RAKE
  // OR BBJ SCHEDULE FOR A SPECIFIC GAME."
  //
  // Six of the twelve blind presets the create-table form offers had no row
  // here, so findScheduleMatch returned null and the price fell through to
  // getTierForBB - a tier whose cap is an ABSOLUTE DOLLAR AMOUNT applied
  // regardless of stake. At the bottom of the ladder that is not a small
  // discrepancy, it is an order of magnitude:
  //
  //     0.01/0.02   $3 flat  =  150 BB
  //     0.02/0.05   $3 flat  =   60 BB
  //     0.05/0.10   $3 flat  =   30 BB   <- THE DEFAULT PRESET
  //     0.10/0.25   $3 flat  =   12 BB
  //
  // against a published ladder whose most generous row (0.1/0.2) is 15 BB and
  // whose typical row is 1-6 BB. The DB creation guard had declined to police
  // this in as many words: "NOT enforced here and left for Dan: the official
  // stakes schedule."
  //
  // HOW THESE NUMBERS WERE DERIVED - no rate is invented:
  //   rakePercent  10 at every stake, as every existing row already is.
  //   rakeCap      the same BB proportion the schedule's own cheapest
  //                published row charges (0.1/0.2 at $3 = 15 BB), so the
  //                three sub-0.2 stakes are 15 BB in dollars. 0.10/0.25 sits
  //                inside the schedule's existing flat-$3 band (0.2, 0.4 and
  //                0.5 are all $3) and takes $3. The two nosebleed rows take
  //                the Nosebleeds tier's own $20, which is what they are
  //                charged today - adding the row changes no price, it just
  //                makes the price published rather than inherited.
  //   bbjFeeBB     the tier's fee for that stake, unchanged: Nano/Micro 0.6,
  //                Nosebleeds 0.03.
  //
  // LIVE EFFECT, measured against production before committing: of 972 cash
  // tables, exactly TWO sit on a stake whose price moves - the two at
  // 0.05/0.10, whose cap falls $3 -> $1.50. Both are closed. Every other live
  // stake was already on the schedule and is untouched. No player pays more.
  { sb: 0.01, bb: 0.02, rakePercent: 10, rakeCap: 0.3, bbjFeeBB: 0.6 },
  { sb: 0.02, bb: 0.05, rakePercent: 10, rakeCap: 0.75, bbjFeeBB: 0.6 },
  { sb: 0.05, bb: 0.1, rakePercent: 10, rakeCap: 1.5, bbjFeeBB: 0.6 },
  { sb: 0.1, bb: 0.25, rakePercent: 10, rakeCap: 3, bbjFeeBB: 0.6 },
  { sb: 25, bb: 50, rakePercent: 10, rakeCap: 20, bbjFeeBB: 0.03 },
  { sb: 50, bb: 100, rakePercent: 10, rakeCap: 20, bbjFeeBB: 0.03 },
];

// BBJ Pool Allocation — uniform across all stakes
// BBJ POOL ALLOCATION (Dan, 2026-08-18 — authoritative)
//   STANDARD (main pool < 100k):  50% Main / 25% Back Up / 25% Promo
//   PIVOT    (main pool >= 100k): 25% Main / 25% Back Up / 50% Promo
// Past the pivot the jackpot is already large, so new rake is steered into the
// promo wallet rather than growing main further; the Back Up share is held flat
// at 25% because its job is to reseed main after a full hit, not to grow.
// 2026-08-18: this client copy said 40/30/30, which matched NEITHER the
// standard nor the pivot split the server actually banks — a third disagreeing
// definition of the same rule. Corrected to the server's standard split.
export const BBJ_POOL_ALLOCATION = {
  mainBBJ: 0.5, // 50% of BBJ rake goes to Main BBJ pool (standard)
  backUpBBJ: 0.25, // 25% goes to Back Up BBJ pool (standard)
  promotional: 0.25, // 25% goes to Promotional fund (standard)
} as const;

/** Applied once the main pool reaches 100,000 chips. */
export const BBJ_POOL_ALLOCATION_PIVOT = {
  mainBBJ: 0.25,
  backUpBBJ: 0.25,
  promotional: 0.5,
} as const;

export const BBJ_PIVOT_THRESHOLD = 100000;

// ═══════════════════════════════════════════════════════════════════════════════
// STAKES TIERS — Fallback for custom/non-standard stakes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MIRROR OF server/src/config/RakeConfig.ts — do not edit one without the other.
 *
 * 2026-08-23: this copy had drifted from the server's on four of six rows, and
 * the server is the one that charges the fee and pays the jackpot:
 *
 *              this file (was)            server (authority)
 *   nano       0.05/0.10 - 0.25/0.50      0.05/0.10 - 0.1/0.2   maxBB 0.5 vs 0.2
 *   micro      0.30/0.60 - 0.50/1.00      0.2/0.4 - 0.4/0.8     fee 0.25 vs 0.60
 *   small      1/2                        0.5/1 - 1.5/3         minBB 1.5 vs 1
 *   high       5/10 - 10/25               5/10 - 20/40          maxBB 25 vs 40
 *
 * scripts/ci/check-rakeconfig-parity.mjs now fails the build if they diverge
 * again, so this comment cannot quietly become false the way the last one did.
 */
export const STAKES_TIERS: Record<string, StakesTier> = {
  nano: {
    label: 'Nano',
    blindRange: '0.05/0.10 - 0.1/0.2',
    minBB: 0.1,
    maxBB: 0.2,
    rakePercent: 10,
    rakeCap: 3,
    rakeCapBB: 3,
    bbjFeeBB: 0.6,
    bbjPayoutTotalPercent: 15,
  },
  micro: {
    label: 'Micro',
    blindRange: '0.2/0.4 - 0.4/0.8',
    minBB: 0.3,
    maxBB: 0.8,
    rakePercent: 10,
    rakeCap: 3,
    rakeCapBB: 3,
    bbjFeeBB: 0.6,
    bbjPayoutTotalPercent: 25,
  },
  small: {
    label: 'Small',
    blindRange: '0.5/1 - 1.5/3',
    minBB: 1,
    maxBB: 3,
    rakePercent: 10,
    rakeCap: 5,
    rakeCapBB: 5,
    bbjFeeBB: 0.25,
    bbjPayoutTotalPercent: 40,
  },
  mid: {
    label: 'Mid',
    blindRange: '2/4 - 4/8',
    minBB: 3.5,
    maxBB: 8,
    rakePercent: 10,
    rakeCap: 8,
    rakeCapBB: 8,
    bbjFeeBB: 0.12,
    bbjPayoutTotalPercent: 55,
  },
  high: {
    label: 'High',
    blindRange: '5/10 - 20/40',
    minBB: 9,
    maxBB: 40,
    rakePercent: 10,
    rakeCap: 15,
    rakeCapBB: 15,
    bbjFeeBB: 0.06,
    bbjPayoutTotalPercent: 70,
  },
  nosebleeds: {
    label: 'Nosebleeds',
    blindRange: '25/50+',
    minBB: 41,
    maxBB: Infinity,
    rakePercent: 10,
    rakeCap: 20,
    rakeCapBB: 20,
    bbjFeeBB: 0.03,
    bbjPayoutTotalPercent: 85,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// BBJ QUALIFYING HANDS — Minimum losing hand per game variant
// ═══════════════════════════════════════════════════════════════════════════════

export const BBJ_QUALIFYING_HANDS: Record<string, BBJQualifyingHand> = {
  nlh: {
    label: 'NLH / FLH',
    minLosingHand: 'AAAJJ',
    description: 'Full House (Aces Full Of Jacks) Or Better Must LOSE To Quads Or Straight Flush',
    rules: [
      'AAAJJ+ must lose to Quads or Straight Flush',
      'Player holding Full House must have at least one Ace in their hole cards (dealt cards)',
      'Both cards from hand must play',
    ],
    handRank: 'full_house',
    minRankValue: 'AAAJJ',
  },
  // Alias: flh (Fixed Limit Hold'em) uses same qualifying hand as NLH
  flh: {
    label: 'NLH / FLH',
    minLosingHand: 'AAAJJ',
    description: 'Full House (Aces Full Of Jacks) Or Better Must LOSE To Quads Or Straight Flush',
    rules: [
      'AAAJJ+ must lose to Quads or Straight Flush',
      'Player holding Full House must have at least one Ace in their hole cards (dealt cards)',
      'Both cards from hand must play',
    ],
    handRank: 'full_house',
    minRankValue: 'AAAJJ',
  },
  plo4: {
    label: 'PLO4 / FLO4',
    minLosingHand: 'KKKK2',
    description: 'Four Of A Kind (Kings) Or Better Must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  plo: {
    label: 'PLO4 / FLO4',
    minLosingHand: 'KKKK2',
    description: 'Four Of A Kind (Kings) Or Better Must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  plo8: {
    label: 'PLO8 (Hi-Lo 8 Or Better)',
    minLosingHand: 'KKKK2',
    description: 'Four Of A Kind (Kings) Or Better Must LOSE - Evaluated On HIGH Hand Only',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
      'BBJ evaluated on HIGH hand only (low hand does not qualify)',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  // 2026-08-23: flo8 is the same GAME as plo8 — four cards, exactly-two rule,
  // 8-or-better low. Only the betting differs, and betting has nothing to do
  // with which hand qualifies for the jackpot. Mirrors the server copy.
  flo8: {
    label: 'FLO8 (Hi-Lo 8 Or Better)',
    minLosingHand: 'KKKK2',
    description: 'Four Of A Kind (Kings) Or Better Must LOSE - Evaluated On HIGH Hand Only',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
      'BBJ evaluated on HIGH hand only (low hand does not qualify)',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },

  plo_hilo: {
    label: 'PLO8 (Hi-Lo 8 Or Better)',
    minLosingHand: 'KKKK2',
    description: 'Four Of A Kind (Kings) Or Better Must LOSE - Evaluated On HIGH Hand Only',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
      'BBJ evaluated on HIGH hand only (low hand does not qualify)',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  plo5: {
    label: 'PLO5 / FLO5',
    minLosingHand: '87654',
    description: 'Straight Flush (8-High) Or Better Must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'straight_flush',
    minRankValue: '87654',
    /* MINI: Quad Tens or better (Dan, 2026-09-12). Stricter than the Omaha
       family default of any quads - five hole cards make quads common. */
    miniMinQuadRank: 10,
    miniBarLabel: 'Quad Tens Or Better',
  },
  // BBJ-SYNC 2026-08-18: server (the authority that actually detects hits)
  // marks PLO6 ineligible — this entry used to advertise an 8-high SF rule the
  // engine never pays. Synced to match server/src/config/RakeConfig.ts.
  /* FLO4 / FLO5 ARE THE SAME GAMES AS PLO4 / PLO5 (2026-09-12). Both labels
     have always read "PLO4 / FLO4" and "PLO5 / FLO5", but neither key existed,
     and the engine's BBJ detectors look this table up by the RAW variant - only
     the client normalises. So an FLO5 table would have taken the mini's
     "variant not covered" branch and paid NO mini at all, while getRakeConfig's
     `|| BBJ_QUALIFYING_HANDS.nlh` fallback judged its MAIN bar by hold'em
     rules. That is the Pineapple defect exactly: a key on one side and not the
     other. No such table exists in production today (nlh, plo4, plo5, plo6,
     plo8, short_deck, pineapple, flh, flo8 are the live variants), so this
     closes a trap rather than repairing a loss - and `flo8` and `flh` were
     already here for the same reason. */
  flo4: {
    label: 'PLO4 / FLO4',
    minLosingHand: 'KKKK2',
    description: 'Four Of A Kind (Kings) Or Better Must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
  },
  flo5: {
    label: 'PLO5 / FLO5',
    minLosingHand: '87654',
    description: 'Straight Flush (8-High) Or Better Must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'straight_flush',
    minRankValue: '87654',
    /* MINI: Quad Tens or better (Dan, 2026-09-12) - the same bar as plo5,
       because it is the same game. */
    miniMinQuadRank: 10,
    miniBarLabel: 'Quad Tens Or Better',
  },
  plo6: {
    label: 'PLO6',
    minLosingHand: null,
    description: 'BBJ Not Available For PLO6',
    rules: [],
    eligible: false,
  },
  short_deck: {
    label: 'Short Deck',
    minLosingHand: null,
    description: 'BBJ Not Available For Short Deck',
    rules: [],
    eligible: false,
  },
  /* PINEAPPLE IS A LIVE VARIANT AND ITS BAR IS NOT HOLD'EM'S (2026-09-11).
     The server has carried this entry all along; the client did not, and
     `normalizeVariantKey` falls through to 'nlh' for any key it does not
     know. So every Pineapple table told its players the HOLD'EM rule -
     "aces full or better must lose", plus the Ace-in-the-hole and
     both-cards-play technicalities - while the engine was enforcing Quad
     Kings or better. Measured that day: 293 Pineapple tables, 11,606
     BBJ-raked hands in seven days, and FOUR real jackpot hits paid under
     the rule the client was not showing. A player holding aces full on a
     Pineapple table was reading a qualifying hand that does not qualify. */
  pineapple: {
    label: 'Pineapple',
    minLosingHand: 'KKKK2',
    description: 'Four Of A Kind (Kings) Or Better Must LOSE',
    rules: [
      'Must use exactly 2 cards from hand',
      'Both players must use two cards from their hole cards',
    ],
    handRank: 'four_of_a_kind',
    minRankValue: 'KKKK',
    /* MINI: Quad Deuces (Dan, 2026-09-12) - every quad clears it. Same effect
       as the old family default for this game, written down explicitly so the
       bar is a stated rule rather than a fall-through nobody chose. */
    miniMinQuadRank: 2,
    miniBarLabel: 'Quad Deuces Or Better',
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// BBJ TABLE-WIDGET LABELS (2026-08-18)
// ═══════════════════════════════════════════════════════════════════════════════
// The on-table jackpot widget used to hardcode "Quad 8s or better" — wrong for
// every variant we spread (NLH is Aces full of Jacks losing to Quads+). These
// helpers turn whatever gameType string the table state carries (short variant
// keys like 'plo4' OR display names like "No Limit Hold'em") into the correct
// per-variant qualifying text.

/** Normalize a gameType string (variant key or display name) to a BBJ_QUALIFYING_HANDS key. */
export function normalizeVariantKey(gameType: string | null | undefined): string {
  const raw = String(gameType || 'nlh')
    .toLowerCase()
    .trim();
  if (BBJ_QUALIFYING_HANDS[raw]) return raw;
  if (raw.includes('short')) return 'short_deck';
  if (raw.includes('omaha') || raw.startsWith('plo') || raw.startsWith('flo')) {
    if (raw.includes('hi-lo') || raw.includes('hilo') || raw.includes('8 or better')) return 'plo8';
    const m = raw.match(/[4568]/);
    if (m) {
      const key = 'plo' + m[0];
      if (BBJ_QUALIFYING_HANDS[key]) return key;
    }
    return 'plo4';
  }
  // Hold'em display names ("No Limit Hold'em", "Fixed Limit Hold'em") + unknowns
  if (raw.includes('fixed limit')) return 'flh';
  return 'nlh';
}

export interface BBJWidgetInfo {
  eligible: boolean;
  /** One-line qualifying rule for the widget popover. */
  shortLabel: string;
  /** Hole-card requirement line under the rule. */
  subLabel: string;
  variantLabel: string;
}

const BBJ_SHORT_LABELS: Record<string, string> = {
  nlh: 'Aces full of Jacks or better must lose to Quads or better',
  flh: 'Aces full of Jacks or better must lose to Quads or better',
  plo4: 'Quad Kings or better must lose',
  plo: 'Quad Kings or better must lose',
  plo8: 'Quad Kings or better must lose (high hand only)',
  plo_hilo: 'Quad Kings or better must lose (high hand only)',
  plo5: '8-high Straight Flush or better must lose',
  flo4: 'Quad Kings or better must lose',
  flo5: '8-high Straight Flush or better must lose',
  flo8: 'Quad Kings or better must lose (high hand only)',
  /* Without this, Pineapple fell through to `q.description` and printed
     SHOUTY "Four Of A Kind (Kings) Or Better Must LOSE" where every other row
     prints a sentence. */
  pineapple: 'Quad Kings or better must lose',
};

/**
 * BBJ payout percent for a table's big blind — SYNCED TO THE SERVER (2026-08-18).
 *
 * The server pays a stakes-tiered slice of the main pool (nano 15% ... nosebleeds
 * 85%); the client's own STAKES_TIERS carry no payout percent and its tier
 * boundaries have drifted from the server's, so this helper mirrors the server's
 * getTierForBB boundaries EXACTLY (server/src/config/RakeConfig.ts) rather than
 * reusing the local tier table. If the widget preview ever disagrees with a real
 * payout, fix it HERE by re-syncing with the server file.
 */
export function getBBJPayoutPercentForBB(bigBlind: number | string): number {
  // Reads the tier table rather than repeating its boundaries. The old body
  // was a hand-kept copy of the server's cascade sitting inches from a
  // DIFFERENT cascade in getTierForBB — two ladders in one file, disagreeing.
  // One cascade, one table, one answer.
  return getTierForBB(bigBlind).bbjPayoutTotalPercent;
}

/** Per-variant info for the on-table BBJ widget. */
export function getBBJQualifyingInfo(gameType: string | null | undefined): BBJWidgetInfo {
  const key = normalizeVariantKey(gameType);
  const q = BBJ_QUALIFYING_HANDS[key] || BBJ_QUALIFYING_HANDS.nlh;
  if (q.eligible === false) {
    return {
      eligible: false,
      shortLabel: 'Bad Beat Jackpot not available for ' + q.label,
      subLabel: '',
      variantLabel: q.label,
    };
  }
  /* WHICH SENTENCE GOES UNDER THE BAR IS A PROPERTY OF THE GAME, NOT OF HOW
     ITS KEY IS SPELLED (2026-09-11).

     This was `key.startsWith('plo')`. `pineapple` and `flo8` both fail that
     test, so both were handed the HOLD'EM sentence - "Both hole cards must
     play (with an Ace for the full house)" - and Pineapple now carries a Quad
     Kings bar, for which there is no full house and no Ace rule at all. FLO8
     is four-card Omaha and was told the same thing.

     The exactly-two-cards rule is Omaha's, and Omaha is what `four_of_a_kind`
     or `straight_flush` on a FOUR-plus-card game means; the Ace-in-the-hole
     clause belongs to the full-house bar and nothing else. Both are read from
     the rank now. */
  const isFullHouseBar = q.handRank === 'full_house';
  const isOmahaFamily = key.startsWith('plo') || key.startsWith('flo');
  return {
    eligible: true,
    shortLabel: BBJ_SHORT_LABELS[key] || q.description,
    subLabel: isOmahaFamily
      ? 'Exactly two hole cards must play (both players).'
      : isFullHouseBar
        ? 'Both hole cards must play (with an Ace for the full house).'
        : 'Both hole cards must play.',
    variantLabel: q.label,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BBJ GENERAL RULES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * HOW A MAIN JACKPOT IS DIVIDED, IN ONE PLACE (2026-09-11).
 *
 * 50 to the bad-beat hand, 25 to the hand that won it, 25 shared by everyone
 * dealt in - `server/src/config/RakeConfig.ts` computes exactly this as
 * `totalPayoutPercent / 2`, `/ 4`, `/ 4`, and `fn_bbj_payout_atomic` applies
 * it in SQL.
 *
 * It was typed as bare `0.5` / `0.25` arithmetic and bare "50%" / "25%" text
 * across six client surfaces - the jackpot page's bar, the celebration, the
 * info modal, the basic panel, the rules panel - with nothing tying the words
 * to the arithmetic beside them. `BBJ_MINI_SPLIT_PERCENT` was created for the
 * mini on exactly this reasoning ("a caption quietly disagreeing with the
 * number under it"); the main, which is the larger money, had no equivalent.
 */
export const BBJ_MAIN_SPLIT = { loser: 0.5, winner: 0.25, table: 0.25 } as const;

/** The percentage a surface PRINTS, derived from the split rather than typed. */
export const BBJ_MAIN_SPLIT_PERCENT: Record<keyof typeof BBJ_MAIN_SPLIT, string> = {
  loser: `${Math.round(BBJ_MAIN_SPLIT.loser * 100)}%`,
  winner: `${Math.round(BBJ_MAIN_SPLIT.winner * 100)}%`,
  table: `${Math.round(BBJ_MAIN_SPLIT.table * 100)}%`,
};

export const BBJ_RULES = {
  /**
   * PAYOUT floor ONLY (Dan 2026-08-29): the drop is collected on every flop
   * with 3+ dealt regardless of pot size; this threshold gates winning only.
   */
  minPotBB: 10,
  /* THREE, NOT FOUR (2026-09-11).
     This read 4 while the engine has enforced 3 since FIX 145
     (`RAKE_SPEC.rules.bbjMinPlayersDealt = 3`, server/src/config/rakeSpec.ts).
     So every rules surface told players a three-handed pot could not win the
     jackpot, and the engine paid it. A player dealt into a 3-handed hand was
     reading that they were ineligible when they were not - the same shape as
     the Pineapple bar this phase fixed, in the same constant family, and found
     by the audit that followed it.
     `tests/one-qualifying-rule-for-one-jackpot.law.test.ts` pins the two
     halves together now, so this cannot drift again. */
  minPlayersDealt: 3,
  /* The MINI's own floor, mirroring server BBJ_RULES.miniMinPlayersDealt.
     Ships equal to the main's; a surface must state the mini's own number
     rather than borrowing the main's the moment they differ. */
  miniMinPlayersDealt: 3,
  excludeDoubleBoard: true,
  onlyFirstRunout: true,
  /* FALSE, MIRRORING server BBJ_RULES.splitIfMultipleQualify (2026-09-11).
     This read `true` and BBJQualifyingHands printed a promise that the prize
     is divided between multiple qualifying losers. The engine has always paid
     the STRONGEST qualifying losing hand - one holder, deterministically, the
     worse beat. The surface now says that. */
  splitIfMultipleQualify: false,
  requireBothHoleCards: true,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// LOOKUP FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find exact match in RAKE_SCHEDULE by SB/BB.
 * Falls back to null for non-standard stakes.
 */
export function findScheduleMatch(
  smallBlind: number | string,
  bigBlind: number | string
): RakeScheduleEntry | null {
  const sb = parseFloat(String(smallBlind)) || 0;
  const bb = parseFloat(String(bigBlind)) || 0;
  return (
    RAKE_SCHEDULE.find((row) => Math.abs(row.sb - sb) < 0.001 && Math.abs(row.bb - bb) < 0.001) ||
    null
  );
}

/**
 * Get tier config for a given Big-Blind size (fallback for non-exact matches).
 */
export function getTierForBB(bigBlind: number | string): StakesTier {
  const bb = parseFloat(String(bigBlind)) || 0;
  // Boundaries are the server's getStakesTierForBB cascade, to the digit.
  // They used to be 0.5 / 1 / 3 / 8 / 25, which put a 0.2/0.4 game in Nano
  // (server: Micro) and a 0.5/1 game in Micro (server: Small) — so the fee and
  // cap this helper reported were the wrong tier's for four common stakes.
  if (bb <= 0.2) return STAKES_TIERS.nano;
  if (bb <= 0.8) return STAKES_TIERS.micro;
  if (bb <= 3) return STAKES_TIERS.small;
  if (bb <= 8) return STAKES_TIERS.mid;
  if (bb <= 40) return STAKES_TIERS.high;
  return STAKES_TIERS.nosebleeds;
}

/**
 * Get full rake + BBJ config for a given stakes/variant.
 * Tries exact schedule match first, then falls back to tier.
 * IMPORTANT: rakeCap is always an absolute dollar amount.
 */
/**
 * A table's (or club's) rake override, mirroring the server's RakeOverride.
 * -1 / null / undefined all mean "inherit — use the schedule".
 *
 * This exists so the Game Rules modal shows what is ACTUALLY taken. The whole
 * point of the 2026-08-15 display fix was that the number on screen is the
 * number the engine uses; once a table can override the schedule, reading the
 * schedule alone would recreate that bug for exactly the tables whose owner
 * bothered to change it.
 *
 * Keep the resolution rules identical to
 * server/src/config/RakeConfig.ts getFullRakeConfig.
 */
export interface RakeOverride {
  rakePercent?: number | null;
  rakeCapBB?: number | null;
}

/** Sentinel stored in the database meaning "inherit". */
export const RAKE_INHERIT = -1;
/** An owner may never rake above the published schedule rate. */
export const MAX_RAKE_PERCENT = 10;
/** …nor set a cap above 10 big blinds. */
export const MAX_RAKE_CAP_BB = 10;

/**
 * THE MOST GENEROUS SHARE OF A BIG BLIND ANY PUBLISHED ROW TAKES.
 *
 * Derived from RAKE_SCHEDULE rather than written down, so it cannot drift from
 * the ladder it describes. Today that is the 0.1/0.2 row: a $3 cap on a $0.20
 * big blind, 15 BB.
 *
 * Dan, 2026-08-31: "IF YOU DON'T HAVE A RAKE OR BBJ SCHEDULE FOR A SPECIFIC
 * GAME, USE THE SAME PERCENTAGES WE USE FOR THE OTHER GAMES." A stake with no
 * row falls through to a stakes TIER, and a tier's cap is an absolute dollar
 * amount - which is a sane number at the stake the tier was written for and an
 * absurd one two rungs below it ($3 on a $0.02 big blind is 150 BB). Holding
 * the fallback to this proportion is what makes an unscheduled stake priced
 * "the same as the other games" instead of priced by accident.
 *
 * This binds ONLY the fallback. A stake with its own published row is charged
 * that row, and MAX_RAKE_CAP_BB continues to bind operator OVERRIDES - a
 * separate ceiling for a separate thing.
 */
export const UNSCHEDULED_CAP_BB = RAKE_SCHEDULE.reduce(
  (worst, row) => (row.bb > 0 ? Math.max(worst, row.rakeCap / row.bb) : worst),
  0
);

/** The cap for a stake with no published row: the tier's, held to the ladder. */
export function unscheduledCapFor(bigBlind: number, tierCap: number): number {
  if (!(bigBlind > 0)) return tierCap;
  return Math.min(tierCap, Math.round(bigBlind * UNSCHEDULED_CAP_BB * 100) / 100);
}

function isRakeSet(v: number | null | undefined): v is number {
  if (v === null || v === undefined) return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

export function getRakeConfig(
  bigBlind: number | string,
  variant: string = 'nlh',
  smallBlind: number | string | null = null,
  override?: RakeOverride
): RakeConfigResult {
  const sb = smallBlind != null ? parseFloat(String(smallBlind)) : parseFloat(String(bigBlind)) / 2;
  const bb = parseFloat(String(bigBlind)) || 0;
  const scheduleMatch = findScheduleMatch(sb, bb);

  const tier = getTierForBB(bb);
  const qualifying = BBJ_QUALIFYING_HANDS[variant] || BBJ_QUALIFYING_HANDS.nlh;
  const bbjEligible = qualifying.eligible !== false;

  const clampNum = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  const schedulePercent = scheduleMatch ? scheduleMatch.rakePercent : tier.rakePercent;
  const scheduleCap = scheduleMatch ? scheduleMatch.rakeCap : unscheduledCapFor(bb, tier.rakeCap);

  // Each game has a max rake — the published schedule for the stake — and an
  // override may only move downward from it. Mirrors the server exactly; see
  // the note in server/src/config/RakeConfig.ts. Without the min() this panel
  // would advertise a cap the engine will never actually take.
  const rakePercent = isRakeSet(override?.rakePercent)
    ? Math.min(clampNum(Number(override!.rakePercent), 0, MAX_RAKE_PERCENT), schedulePercent)
    : schedulePercent;
  // Big blinds -> dollars, exactly as the server does it, then held to the cap.
  const rakeCap = isRakeSet(override?.rakeCapBB)
    ? Math.min(
        Math.round(clampNum(Number(override!.rakeCapBB), 0, MAX_RAKE_CAP_BB) * bb * 100) / 100,
        scheduleCap
      )
    : scheduleCap;
  const bbjFeeBB = scheduleMatch ? scheduleMatch.bbjFeeBB : tier.bbjFeeBB;

  return {
    tier: tier.label,
    blindRange: tier.blindRange,
    rakePercent,
    rakeCap,
    rakeCapBB: rakeCap,
    rakeCapDollars: rakeCap,
    bbjEnabled: bbjEligible,
    bbjFeeBB: bbjEligible ? bbjFeeBB : 0,
    bbjPoolAllocation: BBJ_POOL_ALLOCATION,
    /* DERIVED FROM THE TIER, AS THE ENGINE DOES (2026-09-11).
       These four read `100, 50, 25, 25` - flat literals - and the first of
       them was simply WRONG. No stakes tier pays 100% of the pool: the tiers
       pay 15 / 25 / 40 / 55 / 70 / 85 (`bbjPayoutTotalPercent` above), which
       is what `server/src/config/RakeConfig.ts` returns from the same fields.
       Nothing on the client read these yet, so nothing was displaying the
       wrong number - which is the only reason this was a latent defect and
       not a live one. A wrong constant sitting in a config waiting for its
       first reader is worse than a missing one, because the reader has no
       reason to doubt it. Derived here so the two halves cannot disagree. */
    bbjPayoutTotal: tier.bbjPayoutTotalPercent,
    bbjPayoutLoser: tier.bbjPayoutTotalPercent * BBJ_MAIN_SPLIT.loser,
    bbjPayoutWinner: tier.bbjPayoutTotalPercent * BBJ_MAIN_SPLIT.winner,
    bbjPayoutTable: tier.bbjPayoutTotalPercent * BBJ_MAIN_SPLIT.table,
    qualifyingHand: qualifying,
    rules: BBJ_RULES,
    _exactMatch: !!scheduleMatch,
  };
}

/**
 * Calculate BBJ fee for a specific hand — the COLLECTION rule (display copy;
 * the server engine is authoritative).
 *
 * Dan 2026-08-29 (BINDING): the drop is taken on EVERY flop with 3+ players
 * dealt in, regardless of pot size. The 10BB minimum (BBJ_RULES.minPotBB)
 * gates the PAYOUT only.
 */
export function calculateBBJFee(
  bigBlind: number | string,
  flopSeen: boolean,
  numPlayersDealt: number,
  variant: string = 'nlh',
  smallBlind: number | string | null = null
): number {
  const config = getRakeConfig(bigBlind, variant, smallBlind);
  const bb = parseFloat(String(bigBlind)) || 0;

  if (!config.bbjEnabled) return 0;
  if (!flopSeen) return 0;
  if (numPlayersDealt < BBJ_RULES.minPlayersDealt) return 0;

  return Math.round(bb * config.bbjFeeBB * 100) / 100;
}

/**
 * Get allowed stakes for table creation UI.
 * Returns the official list of supported stake levels.
 */
export function getAllowedStakes() {
  return RAKE_SCHEDULE.map((row) => ({
    label: `${row.sb}/${row.bb}`,
    smallBlind: row.sb,
    bigBlind: row.bb,
    rakeCap: row.rakeCap,
    bbjFeeBB: row.bbjFeeBB,
  }));
}
