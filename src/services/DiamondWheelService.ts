/** Server-owned Diamond Spins. The browser renders the committed receipt; it
 * never chooses a prize. V2 has twelve non-empty sectors and funded game awards.
 * Legacy RPCs remain exclusively for inactive hosts and old-request recovery. */

import { supabase } from '../lib/supabase';
import {
  assertWheelAward,
  assertWheelCardPick,
  assertWheelUpgradeTable,
} from '../utils/wheelAward';

export type WheelContractVersion = 2 | 3 | 4;
export type WheelDrawDomain =
  | 'wheel-v2'
  | 'wheel-v2-upgrade'
  | 'wheel-v3'
  | 'wheel-v3-upgrade'
  | 'wheel-v4'
  | 'wheel-v4-upgrade';
export const WHEEL_DRAW_DOMAINS: readonly WheelDrawDomain[] = [
  'wheel-v2',
  'wheel-v2-upgrade',
  'wheel-v3',
  'wheel-v3-upgrade',
  'wheel-v4',
  'wheel-v4-upgrade',
];

/** Legacy receipts retain their original kind; new tables never include an empty prize. */
export type WheelSegmentKind =
  | 'nothing'
  | 'chips'
  | 'diamonds'
  | 'bonus'
  | 'upgrade'
  | 'throwables'
  | 'time_bank'
  | 'rabbit_hunt';
export type WheelBonusGame = 'plinko' | 'crash' | 'crossing' | 'mines';

export type WheelInventoryGrant = { feature: string; uses: number };

export interface WheelSegment {
  ord: number;
  label: string;
  kind: WheelSegmentKind;
  /** Chips for kind chips, whole diamonds for kind diamonds, 0 for nothing. */
  amount: number;
  /** The prize in chips (dollars), diamonds converted at the bridge rate. */
  value_chips: number;
  weight: number;
  probability: number;
  locked: boolean;
  unlocks_at: number | null;
  game?: WheelBonusGame;
  multiplier?: number;
  grants?: WheelInventoryGrant[];
}

export interface WheelConfigView {
  spin_price_diamonds: number;
  diamonds_per_chip: number;
  spin_price_chips: number;
  segment_version: number;
  multiplier: number;
  purchased_only: boolean;
  max_spins_per_player_per_day: number;
  min_seconds_between_spins: number;
  spec_rtp: number;
  chip_share: number;
  diamond_share: number;
  house_share: number;
  hit_rate: number;
}

export interface WheelPoolView {
  spins: number;
  intake_diamonds: number;
  chips_paid: number;
  diamond_float: number;
  diamonds_paid: number;
  realized_rtp: number | null;
  /**
   * COVER: the promo wallet every chip prize comes out of first, the host's own
   * chip bank standing behind it, and the two together (Dan 2026-09-10: "the
   * back up is the union or club main bank, if the promo pool runs dry"). A
   * tier is locked when `cover_chips` cannot pay it, not when the promo wallet
   * alone cannot.
   */
  promo_wallet_chips: number;
  bank_chips: number;
  cover_chips: number;
  /** The welcome spins: what they have cost and what the host set aside. */
  welcome_chips_paid: number;
  welcome_budget_chips: number;
  welcome_spins: number;
  intake_chips: number;
}

export interface WheelPlayerView {
  diamonds: number;
  purchased_available: number;
  spendable: number;
  spins_today: number;
  /** Every diamond this player has put through all three games at this host today. */
  diamonds_today: number;
  seconds_until_next: number;
  is_member: boolean;
  member_chips: number | null;
}

export interface WheelBonusAward {
  id: string;
  game: WheelBonusGame;
  base_diamonds: number;
  boost_multiplier: number;
  entry_diamonds: number;
  /** When the wheel awarded it; absent from a receipt's own `bonus` and from older servers. */
  created_at?: string;
}

/**
 * A MULTI-SPIN RUN THE PLAYER STARTED (owner ruling 2026-09-21, R18). The
 * server keeps it, so a refresh mid-run comes back to "Resume Run" rather than
 * to a wheel that forgot. `spins_done` counts spins the server executed, which
 * is one ahead of the client's landed count while a wheel is still turning.
 */
export interface WheelAutoRun {
  run_id: string;
  spins: number;
  spins_done: number;
}

export interface WheelRunBegin {
  ok: boolean;
  error?: string;
  run_id: string;
  spins: number;
  spins_done: number;
}

export interface WheelRunEnd {
  ok: boolean;
  error?: string;
  run_id: string;
  spins_done: number;
  pending_awards: WheelBonusAward[];
  /** Card games the run won and left sealed. Empty on an older server. */
  pending_cards: WheelCardAward[];
}

export interface WheelState {
  contract_version?: WheelContractVersion;
  enabled?: boolean;
  min_entry?: number;
  max_entry?: number;
  max_funded_entry?: number;
  welcome?: { available: boolean; entry_diamonds: number };
  /** Every bonus game won and not yet played, oldest first. Empty on an older server. */
  pending_awards?: WheelBonusAward[];
  /**
   * Every three-card game won and not yet picked, oldest first. The server
   * refuses another spin while one of these is open, so this is what reopens
   * the cards after a reload, in a second tab, or on a later visit.
   */
  pending_cards?: WheelCardAward[];
  /** The open run, or null when none is open (and on an older server). */
  auto_run?: WheelAutoRun | null;
  ok: boolean;
  error?: string;
  available: boolean;
  reason?: string;
  host_id: string;
  host_kind: 'union' | 'club';
  club_id?: string;
  config?: WheelConfigView;
  segments: WheelSegment[];
  /** Server quote for Upgrade's secondary draw at the selected entry. */
  upgrade_segments?: WheelSegment[];
  pool?: WheelPoolView;
  player?: WheelPlayerView;
  frozen?: boolean;
}

export interface WheelCommit {
  ok: boolean;
  error?: string;
  commit_id: string;
  server_seed_hash: string;
  expires_at: string;
}

/**
 * Why the welcome spin is not on offer. 'used' means this member has already
 * had theirs, which is once and for all now, not once a day; 'unfunded' means
 * the host has not set a welcome budget; 'pot_empty' means it is spent.
 */
export type WheelWelcomeReason =
  | 'closed'
  | 'unfunded'
  | 'used'
  | 'pot_empty'
  | 'not_member'
  | 'owner';

/**
 * THE WELCOME SPIN (Dan 2026-09-10): "free spin should be once for a new user
 * 100 diamonds ... they simply receive no diamonds but are allowing a free 100
 * diamond spin for new members." One spin per member per host, ever, on the
 * real wheel at the real price, with the payout coming out of the promo wallet
 * against a budget the host declares.
 */
