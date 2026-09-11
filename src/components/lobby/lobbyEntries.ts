/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LOBBY ENTRIES — the thin view-model layer for the line-based lobby (V2)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Normalizes cash tables and tournaments (MTT / Spin / Heads-Up SNG) into a
 * single `LobbyEntry` shape the dense lobby table and the Casino Plaque both
 * read. This is PRESENTATION normalization only — it never replaces the domain
 * rows, which travel alongside on `.raw` so actions (waitlist, register,
 * quick-join) keep receiving exactly what they always received.
 *
 * RULE MEDALLIONS: a medallion is only emitted when the REAL game configuration
 * says the rule is on (TableSettings flags, tournament columns). The name-text
 * fallbacks mirror what DynamicGameCard already shipped — they are existing
 * platform behavior, not new inference.
 */

import { FREE_BUY_HELPER, FREE_BUY_LABEL } from '../../utils/freeBuy';
import { formatGameTitle } from '../../utils/formatGameTitle';
import { isInLateRegistration, STARTING_SOON_WINDOW_MINUTES } from '../../utils/tournamentFilters';
import { stakesLabel as stakesLabelFor } from '../../lib/bettingStructure';
import {
  blindLevelAt,
  blindLevelMinutes,
  parseBlindStructure,
  tournamentLevel,
} from './tournamentFigures';
import { cashBuyInLabel, cashBuyInRange } from '../../lib/cashBuyIn';
import { spinMultiplierLabel } from '../../utils/spinReveal';
import { lateRegEndMs } from './lateRegWindow';
import { SPIN_TIERS } from '../../config/spinSpec';
import { CASH_TEMPLATES } from '../../config/cashGames';

// ─── Raw row shapes (subset the lobby queries actually select) ─────────────
/* Extends CashFeatureSource so the medallion columns travel on the same row
   the lobby already fetches. Interfaces hoist, so the declaration below is in
   scope here. */
export interface LobbyTableRow extends CashFeatureSource {
  id: string;
  name: string;
  game_variant: string;
  stakes?: string;
  small_blind: number;
  big_blind: number;
  min_buy_in: number;
  max_buy_in: number;
  current_players: number;
  max_players: number;
  status: string;
  /* ── LOBBY FLAGS ────────────────────────────────────────────────────────
     `is_private` is deliberately absent: it does not decorate a row, it
     decides whether the row is returned at all (fn_club_home_in_scope). A
     private table the viewer may not see never reaches this type. */
  is_vip_only?: boolean | null;
  label_as_new?: boolean | null;
  is_featured?: boolean | null;
  hide_club_name?: boolean | null;
  settings?: unknown;
  /* ── THE GAME THIS TABLE BELONGS TO (Operation Table Stakes) ───────────
     Null on a pre-cutover fleet table. On a cluster table get_club_home also
     carries the GAME-wide figures, because R10 (Dan 2026-09-04) says a
     must-move game counts its players like a tournament - "0/6 should never
     be a thing" - and the board shows one row per game, never per table. */
  cluster_id?: string | null;
  role?: 'main' | 'feeder' | null;
  main_index?: number | null;
  lifecycle?: string | null;
  cluster_must_move?: boolean | null;
  cluster_template?: string | null;
  cluster_state?: string | null;
  cluster_players?: number | null;
  cluster_tables?: number | null;
  /**
   * `cash_games.enabled`, when the read carried it (the club-home chain embeds
   * the game row). A disabled game is not taking players: its door,
   * fn_cash_game_join, refuses with GAME_CLOSED, so the board says Closed
   * rather than offering a Join that can only fail.
   */
  cluster_enabled?: boolean | null;
  /** Selected by realtime payloads; the fetches filter it to false and omit it. */
  is_deleted?: boolean | null;
}

export interface LobbyTournamentRow {
  id: string;
  name: string;
  game_type: string;
  buy_in_amount: number;
  buy_in_fee: number;
  guaranteed_prize: number | null;
  start_time: string;
  status: string;
  current_players: number;
  max_players: number;
  starting_chips: number;
  late_reg_mins?: number | null;
  late_reg_levels?: number | null;
  started_at?: string | null;
  current_level?: number | null;
  /**
   * JSON text. MTT and SNG rows write `durationMinutes`; Spin rows write
   * `duration` in SECONDS (TournamentRecurringService.createSpin). Read both —
   * see blindLevelMinutes in tournamentFigures.
   */
  blind_structure?: string | null;
  level_started_at?: string | null;
  /**
   * Drawn at START, never at creation (TournamentManagerBase). A registering
   * Spin carries null here by design, which is why the card advertises the
   * ladder ceiling until the wheel has actually turned.
   */
  spin_multiplier?: number | null;
  /**
   * For a Spin this is `buy_in_amount x spin_multiplier`, written at start
   * beside the multiplier — so it is exactly as secret as the multiplier is,
   * and it goes through the same reveal gate. Before the draw it is 0.
   */
  prize_pool?: number | null;
  /**
   * Bounty facts, selected since 2026-08-25 so the shared buy-in card can show
   * the same Bounty row here that it shows on the tournament details page.
   * They were read through `as any` casts before the columns were in the
   * SELECT at all, so the row silently rendered without them.
   */
  is_bounty?: boolean | null;
  bounty_amount?: number | null;
  is_pko?: boolean | null;
  is_mystery_bounty?: boolean | null;
  /* Same four flags as a cash row, plus is_pinned, which is what actually
     holds a tournament at the top of the board. */
  is_vip_only?: boolean | null;
  label_as_new?: boolean | null;
  hide_club_name?: boolean | null;
  is_pinned?: boolean | null;
}

// ─── View model ────────────────────────────────────────────────────────────
export type LobbyEntryKind = 'cash' | 'mtt' | 'spin' | 'sng';

export type LobbyStatusKey =
  | 'open'
  | 'full'
  | 'waitlist'
  | 'registering'
  | 'late_reg'
  | 'starting_soon'
  | 'running'
  | 'completed'
  | 'closed';

export interface RuleMedallion {
  key: string;
  /** Short label on the medallion, e.g. "RUN IT TWICE". */
  label: string;
  /** Small secondary value, e.g. "10%" for bomb pot frequency. */
  detail?: string;
  /** Tooltip / accessible explanation. */
  tip: string;
}

export interface LobbyEntry {
  id: string;
  kind: LobbyEntryKind;
  name: string;
  /** Short game label, e.g. "NLH", "PLO5". */
  gameLabel: string;
  /** Long variant name, e.g. "No Limit Hold'em". */
  variantLabel: string;
  /** "$1 / $2" for cash; null for tournaments. */
  stakesLabel: string | null;
  stakesValue: number; // big blind (cash) or total buy-in (tournament) — numeric sort key
  buyInLabel: string;
  buyInValue: number;
  guaranteeLabel: string | null;
  guaranteeValue: number;
  players: number;
  capacity: number;
  /**
   * Set on the ONE row a must-move game gets on the board (R10). `players`
   * is then the count inside the whole game and `capacity` is 0: the game
   * has no ceiling a single table would have, and the meter must never print
   * "x/6" for it. `tables` is how many are open right now.
   */
  game?: {
    id: string;
    mustMove: boolean;
    template: string | null;
    tables: number;
    state: string | null;
  };
  startTime: string | null;
  startValue: number; // ms epoch, Infinity when none — numeric sort key
  speedLabel: string | null;
  status: LobbyStatusKey;
  statusLabel: string;
  live: boolean;
  rules: RuleMedallion[];
  /**
   * The lobby-only flags, resolved once so no renderer has to know which
   * column a kind keeps them in. `featured` and `isNew` decorate; `vipOnly`
   * also GATES, and the gate is enforced server-side (see the VIP check in
   * atomic_table_buyin) — this is only the sign on the door.
   *
   * `hideClubName` is carried rather than applied here because whether a club
   * name is shown at all depends on the BOARD: a single-club lobby never
   * prints one, a union board does.
   */
  featured: boolean;
  isNew: boolean;
  vipOnly: boolean;
  hideClubName: boolean;
  /**
   * The owning club's name, but ONLY when it is worth printing: a union board
   * showing another club's game, with `hide_club_name` off. Null everywhere
   * else, including on every single-club board — repeating the name of the
   * club you are standing in on all 46 of its rows is noise.
   *
   * Filled in by the page (which knows which club is being viewed), not by the
   * adapters, which see one row at a time and have no board to compare it to.
   */
  clubLabel: string | null;
  raw: LobbyTableRow | LobbyTournamentRow;
}

/**
 * Names the owning club on an entry, for a board that mixes clubs.
 *
 * Returns the SAME object when there is nothing to add, so the page's entry
 * identity cache is not defeated by a pass that changes nothing — which is the
 * common case, since most clubs are in no union.
 */
export function withClubLabel(
  entry: LobbyEntry,
  viewingClubId: string | null | undefined,
  clubNames: Record<string, string>
): LobbyEntry {
  if (entry.hideClubName) return entry;
  const owner = (entry.raw as { club_id?: string | null }).club_id;
  if (!owner || !viewingClubId || owner === viewingClubId) return entry;
  const name = clubNames[owner];
  if (!name) return entry;
  return { ...entry, clubLabel: name };
}

/** True for the handful of flags that read as decoration on any kind of row. */
function lobbyFlags(r: {
  is_vip_only?: boolean | null;
  label_as_new?: boolean | null;
  is_featured?: boolean | null;
  is_pinned?: boolean | null;
  hide_club_name?: boolean | null;
}) {
  return {
    /* A cash table is featured by `is_featured`; a tournament by `is_pinned`,
       which is the column TournamentPage already sorts on. Two names, one
       meaning — resolved here so the board does not have to branch. */
    featured: r.is_featured === true || r.is_pinned === true,
    isNew: r.label_as_new === true,
    vipOnly: r.is_vip_only === true,
    hideClubName: r.hide_club_name === true,
  };
}

