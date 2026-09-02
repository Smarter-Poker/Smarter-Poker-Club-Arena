/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ADVANCED FILTER SPEC — what each game type can be filtered by
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-20: "screen shots of preferences that need to be enabled for all
 * games."
 *
 * The seven reference screens are NOT one form with a variant switch. Each game
 * type filters on a different set of things, and several sections are absent
 * entirely on some of them:
 *
 *   Hold'em   games(NLH/FLH/6+) · blinds · table size · features
 *   Omaha     (no games row)    · blinds · table size · features
 *   MTT       games(7)          · buy-in · running/open-reg · 5 features
 *   Spin-It   games(4)          · buy-in · table size(fixed 3) · NO features
 *   SN        format + games(5) · buy-in · table size · NO features
 *
 * Encoding that as DATA rather than as branches in the component is the whole
 * point: the modal renders whatever the spec for the active tab declares, so
 * adding a variant later is a table entry, not a new conditional. It also keeps
 * the shape honest — Spin-It genuinely has no feature grid, and a component
 * full of `{type !== 'SPIN' && ...}` would hide that fact.
 *
 * FEATURE KEYS map to what the lobby can actually see: `tables.settings` JSON
 * for cash games and the tournament flags for MTT. A filter that cannot be
 * evaluated is worse than a missing one, so anything unmatchable is left out.
 */

import {
  isInLateRegistration,
  STARTING_SOON_WINDOW_MINUTES,
  type FilterableTournament,
} from '../../utils/tournamentFilters';
import { SPIN_VARIANT_KEYS, TOURNAMENT_VARIANT_KEYS } from '../../config/tournamentVariants';

export type FilterGameType = 'ALL' | 'HOLDEM' | 'OMAHA' | 'LIMIT' | 'MTT' | 'SPIN' | 'SNG';

export interface FeatureOption {
  /** Stable key persisted in saved preferences. Never rename. */
  key: string;
  label: string;
  /**
   * settings-JSON keys (cash) or tournament columns (MTT) that mean "this
   * table has the feature". Any one matching counts.
   */
  match: string[];
}

export interface RangeSpec {
  label: string;
  /** Rendered under the slider. Selecting one snaps the range to its bounds. */
  presets: { key: string; label: string; min: number; max: number }[];
  min: number;
  max: number;
}

export interface GameFilterSpec {
  /** "Games:" chips. Omitted entirely when the reference screen has none. */
  games?: { key: string; label: string }[];
  /** "Format:" chips. SN only. */
  format?: { key: string; label: string }[];
  range: RangeSpec;
  /** Table-size status chips. */
  statuses: { key: string; label: string }[];
  /** Seat range slider bounds, or null for a fixed-size game (Spin). */
  seats: { min: number; max: number } | null;
  seatsLabel: string;
  /** Empty array = no MUST-HAVE / Hide grids on this screen. */
  features: FeatureOption[];
}

/**
 * Cash-game feature grid.
 *
 * ── EVERY KEY HERE MUST BE A COLUMN THE LOBBY QUERY SELECTS ────────────────
 * 2026-08-25: fourteen of these twenty chips could never match anything. The
 * matcher reads `settings[k] ?? row[k]`, `settings` is `{}` on all 46 live
 * tables, and `row` is exactly the column list in ClubHomePage — so a chip
 * naming a key outside that list evaluated false for every row. Ticking it as
 * MUST-HAVE emptied the tab with the filter dot lit; ticking it as HIDE was a
 * silent no-op.
 *
 * That is the same defect this file has already recorded removing twice: the
 * FLH chip and the "OMAHA High" chip, both deleted for exactly this reason.
 * The rule is now explicit rather than folklore, and a test asserts it.
 *
 * The removed chips are not lost work — they are features the engine does not
 * enforce (Kill Pot, CallTime, VPIP, NIT Game, PC Emulator) or columns the
 * lobby does not fetch. They come back with the feature, together.
 */