export interface WheelWelcomeState {
  ok: boolean;
  error?: string;
  /** The host offers a welcome spin at all (the wheel and the switch both on). */
  enabled: boolean;
  /** This member may take theirs right now. */
  available: boolean;
  reason: WheelWelcomeReason | null;
  /** This member has already had theirs. Once, ever, not once a day. */
  used: boolean;
  /** Always true: it is stated so the page never has to assume it. */
  once_only: boolean;
  /** What the spin would have cost, which is what the host is giving up. */
  spin_price_diamonds: number;
  /**
   * The host's welcome budget in chips, and what the CURRENT WINDOW has spent
   * and has left. budget_period_days is that window (0 meaning for ever), and
   * the window slides: nothing resets it, it is summed from the spins inside it.
   */
  budget_chips: number;
  budget_period_days: number;
  budget_paid_chips: number;
  budget_left_chips: number;
  /**
   * The biggest prize this table can pay. A welcome spin is the whole wheel or
   * it is not offered, so this is what the window has to be able to cover.
   */
  top_prize_chips: number;
  /** Every welcome chip this host has ever given away, across all windows. */
  lifetime_chips_paid: number;
  /** How many welcome spins this host has given away. */
  welcome_spins: number;
  segments: WheelSegment[];
}

export interface WheelWelcomePatch {
  welcome_spin_enabled?: boolean;
  welcome_budget_chips?: number;
  /** The budget's window in days. 0 means it never turns. */
  welcome_budget_period_days?: number;
}

export interface WheelDailyBonusState {
  ok: boolean;
  available: boolean;
  reason: string | null;
  ticket_count: number;
  ticket_id: string | null;
  entry_diamonds: number;
  segments: WheelSegment[];
}

/**
 * WHAT THE PREVIOUS SPIN WAS, so this one could not repeat it (owner ruling
 * 2026-09-21, R12). `tier` is 'super' when the previous final outcome came off
 * the Upgrade wheel, which is what excludes the ordinary game of the same name
 * as well. Null on a player's very first spin, and absent before contract 4.
 */
export interface WheelPreviousOutcome {
  spin_id: string;
  ord: number;
  game: WheelBonusGame | null;
  tier: 'main' | 'super';
}

export interface WheelFairness {
  domain?: WheelDrawDomain;
  commit_id: string;
  server_seed_hash: string;
  server_seed: string;
  client_seed: string;
  nonce: number;
  roll: number;
  weight_total: number;
  eligible_ords: number[];
  locked: Array<{ ord: number; reason: string; unlocks_at: number }>;
  /** Contract 4: the previous final outcome this draw had to avoid, or null. */
  previous?: WheelPreviousOutcome | null;
  /**
   * Contract 4: the weights this draw ACTUALLY used, one per ord, zero where
   * the follow-up law excluded a segment. The published table in `segments`
   * keeps the base weights, so the odds a player is shown never move.
   */
  weights?: number[];
}

/**
 * THE THREE-CARD GAME (owner ruling 2026-09-21, R15). A Diamonds outcome pays
 * nothing at the spin: it seals three cards worth half, double and triple the
 * diamonds risked. The values stay sealed until the player picks.
 */
export interface WheelCardAward {
  award_id: string;
  risk_diamonds: number;
  status: 'pending';
  /** The spin that dealt it. Listed with a pending award, absent from the receipt's own block. */
  spin_id?: string;
  created_at?: string;
}

/** What the player reads when the database would not turn a card over. */
export const CARD_NOT_PICKED = 'That Card Could Not Be Turned Over';

/**
 * The answer to one pick. A refusal has no reveal behind it, so it carries no
 * seed, no values and no figure: there is nothing to draw and nothing to pay.
 */
export type WheelCardPickAnswer = { ok: true; pick: WheelCardPick } | { ok: false; error: string };

export interface WheelCardPick {
  ok: boolean;
  error?: string;
  replayed?: boolean;
  award_id: string;
  spin_id: string;
  picked: number;
  /** All three prizes, by card position, revealed once the pick is made. */
  cards: number[];
  paid_diamonds: number;
  risk_diamonds: number;
  value_chips?: number;
  balances: { diamonds: number };
  fairness: {
    domain: 'wheel-v4-cards';
    roll: number;
    permutation: number;
    server_seed: string;
    server_seed_hash: string;
    client_seed: string;
    nonce: number;
  };
}

export interface WheelSpinResult {
  contract_version?: WheelContractVersion;
  /** The draw model this receipt was produced by, from contract 4 on. */
  model?: string;
  /** Whether the server drew this spin from the VIP table (owner ruling R2). */
  vip?: boolean;
  segments?: WheelSegment[];
  ok: boolean;
  error?: string;
  detail?: string;
  replayed?: boolean;
  /** True for a spin on the house: paid in diamonds, priced at nothing. */
  welcome: boolean;
  daily_bonus?: boolean;
  bonus_ticket_id?: string | null;
  player_cost_diamonds?: number;
  entry_value_diamonds?: number;
  entry_funded_by?: string;
  spin_id: string;
  club_id: string;
  host_id: string;
  segment_version: number;
  spin_price_diamonds: number;
  diamonds_per_chip: number;
  outcome: {
    ord: number;
    kind: WheelSegmentKind;
    amount: number;
    label: string;
    value_chips: number;
    game?: WheelBonusGame;
    multiplier?: number;
    grants?: WheelInventoryGrant[];
    /** A Diamonds outcome from contract 4: the sealed three-card game it opened. */
    cards?: WheelCardAward;
  };
  bonus?: WheelBonusAward;
  /** The open run this spin belonged to, when one was open (owner ruling R18). */
  auto_run?: WheelAutoRun;
  secondary?: { segments: WheelSegment[]; outcome: WheelSegment; fairness: WheelFairness };
  fairness: WheelFairness;
  balances: { diamonds: number; member_chips: number | null };
  pool: { chips_paid: number; diamond_float: number };
  created_at: string;
}

export interface WheelMetricsWindow {
  window: '1h' | '24h' | '7d';
  spins: number;
  intake_chips: number;
  paid_chips: number;
  realized_rtp: number | null;
  z: number | null;
  constrained: number;
  drift: boolean;
}