// ─── Display maps (lobby-canonical; DynamicGameCard keeps its legacy copy) ──
const VARIANT_LABELS: Record<string, { short: string; long: string }> = {
  nlh: { short: 'NLH', long: "No Limit Hold'em" },
  plo4: { short: 'PLO', long: 'Pot Limit Omaha' },
  plo5: { short: 'PLO5', long: 'Pot Limit Omaha 5' },
  plo6: { short: 'PLO6', long: 'Pot Limit Omaha 6' },
  plo8: { short: 'PLO8', long: 'Pot Limit Omaha Hi-Lo' },
  /* Long name corrected 2026-09-01: the engine deals CRAZY Pineapple (the
     discard is after the flop). The short code stays PNPL - it is a compact
     column label, not a sentence, and the lobby's own filters key on it. */
  pineapple: { short: 'PNPL', long: 'Crazy Pineapple' },
  short_deck: { short: '6+', long: 'Short Deck' },
  /* OFC removed 2026-08-23. Open Face Chinese is a card-PLACEMENT game with no
     betting rounds and no board; this platform has never dealt one. Every row
     that carried `ofc_pineapple` was a Crazy Pineapple table wearing the wrong
     label - all of them NAMED "Pineapple", all with flop/turn/river streets,
     and HorseFleetManager's own comment called them legacy drift. The bare
     `ofc` variant was never used by a single row. Relabelled by migration
     20260823_retire_ofc_pineapple_variant.sql. */
  // Limit family (the LIMIT lobby category classifies on these strings)
  flh: { short: 'FLH', long: "Fixed Limit Hold'em" },
  limit_holdem: { short: 'FLH', long: "Fixed Limit Hold'em" },
  flo8: { short: 'FLO8', long: 'Fixed Limit Omaha Hi-Lo' },
  limit_omaha: { short: 'FLO', long: 'Fixed Limit Omaha' },
};

const TOURNEY_VARIANT_KEYS: Record<string, string> = {
  NLH: 'nlh',
  PLO4: 'plo4',
  PLO5: 'plo5',
  PLO6: 'plo6',
  PLO8: 'plo8',
  PINEAPPLE: 'pineapple',
  /* `tournaments.game_type` still ships OFC_PINEAPPLE across the live census
     (advancedFilterSpec records it), because migration
     20260823_retire_ofc_pineapple_variant.sql retired the variant on
     public.tables ONLY. Without a key here variantDisplay fell through to its
     fallback and the Game Type column printed the raw enum: "OFC_PINEAPPLE". */
  OFC_PINEAPPLE: 'pineapple',
  SHORT_DECK: 'short_deck',
  PLO: 'plo4',
  /* LIMIT (2026-08-31). Limit tournaments became creatable the day these were
     added; without a key here `variantDisplay` falls through to its own
     fallback and prints the raw enum as BOTH labels, so a Fixed Limit Hold'em
     event would have read "FLH" / "FLH" on the card instead of
     "FLH" / "Fixed Limit Hold'em" — the identical defect this map already
     records for OFC_PINEAPPLE. The two legacy spellings are here for the same
     reason `variantKey` still folds them: a row written before the `flh` /
     `flo8` names settled must still be able to name its own game. */
  FLH: 'flh',
  FLO8: 'flo8',
  LIMIT_HOLDEM: 'flh',
  LIMIT_OMAHA: 'flo8',
};

/**
 * A chip total, printed to the cent only when it HAS cents.
 *
 * Tournament prices are whole by construction (splitBuyIn keeps the total
 * whole and takes the fee out of it), but a buy-in plus a fractional fee can
 * land on 1.10, and rounding that to "1" understates what the player pays.
 */