const CASH_FEATURES: FeatureOption[] = [
  { key: 'ante', label: 'Ante', match: ['ante', 'ante_enabled'] },
  { key: 'straddle', label: 'Straddle', match: ['straddle_enabled'] },
  { key: 'auto_straddle', label: 'Auto Straddle', match: ['auto_utg_straddle'] },
  { key: 'insurance', label: 'Insurance', match: ['insurance_enabled'] },
  {
    key: 'rit_choice',
    label: 'Run It Twice',
    match: ['run_it_twice', 'run_it_twice_enabled', 'allow_run_it_twice'],
  },
  { key: 'bomb_pot', label: 'BombPot', match: ['bomb_pot_enabled'] },
  /* MULTI-BOARD DISCOVERY (2026-08-28): the double-board boolean is kept in
     lockstep with bomb_pot_board_count >= 2 by every writer, and the lobby
     query fetches it — so this chip really narrows, unlike the fourteen
     ghosts removed on 2026-08-25. */
  { key: 'bomb_multi_board', label: 'Multi-Board Bomb', match: ['bomb_pot_double_board'] },
  /* seven_deuce_enabled is the column; the old key was `seven_deuce`, off by a
     suffix, so the chip never matched the table it names. */
  { key: 'seven_deuce', label: 'Seven-Deuce', match: ['seven_deuce_enabled'] },
  { key: 'time_bank', label: 'Time Bank', match: ['time_bank_enabled'] },
  { key: 'all_in_or_fold', label: 'All-In Or Fold', match: ['all_in_or_fold'] },
];

/**
 * Omaha drops Seven-Deuce, and now for a reason the engine agrees with rather
 * than a reference screen: ServerTableEngineSettlement gates the bounty to
 * Hold'em ("meaningless in PLO; short-deck has no deuces"), so the chip could
 * only ever match zero Omaha rows. Same keys as the cash grid, so a preference
 * saved on one tab still means the same thing on another.
 */
const OMAHA_FEATURES: FeatureOption[] = CASH_FEATURES.filter(
  (f) => !['seven_deuce'].includes(f.key)
);

/**
 * MTT features.
 *
 * All FIVE of the old entries were inert: the tournament path passes
 * `settings: {}` explicitly and none of `all_in_or_fold`, `is_private`,
 * `is_bounty`, `is_pko`, `is_mystery_bounty`, `vip_only` or `block_emulator`
 * is in the tournament select list. Selecting any of them emptied the MTT tab.
 *
 * The grid is empty rather than wrong. A tournament's traits are already
 * visible as medallions on its card (PKO, MYSTERY BOUNTY, REBUY, GUARANTEED,
 * LATE REG) and those are computed from columns the query really does fetch;
 * turning them into filters means fetching the columns first, which is a
 * change to the query and not to this table.
 */
const MTT_FEATURES: FeatureOption[] = [];

/** Blind tiers, matching BBJRulesPanel's published ladder. */
const BLIND_RANGE: RangeSpec = {
  label: 'Blinds',
  min: 0.02,
  max: 5000,
  presets: [
    { key: 'micro', label: 'Micro', min: 0.02, max: 0.2 },
    { key: 'small', label: 'Small', min: 0.2, max: 3 },
    { key: 'mid', label: 'Mid', min: 3, max: 8 },
    { key: 'high', label: 'High', min: 8, max: 5000 },
  ],
};

/** Buy-in tiers, aligned to the whole-dollar ladder in src/utils/buyIn.ts. */
const BUYIN_RANGE: RangeSpec = {
  label: 'Tournament Buy-In',
  min: 0,
  max: 15000,
  presets: [
    { key: 'micro', label: 'Micro', min: 0, max: 5 },
    { key: 'small', label: 'Small', min: 5, max: 25 },
    { key: 'mid', label: 'Mid', min: 25, max: 100 },
    { key: 'high', label: 'High', min: 100, max: 15000 },
  ],
};

const CASH_STATUSES = [
  { key: 'full', label: 'Full' },
  { key: 'empty', label: 'Empty' },
  { key: 'open', label: 'Open Seats' },
];