export interface WheelMetrics {
  ok: boolean;
  error?: string;
  configured: boolean;
  host_id: string;
  host_kind: 'union' | 'club';
  config?: {
    enabled: boolean;
    spin_price_diamonds: number;
    segment_version: number;
    exposure_allowance_chips: number;
    diamond_seed: number;
    purchased_only: boolean;
    allow_fixture_accounts: boolean;
    max_spins_per_player_per_day: number;
    min_seconds_between_spins: number;
    welcome_spin_enabled: boolean;
    welcome_budget_chips: number;
    welcome_budget_period_days: number;
    updated_at: string;
  };
  pool?: {
    spins: number;
    intake_diamonds: number;
    mint_carry: number;
    chips_paid: number;
    diamond_float: number;
    diamonds_paid: number;
    constrained_spins: number;
    welcome_chips_paid: number;
    welcome_spins: number;
  } | null;
  /**
   * COVER and its two halves. The promo wallet pays first, the host's own chip
   * bank backs it, and `cover_chips` is what a prize may actually draw on.
   */
  cover_chips?: number;
  promo_chips?: number;
  bank_chips?: number;
  /** The welcome spins, and the budget the host set aside for them. */
  welcome_budget_chips?: number;
  welcome_chips_paid?: number;
  welcome_budget_left_chips?: number;
  welcome_spins?: number;
  /** What the wheel has taken in, in chips at the bridge rate. */
  intake_chips?: number;
  /** The host's owner, and the diamond wallet the intake lands in. */
  owner_id?: string | null;
  owner_diamonds?: number;
  exposure_chips?: number;
  exposure_headroom_chips?: number;
  realized_rtp_lifetime?: number | null;
  house_take_lifetime_chips?: number | null;
  lock_rate?: number | null;
  invariant_ok?: boolean;
  windows?: WheelMetricsWindow[];
  audit?: {
    weight_total: number;
    spec_rtp: number;
    chip_share: number;
    diamond_share: number;
    house_share: number;
    sd_chips: number;
    hit_rate: number;
    segments: number;
  };
}

export interface WheelConfigPatch {
  enabled?: boolean;
  spin_price_diamonds?: number;
  segment_version?: number;
  exposure_allowance_chips?: number;
  diamond_seed?: number;
  purchased_only?: boolean;
  allow_fixture_accounts?: boolean;
  max_spins_per_player_per_day?: number;
  min_seconds_between_spins?: number;
}

/** PostgREST hands `numeric` back as a string. Make it a number, exactly once. */
export function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return num(value);
}

function normaliseSegment(raw: Record<string, unknown>): WheelSegment {
  return {
    ord: num(raw.ord),
    label: String(raw.label ?? ''),
    kind: (raw.kind as WheelSegmentKind) ?? 'nothing',
    amount: num(raw.amount),
    value_chips: num(raw.value_chips),
    weight: num(raw.weight),
    probability: num(raw.probability),
    locked: Boolean(raw.locked),
    unlocks_at: numOrNull(raw.unlocks_at),
    game: typeof raw.game === 'string' ? (raw.game as WheelBonusGame) : undefined,
    multiplier: raw.multiplier == null ? undefined : num(raw.multiplier),
  };
}

