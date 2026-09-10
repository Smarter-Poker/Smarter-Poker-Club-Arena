/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND WHEEL SERVICE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-07: a paid prize wheel inside Club Arena. A spin costs diamonds
 * and pays chips, diamonds or nothing at exactly 80 percent return to player,
 * and the wheel can never pay out more than it takes in. Rates are his ruling
 * of the same day: 1 diamond = $0.01, 1 chip = $1.00, read from ca_bridge_rate.
 *
 * NOTHING IS DECIDED HERE. Every number on the wheel screen comes from
 * fn_wheel_state; the outcome comes from fn_wheel_spin, which is the one
 * money door (SECURITY DEFINER, on the money RPC register, one row lock per
 * host). The browser draws the wheel landing on the segment the server names,
 * never the other way round. The fairness commit-and-reveal is the server's
 * too: fn_wheel_commit hands the player the hash of a seed before Spin, the
 * spin reveals the seed, and `src/utils/wheelFairness.ts` lets the browser
 * recompute the roll. The whole design: supabase/migrations/20260907233833.
 *
 * THE FREE SPIN (2026-09-09, supabase/migrations/20260909234101). One spin a
 * day on the house, per player per host, paying diamonds only and never
 * chips: a free spin takes nothing in, and the games never pay out more than
 * they take in. It has its own table (fn_wheel_free_state hands it back), its
 * own record (fn_wheel_free_spin, fn_wheel_free_history) and the SAME commit
 * and derivation as a paid spin, so the verifier below checks it unchanged.
 */

import { supabase } from '../lib/supabase';

export type WheelSegmentKind = 'nothing' | 'chips' | 'diamonds';

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
  chips_minted: number;
  chips_paid: number;
  diamond_float: number;
  diamonds_paid: number;
  realized_rtp: number | null;
}

export interface WheelPlayerView {
  diamonds: number;
  purchased_available: number;
  spendable: number;
  spins_today: number;
  seconds_until_next: number;
  is_member: boolean;
  member_chips: number | null;
}

export interface WheelState {
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

export type WheelFreeReason = 'closed' | 'used' | 'pot_empty' | 'not_member';

export interface WheelFreeState {
  ok: boolean;
  error?: string;
  /** The host runs a free spin at all (the wheel and the switch both on). */
  enabled: boolean;
  /** This player may take today's free spin right now. */
  available: boolean;
  reason: WheelFreeReason | null;
  used_today: boolean;
  /** The host's daily pot in diamonds, and what it has paid out today. */
  pot_diamonds: number;
  pot_paid_today: number;
  spins_today: number;
  segments: WheelSegment[];
  /** The day the count is kept by (America/Chicago), as YYYY-MM-DD. */
  day: string;
}

export interface WheelFreeSpinPatch {
  free_spin_enabled?: boolean;
  free_spin_daily_budget_diamonds?: number;
}

export interface WheelFairness {
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
  ok: boolean;
  error?: string;
  detail?: string;
  replayed?: boolean;
  /** True for a spin on the house: paid in diamonds, priced at nothing. */
  free: boolean;
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
  };
  fairness: WheelFairness;
  balances: { diamonds: number; member_chips: number | null };
  pool: { chips_minted: number; chips_paid: number; diamond_float: number };
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
    free_spin_enabled: boolean;
    free_spin_daily_budget_diamonds: number;
    updated_at: string;
  };
  pool?: {
    spins: number;
    intake_diamonds: number;
    chips_minted: number;
    mint_carry: number;
    chips_paid: number;
    diamond_float: number;
    diamonds_paid: number;
    constrained_spins: number;
  } | null;
  bank_chips?: number;
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
  };
}

function normaliseState(raw: Record<string, unknown>): WheelState {
  const config = raw.config as Record<string, unknown> | undefined;
  const pool = raw.pool as Record<string, unknown> | undefined;
  const player = raw.player as Record<string, unknown> | undefined;
  return {
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
          chips_minted: num(pool.chips_minted),
          chips_paid: num(pool.chips_paid),
          diamond_float: num(pool.diamond_float),
          diamonds_paid: num(pool.diamonds_paid),
          realized_rtp: numOrNull(pool.realized_rtp),
        }
      : undefined,
    player: player
      ? {
          diamonds: num(player.diamonds),
          purchased_available: num(player.purchased_available),
          spendable: num(player.spendable),
          spins_today: num(player.spins_today),
          seconds_until_next: num(player.seconds_until_next),
          is_member: Boolean(player.is_member),
          member_chips: numOrNull(player.member_chips),
        }
      : undefined,
    frozen: Boolean(raw.frozen),
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
    replayed: Boolean(raw.replayed),
    free: Boolean(raw.free),
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
    },
    fairness: {
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
    },
    balances: { diamonds: num(balances.diamonds), member_chips: numOrNull(balances.member_chips) },
    pool: {
      chips_minted: num(pool.chips_minted),
      chips_paid: num(pool.chips_paid),
      diamond_float: num(pool.diamond_float),
    },
    created_at: String(raw.created_at ?? ''),
  };
}

