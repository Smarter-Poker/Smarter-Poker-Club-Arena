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

import { formatGameTitle } from '../../utils/formatGameTitle';
import { isInLateRegistration } from '../../utils/tournamentFilters';
import { stakesLabel as stakesLabelFor } from '../../lib/bettingStructure';
import { blindLevelMinutes, parseBlindStructure, tournamentLevel } from './tournamentFigures';
import { cashBuyInLabel, cashBuyInRange } from '../../lib/cashBuyIn';
import { spinMultiplierLabel } from '../../utils/spinReveal';
import { SPIN_TIERS } from '../../config/spinSpec';

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
  settings?: unknown;
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
  startTime: string | null;
  startValue: number; // ms epoch, Infinity when none — numeric sort key
  speedLabel: string | null;
  status: LobbyStatusKey;
  statusLabel: string;
  live: boolean;
  rules: RuleMedallion[];
  raw: LobbyTableRow | LobbyTournamentRow;
}

// ─── Display maps (lobby-canonical; DynamicGameCard keeps its legacy copy) ──
const VARIANT_LABELS: Record<string, { short: string; long: string }> = {
  nlh: { short: 'NLH', long: "No Limit Hold'em" },
  plo4: { short: 'PLO', long: 'Pot Limit Omaha' },
  plo5: { short: 'PLO5', long: 'Pot Limit Omaha 5' },
  plo6: { short: 'PLO6', long: 'Pot Limit Omaha 6' },
  plo8: { short: 'PLO8', long: 'Pot Limit Omaha Hi-Lo' },
  pineapple: { short: 'PNPL', long: 'Pineapple' },
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
  SHORT_DECK: 'short_deck',
  PLO: 'plo4',
};

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
 * `enable_straddle`; `bomb_pot_enabled` / `bomb_pots`) and they DISAGREE on
 * live rows. So a card cannot pick a spelling and hope. Each predicate below
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
  ante_enabled?: boolean | null;
  ante?: number | null;
  seven_deuce_enabled?: boolean | null;
  seven_deuce_amount?: number | null;
  time_bank_enabled?: boolean | null;
  all_in_or_fold?: boolean | null;
  settings?: unknown;
}

/** A tri-state column: true / false / absent. Absent is NOT false. */
const col = (v: unknown): boolean | undefined =>
  v === true ? true : v === false ? false : undefined;