function normaliseAward(raw: Record<string, unknown>): WheelBonusAward {
  return {
    id: String(raw.id ?? ''),
    game: raw.game as WheelBonusGame,
    base_diamonds: num(raw.base_diamonds),
    boost_multiplier: num(raw.boost_multiplier),
    entry_diamonds: num(raw.entry_diamonds),
    ...(typeof raw.created_at === 'string' ? { created_at: raw.created_at } : {}),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The queue of unplayed bonus games. `pending_awards` is the R18 contract; `awards` the older name. */
function normaliseAwards(raw: Record<string, unknown>): WheelBonusAward[] {
  const list = Array.isArray(raw.pending_awards)
    ? raw.pending_awards
    : Array.isArray(raw.awards)
      ? raw.awards
      : [];
  return list
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object')
    .map(normaliseAward);
}

/**
 * THE THREE-CARD GAME'S AWARD, WHICHEVER DOOR NAMED IT. A spin's own receipt
 * calls it `award_id`; `fn_wheel_card_public`, which is what a state read and
 * a run close list, calls the same value `id` and adds the spin that dealt it.
 * One award, one shape, so the page has one thing to open whether the card
 * game just landed or was found waiting.
 */
function normaliseCardAward(raw: Record<string, unknown>): WheelCardAward {
  return {
    award_id: String(raw.award_id ?? raw.id ?? ''),
    risk_diamonds: num(raw.risk_diamonds),
    status: 'pending',
    ...(typeof raw.spin_id === 'string' ? { spin_id: raw.spin_id } : {}),
    ...(typeof raw.created_at === 'string' ? { created_at: raw.created_at } : {}),
  };
}

/**
 * Unpicked card games, oldest first. A row this client could not act on (no
 * award to send it against, a stake outside the wheel's own limits) is dropped
 * rather than drawn face down with nothing behind it; the server still holds
 * the real one, and the state read that finds it again is the way back to it.
 */
function normaliseCardAwards(raw: Record<string, unknown>): WheelCardAward[] {
  return (Array.isArray(raw.pending_cards) ? raw.pending_cards : [])
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
    .map(normaliseCardAward)
    .filter(
      (c) =>
        UUID.test(c.award_id) &&
        Number.isSafeInteger(c.risk_diamonds) &&
        c.risk_diamonds >= 25 &&
        c.risk_diamonds <= 2500
    );
}

/** One reveal, exactly as fn_wheel_diamond_cards_pick wrote it. */
function normaliseCardPick(raw: Record<string, unknown>): WheelCardPick {
  const fairness = (raw.fairness ?? {}) as Record<string, unknown>;
  const balances = (raw.balances ?? {}) as Record<string, unknown>;
  return {
    ok: raw.ok === true,
    error: raw.error ? String(raw.error) : undefined,
    replayed: raw.replayed === true,
    award_id: String(raw.award_id ?? ''),
    spin_id: String(raw.spin_id ?? ''),
    picked: num(raw.picked),
    cards: Array.isArray(raw.cards) ? raw.cards.map(num) : [],
    paid_diamonds: num(raw.paid_diamonds),
    risk_diamonds: num(raw.risk_diamonds),
    ...(raw.value_chips == null ? {} : { value_chips: num(raw.value_chips) }),
    balances: { diamonds: num(balances.diamonds) },
    fairness: {
      // Carried, never assumed: a draw from another domain is a different game,
      // and assertWheelCardPick is what refuses one.
      domain: String(fairness.domain ?? '') as WheelCardPick['fairness']['domain'],
      roll: num(fairness.roll),
      permutation: num(fairness.permutation),
      server_seed: String(fairness.server_seed ?? ''),
      server_seed_hash: String(fairness.server_seed_hash ?? ''),
      client_seed: String(fairness.client_seed ?? ''),
      nonce: num(fairness.nonce),
    },
  };
}

/** An open run, or null: an absent field (older server) and a malformed one both read as no run. */
function normaliseAutoRun(raw: unknown): WheelAutoRun | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const run = raw as Record<string, unknown>;
  const run_id = String(run.run_id ?? '');
  const spins = num(run.spins);
  const spins_done = num(run.spins_done);
  if (
    !UUID.test(run_id) ||
    !Number.isSafeInteger(spins) ||
    spins <= 0 ||
    !Number.isSafeInteger(spins_done) ||
    spins_done < 0 ||
    spins_done > spins
  )
    return null;
  return { run_id, spins, spins_done };
}

/** 2, 3 or 4, and nothing else: an unreadable contract is never guessed at. */
function contractVersion(raw: unknown): WheelContractVersion | undefined {
  return raw === 2 || raw === 3 || raw === 4 ? raw : undefined;
}

function normaliseState(raw: Record<string, unknown>): WheelState {
  const config = raw.config as Record<string, unknown> | undefined;
  const pool = raw.pool as Record<string, unknown> | undefined;
  const player = raw.player as Record<string, unknown> | undefined;
  return {
    contract_version: contractVersion(raw.contract_version),
    enabled: raw.enabled === true,
    min_entry: num(raw.min_entry),
    max_entry: num(raw.max_entry),
    max_funded_entry: raw.max_funded_entry == null ? undefined : num(raw.max_funded_entry),
    welcome:
      raw.welcome && typeof raw.welcome === 'object'
        ? {
            available: (raw.welcome as Record<string, unknown>).available === true,
            entry_diamonds: num((raw.welcome as Record<string, unknown>).entry_diamonds),
          }
        : undefined,
    pending_awards: normaliseAwards(raw),
    pending_cards: normaliseCardAwards(raw),
    auto_run: normaliseAutoRun(raw.auto_run),
    ok: Boolean(raw.ok),
    error: raw.error ? String(raw.error) : undefined,
    available: Boolean(raw.available),
    reason: raw.reason ? String(raw.reason) : undefined,
    host_id: String(raw.host_id ?? ''),
    host_kind: (raw.host_kind as 'union' | 'club') ?? 'club',
    club_id: raw.club_id ? String(raw.club_id) : undefined,
    config: config
      ? {
          spin_price_diamonds: num(config.spin_price_diamonds),
          diamonds_per_chip: num(config.diamonds_per_chip),
          spin_price_chips: num(config.spin_price_chips),
          segment_version: num(config.segment_version),
          multiplier: num(config.multiplier),
          purchased_only: Boolean(config.purchased_only),
          max_spins_per_player_per_day: num(config.max_spins_per_player_per_day),
          min_seconds_between_spins: num(config.min_seconds_between_spins),
          spec_rtp: num(config.spec_rtp),
          chip_share: num(config.chip_share),
          diamond_share: num(config.diamond_share),
          house_share: num(config.house_share),
          hit_rate: num(config.hit_rate),
        }
      : undefined,
    segments: Array.isArray(raw.segments)
      ? (raw.segments as Record<string, unknown>[]).map(normaliseSegment)
      : [],
    upgrade_segments: Array.isArray(raw.upgrade_segments)
      ? (raw.upgrade_segments as Record<string, unknown>[]).map(normaliseSegment)
      : undefined,
    pool: pool
      ? {
          spins: num(pool.spins),
          intake_diamonds: num(pool.intake_diamonds),
          chips_paid: num(pool.chips_paid),
          diamond_float: num(pool.diamond_float),
          diamonds_paid: num(pool.diamonds_paid),
          realized_rtp: numOrNull(pool.realized_rtp),
          promo_wallet_chips: num(pool.promo_wallet_chips),
          bank_chips: num(pool.bank_chips),
          cover_chips: num(pool.cover_chips),
          welcome_chips_paid: num(pool.welcome_chips_paid),
          welcome_budget_chips: num(pool.welcome_budget_chips),
          welcome_spins: num(pool.welcome_spins),
          intake_chips: num(pool.intake_chips),
        }
      : undefined,
    player: player
      ? {
          diamonds: num(player.diamonds),
          purchased_available: num(player.purchased_available),
          spendable: num(player.spendable),
          spins_today: num(player.spins_today),
          diamonds_today: num(player.diamonds_today),
          seconds_until_next: num(player.seconds_until_next),
          is_member: Boolean(player.is_member),
          member_chips: numOrNull(player.member_chips),
        }
      : undefined,
    frozen: Boolean(raw.frozen),
  };
}

function normaliseFairness(fairness: Record<string, unknown>): WheelFairness {
  return {
    ...(WHEEL_DRAW_DOMAINS.includes(fairness.domain as WheelDrawDomain)
      ? { domain: fairness.domain as WheelDrawDomain }
      : {}),
    commit_id: String(fairness.commit_id ?? ''),
    server_seed_hash: String(fairness.server_seed_hash ?? ''),
    server_seed: String(fairness.server_seed ?? ''),
    client_seed: String(fairness.client_seed ?? ''),
    nonce: num(fairness.nonce),
    roll: num(fairness.roll),
    weight_total: num(fairness.weight_total),
    eligible_ords: Array.isArray(fairness.eligible_ords)
      ? (fairness.eligible_ords as unknown[]).map(num)
      : [],
    locked: Array.isArray(fairness.locked)
      ? (fairness.locked as Record<string, unknown>[]).map((l) => ({
          ord: num(l.ord),
          reason: String(l.reason ?? ''),
          unlocks_at: num(l.unlocks_at),
        }))
      : [],
    // Contract 4 only. `previous` is deliberately null on a first spin, which is
    // not the same as an older server never having sent the field at all.
    ...(Array.isArray(fairness.weights)
      ? { weights: (fairness.weights as unknown[]).map(num) }
      : {}),
    ...(fairness.previous === null
      ? { previous: null }
      : fairness.previous && typeof fairness.previous === 'object'
        ? { previous: normalisePrevious(fairness.previous as Record<string, unknown>) }
        : {}),
  };
}

function normalisePrevious(raw: Record<string, unknown>): WheelPreviousOutcome {
  return {
    spin_id: String(raw.spin_id ?? ''),
    ord: num(raw.ord),
    game: typeof raw.game === 'string' ? (raw.game as WheelBonusGame) : null,
    tier: raw.tier === 'super' ? 'super' : 'main',
  };
}

function normaliseSpin(raw: Record<string, unknown>): WheelSpinResult {
  const run = normaliseAutoRun(raw.auto_run);
  const outcome = (raw.outcome ?? {}) as Record<string, unknown>;
  const fairness = (raw.fairness ?? {}) as Record<string, unknown>;
  const balances = (raw.balances ?? {}) as Record<string, unknown>;
  const pool = (raw.pool ?? {}) as Record<string, unknown>;
  return {
    ok: Boolean(raw.ok),
    error: raw.error ? String(raw.error) : undefined,
    detail: raw.detail ? String(raw.detail) : undefined,
    contract_version: contractVersion(raw.contract_version),
    segments: Array.isArray(raw.segments)
      ? (raw.segments as Record<string, unknown>[]).map(normaliseSegment)
      : undefined,
    replayed: Boolean(raw.replayed),
    welcome: Boolean(raw.welcome),
    daily_bonus: raw.daily_bonus === true,
    bonus_ticket_id: typeof raw.bonus_ticket_id === 'string' ? raw.bonus_ticket_id : null,
    player_cost_diamonds: num(raw.player_cost_diamonds ?? raw.spin_price_diamonds),
    entry_value_diamonds: num(raw.entry_value_diamonds ?? raw.spin_price_diamonds),
    entry_funded_by: typeof raw.entry_funded_by === 'string' ? raw.entry_funded_by : undefined,
    spin_id: String(raw.spin_id ?? ''),
    club_id: String(raw.club_id ?? ''),
    host_id: String(raw.host_id ?? ''),
    segment_version: num(raw.segment_version),
    spin_price_diamonds: num(raw.spin_price_diamonds),
    diamonds_per_chip: num(raw.diamonds_per_chip),
    outcome: {
      ord: num(outcome.ord),
      kind: (outcome.kind as WheelSegmentKind) ?? 'nothing',
      amount: num(outcome.amount),
      label: String(outcome.label ?? ''),
      value_chips: num(outcome.value_chips),
      game: typeof outcome.game === 'string' ? (outcome.game as WheelBonusGame) : undefined,
      multiplier: outcome.multiplier == null ? undefined : num(outcome.multiplier),
      grants: Array.isArray(outcome.grants)
        ? outcome.grants.map((grant: Record<string, unknown>) => ({
            feature: String(grant.feature),
            uses: num(grant.uses),
          }))
        : undefined,
      cards:
        outcome.cards && typeof outcome.cards === 'object'
          ? {
              award_id: String((outcome.cards as Record<string, unknown>).award_id ?? ''),
              risk_diamonds: num((outcome.cards as Record<string, unknown>).risk_diamonds),
              status: 'pending' as const,
            }
          : undefined,
    },
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
    ...(typeof raw.vip === 'boolean' ? { vip: raw.vip } : {}),
    ...(run ? { auto_run: run } : {}),
    bonus: raw.bonus ? normaliseAward(raw.bonus as Record<string, unknown>) : undefined,
    secondary: raw.secondary
      ? {
          segments: Array.isArray((raw.secondary as Record<string, unknown>).segments)
            ? (
                (raw.secondary as Record<string, unknown>).segments as Record<string, unknown>[]
              ).map(normaliseSegment)
            : [],
          outcome: normaliseSegment(
            ((raw.secondary as Record<string, unknown>).outcome ?? {}) as Record<string, unknown>
          ),
          fairness: normaliseFairness(
            ((raw.secondary as Record<string, unknown>).fairness ?? {}) as Record<string, unknown>
          ),
        }
      : undefined,
    fairness: normaliseFairness(fairness),
    balances: { diamonds: num(balances.diamonds), member_chips: numOrNull(balances.member_chips) },
    pool: {
      chips_paid: num(pool.chips_paid),
      diamond_float: num(pool.diamond_float),
    },
    created_at: String(raw.created_at ?? ''),
  };
}

function spinResponse(data: unknown): WheelSpinResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('The Spin Receipt Could Not Be Confirmed');
  }
  const raw = data as Record<string, unknown>;
  if (
    typeof raw.ok !== 'boolean' ||
    (raw.contract_version != null && contractVersion(raw.contract_version) === undefined) ||
    (raw.ok === false && typeof raw.error !== 'string') ||
    (raw.ok === true && (!raw.spin_id || !raw.fairness || !raw.outcome))
  ) {
    throw new Error('The Spin Receipt Could Not Be Confirmed');
  }
  const result = normaliseSpin(raw);
  if (result.ok) assertWheelAward(result);
  return result;
}