/**
 * ── THE GAMES ROW OF EVERY TOURNAMENT TAB IS DERIVED, NOT TYPED ──────────────
 *
 * Dan 2026-08-31, with the Heads Up tab open: "LIMIT POKER NEEDS TO BE ADDED TO
 * THE GAME VARIATIONS FILTER."
 *
 * It could not be added as a chip alone. This file records, three times over,
 * that a chip whose key nothing can produce EMPTIES THE TAB when it is ticked —
 * the FLH chip and the "OMAHA High" chip were both deleted for exactly that. So
 * limit first had to become a game a tournament can BE
 * (src/config/tournamentVariants), and the chips now come from that same list.
 *
 * Deriving them also closed two live instances of the OPPOSITE defect, which
 * this file also records ("a producible variant with no chip is deleted by the
 * games filter the moment a player ticks any other chip"):
 *
 *   • the Heads Up tab had no PLO8 chip while a PLO8 Sit & Go was creatable;
 *   • the Spins tab had no PLO8 or Short Deck chip while both were creatable
 *     from the create-table form. That pair is fixed at the SOURCE instead —
 *     the spin catalogue is now enforced where spins are authored, so the Spins
 *     row stays the four games Spin & Go actually sells.
 *
 * Adding a variant is now one entry in one map, and the chip follows it.
 */
const VARIANT_CHIP_LABELS: Record<string, string> = {
  nlh: 'NLH',
  plo4: 'PLO 4c',
  plo5: 'PLO 5c',
  plo6: 'PLO 6c',
  plo8: 'PLO Hi/Lo',
  short_deck: '6+',
  pineapple: 'Crazy Pineapple',
  flh: 'FLH',
  flo8: 'FLO8',
};

/* The MTT tab has always said OMAHA where the cash and Sit & Go tabs say PLO.
   That wording predates this change, so it is preserved as an override rather
   than quietly normalised by the refactor that derived the row. */
const MTT_CHIP_LABELS: Record<string, string> = {
  ...VARIANT_CHIP_LABELS,
  plo4: 'OMAHA 4c',
  plo5: 'OMAHA 5c',
  plo6: 'OMAHA 6c',
  plo8: 'OMAHA Hi/Lo',
};

const chipsFor = (
  keys: readonly string[],
  labels: Record<string, string> = VARIANT_CHIP_LABELS
): { key: string; label: string }[] =>
  keys.map((key) => ({ key, label: labels[key] ?? key.toUpperCase() }));