export function cashRuleMedallions(row: CashFeatureSource, name: string): RuleMedallion[] {
  const s = parseTableSettings(row.settings);
  const n = (name || '').toLowerCase();
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

  /* `bomb_pot_enabled` with a frequency of 0 deals no bomb pots — the engine
     requires both (`bomb_pot_enabled && bomb_pot_frequency > 0`). */
  const bombOn = col(row.bomb_pot_enabled) ?? on(s, 'bomb_pot_enabled', 'bombPot');
  const bombFreq =
    Number(row.bomb_pot_frequency) || num(s, 'bomb_pot_frequency', 'bombPotFrequency') || 0;
  if (bombOn && bombFreq > 0) {
    const dbl = col(row.bomb_pot_double_board) === true || s.bomb_pot_double_board === true;
    rules.push({
      key: 'bomb',
      label: 'BOMB POTS',
      detail: `1 IN ${bombFreq}`,
      tip: `A bomb pot every ${bombFreq} hands${dbl ? ', dealt on two boards' : ''}`,
    });
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

  if (on(s, 'double_board', 'doubleBoard')) {
    rules.push({
      key: 'double_board',
      label: 'DOUBLE BOARD',
      tip: 'Every hand is dealt with two boards',
    });
  }

  /* ── FOUR MEDALLIONS DELIBERATELY NOT HERE ──────────────────────────────
     Dan asked for VPIP and for a minimum-hands rule, and the honest answer is
     that this platform does not have either yet:

       VPIP        - there is no vpip column on `tables` at all. The seat HUD
                     shows VPIP to everyone unconditionally, so a chip would
                     be true of every table and would distinguish nothing.
       MIN HANDS   - `maintain_hands` is 10 on all 46 rows and is read by
                     NOTHING. A player can sit, play one hand and leave.
                     "MIN 10 HANDS" would be a rule the table will not keep.
       NO RATHOLE  - `no_rathole` has no reader in server/src either.
       CALL TIME   - `calltime_enabled` likewise, and the old medallion read
                     `call_time_enabled`, a name that is not even a column.

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
  if (l.includes('freeroll') || l.includes('free roll')) return 'freeroll';
  if (l.includes('mystery')) return 'mystery';
  if (l.includes('pko') || l.includes('progressive')) return 'pko';
  if (l.includes('bounty') || l.includes('ko ')) return 'ko';
  if (l.includes('satellite')) return 'satellite';
  return 'freezeout';
}

export function tournamentSpeed(name: string): string | null {
  const l = (name || '').toLowerCase();
  if (l.includes('hyper')) return 'Hyper';
  if (l.includes('turbo')) return 'Turbo';
  if (l.includes('deep')) return 'Deepstack';
  return null;
}

export function tournamentMedallions(t: LobbyTournamentRow): RuleMedallion[] {
  const rules: RuleMedallion[] = [];
  const type = detectTourneyType(t.name);
  const l = (t.name || '').toLowerCase();

  if (type === 'freeroll') rules.push({ key: 'freeroll', label: 'FREEROLL', tip: 'Free entry' });
  if (type === 'pko')
    rules.push({
      key: 'pko',
      label: 'PKO',
      tip: 'Progressive knockout: half of each bounty grows your own',
    });
  if (type === 'mystery')
    rules.push({
      key: 'mystery',
      label: 'MYSTERY BOUNTY',
      tip: 'Knockouts award a mystery bounty draw',
    });
  if (type === 'ko')
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
  if (!reentry && !rebuy && type === 'freezeout' && !l.includes('spin'))
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
const STARTING_SOON_MS = 60 * 60 * 1000;

export function cashStatus(t: LobbyTableRow): { key: LobbyStatusKey; label: string } {
  const isFull = t.max_players > 0 && t.current_players >= t.max_players;
  const status = String(t.status || '').toLowerCase();
  if (status === 'closed' || status === 'deleted') return { key: 'closed', label: 'Closed' };
  if (status === 'paused') return { key: 'closed', label: 'Paused' };
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
  if (status === 'REGISTERING' || status === 'ANNOUNCED') {
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
    const seatFirst = classifyTournament(t) !== 'mtt';
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

/** Can the player still enter this tournament (register or late register)? */
export function tournamentJoinable(t: LobbyTournamentRow): boolean {
  const st = tournamentStatus(t);
  return st.key === 'registering' || st.key === 'starting_soon' || st.key === 'late_reg';
}

// ─── Adapters ──────────────────────────────────────────────────────────────
export function cashEntry(t: LobbyTableRow): LobbyEntry {
  const v = variantDisplay(t.game_variant);
  const st = cashStatus(t);
  /* Dan 2026-08-25: the lobby used to print tables.max_buy_in raw, which on 42
     of 46 live tables is 200bb — a ceiling the table's own BuyInModal will not
     sell. cashBuyInRange reports what a player can actually bring. */
  const { min: minBuy } = cashBuyInRange(t);
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
    stakesLabel: stakesLabelFor(t.small_blind || 0, t.big_blind || 0, t.game_variant),
    stakesValue: Number(t.big_blind) || 0,
    buyInLabel: cashBuyInLabel(t),
    buyInValue: minBuy,
    guaranteeLabel: null,
    guaranteeValue: 0,
    players: t.current_players || 0,
    capacity: t.max_players || 0,
    startTime: null,
    startValue: Infinity,
    speedLabel: null,
    status: st.key,
    statusLabel: st.label,
    live: (t.current_players || 0) > 0,
    rules: cashRuleMedallions(t, t.name),
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
    buyInLabel: total <= 0 ? 'FREE' : Math.round(total).toLocaleString(),
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
    live: String(t.status).toUpperCase() === 'RUNNING',
    rules: tournamentMedallions(t),
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

/**
 * When does late registration CLOSE, in ms epoch — or null when the row does
 * not carry enough to know. Mirrors isInLateRegistration's OR: minutes and
 * levels each keep the door open, so the close is the LATER of the two
 * windows the row can prove.
 *
 * The level window is exact when the row carries blind_structure and
 * level_started_at: the remainder of the current level plus every remaining
 * late-reg level's configured duration. (Dan 2026-08-24: the late reg closing
 * needs a countdown timer, not a static "Thru Level N".)
 */
export function lateRegEndMs(t: LobbyTournamentRow): number | null {
  const candidates: number[] = [];

  const begun = new Date(t.started_at || t.start_time || '').getTime();
  const lateMins = Number(t.late_reg_mins) || 0;
  if (lateMins > 0 && Number.isFinite(begun)) candidates.push(begun + lateMins * 60000);

  const lateLevels = Number(t.late_reg_levels) || 0;
  if (lateLevels > 0) {
    const structure = parseBlindStructure(t.blind_structure);
    if (structure) {
      const cur = tournamentLevel(t);
      const levelBegun = new Date(t.level_started_at || t.started_at || '').getTime();
      if (Number.isFinite(levelBegun) && cur <= lateLevels) {
        // Rest of the current level, then every configured level through the
        // last late-reg level. A level with no configured duration adds 0 —
        // the estimate degrades toward "sooner", never invents time.
        let end = levelBegun + blindLevelMinutes(structure, cur) * 60000;
        for (let lvl = cur + 1; lvl <= lateLevels; lvl++)
          end += blindLevelMinutes(structure, lvl) * 60000;
        candidates.push(end);
      }
    }
  }

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

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
export function stackDepthLabel(entry: LobbyEntry): string | null {
  if (entry.kind === 'cash') return null;
  const t = entry.raw as LobbyTournamentRow;
  const named = tournamentSpeed(t.name);
  if (named) return named;

  const chips = Number(t.starting_chips) || 0;
  if (chips <= 0) return null;
  const structure = parseBlindStructure(t.blind_structure);
  const first = structure?.[0];
  const firstBig = Number(first?.big_blind ?? first?.bigBlind ?? 0) || 0;
  if (firstBig <= 0) return null;

  const depth = chips / firstBig;
  if (depth >= 40) return 'Deepstack';
  if (depth >= 20) return 'Standard';
  return 'Turbo';
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
    return `${entry.players}/${entry.capacity || '-'}`;
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
const VARIANT_HEAD =
  /^\s*(nlhe?|plo[4568]?|flh|flo8?|limit[_\s-]?(?:holdem|omaha)|pineapple|short[\s_-]?deck|6\+)\b/i;
const STAKES_HEAD = /^\s*\$?\d+(?:\.\d+)?\s*\/\s*\$?\d+(?:\.\d+)?/;

export function cashTitleLines(entry: LobbyEntry): { headline: string; subtitle: string | null } {
  const headline = [entry.gameLabel, entry.stakesLabel].filter(Boolean).join(' ').trim();
  const rest = String(entry.name || '')
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
  return name.toUpperCase().includes(entry.gameLabel.toUpperCase())
    ? name
    : `${name} (${entry.gameLabel})`;
}

export function classifyTournament(t: LobbyTournamentRow): 'mtt' | 'spin' | 'sng' {
  const v = String((t as { variant?: unknown }).variant ?? '').toLowerCase();
  if (v === 'spin') return 'spin';
  if (v === 'sng') return 'sng';
  // Present and not a spin means NOT A SPIN, whatever the name says.
  if (v) return (t.max_players || 0) <= 10 ? 'sng' : 'mtt';

  const n = (t.name || '').toLowerCase();
  if (n.includes('spin')) return 'spin';
  if (n.includes('sng') || (t.max_players || 0) <= 10) return 'sng';
  return 'mtt';
}