/**
 * AN ERROR THE DATABASE ANSWERED IS AN ANSWER (2026-09-22).
 *
 * Every spin door replays a spent commit before it can move anything, and again
 * under the host lock that serialises spins, so a spin whose answer was lost is
 * sent again safely: if the first send committed, the next one is answered by
 * that spin's receipt, never by a second spin. An error carrying a SQLSTATE says
 * what a lost answer cannot. The database ran THIS execution and rolled it
 * back, and there was no committed spin behind it (an earlier committed send
 * would have been answered by the replay, not by an error). Nothing was
 * charged. The wheel used to treat it as unconfirmed and send it again every
 * eight seconds for as long as the page stayed open, with the exit guard
 * holding the player on it.
 *
 *  - A SQLSTATE that passes (a serialization failure, a deadlock, a lock not
 *    available in time, a statement timeout), and PostgREST saying it could not
 *    reach the database at all (PGRST000-003), may be sent again: the same saved
 *    request, until one commit has met such an answer SPIN_SENDS_PER_COMMIT
 *    times. That answer is a refusal.
 *  - Any other SQLSTATE, and any other PostgREST code, is a refusal at once: it
 *    is the answer every later send would get.
 *  - No code at all (the network, a gateway page) says nothing about whether the
 *    spin ran, so the page keeps sending the saved request until it hears back.
 */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '55P03', '57014']);
export const SPIN_SENDS_PER_COMMIT = 3;
/** What the player reads when the database answered a spin with an error. */
export const SPIN_NOT_TAKEN = 'The Wheel Could Not Take That Spin';
/** Sends of each commit that met a passing error, while it may still be sent. */
const passingSends = new Map<string, number>();

export type SpinErrorKind = 'refused' | 'transient' | 'unknown';

/** What an error from a spin RPC says about the spin. */
export function spinErrorKind(error: unknown): SpinErrorKind {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  if (code.startsWith('PGRST')) return /^PGRST00[0-3]$/.test(code) ? 'transient' : 'refused';
  if (/^[0-9A-Z]{5}$/.test(code)) return TRANSIENT_SQLSTATES.has(code) ? 'transient' : 'refused';
  return 'unknown';
}

/**
 * The database answered the spin and this browser cannot verify what it said.
 * Unlike a lost answer, money may have moved, so the page keeps the saved spin;
 * unlike a lost answer, the same bytes will not verify on a later send, so the
 * page stops sending it after a few of these (DiamondWheelPage).
 */
export class WheelReceiptUnverified extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'The Spin Receipt Could Not Be Confirmed');
    this.name = 'WheelReceiptUnverified';
  }
}

/** Read an answered spin. A body that does not verify is WheelReceiptUnverified. */
function verifiedSpin(read: () => WheelSpinResult): WheelSpinResult {
  try {
    return read();
  } catch (error) {
    throw new WheelReceiptUnverified(error);
  }
}

/**
 * Send one spin. Resolves with the body the database answered, or with a
 * refusal the page acts on (it clears the saved spin and deals the next
 * ticket); throws when the same saved request should be sent again.
 */
async function sendSpin(
  fn: string,
  args: Record<string, unknown>,
  commitId: string,
  refusal: string = SPIN_NOT_TAKEN
) {
  const { data, error } = await supabase.rpc(fn, args);
  if (!error) {
    passingSends.delete(commitId);
    return data;
  }
  const kind = spinErrorKind(error);
  if (kind === 'unknown') throw error;
  if (kind === 'transient') {
    const sends = (passingSends.get(commitId) ?? 0) + 1;
    if (sends < SPIN_SENDS_PER_COMMIT) {
      passingSends.set(commitId, sends);
      throw error;
    }
  }
  passingSends.delete(commitId);
  return { ok: false, error: refusal };
}

