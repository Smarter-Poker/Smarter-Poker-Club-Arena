/** Server-owned Diamond Spins. The browser renders the committed receipt; it
 * never chooses a prize. V2 has twelve non-empty sectors and funded game awards.
 * Legacy RPCs remain exclusively for inactive hosts and old-request recovery. */

import { supabase } from '../lib/supabase';
import { assertWheelAward } from '../utils/wheelAward';

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
}

export interface WheelState {
  contract_version?: 2;
  enabled?: boolean;
  min_entry?: number;
  max_entry?: number;
  max_funded_entry?: number;
  welcome?: { available: boolean; entry_diamonds: number };
  pending_awards?: WheelBonusAward[];
  ok: boolean;
  error?: string;
  available: boolean;
  reason?: string;
  host_id: string;
  host_kind: 'union' | 'club';
  club_id?: string;
  config?: WheelConfigView;
  segments: WheelSegment[];
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

export interface WheelFairness {
  domain?: 'wheel-v2' | 'wheel-v2-upgrade';
  commit_id: string;
  server_seed_hash: string;
  server_seed: string;
  client_seed: string;
  nonce: number;
  roll: number;
  weight_total: number;
  eligible_ords: number[];
  locked: Array<{ ord: number; reason: string; unlocks_at: number }>;
}

export interface WheelSpinResult {
  contract_version?: 2;
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
  };
  bonus?: WheelBonusAward;
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
  };
}

function normaliseState(raw: Record<string, unknown>): WheelState {
  const config = raw.config as Record<string, unknown> | undefined;
  const pool = raw.pool as Record<string, unknown> | undefined;
  const player = raw.player as Record<string, unknown> | undefined;
  return {
    contract_version: raw.contract_version === 2 ? 2 : undefined,
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
    pending_awards: Array.isArray(raw.awards)
      ? raw.awards.map((a) => normaliseAward(a as Record<string, unknown>))
      : [],
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
    ...(fairness.domain === 'wheel-v2' || fairness.domain === 'wheel-v2-upgrade'
      ? { domain: fairness.domain }
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
  };
}

function normaliseSpin(raw: Record<string, unknown>): WheelSpinResult {
  const outcome = (raw.outcome ?? {}) as Record<string, unknown>;
  const fairness = (raw.fairness ?? {}) as Record<string, unknown>;
  const balances = (raw.balances ?? {}) as Record<string, unknown>;
  const pool = (raw.pool ?? {}) as Record<string, unknown>;
  return {
    ok: Boolean(raw.ok),
    error: raw.error ? String(raw.error) : undefined,
    detail: raw.detail ? String(raw.detail) : undefined,
    contract_version: raw.contract_version === 2 ? 2 : undefined,
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
    },
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
    (raw.ok === false && typeof raw.error !== 'string') ||
    (raw.ok === true && (!raw.spin_id || !raw.fairness || !raw.outcome))
  ) {
    throw new Error('The Spin Receipt Could Not Be Confirmed');
  }
  const result = normaliseSpin(raw);
  if (result.ok) assertWheelAward(result);
  return result;
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
    if (!data || data.contract_version !== 2 || typeof data.enabled !== 'boolean')
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
    const { data, error } = await supabase.rpc('fn_wheel_spin_v2', {
      p_club_id: input.clubId,
      p_commit_id: input.commitId,
      p_client_seed: input.clientSeed,
      p_entry_diamonds: input.entryDiamonds,
      p_mode: input.mode === 'daily_bonus' ? 'daily' : input.mode,
      p_bonus_ticket_id: input.ticketId,
    });
    if (error) throw error;
    const result = spinResponse(data);
    if (result.ok && result.contract_version !== 2)
      throw new Error('The Diamond Spins Receipt Version Could Not Be Confirmed');
    return result;
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
    const { data, error } = await supabase.rpc('fn_wheel_daily_bonus_spin', {
      p_club_id: clubId,
      p_commit_id: commitId,
      p_client_seed: clientSeed,
      p_ticket_id: ticketId,
    });
    if (error) throw error;
    if (data?.ok === false && typeof data.error === 'string') return normaliseSpin(data);
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
    const { data, error } = await supabase.rpc('fn_wheel_spin', {
      p_club_id: clubId,
      p_commit_id: commitId,
      p_client_seed: clientSeed,
    });
    if (error) throw error;
    return spinResponse(data);
  },

  async history(clubId: string, limit = 25): Promise<WheelSpinResult[]> {
    const { data, error } = await supabase.rpc('fn_wheel_history', {
      p_club_id: clubId,
      p_limit: limit,
    });
    if (error) throw error;
    return Array.isArray(data) ? (data as Record<string, unknown>[]).map(normaliseSpin) : [];
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
    const { data, error } = await supabase.rpc('fn_wheel_welcome_spin', {
      p_club_id: clubId,
      p_commit_id: commitId,
      p_client_seed: clientSeed,
    });
    if (error) throw error;
    return spinResponse(data);
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
