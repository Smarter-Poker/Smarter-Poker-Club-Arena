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

/** Cash-game feature grid. Keys match tables.settings flags. */
const CASH_FEATURES: FeatureOption[] = [
  { key: 'double_board', label: 'Double Board', match: ['double_board', 'doubleBoard'] },
  { key: 'triple_board', label: 'Triple Board', match: ['triple_board', 'tripleBoard'] },
  { key: 'jackpot', label: 'Jackpot', match: ['bbj_enabled', 'jackpot_enabled'] },
  { key: 'kill_pot', label: 'Kill Pot', match: ['kill_pot', 'killPot'] },
  { key: 'call_time', label: 'CallTime', match: ['call_time_enabled', 'callTime'] },
  { key: 'anonymous', label: 'Anonymous', match: ['anonymous', 'anonymous_tables'] },
  { key: 'ante', label: 'Ante', match: ['ante', 'ante_enabled'] },
  { key: 'vpip', label: 'VPIP', match: ['vpip_required', 'vpip'] },
  { key: 'straddle', label: 'Straddle', match: ['straddle_enabled', 'straddle'] },
  { key: 'insurance', label: 'Insurance', match: ['insurance_enabled', 'allInInsurance'] },
  { key: 'rit_multi', label: 'Run It Multi-Times', match: ['run_it_multi', 'runItMulti'] },
  { key: 'rit_choice', label: "Run It Player's Choice", match: ['run_it_twice', 'runItTwice'] },
  {
    key: 'rit_mandatory',
    label: 'Mandatory Run It',
    match: ['mandatory_run_it', 'mandatoryRunIt'],
  },
  { key: 'vip', label: 'VIP', match: ['vip_only', 'vipOnly'] },
  { key: 'pineapple', label: 'Pineapple', match: ['pineapple'] },
  { key: 'bomb_pot', label: 'BombPot', match: ['bomb_pot_enabled', 'bombPot'] },
  { key: 'seven_deuce', label: 'Seven-Deuce', match: ['seven_deuce', 'sevenDeuce'] },
  { key: 'nit_game', label: 'NIT Game', match: ['nit_game', 'nitGame'] },
  { key: 'cap', label: 'CAP', match: ['cap_enabled', 'cap'] },
  { key: 'pc_emulator', label: 'PC Emulator Restriction', match: ['block_emulator', 'pcRestrict'] },
];

/**
 * Omaha drops Pineapple (a Hold'em-family variant) and Seven-Deuce (a
 * two-card-hand prop) exactly as the reference screen does, and reorders the
 * tail. Same keys, so a preference saved on one tab still means the same thing.
 */
const OMAHA_FEATURES: FeatureOption[] = CASH_FEATURES.filter(
  (f) => !['pineapple', 'seven_deuce'].includes(f.key)
);

/** MTT has five, all tournament-level. */
const MTT_FEATURES: FeatureOption[] = [
  { key: 'all_in_or_fold', label: 'All-in or Fold', match: ['all_in_or_fold'] },
  { key: 'private_mtt', label: 'Private MTT', match: ['is_private'] },
  { key: 'bounty', label: 'Bounty', match: ['is_bounty', 'is_pko', 'is_mystery_bounty'] },
  { key: 'vip', label: 'VIP', match: ['vip_only'] },
  { key: 'pc_emulator', label: 'PC Emulator Restriction', match: ['block_emulator'] },
];

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

export const FILTER_SPECS: Record<Exclude<FilterGameType, 'ALL'>, GameFilterSpec> = {
  HOLDEM: {
    games: [
      { key: 'nlh', label: 'NLH' },
      { key: 'flh', label: 'FLH' },
      { key: 'short_deck', label: '6+' },
    ],
    range: BLIND_RANGE,
    statuses: CASH_STATUSES,
    seats: { min: 2, max: 9 },
    seatsLabel: 'Table Size',
    features: CASH_FEATURES,
  },
  OMAHA: {
    // No "Games:" row on the Omaha reference screen - the Omaha tab already IS
    // the variant selection, and the lobby has no sub-variant chips for it.
    range: BLIND_RANGE,
    statuses: CASH_STATUSES,
    seats: { min: 2, max: 9 },
    seatsLabel: 'Table Size',
    features: OMAHA_FEATURES,
  },
  LIMIT: {
    // No "Games:" row - like Omaha, the Limit tab already IS the variant
    // selection (cashKind routes FLH and every fixed/mixed-limit variant
    // here), and inventing sub-variant chips without a reference screen
    // risks hiding real tables behind keys variantKey has not learnt.
    range: BLIND_RANGE,
    statuses: CASH_STATUSES,
    seats: { min: 2, max: 9 },
    seatsLabel: 'Table Size',
    features: CASH_FEATURES,
  },
  MTT: {
    games: [
      { key: 'nlh', label: 'NLH' },
      { key: 'plo4', label: 'OMAHA 4c' },
      { key: 'plo5', label: 'OMAHA 5c' },
      { key: 'plo6', label: 'OMAHA 6c' },
      { key: 'short_deck', label: '6+' },
      { key: 'plo8', label: 'OMAHA Hi/Lo' },
      { key: 'plo_high', label: 'OMAHA High' },
    ],
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
    games: [
      { key: 'nlh', label: 'NLH' },
      { key: 'plo4', label: 'PLO 4c' },
      { key: 'plo5', label: 'PLO 5c' },
      { key: 'plo6', label: 'PLO 6c' },
    ],
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
    games: [
      { key: 'nlh', label: 'NLH' },
      { key: 'plo4', label: 'PLO 4c' },
      { key: 'plo5', label: 'PLO 5c' },
      { key: 'plo6', label: 'PLO 6c' },
      { key: 'short_deck', label: '6+' },
    ],
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
function variantKey(raw: string | null | undefined): string {
  const v = String(raw ?? '').toLowerCase();
  if (!v) return '';
  if (v.includes('plo8') || v.includes('hi/lo') || v.includes('hilo')) return 'plo8';
  if (v.includes('plo6')) return 'plo6';
  if (v.includes('plo5')) return 'plo5';
  if (v.includes('plo4') || v === 'plo') return 'plo4';
  if (v.includes('short') || v === '6+') return 'short_deck';
  if (v.includes('flh') || v.includes('limit holdem')) return 'flh';
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
    // An UNRECOGNISED variant passes. The alternative is hiding a real table
    // because this function has not learnt its name yet, which is the same
    // "absence of evidence" trap the feature matcher above avoids.
    if (key && !v.games.includes(key)) return false;
  }

  // ── Format chips (SN only: satellite vs regular) ─────────────────────────
  if (v.format.length > 0) {
    const name = String(r.name ?? '').toLowerCase();
    const isSat = name.includes('sat') || r.row.is_satellite === true;
    const wantsSat = v.format.includes('sats');
    const wantsReg = v.format.includes('regular');
    // Both selected is the same as neither: no opinion.
    if (wantsSat !== wantsReg) {
      if (wantsSat && !isSat) return false;
      if (wantsReg && isSat) return false;
    }
  }

  // ── Price range (blinds for cash, total buy-in for tournaments) ──────────
  const price = Number(r.price);
  if (Number.isFinite(price) && price > 0) {
    if (v.selectedRanges && v.selectedRanges.length > 0) {
      const matchesPreset = spec.range.presets.some((p) => {
        if (!v.selectedRanges!.includes(p.key)) return false;
        return price >= p.min && price <= p.max;
      });
      if (!matchesPreset) return false;
    } else {
      if (price < v.rangeMin || price > v.rangeMax) return false;
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