/** Paid and welcome spins in one list, newest first, for the player's own history. */

function normaliseWelcomeState(raw: Record<string, unknown>): WheelWelcomeState {
  const reason = raw.reason ? String(raw.reason) : null;
  return {
    ok: Boolean(raw.ok),
    error: raw.error ? String(raw.error) : undefined,
    enabled: Boolean(raw.enabled),
    available: Boolean(raw.available),
    reason:
      reason === 'closed' ||
      reason === 'unfunded' ||
      reason === 'used' ||
      reason === 'pot_empty' ||
      reason === 'not_member' ||
      reason === 'owner'
        ? reason
        : null,
    used: Boolean(raw.used),
    once_only: raw.once_only === undefined ? true : Boolean(raw.once_only),
    spin_price_diamonds: num(raw.spin_price_diamonds),
    budget_chips: num(raw.budget_chips),
    budget_period_days: num(raw.budget_period_days),
    budget_paid_chips: num(raw.budget_paid_chips),
    budget_left_chips: num(raw.budget_left_chips),
    top_prize_chips: num(raw.top_prize_chips),
    lifetime_chips_paid: num(raw.lifetime_chips_paid),
    welcome_spins: num(raw.welcome_spins),
    segments: Array.isArray(raw.segments)
      ? (raw.segments as Record<string, unknown>[]).map(normaliseSegment)
      : [],
  };
}