export const FILTER_SPECS: Record<Exclude<FilterGameType, 'ALL'>, GameFilterSpec> = {
  HOLDEM: {
    games: [
      { key: 'nlh', label: 'NLH' },
      /* Pineapple is a Hold'em-family variant and cashKind routes it here, so
         without a chip of its own every Pineapple table vanished the moment a
         player ticked NLH. Five of them run in production. */
      { key: 'pineapple', label: 'Crazy Pineapple' },
      // 2026-08-23: the FLH chip used to live here and could never match a
      // single row. ClubHomePage.cashKind() routes every fixed-limit variant to
      // the LIMIT tab, so an FLH table is by construction absent from the
      // HOLDEM list — ticking the chip narrowed HOLDEM to nothing and read as
      // "there are no Hold'em games". Limit games are filtered on the LIMIT
      // tab, which deliberately carries no sub-variant chips.
      { key: 'short_deck', label: '6+' },
    ],
    range: BLIND_RANGE,
    statuses: CASH_STATUSES,
    seats: { min: 2, max: 9 },
    seatsLabel: 'Table Size',
    features: CASH_FEATURES,
  },
  OMAHA: {
    /* Dan 2026-08-25: "PLO ... HAS 5 VARIATIONS. INSIDE THE FILTERS, USERS
       SHOULD BE ABLE TO SELECT WHAT PLO GAMES THEY WANT DISPLAYED, AND THEY
       SHOULD BE DISPLAYED IN ORDER."

       The old note here said the Omaha tab "already IS the variant selection".
       It is not: it is four games in one list. PLO4 and PLO6 are different
       games with different bankroll requirements and the tab mixed them at
       every stake, so a player who only plays 4-card had to read every row.

       Every key below is one `variantKey` already returns — the precedent
       this file records twice (the removed FLH and 'OMAHA High' chips) is that
       a chip whose key can never be produced silently empties the tab. PLO8 is
       matched before PLO6/5/4 in variantKey, so hi-lo does not fall into the
       4-card bucket. */
    games: [
      { key: 'plo4', label: 'PLO 4c' },
      { key: 'plo5', label: 'PLO 5c' },
      { key: 'plo6', label: 'PLO 6c' },
      { key: 'plo8', label: 'PLO Hi/Lo' },
    ],
    range: BLIND_RANGE,
    statuses: CASH_STATUSES,
    seats: { min: 2, max: 9 },
    seatsLabel: 'Table Size',
    features: OMAHA_FEATURES,
  },
  LIMIT: {
    // 2026-08-24: this row was withheld because "inventing sub-variant chips
    // risks hiding real tables behind keys variantKey has not learnt". That
    // precondition is now met: variantKey learnt `flh` and `flo8` (and the
    // legacy `limit_holdem` / `limit_omaha` spellings, which fold into the same
    // two keys) when the limit games shipped. There are exactly two limit
    // variants, both creatable, so the tab has something to sub-divide.
    games: [
      { key: 'flh', label: 'FLH' },
      { key: 'flo8', label: 'FLO8' },
    ],
    range: BLIND_RANGE,
    statuses: CASH_STATUSES,
    seats: { min: 2, max: 9 },
    seatsLabel: 'Table Size',
    features: CASH_FEATURES,
  },
  MTT: {
    /* Every game an MTT can be created as, plus `pineapple` — which is NOT
       creatable but IS present: one legacy OFC_PINEAPPLE row survives and
       variantKey maps it (lobbyEntries.TOURNEY_VARIANT_KEYS), so without a chip
       that event is deleted from the board the moment any other chip is ticked.
       A chip for something that exists is right even when nothing new can make
       one; a chip for something that cannot exist is the defect.

       'OMAHA High' was removed here on 2026-08-25 and must not come back:
       `variantKey` can only ever return `plo_high` for an input literally equal
       to that string, and no row in the database is. */
    games: chipsFor([...TOURNAMENT_VARIANT_KEYS, 'pineapple'], MTT_CHIP_LABELS),
    range: BUYIN_RANGE,
    statuses: [
      { key: 'running', label: 'Running' },
      { key: 'open_reg', label: 'Open Registration' },
      { key: 'late_reg', label: 'Late Reg' },
      { key: 'starting_soon', label: 'Starting Soon' },
    ],
    seats: { min: 2, max: 9 },
    seatsLabel: 'Table Size',
    features: MTT_FEATURES,
  },
  SPIN: {
    /* The spin CATALOGUE, not the tournament catalogue: Spin & Go sells four
       games and the tier table is tuned around them. Derived so that the day a
       fifth is added to SPIN_GAME_TYPES it appears here, and so that a game the
       catalogue does not sell can no longer be created without a chip. */
    games: chipsFor(SPIN_VARIANT_KEYS),
    range: BUYIN_RANGE,
    statuses: CASH_STATUSES,
    // Spins are always three-handed, so the reference screen shows a fixed
    // "Table Size: 3" and no slider at all.
    seats: null,
    seatsLabel: 'Table Size: 3',
    features: [],
  },
  SNG: {
    format: [
      { key: 'sats', label: 'SNG SATS' },
      { key: 'regular', label: 'Regular SNG' },
    ],
    /* THE TAB IN DAN'S SCREENSHOT. Same source as MTT, so Heads Up offers
       every game a Sit & Go can be — which is how FLH and FLO8 arrived, and how
       the missing PLO Hi/Lo chip was found. */
    games: chipsFor(TOURNAMENT_VARIANT_KEYS),
    range: BUYIN_RANGE,
    statuses: CASH_STATUSES,
    seats: { min: 2, max: 9 },
    seatsLabel: 'Table Size',
    features: [],
  },
};

/** One tab's worth of chosen filters. */
export interface GameFilterValue {
  games: string[];
  format: string[];
  rangeMin: number;
  rangeMax: number;
  selectedRanges?: string[];
  statuses: string[];
  seatMin: number;
  seatMax: number;
  /** Show ONLY tables carrying ALL of these. */
  mustHave: string[];
  /** Hide tables carrying ANY of these. */
  hide: string[];
}

export function emptyFilterValue(spec: GameFilterSpec): GameFilterValue {
  return {
    games: [],
    format: [],
    rangeMin: spec.range.min,
    rangeMax: spec.range.max,
    selectedRanges: [],
    statuses: [],
    seatMin: spec.seats?.min ?? 3,
    seatMax: spec.seats?.max ?? 3,
    mustHave: [],
    hide: [],
  };
}

