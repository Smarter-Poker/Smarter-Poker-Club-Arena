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

import { isInLateRegistration } from '../../utils/tournamentFilters';

// ─── Raw row shapes (subset the lobby queries actually select) ─────────────
export interface LobbyTableRow {
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
export function cashRuleMedallions(rawSettings: unknown, name: string): RuleMedallion[] {
  const s = parseTableSettings(rawSettings);
  const n = (name || '').toLowerCase();
  const rules: RuleMedallion[] = [];

  if (on(s, 'run_it_twice', 'runItTwice') || n.includes('rit')) {
    rules.push({
      key: 'rit',
      label: 'RUN IT TWICE',
      detail: s.run_it_twice_mandatory === true ? 'ALWAYS' : undefined,
      tip:
        s.run_it_twice_mandatory === true
          ? 'All-in pots always run the remaining cards twice'
          : 'Players may agree to run the remaining cards twice when all in',
    });
  }
  if (on(s, 'insurance_enabled', 'allInInsurance') || n.includes('insurance')) {
    rules.push({
      key: 'insurance',
      label: 'INSURANCE',
      tip: 'All-in insurance is available at this table',
    });
  }
  if (on(s, 'straddle_enabled', 'straddle') || n.includes('straddle')) {
    const type = String(s.straddle_type || s.straddleType || '').toUpperCase();
    rules.push({
      key: 'straddle',
      label: 'STRADDLE',
      detail: type ? type.slice(0, 3) : undefined,
      tip: type ? `${type} straddle is enabled` : 'Straddling is enabled at this table',
    });
  }
  if (on(s, 'bomb_pot_enabled', 'bombPot') || n.includes('bomb')) {
    const freq = num(s, 'bomb_pot_frequency', 'bombPotFrequency');
    const dbl = s.bomb_pot_double_board === true;
    rules.push({
      key: 'bomb',
      label: 'BOMB POTS',
      detail: freq ? `${freq}%` : undefined,
      tip: `Bomb pots${freq ? ` on ${freq}% of hands` : ''}${dbl ? ', dealt double board' : ''}`,
    });
  }
  if (on(s, 'ante_enabled')) {
    const amt = num(s, 'ante_amount');
    rules.push({
      key: 'ante',
      label: 'ANTE',
      detail: amt ? amt.toLocaleString() : undefined,
      tip: amt ? `Every player antes ${amt.toLocaleString()} each hand` : 'Antes are in play',
    });
  }
  if (on(s, 'double_board', 'doubleBoard')) {
    rules.push({
      key: 'double_board',
      label: 'DOUBLE BOARD',
      tip: 'Every hand is dealt with two boards',
    });
  }
  if (on(s, 'seven_deuce_enabled')) {
    const amt = num(s, 'seven_deuce_amount');
    rules.push({
      key: 'seven_deuce',
      label: 'SEVEN DEUCE',
      detail: amt ? amt.toLocaleString() : undefined,
      tip: 'Win with seven-deuce and every player pays you a bonus',
    });
  }
  if (on(s, 'time_bank_enabled')) {
    rules.push({
      key: 'time_bank',
      label: 'TIME BANK',
      tip: 'Players have a time bank for big decisions',
    });
  }
  if (on(s, 'vpip_display', 'vpipDisplay') || n.includes('vpip')) {
    rules.push({
      key: 'vpip',
      label: 'VPIP',
      tip: 'Player VPIP statistics are displayed at the table',
    });
  }
  if (on(s, 'call_time_enabled', 'callTime') || n.includes('call time')) {
    rules.push({ key: 'call_time', label: 'CALL TIME', tip: 'Call time rules are in effect' });
  }
  if (on(s, 'no_rathole', 'noRathole')) {
    rules.push({
      key: 'no_rathole',
      label: 'NO RATHOLE',
      tip: 'Players must return with their full previous stack',
    });
  }
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
          name: t.name,
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
  const minBuy = t.min_buy_in || t.big_blind * 20;
  const maxBuy = t.max_buy_in || t.big_blind * 100;
  return {
    id: t.id,
    kind: 'cash',
    name: t.name,
    gameLabel: v.short,
    variantLabel: v.long,
    stakesLabel: `${(t.small_blind || 0).toLocaleString()} / ${(t.big_blind || 0).toLocaleString()}`,
    stakesValue: Number(t.big_blind) || 0,
    buyInLabel: `${minBuy.toLocaleString()} - ${maxBuy.toLocaleString()}`,
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
    rules: cashRuleMedallions(t.settings, t.name),
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
    name: t.name,
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

/** The same spin / heads-up classification the card grid used. */
export function classifyTournament(t: LobbyTournamentRow): 'mtt' | 'spin' | 'sng' {
  const n = (t.name || '').toLowerCase();
  if (n.includes('spin')) return 'spin';
  if (n.includes('sng') || (t.max_players || 0) <= 10) return 'sng';
  return 'mtt';
}