export function formatChipTotal(n: number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  const rounded = Math.round(v * 100) / 100;
  return Number.isInteger(rounded)
    ? rounded.toLocaleString('en-US')
    : rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function variantDisplay(variant?: string): { short: string; long: string } {
  const key = (variant || '').toLowerCase();
  return (
    VARIANT_LABELS[key] ||
    VARIANT_LABELS[TOURNEY_VARIANT_KEYS[(variant || '').toUpperCase()] || ''] || {
      short: (variant || 'NLH').toUpperCase(),
      long: variant || "No Limit Hold'em",
    }
  );
}

// ─── Settings parsing (string-or-object, same tolerance as the cards) ──────
export function parseTableSettings(settings: unknown): Record<string, unknown> {
  if (!settings) return {};
  if (typeof settings === 'string') {
    try {
      return JSON.parse(settings) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof settings === 'object') return settings as Record<string, unknown>;
  return {};
}

const on = (s: Record<string, unknown>, ...keys: string[]) => keys.some((k) => s[k] === true);
const num = (s: Record<string, unknown>, ...keys: string[]): number | null => {
  for (const k of keys) {
    const v = Number(s[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
};

// ─── Cash rule medallions — driven by the REAL table configuration ─────────
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS READS COLUMNS AND NOT `settings` (Dan 2026-08-25)
 * ───────────────────────────────────────────────────────────────────────────
 * "you need to add any table specifics and attributes tags next to the buy in
 *  ... Not one NLH table has this currently." Not one PLO table either.
 *
 * The medallions were already being rendered. They were reading the wrong
 * place. Every one of the 46 live cash tables carries `settings = {}` — an
 * empty object — because TableConfigPage writes the host's choices to
 * top-level COLUMNS on `tables`, and only CreateTableModal ever wrote the JSON
 * blob. So `parseTableSettings` returned {} and every medallion was false, on
 * every table, forever. Measured on production 2026-08-25: 43 of 46 tables run
 * it twice, 3 offer insurance, 1 runs bomb pots — and the lobby showed none of
 * it.
 *
 * The columns are also TRIPLICATED (`run_it_twice` / `run_it_twice_enabled` /
 * `allow_run_it_twice`; `straddle_enabled` / `allow_straddle` /
 * `enable_straddle`) and they DISAGREE on live rows.
 *
 * 2026-08-29: the bomb-pot pair named here is GONE. This comment was the
 * evidence that `bomb_pot_enabled` and `bomb_pots` disagreed, and measuring it
 * settled the argument — `bomb_pots` was false on both of the only two
 * bomb-pot tables on the platform and true on none of 97,944 rows, so it said
 * "no bomb pots here" about every table that had them. Nothing wrote it and
 * nothing read it, so it was DROPPED rather than repaired: a second spelling of
 * a boolean has no correct value, only a currently-less-wrong one.
 * `bomb_pot_enabled` is now the only spelling.
 *
 * So a card cannot pick a spelling and hope. Each predicate below
 * is the one the game server itself evaluates, cited to the line, because the
 * only defensible thing for a lobby to print is what the engine will actually
 * do when you sit down.
 *
 * Settings-blob keys are still read as a fallback, so a table created through
 * CreateTableModal (which does write JSON) keeps working.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface CashFeatureSource {
  /* The engine's own select list — server/src/services/supabase/tables.ts. */
  run_it_twice?: boolean | null;
  run_it_twice_enabled?: boolean | null;
  allow_run_it_twice?: boolean | null;
  insurance_enabled?: boolean | null;
  straddle_enabled?: boolean | null;
  straddle_type?: string | null;
  auto_utg_straddle?: boolean | null;
  bomb_pot_enabled?: boolean | null;
  bomb_pot_frequency?: number | null;
  bomb_pot_double_board?: boolean | null;
  /* BOMB POT STANDARDIZATION 2026-08-27: canonical board count (1-3) and
     trigger mode ('every_n_hands' | 'once_per_orbit' | 'timed' |
     'bomb_pot_only'), plus the timed interval. */
  bomb_pot_board_count?: number | null;
  bomb_pot_trigger_mode?: string | null;
  bomb_pot_interval_seconds?: number | null;
  /** VARIANT OVERRIDE (spec §10.1): the bomb hand's game when it differs. */
  bomb_pot_variant?: string | null;
  /** Lobby ante disclosure (spec §15.1): BB multiple and fixed override. */
  bomb_pot_ante_multiplier?: number | null;
  bomb_pot_ante_fixed?: number | null;
  ante_enabled?: boolean | null;
  ante?: number | null;
  seven_deuce_enabled?: boolean | null;
  seven_deuce_amount?: number | null;
  time_bank_enabled?: boolean | null;
  all_in_or_fold?: boolean | null;
  /* Shipped by get_club_home since 2026-08-25. Every one of these was already
     written by the table creation page and enforced by the engine; the lobby
     simply never received them, so a Cap table and an uncapped one looked
     identical on the board. */
  cap_enabled?: boolean | null;
  cap_bb?: number | null;
  no_rathole?: boolean | null;
  pineapple_holdem?: boolean | null;
  is_anonymous?: boolean | null;
  restrict_observers?: boolean | null;
  /* NIT GAME. The switch, then the three numbers it governs. */
  nit_game?: boolean | null;
  maintain_percent_min?: number | null;
  maintain_hands?: number | null;
  career_percent_min?: number | null;
  /**
   * Legacy JSONB. All 50 live tables carry `{}` and get_club_home stopped
   * sending it on 2026-08-25 - the fields are columns now. Kept optional
   * because other callers (TableService's `select('*')`) still hand it over,
   * and parseTableSettings still reads it as a last-resort fallback.
   */
  settings?: unknown;
}

/** A tri-state column: true / false / absent. Absent is NOT false. */
const col = (v: unknown): boolean | undefined =>
  v === true ? true : v === false ? false : undefined;

export function cashRuleMedallions(row: CashFeatureSource): RuleMedallion[] {
  const s = parseTableSettings(row.settings);
  const rules: RuleMedallion[] = [];

  /* ServerTableEngineBase: `(run_it_twice ?? true) && (allow_run_it_twice ??
     true) || run_it_twice_enabled`, and then `&& !insurance_enabled` —
     insurance takes priority and silently switches RIT off. A card that
     printed both would be promising something the table will refuse. */
  const insurance = col(row.insurance_enabled) ?? on(s, 'insurance_enabled', 'allInInsurance');
  const ritConfigured =
    ((col(row.run_it_twice) ?? true) && (col(row.allow_run_it_twice) ?? true)) ||
    (col(row.run_it_twice_enabled) ?? false) ||
    on(s, 'run_it_twice', 'runItTwice');

  if (insurance) {
    rules.push({
      key: 'insurance',
      label: 'INSURANCE',
      tip: 'All-in insurance is offered here. Insurance and run it twice cannot both be on, so this table does not run it twice',
    });
  } else if (ritConfigured) {
    rules.push({
      key: 'rit',
      label: 'RUN IT TWICE',
      /* No ALWAYS variant. `run_it_mode` has the values 'mandatory_twice' and
         'mandatory_three', but nothing in the engine reads that column — the
         runout always asks and always needs every all-in player to agree. A
         MANDATORY badge would describe a feature the platform does not have. */
      tip: 'All-in players may agree to run the remaining cards more than once',
    });
  }

  /* ServerTableEngineDealing / ServerTableEngineSeating both gate on
     `straddle_enabled` alone, and refuse a straddle when it is false. On every
     live row today that column is false while `allow_straddle` and
     `enable_straddle` are true — the club-level and legacy spellings, which
     the engine never loads. Reading those would put a STRADDLE chip on 46
     tables that reject a straddle. */
  if (col(row.straddle_enabled) ?? on(s, 'straddle_enabled', 'straddle')) {
    const auto = col(row.auto_utg_straddle) === true;
    rules.push({
      key: 'straddle',
      label: auto ? 'AUTO STRADDLE' : 'STRADDLE',
      tip: auto
        ? 'Under the gun posts a straddle every hand'
        : 'Players may straddle from under the gun',
    });
  }

  /* `bomb_pot_enabled` with a frequency of 0 deals no bomb pots in the legacy
     every-N-hands mode — the engine requires both. BOMB POT STANDARDIZATION
     2026-08-27 (spec §15.1): the other trigger modes carry their own cadence,
     so each mode gets its own badge detail — players must see the bomb
     frequency, board count and mode BEFORE they sit. */
  const bombOn = col(row.bomb_pot_enabled) ?? on(s, 'bomb_pot_enabled', 'bombPot');
  const bombFreq =
    Number(row.bomb_pot_frequency) || num(s, 'bomb_pot_frequency', 'bombPotFrequency') || 0;
  const bombMode =
    (typeof row.bomb_pot_trigger_mode === 'string' && row.bomb_pot_trigger_mode) ||
    (typeof s.bomb_pot_trigger_mode === 'string' && s.bomb_pot_trigger_mode) ||
    'every_n_hands';
  const bombBoards =
    Number(row.bomb_pot_board_count) ||
    num(s, 'bomb_pot_board_count') ||
    (col(row.bomb_pot_double_board) === true || s.bomb_pot_double_board === true ? 2 : 1);
  const bombIntervalMin = Math.round(
    (Number(row.bomb_pot_interval_seconds) || num(s, 'bomb_pot_interval_seconds') || 0) / 60
  );
  const bombModeLive =
    bombMode === 'bomb_pot_only' ||
    bombMode === 'once_per_orbit' ||
    (bombMode === 'timed' && bombIntervalMin > 0) ||
    (bombMode === 'every_n_hands' && bombFreq > 0);
  if (bombOn && bombModeLive) {
    // VARIANT OVERRIDE (spec §10.1/§15.1): "NLH • PLO4 bomb pots" must be
    // visible before a player sits. Named in the tip when set.
    const bombVariant =
      (typeof row.bomb_pot_variant === 'string' && row.bomb_pot_variant) ||
      (typeof s.bomb_pot_variant === 'string' && s.bomb_pot_variant) ||
      '';
    const variantTip = bombVariant ? `, played as ${bombVariant.toUpperCase()}` : '';
    // Ante disclosure (spec §15.1): a fixed amount wins over the BB multiple.
    const bombAnteFixed = Number(row.bomb_pot_ante_fixed) || num(s, 'bomb_pot_ante_fixed') || 0;
    const bombAnteBB =
      Number(row.bomb_pot_ante_multiplier) ||
      num(s, 'bomb_pot_ante_multiplier', 'bomb_pot_ante_bb') ||
      0;
    const anteTip =
      bombAnteFixed > 0
        ? `, ${bombAnteFixed.toLocaleString()} ante`
        : bombAnteBB > 0
          ? `, ${bombAnteBB}x BB ante`
          : '';
    const boardsTip =
      (bombBoards >= 3
        ? ', dealt on three boards'
        : bombBoards === 2
          ? ', dealt on two boards'
          : '') +
      variantTip +
      anteTip;
    const byMode: Record<string, { label: string; detail?: string; tip: string }> = {
      every_n_hands: {
        label: 'BOMB POTS',
        detail: `1 IN ${bombFreq}`,
        tip: `A bomb pot every ${bombFreq} hands${boardsTip}`,
      },
      once_per_orbit: {
        label: 'BOMB POTS',
        detail: 'EVERY ORBIT',
        tip: `A bomb pot once per dealer-button orbit${boardsTip}`,
      },
      timed: {
        label: 'BOMB POTS',
        detail: `EVERY ${bombIntervalMin} MIN`,
        tip: `A bomb pot every ${bombIntervalMin} minutes${boardsTip}`,
      },
      bomb_pot_only: {
        label: 'BOMB POT ONLY',
        /* Two boards is what a bomb pot IS here, so saying it tells the player
           nothing they did not already know (Dan 2026-09-07, item 7D: "because
           all bomb pots are double board, it doesn't need to say double
           board"). Three is a real departure from the default, so three still
           speaks. The tip below still spells the board count out for anyone
           who wants the number. */
        detail: bombBoards >= 3 ? 'TRIPLE BOARD' : undefined,
        tip: `Every hand is a bomb pot${boardsTip}`,
      },
    };
    const b = byMode[bombMode] ?? byMode.every_n_hands;
    rules.push({ key: 'bomb', label: b.label, detail: b.detail, tip: b.tip });
  }

  if (col(row.ante_enabled) ?? on(s, 'ante_enabled')) {
    const amt = Number(row.ante) || num(s, 'ante_amount') || 0;
    rules.push({
      key: 'ante',
      label: 'ANTE',
      detail: amt > 0 ? amt.toLocaleString() : undefined,
      tip: amt > 0 ? `Every player antes ${amt.toLocaleString()} a hand` : 'Antes are in play',
    });
  }

  if (col(row.seven_deuce_enabled) ?? on(s, 'seven_deuce_enabled')) {
    const amt = Number(row.seven_deuce_amount) || num(s, 'seven_deuce_amount') || 0;
    rules.push({
      key: 'seven_deuce',
      label: 'SEVEN DEUCE',
      detail: amt > 0 ? amt.toLocaleString() : undefined,
      tip: 'Win with seven-deuce and every player pays you a bonus',
    });
  }

  if (col(row.time_bank_enabled) ?? on(s, 'time_bank_enabled')) {
    rules.push({
      key: 'time_bank',
      label: 'TIME BANK',
      tip: 'Extra time is available for a big decision',
    });
  }

  if (col(row.all_in_or_fold) === true) {
    rules.push({
      key: 'all_in_or_fold',
      label: 'ALL IN OR FOLD',
      tip: 'The only actions are all in and fold',
    });
  }

  /* ── THE FOUR THAT BECAME REAL (2026-08-25) ─────────────────────────────
     Each of these was on the "deliberately not here" list below until the
     engine or the seat sale actually started enforcing it. They are cited to
     their enforcer, and each comes back only because a player who reads the
     chip and sits down will now get what it promised. */

  /* ServerTableEngineTurns: a bet is clamped to cap_bb big blinds once
     cap_enabled is on. */
  if (col(row.cap_enabled) === true) {
    const capBB = Number(row.cap_bb) || 0;
    rules.push({
      key: 'cap',
      label: 'CAP',
      detail: capBB > 0 ? `${capBB}BB` : undefined,
      tip:
        capBB > 0
          ? `Betting is capped at ${capBB} big blinds a hand`
          : 'Betting is capped each hand',
    });
  }

  /* CHIP CONTINUITY (2026-09-04): there is no medallion for the rejoin
     floor any more, because it is no longer a per-table feature. Every cash
     table carries it (OPORD 1.3 section 6.1: no badge, no lobby tag). */

  /* ServerTableEngineBase.dealtGameVariant maps a Hold'em table with this
     column on to a three-card Pineapple deal. */
  if (col(row.pineapple_holdem) === true) {
    rules.push({
      key: 'pineapple',
      label: 'PINEAPPLE',
      tip: 'Three cards are dealt and one is discarded after the flop',
    });
  }

  /* EngineWebSocketServer refuses an observer socket when this is on. */
  if (col(row.restrict_observers) === true) {
    rules.push({
      key: 'restrict_observers',
      label: 'NO RAILBIRDS',
      tip: 'Only seated players may watch this table',
    });
  }

  /* NIT GAME. fn_nit_check is the enforcer: career VPIP at the door
     (atomic_table_buyin) and table VPIP between hands (fn_nit_evictions, read
     by the dealing loop). The chip states the numbers rather than just the
     name, because "NIT GAME" alone tells a player nothing about whether they
     would survive it. The switch is the master: with it off the three numbers
     do nothing, so a table carrying stale numbers must not advertise them. */
  if (col(row.nit_game) === true) {
    const career = Number(row.career_percent_min) || 0;
    const maintain = Number(row.maintain_percent_min) || 0;
    const hands = Number(row.maintain_hands) || 0;
    const parts: string[] = [];
    if (career > 0) parts.push(`${career}% career`);
    if (maintain > 0) parts.push(`${maintain}% here`);
    rules.push({
      key: 'nit_game',
      label: 'NIT GAME',
      detail: parts.length ? parts.join(' / ') : undefined,
      tip:
        parts.length === 0
          ? 'This table penalises tight play'
          : [
              career > 0 ? `A career VPIP of ${career}% or more is needed to take a seat` : '',
              maintain > 0
                ? `Play under ${maintain}% VPIP over ${hands || 10} hands here and you are stood up`
                : '',
            ]
              .filter(Boolean)
              .join('. '),
    });
  }

  /* The engine substitutes seat aliases for names at an anonymous table. */
  if (col(row.is_anonymous) === true) {
    rules.push({
      key: 'anonymous',
      label: 'ANONYMOUS',
      tip: 'Player names are hidden at this table',
    });
  }

  /* NO "DOUBLE BOARD" MEDALLION (removed 2026-09-07, Dan item 7D).
     It was the same default restated a second time: a table with bomb pots
     already shows a BOMB POTS medallion, and every bomb pot on this platform
     runs two boards, so this chip spent a slot in a crowded row telling the
     player something that is true of every bomb pot they will ever sit in.
     A TRIPLE BOARD table is genuinely different and still says so, from the
     bomb medallion above.

     The flag itself is untouched and still read everywhere it means something
     - the board count in the rules modal, the second board on the felt, the
     filters. This is a copy rule about a badge, not a change to the game. */

  /* ── FOUR MEDALLIONS DELIBERATELY NOT HERE ──────────────────────────────
     Dan asked for VPIP and for a minimum-hands rule, and the honest answer is
     that this platform does not have either yet:

       CALL TIME   - `calltime_enabled` has no reader anywhere, and the old
                     medallion read `call_time_enabled`, a name that is not
                     even a column.

     VPIP AND MIN HANDS LEFT THIS LIST on 2026-08-25. They were never a chip of
     their own: they are the NIT GAME rule, which now has an enforcer at the
     door (atomic_table_buyin, career VPIP) and one between hands
     (fn_nit_evictions, VPIP at this table over maintain_hands). The chip above
     prints the actual thresholds, because "NIT GAME" on its own tells a player
     nothing about whether they would survive it.

     NO RATHOLE LEFT THIS LIST on 2026-08-25, when atomic_table_buyin started
     enforcing it. That is the bar: a chip appears the day something refuses to
     let a player do the thing the chip forbids, and not a day earlier.

     They come back the moment the engine enforces them, and not before: a
     lobby chip is a promise about what happens when you sit down.

     The name-substring fallbacks are gone with them. A table CALLED
     "NLH 25/50 INSURANCE TEST" whose insurance column is off is a
     misconfigured table, not an insurance table, and guessing from its title
     is how the lobby ends up disagreeing with the felt. */
  return rules;
}

// ─── Tournament trait medallions — from real columns + house name convention ─
function detectTourneyType(name: string): string {
  const l = (name || '').toLowerCase();
  /* SATELLITE IS DECIDED FIRST (2026-09-03). First match wins here, and
     'satellite' used to be tested LAST - which was harmless while every
     satellite was named "Satellite to X", and wrong the moment a feeder
     carried its TARGET's name. The satellite heads-ups added today are named
     "<target> Satellite Heads-Up", so a feeder into "Saturday Mystery"
     resolved to 'mystery' and into "Friday Fight Night PKO" to 'pko': the
     SATELLITE badge - the one fact that makes the prize a SEAT rather than
     chips - was dropped, and a bounty medallion the row's own is_bounty and
     is_pko columns say is false was pushed in its place.

     A satellite that also carries a real bounty flag still shows the bounty
     medallion: those come from the COLUMNS below, which outrank this. */
  if (l.includes('satellite')) return 'satellite';
  if (l.includes('freeroll') || l.includes('free roll')) return 'freeroll';
  if (l.includes('mystery')) return 'mystery';
  if (l.includes('pko') || l.includes('progressive')) return 'pko';
  if (l.includes('bounty') || l.includes('ko ')) return 'ko';
  return 'freezeout';
}

export function tournamentSpeed(name: string): string | null {
  const l = (name || '').toLowerCase();
  /* A FEEDER DOES NOT INHERIT ITS TARGET'S SPEED (2026-09-03). This reads the
     name, and a satellite heads-up is named after the event it feeds - so
     "Sunday $200 Deep Stack Satellite Heads-Up" read as 'Deepstack' while
     actually running a 300-chip turbo stack on three-minute levels, and the
     target's own Satellites tab called the same game "Hyper". Two surfaces,
     two labels, neither true. The word that describes the TARGET is dropped
     from the part of the name after "satellite"; what is left is the feeder's
     own speed if it names one, and stackDepthLabel's structural read if not. */
  const own = l.includes('satellite') ? l.slice(l.indexOf('satellite')) : l;
  if (own.includes('hyper')) return 'Hyper';
  if (own.includes('turbo')) return 'Turbo';
  if (own.includes('deep')) return 'Deepstack';
  return null;
}

export function tournamentMedallions(t: LobbyTournamentRow): RuleMedallion[] {
  const rules: RuleMedallion[] = [];
  const type = detectTourneyType(t.name);
  const l = (t.name || '').toLowerCase();
  /* THE COLUMNS OUTRANK THE NAME (2026-08-26). is_pko, is_bounty and
     is_mystery_bounty are selected and were declared on the row type, and this
     function read none of them - it substring-matched the title instead. A PKO
     called "Sunday Special" therefore carried a FREEZEOUT medallion, which is
     the opposite of the truth, and with the Rules column gone from the board
     the game panel is the only place that says so at all. The name convention
     stays as a fallback for a tournament whose flags were never set. */
  const isPko = t.is_pko === true || type === 'pko';
  const isMystery = t.is_mystery_bounty === true || type === 'mystery';
  const isBounty = t.is_bounty === true || Number(t.bounty_amount) > 0 || type === 'ko';

  /* FREEROLLS ARE FREE BUY (Dan 2026-09-02): the medallion names the deal a
     freeroll always carries - free to enter, 1-chip rebuys and add-ons. */
  if (type === 'freeroll')
    rules.push({ key: 'freeroll', label: FREE_BUY_LABEL, tip: FREE_BUY_HELPER });
  /* One medallion for the bounty family, most specific first: a PKO is a
     bounty event and a mystery bounty is a bounty event, so pushing all three
     would say the same thing three times on one card. */
  if (isPko)
    rules.push({
      key: 'pko',
      label: 'PKO',
      tip: 'Progressive knockout: half of each bounty grows your own',
    });
  else if (isMystery)
    rules.push({
      key: 'mystery',
      label: 'MYSTERY BOUNTY',
      tip: 'Knockouts award a mystery bounty draw',
    });
  else if (isBounty)
    rules.push({ key: 'bounty', label: 'BOUNTY', tip: 'A bounty is paid for every knockout' });
  if (type === 'satellite')
    rules.push({ key: 'satellite', label: 'SATELLITE', tip: 'Wins seats into a larger event' });

  // Rows fetched by the lobby query do not select these columns; rows fetched
  // by the panel's full-tournament read do. Read them loosely either way.
  const extra = t as unknown as Record<string, unknown>;
  const reentry = extra.is_reentry === true || l.includes('re-entry') || l.includes('reentry');
  const rebuy = Number(extra.rebuy_cost) > 0 || l.includes('rebuy');
  const addon = Number(extra.addon_cost) > 0;
  if (reentry)
    rules.push({ key: 'reentry', label: 'RE-ENTRY', tip: 'Eliminated players may re-enter' });
  if (rebuy) rules.push({ key: 'rebuy', label: 'REBUY', tip: 'Rebuys are available' });
  if (addon) rules.push({ key: 'addon', label: 'ADD-ON', tip: 'An add-on is available' });
  if (
    !reentry &&
    !rebuy &&
    !isPko &&
    !isMystery &&
    !isBounty &&
    type === 'freezeout' &&
    !l.includes('spin')
  )
    rules.push({ key: 'freezeout', label: 'FREEZEOUT', tip: 'One entry, no rebuys' });

  const speed = tournamentSpeed(t.name);
  if (speed === 'Turbo') rules.push({ key: 'turbo', label: 'TURBO', tip: 'Fast blind levels' });
  if (speed === 'Hyper')
    rules.push({ key: 'hyper', label: 'HYPER', tip: 'Very fast blind levels' });
  if (speed === 'Deepstack')
    rules.push({ key: 'deepstack', label: 'DEEPSTACK', tip: 'Deep starting stacks' });

  if ((Number(t.guaranteed_prize) || 0) > 0)
    rules.push({
      key: 'gtd',
      label: 'GUARANTEED',
      detail: Number(t.guaranteed_prize).toLocaleString(),
      tip: `The prize pool is guaranteed at ${Number(t.guaranteed_prize).toLocaleString()}`,
    });

  const lateMins = Number(t.late_reg_mins) || 0;
  const lateLevels = Number(t.late_reg_levels) || 0;
  if (lateMins > 0 || lateLevels > 0)
    rules.push({
      key: 'latereg',
      label: 'LATE REG',
      detail: lateLevels > 0 ? `${lateLevels} LVLS` : `${lateMins} MIN`,
      tip:
        lateLevels > 0
          ? `Late registration stays open for ${lateLevels} levels`
          : `Late registration stays open for ${lateMins} minutes`,
    });

  return rules;
}

// ─── Status derivation ─────────────────────────────────────────────────────
// One window, one constant: the badge and the "Starting Soon" filter chip
// read the same minutes so they cannot drift apart.
const STARTING_SOON_MS = STARTING_SOON_WINDOW_MINUTES * 60 * 1000;

/**
 * ── THE WAITLIST WAS HALF-BUILT (Dan 2026-08-25) ──────────────────────────
 *
 * `'waitlist'` has been in LobbyStatusKey since the lobby was written, with a
 * badge colour and a row rail in the stylesheet, and NOTHING EVER RETURNED
 * IT. Meanwhile WaitlistService is complete, the game panel offers Join and
 * Leave Waitlist, and the page already tracks `waitlistedTableIds` — so a
 * player could join a waitlist for a full table and the card would keep
 * saying, flatly, "Full".
 *
 * A full table with people waiting is a different proposition from a full
 * table nobody wants, and the number is the whole reason to join or not. It
 * is passed in rather than read off the row because it lives in its own
 * table: the lobby query fetches the counts once, for every table, in one
 * round trip (see waitlistCountsFor).
 */
export function cashStatus(t: LobbyTableRow, waiting = 0): { key: LobbyStatusKey; label: string } {
  const isFull = t.max_players > 0 && t.current_players >= t.max_players;
  const status = String(t.status || '').toLowerCase();
  if (status === 'closed' || status === 'deleted') return { key: 'closed', label: 'Closed' };
  if (status === 'paused') return { key: 'closed', label: 'Paused' };
  if (isFull && waiting > 0) return { key: 'waitlist', label: `Waitlist ${waiting}` };
  if (isFull) return { key: 'full', label: 'Full' };
  if ((t.current_players || 0) > 0) return { key: 'running', label: 'Running' };
  return { key: 'open', label: 'Open' };
}

export function tournamentStatus(t: LobbyTournamentRow): { key: LobbyStatusKey; label: string } {
  const status = String(t.status || '').toUpperCase();
  if (status === 'COMPLETED') return { key: 'completed', label: 'Completed' };
  if (status === 'CANCELLED') return { key: 'closed', label: 'Cancelled' };
  if (status === 'RUNNING') {
    if (
      isInLateRegistration(
        {
          name: formatGameTitle(t.name),
          status: t.status,
          start_time: t.start_time,
          max_players: t.max_players,
          late_reg_mins: t.late_reg_mins,
          late_reg_levels: t.late_reg_levels,
          started_at: t.started_at,
          current_level: t.current_level,
        },
        Date.now()
      )
    )
      return { key: 'late_reg', label: 'Late Reg' };
    return { key: 'running', label: 'Running' };
  }
  /**
   * The lobby query fetches `.in('status', ['REGISTERING','RUNNING','LATE_REG',
   * 'STARTING_SOON'])`, and two of those four had no branch here — they fell
   * all the way to the default and came back "Registering". For a Spin or a
   * Heads-Up that was worse than a wrong badge: the whole seat-first block
   * below was skipped, so a LATE_REG seat-first game never said Filling or
   * Running and never sank to the bottom of the board.
   *
   * LATE_REG is late registration by name, and a seat-first game does not have
   * one — it falls through to the seat logic, which is the right answer for it.
   */
  if (status === 'LATE_REG' || status === 'LATE_REGISTRATION') {
    if (classifyTournament(t) === 'mtt') return { key: 'late_reg', label: 'Late Reg' };
  }
  if (
    status === 'REGISTERING' ||
    status === 'ANNOUNCED' ||
    status === 'LATE_REG' ||
    status === 'LATE_REGISTRATION' ||
    status === 'STARTING_SOON'
  ) {
    /**
     * SEAT-FIRST GAMES DO NOT HAVE A START TIME (Dan 2026-08-23: "THE STATUS
     * IS BROKEN SAYS 'STARTING SOON' EVEN FOR GAMES THAT ARE FULL").
     *
     * A Spin or Heads-Up starts when its last seat is bought, not at a clock
     * time. The recycler still stamps a start_time on the row, and it is
     * always in the past, so the branch below matched unconditionally and
     * every Spin on the board — empty, half full, or sold out — carried the
     * identical "Starting Soon". The one column meant to tell the games apart
     * told the player nothing.
     *
     * Report what is actually true: how the seats are going.
     */
    const seatFirst = isSeatFirstTournament(t);
    if (seatFirst) {
      const cap = t.max_players || 0;
      const taken = t.current_players || 0;
      /* The COUNT moved out of the badge on 2026-08-25: every seat-first card
         now carries a labelled "Registered 2/3" well of its own (Dan asked for
         it by name), and printing the same fraction twice on a 375px card cost
         a line for nothing. The badge says the STATE; the well says the seats. */
      /* Dan 2026-08-25: "IF A TABLE ALREADY HAS 3 PLAYERS, IT NEEDS TO SAY
         RUNNING NOT STARTING." A seat-first game starts on its last bought
         seat — there is no gap between full and dealing for a player to act
         in, so "Starting" described a state that lasts no time and invited a
         tap that can only fail. Running is also what pushes the card to the
         bottom of the board (see seatFirstJoinable). */
      if (cap > 0 && taken >= cap) return { key: 'running', label: 'Running' };
      if (taken > 0) return { key: 'registering', label: 'Filling' };
      return { key: 'registering', label: 'Open Seats' };
    }

    // House rule (tournamentFilters): overdue-but-still-registering is the
    // most "starting soon" thing in the lobby, so no lower bound here.
    const startMs = t.start_time ? new Date(t.start_time).getTime() : NaN;
    if (Number.isFinite(startMs) && startMs - Date.now() <= STARTING_SOON_MS)
      return { key: 'starting_soon', label: 'Starting Soon' };
    return { key: 'registering', label: 'Registering' };
  }
  return { key: 'registering', label: 'Registering' };
}

/* tournamentJoinable was here and is deleted: an exported predicate with no
   caller anywhere in src/ or tests/. seatFirstJoinable covers the only
   question the lobby actually asks. */

// ─── Adapters ──────────────────────────────────────────────────────────────
/** The one table of a cluster that stands for the whole game on the board. */
export function isClusterFront(
  t: Pick<LobbyTableRow, 'cluster_id' | 'role' | 'main_index'>
): boolean {
  return !!t.cluster_id && t.role === 'main' && Number(t.main_index) === 1;
}

/** A cluster table that is NOT the front is never its own row (R10). */
export function isHiddenClusterMember(
  t: Pick<LobbyTableRow, 'cluster_id' | 'role' | 'main_index'>
): boolean {
  return !!t.cluster_id && !isClusterFront(t);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE DEFINITION OF A GAME'S PLAYERS AND TABLES (2026-09-09, must-move audit
 *  lane G; handoff item 5.2)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fn_cash_cluster_census` is what the controller decides a game's shape
 * from, and since 20260906163151 `get_club_home` and `fn_cash_game_lobby`
 * carry its predicate verbatim:
 *
 *     coalesce(is_deleted, false) = false
 *     AND status IN ('waiting', 'running', 'active')
 *     AND lifecycle <> 'closed'
 *
 * The client had a THIRD answer: `cluster_tables ?? 1` and
 * `cluster_players ?? current_players ?? 0`, a guess for any row the fast
 * path had not painted. Worse, the figure the fast path DID paint never moved
 * again: realtime delivers one `tables` row at a time and carries no
 * game-wide aggregate, the chain reload overlays its rows and keeps the old
 * aggregate, and the fast path does not run on a warm reload at all - so a
 * game's PLAYERS figure was frozen at first paint for the whole visit.
 *
 * So the board now derives both figures from the rows it holds, with the
 * census predicate and nothing else. `tables.current_players` is the seat
 * count `count(table_seats where left_at is null)` denormalised (read on
 * production 2026-09-09: 137 of 137 live cluster tables agree), so summing it
 * over the census tables of a cluster IS the census count, and it moves with
 * every realtime seat transition. A row that carries no figure is a one-row
 * board: the same predicate applied to the row itself.
 *
 * The only way this can disagree with the database is the 200-row cap on
 * both reads, which trims the EMPTIEST tables in scope (both order by
 * current_players first). A trimmed empty feeder would then be one table
 * short on its game's row. The largest scope on production holds 69 tables.
 */
export function isCensusTable(
  t: Pick<LobbyTableRow, 'status' | 'lifecycle'> & { is_deleted?: boolean | null }
): boolean {
  if (t.is_deleted === true) return false;
  const status = String(t.status ?? '').toLowerCase();
  if (status !== 'waiting' && status !== 'running' && status !== 'active') return false;
  /* `lifecycle <> 'closed'` in SQL is NULL, i.e. false, for a null lifecycle;
     the client says the same so the two can never count a table differently. */
  return t.lifecycle != null && String(t.lifecycle) !== 'closed';
}

export interface ClusterFigures {
  players: number;
  tables: number;
}

export type ClusterFigureSource = Pick<
  LobbyTableRow,
  'cluster_id' | 'status' | 'lifecycle' | 'current_players'
> & { is_deleted?: boolean | null };

/** Players and open tables per game, from the rows on the board. */
export function clusterFigures(
  rows: ReadonlyArray<ClusterFigureSource>
): Map<string, ClusterFigures> {
  const out = new Map<string, ClusterFigures>();
  for (const r of rows) {
    if (!r.cluster_id) continue;
    const id = String(r.cluster_id);
    const fig = out.get(id) ?? { players: 0, tables: 0 };
    if (isCensusTable(r)) {
      fig.tables += 1;
      fig.players += Math.max(0, Number(r.current_players) || 0);
    }
    out.set(id, fig);
  }
  return out;
}

/**
 * Stamp every cluster row with its game's figures, derived from the whole
 * board. The stamp overwrites whatever a read painted: the read's number was
 * true when it was taken, and this one is true now.
 */
export function withClusterFigures<
  T extends ClusterFigureSource & { cluster_players?: number | null; cluster_tables?: number | null },
>(rows: ReadonlyArray<T>): T[] {
  const figures = clusterFigures(rows);
  return rows.map((r) => {
    if (!r.cluster_id) return r;
    const fig = figures.get(String(r.cluster_id));
    if (!fig) return r;
    if (r.cluster_players === fig.players && r.cluster_tables === fig.tables) return r;
    return { ...r, cluster_players: fig.players, cluster_tables: fig.tables };
  });
}

/** The figures a single row carries, or the one-row board when it carries none. */
function clusterFiguresOf(t: LobbyTableRow): ClusterFigures {
  const players = Number(t.cluster_players);
  const tables = Number(t.cluster_tables);
  if (t.cluster_players != null && t.cluster_tables != null && Number.isFinite(players) && Number.isFinite(tables)) {
    return { players: Math.max(0, players), tables: Math.max(0, tables) };
  }
  return clusterFigures([t]).get(String(t.cluster_id)) ?? { players: 0, tables: 0 };
}

export function cashEntry(t: LobbyTableRow, waiting = 0): LobbyEntry {
  const v = variantDisplay(t.game_variant);
  const figures = t.cluster_id ? clusterFiguresOf(t) : null;
  const cluster =
    t.cluster_id && figures
      ? {
          id: t.cluster_id,
          mustMove: t.cluster_must_move !== false,
          template: t.cluster_template ?? null,
          tables: figures.tables,
          state: t.cluster_state ?? null,
        }
      : null;
  const gamePlayers = figures ? figures.players : 0;
  /* R10: a game is never "full" - a full Main opens a feeder - so its status
     is running or open, from the game-wide count, never from one table. A
     game the host has disabled is Closed: its door refuses GAME_CLOSED, and
     a Join that can only fail is not an offer (fix-first, 2026-09-09). */
  const st = cluster
    ? t.cluster_enabled === false
      ? { key: 'closed' as LobbyStatusKey, label: 'Closed' }
      : gamePlayers > 0
        ? { key: 'running' as LobbyStatusKey, label: 'Running' }
        : { key: 'open' as LobbyStatusKey, label: 'Open' }
    : cashStatus(t, waiting);
  /* Dan 2026-08-25: the lobby used to print tables.max_buy_in raw, which on 42
     of 46 live tables is 200bb — a ceiling the table's own BuyInModal will not
     sell. cashBuyInRange reports what a player can actually bring. */
  const range = cashBuyInRange(t);
  const minBuy = range.min;
  return {
    id: t.id,
    kind: 'cash',
    name: formatGameTitle(t.name),
    gameLabel: v.short,
    variantLabel: v.long,
    // 2026-08-24: a fixed-limit table is posted by BET size, not blind size —
    // blinds 1/2 IS a "2/4" game. TableConfigPage already names the table and
    // writes `tables.stakes` that way, so building this row from the raw blinds
    // made the lobby list disagree with the table it links to: the row read
    // "1 / 2" and the table called itself "FLH 2/4". Same helper as the create
    // screen, so the two cannot drift again. No-limit and pot-limit rows are
    // unchanged — stakesLabelFor returns the blinds for them.
    // `|| 0` turns a null blind into a CLAIM: stakesLabelFor has no unknown
    // branch, so it printed "0/0" and CasinoPlaque rendered "Blinds 0/0". The
    // field is `string | null` precisely so a row that cannot say its stakes
    // says nothing, which is what cashBuyInLabel already does one line down.
    stakesLabel:
      Number(t.big_blind) > 0
        ? stakesLabelFor(Number(t.small_blind) || 0, Number(t.big_blind), t.game_variant)
        : null,
    stakesValue: Number(t.big_blind) || 0,
    buyInLabel: cashBuyInLabel(t),
    /* ITEM E audit, 2026-08-26: an unknown range used to sort as buyInValue 0
       — the TOP of an ascending Buy-In sort, as if it were the cheapest game
       on the board. Unknown sinks to the bottom instead (the comparator
       already handles the Infinity-vs-Infinity case). */
    buyInValue: range.unknown ? Infinity : minBuy,
    guaranteeLabel: null,
    guaranteeValue: 0,
    players: cluster ? gamePlayers : t.current_players || 0,
    capacity: cluster ? 0 : t.max_players || 0,
    ...(cluster ? { game: cluster } : {}),
    startTime: null,
    startValue: Infinity,
    speedLabel: null,
    status: st.key,
    statusLabel: st.label,
    live: (cluster ? gamePlayers : t.current_players || 0) > 0,
    rules: cluster
      ? [
          {
            key: cluster.mustMove ? 'must_move' : 'manual_table',
            label: cluster.mustMove ? 'MUST MOVE' : 'MANUAL',
            detail: cluster.template ? cluster.template.toUpperCase() : undefined,
            tip: cluster.mustMove
              ? 'One Game, Many Tables. Seats Open On A Main Pull Players Off The Feeder.'
              : 'One Table The Host Runs By Hand.',
          },
          ...cashRuleMedallions(t),
        ]
      : cashRuleMedallions(t),
    ...lobbyFlags(t),
    clubLabel: null,
    raw: t,
  };
}

export function tournamentEntry(t: LobbyTournamentRow, kind: 'mtt' | 'spin' | 'sng'): LobbyEntry {
  const v = variantDisplay(t.game_type);
  const st = tournamentStatus(t);
  const total = (Number(t.buy_in_amount) || 0) + (Number(t.buy_in_fee) || 0);
  const startMs = t.start_time ? new Date(t.start_time).getTime() : NaN;
  return {
    id: t.id,
    kind,
    name: formatGameTitle(t.name),
    gameLabel: v.short,
    variantLabel: v.long,
    stakesLabel: null,
    stakesValue: total,
    /**
     * NOT Math.round (2026-08-25). Fees became fractional the same day — a
     * 1-chip game is 0.90 + 0.10, so `total` is 1.10 and rounding printed "1"
     * on a card whose player is charged 1.10. The panel behind the card uses
     * formatBuyIn and showed the real figure, so the two surfaces quoted
     * different prices for the same seat. A whole total still prints whole,
     * because that is what it is.
     */
    buyInLabel: total <= 0 ? FREE_BUY_LABEL : formatChipTotal(total),
    buyInValue: total,
    guaranteeLabel:
      (Number(t.guaranteed_prize) || 0) > 0
        ? `${Number(t.guaranteed_prize).toLocaleString()} GTD`
        : null,
    guaranteeValue: Number(t.guaranteed_prize) || 0,
    players: t.current_players || 0,
    capacity: t.max_players || 0,
    startTime: t.start_time || null,
    startValue: Number.isFinite(startMs) ? startMs : Infinity,
    speedLabel:
      tournamentSpeed(t.name) || (kind === 'spin' || kind === 'sng' ? 'When Full' : 'Standard'),
    status: st.key,
    statusLabel: st.label,
    /* ITEM E audit, 2026-08-26: derived from the SAME status the surfaces
       render, not from the raw column. A seat-first game whose last seat just
       sold reports Running (Dan 2026-08-25: "IF A TABLE ALREADY HAS 3 PLAYERS,
       IT NEEDS TO SAY RUNNING NOT STARTING") while the column still says
       REGISTERING for a beat — so the card showed a Running badge with no
       live pip: one card, two claims. One derivation now. */
    live: st.key === 'running' || st.key === 'late_reg',
    rules: tournamentMedallions(t),
    ...lobbyFlags(t),
    clubLabel: null,
    raw: t,
  };
}

/**
 * The same spin / heads-up classification the card grid used — now asking the
 * ROW what it is, and only guessing from the name when the column is absent.
 * See tournamentVariant in src/utils/tournamentFilters.ts for why.
 */
// ─── MTT title helpers (pure — LobbyTable renders them, tests pin them) ────

/** "17:33" under an hour, "1:02:33" above it. Never negative. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/* The local BlindLevel shadow that used to sit here declared only
   `durationMinutes`, which is why both readers below silently ignored the
   canonical `duration_minutes`. They read through tournamentFigures now,
   which takes either spelling and is the only parser in the folder. */

/* lateRegEndMs moved to ./lateRegWindow so the root-mounted tournament
   ticker can read it without pulling this entire module into the entry
   bundle. Re-exported here so every existing caller is unchanged. */
export { lateRegEndMs };

/**
 * The live phrase on line 2 of an MTT title: "Starting In 17:33...",
 * "Late Reg 12:45 Left", "Running", or the terminal status label.
 */
/** Time left in the level a running tournament is on, or null when the blind
    structure does not say. */
export function levelRemainingMs(t: LobbyTournamentRow, now: number): number | null {
  if (!t.level_started_at) return null;
  const structure = parseBlindStructure(t.blind_structure);
  if (!structure) return null;
  const mins = blindLevelMinutes(structure, tournamentLevel(t));
  if (mins <= 0) return null;
  const began = new Date(t.level_started_at).getTime();
  if (!Number.isFinite(began)) return null;
  const left = began + mins * 60000 - now;
  return left > 0 ? left : 0;
}

/* ── SEAT-FIRST CARD FACTS (Dan 2026-08-25) ────────────────────────────────
   "for spins, it needs to show the 'max payout' 'Win Up To 100x' ... the game
   type, deep stack or turbo, and the default starting stacks ... the level
   times to '3 Min Levels' and the amount of players registered."
   "Heads Up, needs to have the amount of players registered 0/2 ... the type,
   turbo or deep stack, should say the starting stack and blind speed."

   Every one of these already existed in the row or in spinSpec; none of them
   had ever been asked for by the lobby. They are pure functions here so the
   table renders them and the tests pin them, in the same shape as the MTT
   title helpers directly above. */

/** The top of the Spin ladder — 100x since the 500x tier was retired. */
export const SPIN_MAX_MULTIPLIER = SPIN_TIERS.reduce((max, t) => Math.max(max, t.multiplier), 0);

/**
 * A Spin's headline prize. The multiplier is NOT drawn until the game starts
 * (TournamentManagerBase writes spin_multiplier at start, and the row carries
 * null before that) — so a game still filling advertises the ceiling of the
 * ladder, and one that has turned the wheel shows what it actually pays.
 */
export function spinPayoutLabel(entry: LobbyEntry): string | null {
  if (entry.kind !== 'spin') return null;
  /* THE DRAW IS THE PRODUCT, so the column is never read raw here — the gate
     in utils/spinReveal decides whether this Spin has actually turned its
     wheel, and returns null while the answer is still secret. A game still
     filling advertises the ceiling of the ladder instead, which is the honest
     thing to shop by and gives nothing away. */
  const revealed = spinMultiplierLabel(entry.raw as Parameters<typeof spinMultiplierLabel>[0]);
  if (revealed) return revealed;
  return `Win Up To ${SPIN_MAX_MULTIPLIER}x`;
}

/**
 * The money underneath the multiplier. Dan 2026-08-25: "YOU NEED TO ADD THE
 * WIN UP TO 100X THE BUY IN AND SHOW WHAT THE TOP PRIZE IS (BUY IN AMOUNT X
 * 100 = 100 TOP PRIZE)" and, for a game already under way, "THE PAYOUT
 * MULTIPLIER SHOULD BE DISPLAYED AFTER ITS DECIDED FOR RUNNING SPINS, PRIZE
 * POOL XXX".
 *
 * "Win Up To 100x" is a ratio, and a ratio is the one thing a player shopping
 * a board of eight buy-ins cannot compare at a glance. The chips can.
 *
 * Before the draw this is arithmetic on the ladder ceiling and gives nothing
 * away. After it, `prize_pool` IS `buy_in x multiplier`, so it is exactly as
 * secret as the multiplier and goes through the same gate — printing it early
 * would leak the draw by division.
 */
export function spinPrizeLabel(entry: LobbyEntry): string | null {
  if (entry.kind !== 'spin') return null;
  const t = entry.raw as LobbyTournamentRow;
  const revealed = spinMultiplierLabel(t as Parameters<typeof spinMultiplierLabel>[0]);
  if (revealed) {
    const pool = Number(t.prize_pool) || 0;
    if (pool > 0) return `Prize Pool ${pool.toLocaleString()}`;
    /* The row has not been re-read since the draw. Derive it from the two
       numbers that ARE on the card rather than showing nothing. */
    const derived = (Number(t.buy_in_amount) || 0) * (Number(t.spin_multiplier) || 0);
    return derived > 0 ? `Prize Pool ${derived.toLocaleString()}` : null;
  }
  const top = (Number(t.buy_in_amount) || 0) * SPIN_MAX_MULTIPLIER;
  return top > 0 ? `Top Prize ${top.toLocaleString()}` : null;
}

/**
 * Can a player still buy a seat in this game? Dan 2026-08-25, twice: a running
 * Spin and a running Heads-Up both "NEED TO BE DROPPED TO THE BOTTOM OF THE
 * RESULTS". A board sorted by buy-in alone put a sold-out game between two
 * joinable ones at the same price, which is the row a player taps by mistake.
 */
export function seatFirstJoinable(entry: LobbyEntry): boolean {
  if (entry.kind !== 'spin' && entry.kind !== 'sng') return true;
  if (entry.status === 'running' || entry.status === 'completed' || entry.status === 'closed')
    return false;
  if (entry.capacity > 0 && entry.players >= entry.capacity) return false;
  return true;
}

/** "3 Min Levels" / "10 Min Levels" — the blind clock, from level 1. */
export function levelSpeedLabel(t: LobbyTournamentRow): string | null {
  const structure = parseBlindStructure(t.blind_structure);
  if (!structure) return null;
  const mins = blindLevelMinutes(structure, 1);
  if (mins <= 0) return null;
  const rounded = Math.round(mins * 10) / 10;
  /* Just the number. "Levels" used to be in the value and wrapped the well
     onto three lines on a 375px card, under a heading that already said BLIND
     LEVELS. The heading carries the noun. */
  return `${rounded} Min`;
}

/**
 * Turbo / Standard / Deepstack, measured rather than guessed.
 *
 * A name keyword wins when the creator supplied one. Otherwise the honest
 * signal is how many big blinds the starting stack actually is at level 1 —
 * which is exactly how spinSpec describes its own ladder ("300 chips … over
 * fast", "1000 chips … deep stack"). A Spin at 300 chips into 10/20 is 15bb
 * and plays like a turbo; the same 3-minute levels at 5,000 chips do not.
 */
/**
 * How many big blinds the starting stack is worth at level 1, or 0 when the
 * row cannot say. Exported so the Format column can SORT on the depth instead
 * of on the word — 'Deepstack' < 'Hyper' < 'Standard' < 'Turbo' is the
 * alphabet, not a speed, and an empty string floated every cash row to the top
 * of the ALL tab (the same defect COL_TSTACK uses Infinity to avoid).
 */
export function stackDepthBB(entry: LobbyEntry): number {
  if (entry.kind === 'cash') return 0;
  const t = entry.raw as LobbyTournamentRow;
  const chips = Number(t.starting_chips) || 0;
  if (chips <= 0) return 0;
  const structure = parseBlindStructure(t.blind_structure);
  const first = structure ? blindLevelAt(structure, 1) : undefined;
  const firstBig = Number(first?.big_blind ?? first?.bigBlind ?? 0) || 0;
  return firstBig > 0 ? chips / firstBig : 0;
}

export function stackDepthLabel(entry: LobbyEntry): string | null {
  if (entry.kind === 'cash') return null;
  const t = entry.raw as LobbyTournamentRow;
  const named = tournamentSpeed(t.name);
  if (named) return named;

  const chips = Number(t.starting_chips) || 0;
  if (chips <= 0) return null;
  const structure = parseBlindStructure(t.blind_structure);
  /* Through blindLevelAt, like every other reader in this folder. Reading
     `structure[0]` raw agrees with it only while the array happens to be
     index-ordered, and tournamentFigures exists precisely so there is one
     convention rather than two. */
  const first = structure ? blindLevelAt(structure, 1) : undefined;
  const firstBig = Number(first?.big_blind ?? first?.bigBlind ?? 0) || 0;
  if (firstBig <= 0) return null;

  const depth = chips / firstBig;
  if (depth >= 40) return 'Deepstack';
  if (depth >= 20) return 'Standard';
  return 'Turbo';
}

/**
 * The Format column's SORT rank, derived from the SAME label the column
 * renders (ITEM E audit, 2026-08-26). It used to sort on measured depth while
 * rendering the name keyword, so a 60bb "Sunday Turbo" printed Turbo and
 * sorted among the Deepstacks — click the header and the visible order read
 * `Turbo, Deepstack, Standard, Turbo…`, a sort that looks broken because the
 * two derivations disagreed. One derivation now: rank follows the label,
 * fastest first. A row with no label (every cash row) sinks in both
 * directions, as before. Named rows short-circuit before any blind-structure
 * parse, so the comparator's cost is unchanged for them.
 */
export function stackFormatRank(entry: LobbyEntry): number {
  switch (stackDepthLabel(entry)) {
    case 'Hyper':
      return 1;
    case 'Turbo':
      return 2;
    case 'Standard':
      return 3;
    case 'Deepstack':
      return 4;
    default:
      return Infinity;
  }
}

/**
 * Seats taken on a game that starts when it fills: "2/3", "1/2".
 *
 * An MTT keeps a bare count — Dan 2026-08-24, "THERE ARE NO LIMITATIONS ON THE
 * AMOUNT OF PLAYERS THAT CAN REGISTER, IT SHOULDN'T DEFAULT TO /500" — but a
 * Spin and a Heads-Up have a real, small denominator that IS the information.
 */
export function seatsTakenLabel(entry: LobbyEntry): string {
  if (entry.kind === 'spin' || entry.kind === 'sng')
    return `${entry.players.toLocaleString()}/${entry.capacity || '-'}`;
  return entry.players.toLocaleString();
}

/**
 * A cash card's two lines. Dan 2026-08-25: "the 2nd line below the game type
 * and stakes is for the table name, make sure it doesn't get cut off by the
 * other fields."
 *
 * `tables.name` arrives as one string that already opens with the variant and
 * the stakes — "NLH 25/50 INSURANCE TEST" — so line 1 is rebuilt from the
 * canonical fields (which is also how a fixed-limit table gets its BET-size
 * stakes rather than its blinds) and line 2 is whatever the host actually
 * named the table. A table with no name beyond its stakes has no second line
 * rather than an empty one.
 */
/* plo6 was missing from this class until 2026-08-25 and the miss was visible:
   a table named "PLO6 1/2" kept its whole name as the SUBTITLE, so the card
   printed "PLO6 1/2" twice, once per line. The class now covers every variant
   the platform deals. */
/**
 * `6\+\b` could never match: `+` and the space after it are both non-word
 * characters, so there is no word boundary between them and the alternative
 * always failed. A short-deck table called "6+ 1/2 Deep" then failed
 * STAKES_HEAD too (it starts with "6" but the next character is "+", not "/"),
 * so the entire name came back as the subtitle and the card printed it twice —
 * the exact duplication the plo6 fix was for.
 *
 * `(?!\w)` instead of `\b` asserts "not followed by a word character", which
 * is true after a `+` and true at end-of-string, and behaves identically to
 * `\b` for every alphabetic alternative.
 */
const VARIANT_HEAD =
  /^\s*(nlhe?|no[\s-]?limit[\s-]?hold(?:'|’)?em|plo[4568]?|pot[\s-]?limit[\s-]?omaha|flh|flo8?|limit[_\s-]?(?:holdem|omaha)|pineapple|short[\s_-]?deck|6\+)(?!\w)/i;
/**
 * A stake is `1/2`, `$1/$2`, `0.10/0.25` - or `.10/.25`, because `entry.name`
 * has already been through formatGameTitle, which drops the leading zero of
 * every sub-dollar blind. `\d+` required that zero, so on the desktop board
 * every micro table's second line began with the stakes its first line had
 * just given: "NLH 0.10/0.25" over ".10/.25 Classic" (Dan, 2026-09-04).
 */
const STAKES_HEAD = /^\s*\$?(?:\d+(?:\.\d+)?|\.\d+)\s*\/\s*\$?(?:\d+(?:\.\d+)?|\.\d+)/;

/** The template's display name; the vocabulary is `src/config/cashGames.ts`. */
export function cashTemplateLabel(template: string | null | undefined): string | null {
  if (!template) return null;
  return CASH_TEMPLATES.find((t) => t.id === String(template).toLowerCase())?.label ?? null;
}

/**
 * THE STAKES MENU COUNTS STYLES (Dan 2026-09-05). How many GAMES of each
 * style the board holds - one per cluster front (R10: a must-move game is one
 * row, its Main 1), so a game with three tables counts once. Keys are the
 * template ids (`classic` / `action` / `madness`); a table with no template
 * is not a style and is not counted. Derived from rows already loaded; it
 * costs no network call.
 */
export function countStylesOnBoard(
  rows: ReadonlyArray<
    Pick<LobbyTableRow, 'cluster_id' | 'role' | 'main_index'> & { cluster_template?: string | null }
  >
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    if (!r.cluster_id || !isClusterFront(r)) continue;
    const key = String(r.cluster_template ?? '')
      .trim()
      .toLowerCase();
    if (!key) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** "Classic 12 / Action 4 / Madness 2", in the menu's own order; zero is printed, not hidden. */
export function styleCountsLine(
  choices: ReadonlyArray<{ key: string; label: string }>,
  counts: Readonly<Record<string, number>>
): string {
  return choices.map((c) => `${c.label} ${counts[c.key] ?? 0}`).join(' / ');
}

export function cashTitleLines(entry: LobbyEntry): { headline: string; subtitle: string | null } {
  const headline = [entry.gameLabel, entry.stakesLabel].filter(Boolean).join(' ').trim();
  /* A templated game (Operation Table Stakes) says what KIND of game it is on
     line two - Classic, Action or Madness - straight from the game row, not
     parsed back out of a table name. Dan 2026-09-04: "UNDER ALL THE GAMES
     TITLES INSTEAD OF REPEATING THE STAKES AGAIN, SHOULD JUST SAY 'CLASSIC'
     'ACTION' OR 'MADNESS'." */
  const templateLabel = cashTemplateLabel(entry.game?.template);
  if (templateLabel) {
    return { headline: headline || String(entry.name || ''), subtitle: templateLabel };
  }
  /* Strip in BOTH orders. A host may type "NLH 1/2 Late Night" or
     "1/2 NLH Late Night", and stripping only variant-then-stakes left the
     variant in the subtitle for the second one, so the card said NLH twice. */
  const rest = String(entry.name || '')
    .replace(VARIANT_HEAD, '')
    .replace(STAKES_HEAD, '')
    .replace(VARIANT_HEAD, '')
    .replace(STAKES_HEAD, '')
    /* Separators written as escapes, not literals: the en and em dash are here
       to be STRIPPED off a table name, but check-ui-text scans source for the
       character and cannot tell a matcher from a message. */
    .replace(/^[\s\-\u2013\u2014:|,]+/, '')
    .trim();
  return {
    headline: headline || String(entry.name || ''),
    subtitle: rest.length > 0 ? rest : null,
  };
}

/**
 * Dan 2026-08-24: "KEEP THE LATE REG CLOCK RUNNING OR THE STARTS IN CLOCK
 * RUNNING AT ALL TIMES. DON'T SWITCH BACK AND FORTH FROM A CLOCK TO 'LATE REG
 * CLOSING SOON'. ALWAYS USE CLOCKS."
 *
 * Every branch here used to fall back to a phrase the moment its number went
 * to zero or its input was briefly missing — so a card that had been counting
 * down for an hour would suddenly read "Late Reg Closing", then go back to
 * counting on the next poll. A clock that disappears at the exact moment it
 * matters most is worse than no clock. Zero is now a legitimate reading, and
 * a running tournament counts its level down instead of saying "Running".
 */
export function mttPhaseText(entry: LobbyEntry, now: number): string | null {
  if (entry.status === 'registering' || entry.status === 'starting_soon') {
    const startMs = entry.startTime ? new Date(entry.startTime).getTime() : NaN;
    /**
     * ZERO IS A LEGITIMATE READING; A MISSING CLOCK IS NOT.
     *
     * An audit on 2026-08-25 flagged the frozen "Starts In 0:00" on an overdue
     * MTT as a defect and I changed it to a phrase. That was wrong, and the
     * suite caught it: this behaviour was RE-PINNED on 2026-08-24 in Dan's own
     * words — "keep the clock running at all times, don't switch back and
     * forth from a clock to a phrase". A card that has been counting down must
     * not flip to prose at the exact moment the number matters most. Only a
     * start time that cannot be parsed at all has nothing to count.
     */
    if (Number.isFinite(startMs)) return `Starts In ${formatClock(Math.max(0, startMs - now))}`;
    return 'Starting Soon';
  }
  if (entry.status === 'late_reg') {
    const end = lateRegEndMs(entry.raw as LobbyTournamentRow);
    if (end != null) return `Late Reg ${formatClock(Math.max(0, end - now))} Left`;
    return 'Late Reg Open';
  }
  if (entry.status === 'running') {
    const left = levelRemainingMs(entry.raw as LobbyTournamentRow, now);
    if (left != null) return `Level Ends In ${formatClock(left)}`;
    return 'Running';
  }
  if (entry.status === 'completed' || entry.status === 'closed') return entry.statusLabel;
  return null;
}

/** MTT names carry their variation; make sure it is there even when the
    creator left it out of the name text. */
export function mttTitleLine(entry: LobbyEntry): string {
  const name = entry.name || '';
  // formatGameTitle returns '' for a nameless tournament, which used to render
  // as a leading space and a parenthesised label: " (NLH)".
  if (!name) return entry.gameLabel;
  return name.toUpperCase().includes(entry.gameLabel.toUpperCase())
    ? name
    : `${name} (${entry.gameLabel})`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SEAT-FIRST MEANS WHAT THE SERVER MEANS BY IT (2026-08-31, Phase 3)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The server has one definition, in TournamentRecurringService:
 *
 *     isSeatFirstFormat(variant, maxPlayers) =
 *       variant === 'spin' || maxPlayers <= 2
 *
 * and `fn_take_seat_and_buy_in` honours the same rule. The lobby had a
 * different one: anything `classifyTournament` called an 'sng', which is every
 * capped field up to TEN seats. A six- or nine-max SNG therefore rendered a Sit
 * Down affordance for a seat the server will not sell -- the player clicks and
 * the buy-in is refused.
 *
 * No such row is created today ("WE AREN'T DOING ANY OTHER SIT N GO'S", Dan
 * 2026-08-21), which is exactly why this is worth pinning rather than leaving:
 * the day one is, the lobby lies about it and nothing fails first.
 *
 * classifyTournament keeps its own job -- it decides the TAB and the label, and
 * a 6-max SNG genuinely belongs on the sit-n-go tab. What it must not decide,
 * alone, is whether a seat can be taken.
 */
export function isSeatFirstTournament(t: LobbyTournamentRow): boolean {
  if (classifyTournament(t) === 'spin') return true;
  const seats = Number((t as { max_players?: unknown }).max_players);
  return Number.isFinite(seats) && seats > 0 && seats <= 2;
}

export function classifyTournament(t: LobbyTournamentRow): 'mtt' | 'spin' | 'sng' {
  const v = String((t as { variant?: unknown }).variant ?? '').toLowerCase();
  if (v === 'spin') return 'spin';
  if (v === 'sng') return 'sng';
  // Present and not a spin means NOT A SPIN, whatever the name says.
  /* A MISSING cap is not a small field. Dan 2026-08-24: "THERE ARE NO
     LIMITATIONS ON THE AMOUNT OF PLAYERS THAT CAN REGISTER", so an unlimited
     MTT carries max_players null — and `(null || 0) <= 10` called every one of
     them a Heads-Up: wrong tab, seat-first status text, "12/-" for the field,
     and Sit Down instead of Register. A cap only means something when it is a
     real number. */
  if (v) return t.max_players != null && t.max_players > 0 && t.max_players <= 10 ? 'sng' : 'mtt';

  const n = (t.name || '').toLowerCase();
  if (n.includes('spin')) return 'spin';
  if (n.includes('sng') || (t.max_players != null && t.max_players > 0 && t.max_players <= 10))
    return 'sng';
  return 'mtt';
}