const DiamondWheelService = {
  /** An explicit inactive contract permits legacy play; an unreadable one never does. */
  async getStateV2(clubId: string, entryDiamonds = 100): Promise<WheelState> {
    const { data, error } = await supabase.rpc('fn_wheel_state_v2', {
      p_club_id: clubId,
      p_entry_diamonds: entryDiamonds,
    });
    if (error) throw error;
    if (
      !data ||
      contractVersion(data.contract_version) === undefined ||
      typeof data.enabled !== 'boolean'
    )
      throw new Error('Diamond Spins Availability Could Not Be Confirmed');
    if (!data.enabled) return this.getState(clubId);
    const state = normaliseState(data);
    // The server deliberately omits a prize table until a host is configured.
    // Keep that closed state visible without downgrading to another play route.
    if (state.ok && !state.available && state.reason === 'not_configured') return state;
    if (
      state.min_entry !== 25 ||
      state.max_entry !== 2500 ||
      state.segments.length !== 12 ||
      state.segments.some((s) => s.kind === 'nothing')
    )
      throw new Error('The Diamond Spins Prize Table Could Not Be Confirmed');
    if (state.contract_version !== undefined && state.contract_version >= 3) {
      if (state.config?.spin_price_diamonds !== entryDiamonds)
        throw new Error('The Diamond Spins Prize Table Could Not Be Confirmed');
      assertWheelUpgradeTable(
        state.upgrade_segments,
        entryDiamonds,
        state.config.diamonds_per_chip
      );
    }
    return state;
  },

  async spinV2(input: {
    clubId: string;
    commitId: string;
    clientSeed: string;
    entryDiamonds: number;
    mode: 'paid' | 'welcome' | 'daily_bonus';
    ticketId: string | null;
  }): Promise<WheelSpinResult> {
    const data = await sendSpin(
      'fn_wheel_spin_v2',
      {
        p_club_id: input.clubId,
        p_commit_id: input.commitId,
        p_client_seed: input.clientSeed,
        p_entry_diamonds: input.entryDiamonds,
        p_mode: input.mode === 'daily_bonus' ? 'daily' : input.mode,
        p_bonus_ticket_id: input.ticketId,
      },
      input.commitId
    );
    return verifiedSpin(() => {
      const result = spinResponse(data);
      if (result.ok && contractVersion(result.contract_version) === undefined)
        throw new Error('The Diamond Spins Receipt Version Could Not Be Confirmed');
      return result;
    });
  },

  /**
   * THE RUN IS THE SERVER'S (owner ruling 2026-09-21, R18). A run of 5, 10 or
   * 25 paid spins is declared before its first spin so that the bonus games it
   * wins can pile up unplayed until the end, and so that a refresh mid-run
   * finds the run still open. A refusal comes back as `{ ok: false, error }`;
   * a reply that is not a run at all is thrown, never guessed at.
   */
  async runBegin(clubId: string, spins: number): Promise<WheelRunBegin> {
    const { data, error } = await supabase.rpc('fn_wheel_run_begin', {
      p_club_id: clubId,
      p_spins: spins,
    });
    if (error) throw error;
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean')
      throw new Error('The Run Could Not Be Started');
    const raw = data as Record<string, unknown>;
    if (raw.ok === false) {
      return {
        ok: false,
        error: typeof raw.error === 'string' ? raw.error : 'The Run Could Not Be Started',
        run_id: '',
        spins: 0,
        spins_done: 0,
      };
    }
    const run = normaliseAutoRun(raw);
    if (!run || run.spins !== spins) throw new Error('The Run Could Not Be Confirmed');
    return { ok: true, ...run };
  },

  /** Close a run. The queue of bonus games it left unplayed comes back with it. */
  async runEnd(runId: string): Promise<WheelRunEnd> {
    const { data, error } = await supabase.rpc('fn_wheel_run_end', { p_run_id: runId });
    if (error) throw error;
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean')
      throw new Error('The Run Could Not Be Closed');
    const raw = data as Record<string, unknown>;
    if (raw.ok === false) {
      return {
        ok: false,
        error: typeof raw.error === 'string' ? raw.error : 'The Run Could Not Be Closed',
        run_id: runId,
        spins_done: 0,
        pending_awards: [],
        pending_cards: [],
      };
    }
    const spins_done = num(raw.spins_done);
    if (String(raw.run_id ?? '') !== runId || !Number.isSafeInteger(spins_done) || spins_done < 0)
      throw new Error('The Run Could Not Be Confirmed');
    return {
      ok: true,
      run_id: runId,
      spins_done,
      pending_awards: normaliseAwards(raw),
      pending_cards: normaliseCardAwards(raw),
    };
  },

  /**
   * TURN ONE OF THE THREE CARDS OVER (owner ruling 2026-09-21, R15).
   *
   * `fn_wheel_diamond_cards_pick` is idempotent on the AWARD rather than on
   * this request: an award already picked answers with its FIRST pick's
   * reveal and `replayed: true`, whatever card this send carried. So a pick
   * whose answer was lost is sent again with the identity the player chose,
   * and the second send can neither pay twice nor take a different card.
   *
   * A refusal the database ANSWERED is an answer: it comes back as
   * `{ ok: false }` and the page stops sending. Anything else throws, and the
   * page's own schedule sends the same saved pick again.
   */
  async pickCard(awardId: string, card: number): Promise<WheelCardPickAnswer> {
    const data = await sendSpin(
      'fn_wheel_diamond_cards_pick',
      { p_award_id: awardId, p_card: card },
      `card:${awardId}`,
      CARD_NOT_PICKED
    );
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('The Card Reveal Could Not Be Confirmed');
    const raw = data as Record<string, unknown>;
    if (typeof raw.ok !== 'boolean') throw new Error('The Card Reveal Could Not Be Confirmed');
    if (raw.ok === false)
      return { ok: false, error: typeof raw.error === 'string' ? raw.error : CARD_NOT_PICKED };
    const pick = normaliseCardPick(raw);
    assertWheelCardPick(pick, awardId, card);
    return { ok: true, pick };
  },

  async dailyBonusState(clubId: string): Promise<WheelDailyBonusState> {
    const { data, error } = await supabase.rpc('fn_wheel_daily_bonus_state', { p_club_id: clubId });
    if (error) throw error;
    if (
      !data ||
      data.ok !== true ||
      typeof data.available !== 'boolean' ||
      !Number.isInteger(data.ticket_count) ||
      data.ticket_count < 0 ||
      data.entry_diamonds !== 100 ||
      data.funded_by !== 'mint' ||
      data.claim_required !== true ||
      (data.ticket_count > 0 && typeof data.ticket_id !== 'string')
    ) {
      throw new Error('Bonus Spin Availability Could Not Be Confirmed');
    }
    return {
      ok: true,
      available: data.available,
      reason: data.reason ?? null,
      ticket_count: data.ticket_count,
      ticket_id: data.ticket_id ?? null,
      entry_diamonds: 100,
      segments: Array.isArray(data.segments) ? data.segments.map(normaliseSegment) : [],
    };
  },

  async dailyBonusSpin(
    clubId: string,
    commitId: string,
    clientSeed: string,
    ticketId: string
  ): Promise<WheelSpinResult> {
    const data = await sendSpin(
      'fn_wheel_daily_bonus_spin',
      {
        p_club_id: clubId,
        p_commit_id: commitId,
        p_client_seed: clientSeed,
        p_ticket_id: ticketId,
      },
      commitId
    );
    if (data?.ok === false && typeof data.error === 'string') return normaliseSpin(data);
    return verifiedSpin(() => {
      if (
        data?.ok !== true ||
        data.daily_bonus !== true ||
        data.welcome !== false ||
        data.bonus_ticket_id !== ticketId ||
        data.club_id !== clubId ||
        data.fairness?.commit_id !== commitId ||
        data.fairness?.client_seed !== clientSeed ||
        data.player_cost_diamonds == null ||
        Number(data.player_cost_diamonds) !== 0 ||
        Number(data.entry_value_diamonds) !== 100 ||
        data.entry_funded_by !== 'mint' ||
        typeof data.spin_id !== 'string' ||
        !data.outcome
      ) {
        throw new Error('Bonus Spin Receipt Could Not Be Confirmed. Retry The Same Spin');
      }
      return spinResponse(data);
    });
  },

  /** Everything the wheel screen shows: table, odds, locks, the player's limits. */
  async getState(clubId: string): Promise<WheelState> {
    const { data, error } = await supabase.rpc('fn_wheel_state', { p_club_id: clubId });
    if (error) throw error;
    return normaliseState((data ?? {}) as Record<string, unknown>);
  },

  /** The server commits to a seed (by hash) before the player presses Spin. */
  async commit(): Promise<WheelCommit> {
    const { data, error } = await supabase.rpc('fn_wheel_commit');
    if (error) throw error;
    const raw = (data ?? {}) as Record<string, unknown>;
    return {
      ok: Boolean(raw.ok),
      error: raw.error ? String(raw.error) : undefined,
      commit_id: String(raw.commit_id ?? ''),
      server_seed_hash: String(raw.server_seed_hash ?? ''),
      expires_at: String(raw.expires_at ?? ''),
    };
  },

  /**
   * The spin. Idempotent on the commit: a lost response replays the same
   * answer and moves nothing twice.
   */
  async spin(clubId: string, commitId: string, clientSeed: string): Promise<WheelSpinResult> {
    const data = await sendSpin(
      'fn_wheel_spin',
      { p_club_id: clubId, p_commit_id: commitId, p_client_seed: clientSeed },
      commitId
    );
    return verifiedSpin(() => spinResponse(data));
  },

  async history(clubId: string, limit = 25): Promise<WheelSpinResult[]> {
    const { data, error } = await supabase.rpc('fn_wheel_history', {
      p_club_id: clubId,
      p_limit: limit,
    });
    if (error) throw error;
    return Array.isArray(data)
      ? (data as Record<string, unknown>[]).map((raw) =>
          raw.contract_version == null ? normaliseSpin(raw) : spinResponse(raw)
        )
      : [];
  },

  /** The welcome spin: whether this member still has theirs, and the table it pays from. */
  async welcomeState(clubId: string): Promise<WheelWelcomeState> {
    const { data, error } = await supabase.rpc('fn_wheel_welcome_state', { p_club_id: clubId });
    if (error) throw error;
    return normaliseWelcomeState((data ?? {}) as Record<string, unknown>);
  },

  /**
   * The welcome spin. The same commit as a paid spin, the same derivation over
   * the SAME table's weights, idempotent on the commit, and once per member: the
   * server refuses the second with its reason.
   */
  async welcomeSpin(
    clubId: string,
    commitId: string,
    clientSeed: string
  ): Promise<WheelSpinResult> {
    const data = await sendSpin(
      'fn_wheel_welcome_spin',
      { p_club_id: clubId, p_commit_id: commitId, p_client_seed: clientSeed },
      commitId
    );
    return verifiedSpin(() => spinResponse(data));
  },

  /** The operator's switch, budget and window for the welcome spin. The RPC decides who may. */
  async setWelcomeSpin(
    clubId: string,
    patch: WheelWelcomePatch
  ): Promise<{ ok: boolean; error?: string }> {
    const { data, error } = await supabase.rpc('fn_wheel_set_welcome_spin', {
      p_club_id: clubId,
      p_patch: patch,
    });
    if (error) throw error;
    const raw = (data ?? {}) as Record<string, unknown>;
    return { ok: Boolean(raw.ok), error: raw.error ? String(raw.error) : undefined };
  },

  /** Operator readings: exposure, realised return, the invariant, the z-score. */
  async metrics(clubId: string): Promise<WheelMetrics> {
    const { data, error } = await supabase.rpc('fn_wheel_metrics', { p_club_id: clubId });
    if (error) throw error;
    const raw = (data ?? {}) as Record<string, unknown>;
    const windows = Array.isArray(raw.windows)
      ? (raw.windows as Record<string, unknown>[]).map((w) => ({
          window: (w.window as WheelMetricsWindow['window']) ?? '24h',
          spins: num(w.spins),
          intake_chips: num(w.intake_chips),
          paid_chips: num(w.paid_chips),
          realized_rtp: numOrNull(w.realized_rtp),
          z: numOrNull(w.z),
          constrained: num(w.constrained),
          drift: Boolean(w.drift),
        }))
      : [];
    const cfg = raw.config as Record<string, unknown> | undefined;
    const pool = raw.pool as Record<string, unknown> | null | undefined;
    const audit = raw.audit as Record<string, unknown> | undefined;
    return {
      ok: Boolean(raw.ok),
      error: raw.error ? String(raw.error) : undefined,
      configured: Boolean(raw.configured),
      host_id: String(raw.host_id ?? ''),
      host_kind: (raw.host_kind as 'union' | 'club') ?? 'club',
      config: cfg
        ? {
            enabled: Boolean(cfg.enabled),
            spin_price_diamonds: num(cfg.spin_price_diamonds),
            segment_version: num(cfg.segment_version),
            exposure_allowance_chips: num(cfg.exposure_allowance_chips),
            diamond_seed: num(cfg.diamond_seed),
            purchased_only: Boolean(cfg.purchased_only),
            allow_fixture_accounts: Boolean(cfg.allow_fixture_accounts),
            max_spins_per_player_per_day: num(cfg.max_spins_per_player_per_day),
            min_seconds_between_spins: num(cfg.min_seconds_between_spins),
            welcome_spin_enabled: Boolean(cfg.welcome_spin_enabled),
            welcome_budget_chips: num(cfg.welcome_budget_chips),
            welcome_budget_period_days: num(cfg.welcome_budget_period_days),
            updated_at: String(cfg.updated_at ?? ''),
          }
        : undefined,
      pool: pool
        ? {
            spins: num(pool.spins),
            intake_diamonds: num(pool.intake_diamonds),
            mint_carry: num(pool.mint_carry),
            chips_paid: num(pool.chips_paid),
            diamond_float: num(pool.diamond_float),
            diamonds_paid: num(pool.diamonds_paid),
            constrained_spins: num(pool.constrained_spins),
            welcome_chips_paid: num(pool.welcome_chips_paid),
            welcome_spins: num(pool.welcome_spins),
          }
        : null,
      cover_chips: num(raw.cover_chips),
      promo_chips: num(raw.promo_chips),
      bank_chips: num(raw.bank_chips),
      welcome_budget_chips: num(raw.welcome_budget_chips),
      welcome_chips_paid: num(raw.welcome_chips_paid),
      welcome_budget_left_chips: num(raw.welcome_budget_left_chips),
      welcome_spins: num(raw.welcome_spins),
      intake_chips: num(raw.intake_chips),
      owner_id: raw.owner_id ? String(raw.owner_id) : null,
      owner_diamonds: num(raw.owner_diamonds),
      exposure_chips: num(raw.exposure_chips),
      exposure_headroom_chips: num(raw.exposure_headroom_chips),
      realized_rtp_lifetime: numOrNull(raw.realized_rtp_lifetime),
      house_take_lifetime_chips: numOrNull(raw.house_take_lifetime_chips),
      lock_rate: numOrNull(raw.lock_rate),
      invariant_ok: raw.invariant_ok === undefined ? undefined : Boolean(raw.invariant_ok),
      windows,
      audit: audit
        ? {
            weight_total: num(audit.weight_total),
            spec_rtp: num(audit.spec_rtp),
            chip_share: num(audit.chip_share),
            diamond_share: num(audit.diamond_share),
            house_share: num(audit.house_share),
            sd_chips: num(audit.sd_chips),
            hit_rate: num(audit.hit_rate),
            segments: num(audit.segments),
          }
        : undefined,
    };
  },

  /** Operator controls. The RPC decides who may; this only carries the patch. */
  async setConfig(
    clubId: string,
    patch: WheelConfigPatch
  ): Promise<{ ok: boolean; error?: string }> {
    const { data, error } = await supabase.rpc('fn_wheel_set_config', {
      p_club_id: clubId,
      p_patch: patch,
    });
    if (error) throw error;
    const raw = (data ?? {}) as Record<string, unknown>;
    return { ok: Boolean(raw.ok), error: raw.error ? String(raw.error) : undefined };
  },
};