/** Paid and free spins in one list, newest first, for the player's own history. */
export function mergeSpinHistory(
  paid: WheelSpinResult[],
  free: WheelSpinResult[]
): WheelSpinResult[] {
  return [...paid, ...free].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

function normaliseFreeState(raw: Record<string, unknown>): WheelFreeState {
  const reason = raw.reason ? String(raw.reason) : null;
  return {
    ok: Boolean(raw.ok),
    error: raw.error ? String(raw.error) : undefined,
    enabled: Boolean(raw.enabled),
    available: Boolean(raw.available),
    reason:
      reason === 'closed' || reason === 'used' || reason === 'pot_empty' || reason === 'not_member'
        ? reason
        : null,
    used_today: Boolean(raw.used_today),
    pot_diamonds: num(raw.pot_diamonds),
    pot_paid_today: num(raw.pot_paid_today),
    spins_today: num(raw.spins_today),
    segments: Array.isArray(raw.segments)
      ? (raw.segments as Record<string, unknown>[]).map(normaliseSegment)
      : [],
    day: String(raw.day ?? ''),
  };
}

const DiamondWheelService = {
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
    return normaliseSpin((data ?? {}) as Record<string, unknown>);
  },

  async history(clubId: string, limit = 25): Promise<WheelSpinResult[]> {
    const { data, error } = await supabase.rpc('fn_wheel_history', {
      p_club_id: clubId,
      p_limit: limit,
    });
    if (error) throw error;
    return Array.isArray(data) ? (data as Record<string, unknown>[]).map(normaliseSpin) : [];
  },

  /** Today's free spin: whether this player has one, and the table it pays from. */
  async freeState(clubId: string): Promise<WheelFreeState> {
    const { data, error } = await supabase.rpc('fn_wheel_free_state', { p_club_id: clubId });
    if (error) throw error;
    return normaliseFreeState((data ?? {}) as Record<string, unknown>);
  },

  /**
   * The free spin. The same commit as a paid spin, the same derivation over
   * the free table's weights, idempotent on the commit, and one a day: the
   * server refuses the second with its reason.
   */
  async freeSpin(clubId: string, commitId: string, clientSeed: string): Promise<WheelSpinResult> {
    const { data, error } = await supabase.rpc('fn_wheel_free_spin', {
      p_club_id: clubId,
      p_commit_id: commitId,
      p_client_seed: clientSeed,
    });
    if (error) throw error;
    return normaliseSpin((data ?? {}) as Record<string, unknown>);
  },

  async freeHistory(clubId: string, limit = 25): Promise<WheelSpinResult[]> {
    const { data, error } = await supabase.rpc('fn_wheel_free_history', {
      p_club_id: clubId,
      p_limit: limit,
    });
    if (error) throw error;
    return Array.isArray(data) ? (data as Record<string, unknown>[]).map(normaliseSpin) : [];
  },

  /** The operator's switch and daily pot for the free spin. The RPC decides who may. */
  async setFreeSpin(
    clubId: string,
    patch: WheelFreeSpinPatch
  ): Promise<{ ok: boolean; error?: string }> {
    const { data, error } = await supabase.rpc('fn_wheel_set_free_spin', {
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
            free_spin_enabled: Boolean(cfg.free_spin_enabled),
            free_spin_daily_budget_diamonds: num(cfg.free_spin_daily_budget_diamonds),
            updated_at: String(cfg.updated_at ?? ''),
          }
        : undefined,
      pool: pool
        ? {
            spins: num(pool.spins),
            intake_diamonds: num(pool.intake_diamonds),
            chips_minted: num(pool.chips_minted),
            mint_carry: num(pool.mint_carry),
            chips_paid: num(pool.chips_paid),
            diamond_float: num(pool.diamond_float),
            diamonds_paid: num(pool.diamonds_paid),
            constrained_spins: num(pool.constrained_spins),
          }
        : null,
      bank_chips: num(raw.bank_chips),
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