/**
 * Does this row survive the tab's saved filters?
 *
 * `row` is a raw table or tournament record. Feature detection reads the
 * settings JSON for cash and the flags for tournaments, via the `match` keys
 * on each FeatureOption - which is why those keys live in the spec rather than
 * being inferred from the label.
 *
 * A filter that CANNOT be evaluated passes. If a table's settings blob does not
 * mention Bomb Pot at all we do not know whether it has one, and hiding rows on
 * an unknown is how a lobby ends up empty for a reason the player cannot see.
 * Absence of evidence is not evidence of absence on a screen whose whole job is
 * to show what is available.
 */
export function matchesAdvancedFilter(
  spec: GameFilterSpec,
  v: GameFilterValue,
  row: Record<string, unknown>,
  settings: Record<string, unknown>
): boolean {
  const hasFeature = (f: FeatureOption): boolean =>
    f.match.some((k) => {
      const val = settings[k] ?? row[k];
      return val === true || val === 'true' || (typeof val === 'number' && val > 0);
    });

  for (const key of v.mustHave) {
    const f = spec.features.find((x) => x.key === key);
    if (f && !hasFeature(f)) return false;
  }
  for (const key of v.hide) {
    const f = spec.features.find((x) => x.key === key);
    if (f && hasFeature(f)) return false;
  }
  return true;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WHOLE FILTER DECISION, IN ONE PLACE
 * ───────────────────────────────────────────────────────────────────────────
 * AUDIT 2026-08-21. The sheet collected NINE fields and the lobby applied
 * THREE. `games`, `format` and `statuses` were saved to localStorage, rendered
 * back as selected chips on reopen, and then ignored completely: a player
 * could pick "NLH only", "Regular SNG" or "Open Seats", press Save, and watch
 * the lobby return exactly the same list. The seat range was applied to cash
 * tables only, so the MTT and SNG sliders did nothing either.
 *
 * That is the worst shape a filter can take - it is not an absent feature, it
 * is a control that LOOKS applied and is not, so the player concludes the
 * lobby is broken rather than that the filter is.
 *
 * The fix is structural, not three more `if`s in the page: the decision moves
 * here, beside the spec that defines the fields, and both the cash and
 * tournament paths call the same function. A field added to GameFilterValue
 * now has exactly one place that must learn to honour it.
 */
export interface FilterableRow {
  /** Cash: game_variant. Tournament: game_type. */
  variant?: string | null;
  /** Cash: big_blind. Tournament: total buy-in (prize + fee). */
  price?: number | null;
  /** Cash: max_players. Tournament: max_players, i.e. the FIELD cap. */
  seats?: number | null;
  /**
   * Seats at ONE table, when the row knows it -- tournaments.table_size.
   * The "Table Size" slider reads this, never `seats`: a 500-runner MTT seats
   * nine at a table and comparing 500 to a 2-9 range deletes it. Pass the key
   * with a null value rather than omitting it when the size is unknown; that
   * skips the range instead of falling back to the field cap.
   */
  tableSeats?: number | null;
  seatsTaken?: number | null;
  /** Tournament status, for the MTT running / open-registration chips. */
  status?: string | null;
  /** Tournament name, the only place SATS vs REGULAR is expressed today. */
  name?: string | null;
  /** Raw record for feature lookups. */
  row: Record<string, unknown>;
  settings: Record<string, unknown>;
}

/** Normalise a variant string to the keys used by the spec's `games` chips. */
/**
 * Exported since 2026-08-25 so the lobby can GROUP by the same key it filters
 * by. A second copy of this ladder in ClubHomePage would be a second place for
 * `plo8` to stop being tested before `plo6`.
 */
export function variantKey(raw: string | null | undefined): string {
  const v = String(raw ?? '').toLowerCase();
  if (!v) return '';
  // Fixed-limit Omaha Hi-Lo first: `flo8` contains neither "plo8" nor "hilo",
  // and every other hi-lo test below would otherwise fold it into plo8 or drop
  // it through unrecognised. Legacy rows spell it `limit_omaha` (2026-08-23).
  if (v === 'flo8' || v.includes('flo8') || v.includes('limit_omaha') || v.includes('limit omaha'))
    return 'flo8';
  if (v.includes('plo8') || v.includes('hi/lo') || v.includes('hilo')) return 'plo8';

  if (v.includes('plo6')) return 'plo6';
  if (v.includes('plo5')) return 'plo5';
  if (v.includes('plo4') || v === 'plo') return 'plo4';
  if (v.includes('short') || v === '6+') return 'short_deck';
  if (v.includes('flh') || v.includes('limit holdem') || v.includes('limit_holdem')) return 'flh';
  /* `ofc_pineapple` is what tournaments.game_type actually stores, and it
     passed through unchanged - a non-empty key matching no chip, which the
     rule below then filtered the row out on. Both spellings normalise to the
     one key the HOLDEM and MTT chips already use. Kept above the holdem tests
     so a future "pineapple holdem" spelling cannot be swallowed by them. */
  if (v.includes('pineapple')) return 'pineapple';

  if (v.includes('nlh') || v.includes('holdem') || v.includes("hold'em")) return 'nlh';
  return v;
}

/**
 * Does this row survive every saved filter for its tab?
 *
 * Empty selections mean "no opinion", never "match nothing" - an untouched
 * filter must not silently empty the lobby.
 */
export function rowPassesFilter(
  spec: GameFilterSpec,
  v: GameFilterValue,
  r: FilterableRow
): boolean {
  // ── Games chips ─────────────────────────────────────────────────────────
  if (v.games.length > 0) {
    const key = variantKey(r.variant);
    /**
     * An unrecognised variant passes — only an EMPTY key qualifies, because
     * variantKey returns its input unchanged when it recognises nothing.
     *
     * That is the correct narrowing rule and it is deliberately unchanged.
     * The real defect it exposed on 2026-08-25 was elsewhere: `pineapple` IS
     * recognised, cashKind routes Pineapple tables to the HOLDEM tab, and
     * HOLDEM offered no chip for it — so ticking "NLH" made five real
     * production tables disappear. The fix is a chip, not a looser matcher;
     * loosening this would stop every chip from narrowing anything.
     */
    if (key && !v.games.includes(key)) return false;
  }

  // ── Format chips (SN only: satellite vs regular) ─────────────────────────
  if (v.format.length > 0) {
    const name = String(r.name ?? '').toLowerCase();
    /* `includes('sat')` matched Saturday, Satchel and anything else with those
       three letters, so "Regular SNG" hid real games. Word-boundary match on
       the actual word, plus the column when the query ever fetches it. */
    /* `includes('sat')` matched Saturday, Satchel and anything else carrying
       those three letters, so "Regular SNG" hid real games. A WORD match keeps
       "Sat To Main" and "Satellite" and rejects "Saturday", because there is no
       word boundary after the "Sat" in Saturday. */
    const isSat = /\bsat(ellite)?\b/i.test(name) || r.row.is_satellite === true;
    const wantsSat = v.format.includes('sats');
    const wantsReg = v.format.includes('regular');
    // Both selected is the same as neither: no opinion.
    if (wantsSat !== wantsReg) {
      if (wantsSat && !isSat) return false;
      if (wantsReg && isSat) return false;
    }
  }

  // ── Price range (blinds for cash, total buy-in for tournaments) ──────────
  /* `> 0` used to be part of this guard, which exempted every FREEROLL from
     the buy-in filter: a 0 buy-in passed even with only the High tier
     selected. Zero is a real price here - BUYIN_RANGE's micro preset starts
     at 0 - so only an absent or unparseable price counts as unknown. */
  const price = r.price == null ? NaN : Number(r.price);
  if (Number.isFinite(price)) {
    if (v.selectedRanges && v.selectedRanges.length > 0) {
      const matchesPreset = spec.range.presets.some((p) => {
        if (!v.selectedRanges!.includes(p.key)) return false;
        return price >= p.min && price <= p.max;
      });
      if (!matchesPreset) return false;
    } else {
      /* RULE 1 OF THE SEAT BLOCK BELOW, WHICH THIS BRANCH NEVER GOT. A range
         sitting at its default is not a filter. isFilterActive() says the same
         (it compares both ends against the spec), so without this guard the
         two functions disagreed - the chip read "no filters" while this line
         quietly deleted rows. It bites hardest on a table whose big_blind is
         null or 0: callers pass `Number(table.big_blind) || 0`, and 0 is below
         BLIND_RANGE.min (0.02), so an untouched slider hid every one of them
         and the empty state offered nothing to clear. */
      const atDefault = v.rangeMin === spec.range.min && v.rangeMax === spec.range.max;
      if (!atDefault && (price < v.rangeMin || price > v.rangeMax)) return false;
    }
  }

  // ── Seat range ───────────────────────────────────────────────────────────
  // Applies to EVERY format whose spec declares a slider, not just cash. The
  // MTT and SNG sliders were previously inert.
  //
  // TWO RULES LEARNED THE HARD WAY ON 2026-08-23, both from the same report:
  // "THE MTT, SPINS AND HEADS UP TABLES AND EVENTS ARE NOT BEING DISPLAYED."
  // Shark Club and Midway showed Spins and Heads Up but an EMPTY MTT tab,
  // while Club JAQK -- identical union, identical games -- showed all 24.
  //
  //   1. A RANGE SITTING AT ITS DEFAULT IS NOT A FILTER. The only difference
  //      between those clubs was that Shark and Midway had a saved filter
  //      value at all, untouched at its default 2-9. isFilterActive() calls
  //      that inactive, so the empty state read "Nothing Here On This Tab" and
  //      offered no filter to clear -- while this function quietly deleted
  //      every row. Two functions disagreeing about whether a filter is set is
  //      the whole bug; they now share one answer.
  //
  //   2. "TABLE SIZE" MEANS SEATS AT A TABLE. For a tournament r.seats is
  //      max_players, the FIELD cap -- 150, 300, 1000 -- so comparing it to a
  //      2-9 slider rejects every MTT that has ever existed. The seats at one
  //      table is table_size, which callers pass as tableSeats. When the row
  //      carries the key but has no value, the range is skipped: not knowing a
  //      table's size is never a reason to hide the game.
  if (spec.seats) {
    const atDefault = v.seatMin === spec.seats.min && v.seatMax === spec.seats.max;
    if (!atDefault) {
      const raw = 'tableSeats' in r ? r.tableSeats : r.seats;
      const seats = Number(raw);
      if (Number.isFinite(seats) && seats > 0) {
        if (seats < v.seatMin || seats > v.seatMax) return false;
      }
    }
  }

  // ── Status chips ─────────────────────────────────────────────────────────
  if (v.statuses.length > 0) {
    const taken = Number(r.seatsTaken) || 0;
    const cap = Number(r.seats) || 0;
    const status = String(r.status ?? '').toUpperCase();

    const matches = v.statuses.some((key) => {
      switch (key) {
        case 'full':
          return cap > 0 && taken >= cap;
        case 'empty':
          return taken === 0;
        case 'open':
          return cap > 0 && taken < cap;
        case 'running':
          return status === 'RUNNING' || status === 'IN_PROGRESS';
        case 'open_reg':
          return status === 'REGISTERING' || status === 'OPEN' || status === 'PENDING';
        case 'late_reg':
          // Derived from late_reg_mins / late_reg_levels, never from a status
          // string - no tournament has ever carried a 'LATE_REG' status, which
          // is why that tab was empty for months. Reuses the shared rule.
          return isInLateRegistration(r.row as unknown as FilterableTournament, Date.now());
        case 'starting_soon': {
          const startsAt = new Date(String(r.row.start_time ?? '')).getTime();
          if (!Number.isFinite(startsAt)) return false;
          const minsAway = (startsAt - Date.now()) / 60000;
          // Games here start on FILL, not on the clock, so a live one usually
          // has a start_time already in the past. "Soon" therefore includes
          // anything already due as well as anything inside the window.
          return minsAway <= STARTING_SOON_WINDOW_MINUTES;
        }
        default:
          // A key this build does not know is not an opinion about this row.
          return true;
      }
    });
    // Status chips are an OR within themselves: "Full or Empty" is a union,
    // not an impossible intersection.
    if (!matches) return false;
  }

  return matchesAdvancedFilter(spec, v, r.row, r.settings);
}

/** Has the player actually narrowed anything? Drives the bar's "active" dot. */
export function isFilterActive(spec: GameFilterSpec, v: GameFilterValue): boolean {
  return (
    v.games.length > 0 ||
    v.format.length > 0 ||
    v.statuses.length > 0 ||
    v.mustHave.length > 0 ||
    v.hide.length > 0 ||
    (v.selectedRanges && v.selectedRanges.length > 0) ||
    v.rangeMin !== spec.range.min ||
    v.rangeMax !== spec.range.max ||
    (spec.seats ? v.seatMin !== spec.seats.min || v.seatMax !== spec.seats.max : false)
  );
}