export default DiamondWheelService;
/**
 * THE PICK THIS BROWSER SENT, KEPT UNTIL ITS REVEAL LANDS.
 *
 * Saved before the request leaves, exactly as a spin is, so an answer that
 * never arrives is sent again as the SAME pick rather than as a second,
 * different one. The server refuses another spin while a card game is open,
 * so there is at most one of these per player per club and one key holds it.
 */
export interface WheelPendingCard {
  userId: string;
  clubId: string;
  awardId: string;
  card: 1 | 2 | 3;
}

const cardKeyFor = (userId: string, clubId: string) => `diamond-wheel-card:v1:${userId}:${clubId}`;

function validCard(saved: WheelPendingCard, userId: string, clubId: string): boolean {
  return (
    Boolean(saved) &&
    saved.userId === userId &&
    saved.clubId === clubId &&
    UUID.test(String(saved.awardId)) &&
    (saved.card === 1 || saved.card === 2 || saved.card === 3)
  );
}

/**
 * A saved pick this build cannot send is not a pick: it is dropped rather than
 * replayed, which leaves the three cards face down where the server still has
 * them. Nothing is lost by that, because the award is only ever picked once.
 */
export function readWheelPendingCard(userId: string, clubId: string): WheelPendingCard | null {
  const key = cardKeyFor(userId, clubId);
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let saved: WheelPendingCard;
  try {
    saved = JSON.parse(raw) as WheelPendingCard;
  } catch {
    saved = { userId: '', clubId: '', awardId: '', card: 1 };
  }
  if (!validCard(saved, userId, clubId)) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Storage that cannot be written cannot hold a pick either. */
    }
    return null;
  }
  return saved;
}

/** Persist before the money request leaves. An unsaved pick is never sent. */
export function saveWheelPendingCard(saved: WheelPendingCard): void {
  if (!validCard(saved, saved.userId, saved.clubId))
    throw new Error('The Card Pick Could Not Be Saved');
  const key = cardKeyFor(saved.userId, saved.clubId);
  const value = JSON.stringify(saved);
  localStorage.setItem(key, value);
  if (localStorage.getItem(key) !== value) throw new Error('The Card Pick Could Not Be Saved');
}

/** Only the pick that owns the saved slot may clear it. */
export function clearWheelPendingCard(saved: WheelPendingCard): void {
  if (readWheelPendingCard(saved.userId, saved.clubId)?.awardId !== saved.awardId) return;
  try {
    localStorage.removeItem(cardKeyFor(saved.userId, saved.clubId));
  } catch {
    /* Nothing more this browser can do; the award is picked either way. */
  }
}
