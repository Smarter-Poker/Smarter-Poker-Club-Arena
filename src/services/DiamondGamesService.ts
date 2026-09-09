/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND GAMES SERVICE - Plinko and Crash
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-08: two alternates to the Diamond Wheel, a Plinko board and a
 * Crash (Aviator-style) curve, 50x or higher, a crash pays nothing, the 20
 * percent edge kept, and neither ever pays out more than it takes in.
 *
 * NOTHING IS DECIDED HERE. fn_diamond_game_state says what a bet can win right
 * now (the cap the pool can promise on it), fn_plinko_drop and fn_crash_start /
 * fn_crash_settle are the money doors, and the browser draws what they say:
 * the ball follows the path the server rolled, the curve is read off the
 * server's clock. The design: supabase/migrations/20260908010241.
 */

import { supabase } from '../lib/supabase';

export type DiamondGame = 'plinko' | 'crash';

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const intOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Math.trunc(num(v));
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export interface GameBetOption {
  bet_diamonds: number;
  bet_chips: number;
  /** The largest multiplier the pool can promise on this bet right now, in cents. */
  cap_cents: number;
  playable: boolean;
}

export interface PlinkoTable {
  version: number;
  name: string;
  rows: number;
  multipliers_cents: number[];
  max_multiplier_cents: number;
  spec_rtp: number;
  sd_chips: number;
  hit_rate: number;
  note: string;
}

export interface GameConfigView {
  diamonds_per_chip: number;
  min_bet_diamonds: number;
  max_bet_diamonds: number;
  exposure_allowance_chips: number;
  cap_fraction: number;
  max_multiplier_cents: number;
  growth_k: number;
  purchased_only: boolean;
  max_rounds_per_player_per_day: number;
  min_seconds_between_rounds: number;
  spec_rtp: number;
  house_share: number;
}

export interface GamePoolView {
  rounds: number;
  intake_diamonds: number;
  chips_minted: number;
  chips_paid: number;
  reserved_chips: number;
  headroom_chips: number;
  realized_rtp: number | null;
}

export interface GamePlayerView {
  diamonds: number;
  purchased_available: number;
  spendable: number;
  rounds_today: number;
  seconds_until_next: number;
  is_member: boolean;
  member_chips: number | null;
}

export interface GameState {
  ok: boolean;
  error?: string;
  available: boolean;
  reason?: string;
  game: DiamondGame;
  host_id: string;
  host_kind: 'union' | 'club';
  club_id: string;
  config?: GameConfigView;
  bets: GameBetOption[];
  tables: PlinkoTable[];
  open_round: CrashRound | null;
  pool?: GamePoolView;
  player?: GamePlayerView;
  frozen: boolean;
}

export interface GameCommit {
  ok: boolean;
  error?: string;
  commit_id: string;
  server_seed_hash: string;
  expires_at: string;
}

export interface PlinkoDrop {
  ok: boolean;
  error?: string;
  detail?: string;
  replayed: boolean;
  cap_cents?: number;
  drop_id: string;
  club_id: string;
  host_id: string;
  table_version: number;
  bet_diamonds: number;
  bet_chips: number;
  diamonds_per_chip: number;
  outcome: {
    slot: number;
    path_bits: number;
    path: number[];
    table_multiplier_cents: number;
    cap_multiplier_cents: number;
    multiplier_cents: number;
    capped: boolean;
    payout_chips: number;
  };
  fairness: {
    commit_id: string;
    server_seed_hash: string;
    server_seed: string;
    client_seed: string;
    nonce: number;
    hmac_hex: string;
  };
  balances: { diamonds: number; member_chips: number | null };
  pool: { chips_minted: number; chips_paid: number };
  created_at: string;
}

export type CrashStatus = 'open' | 'cashed' | 'crashed';

export interface CrashRound {
  ok: boolean;
  error?: string;
  detail?: string;
  replayed: boolean;
  resumed: boolean;
  frozen?: boolean;
  cap_cents_hint?: number;
  round_id: string;
  club_id: string;
  host_id: string;
  status: CrashStatus;
  bet_diamonds: number;
  bet_chips: number;
  diamonds_per_chip: number;
  cap_cents: number;
  growth_k: number;
  auto_cashout_cents: number | null;
  started_at: string;
  server_now: string;
  elapsed_ms: number;
  multiplier_now_cents: number | null;
  outcome: {
    status: CrashStatus;
    cashout_cents: number | null;
    crash_cents: number;
    payout_chips: number;
    settled_by: string;
    settled_at: string;
  } | null;
  fairness: {
    commit_id: string;
    server_seed_hash: string;
    client_seed: string;
    nonce: number;
    server_seed?: string;
    roll?: number;
    crash_cents?: number;
  };
  balances: { diamonds: number; member_chips: number | null };
  pool: { chips_minted: number | null; chips_paid: number | null };
  created_at: string;
}

export interface GameMetricsWindow {
  window: '1h' | '24h' | '7d';
  rounds: number;
  intake_chips: number;
  paid_chips: number;
  realized_rtp: number | null;
  z: number | null;
  constrained: number;
  instant_crashes?: number;
  drift: boolean;
}

export interface GameMetrics {
  ok: boolean;
  error?: string;
  configured: boolean;
  game: DiamondGame;
  host_id: string;
  host_kind: 'union' | 'club';
  config?: GameConfigFull;
  pool: {
    rounds: number;
    intake_diamonds: number;
    chips_minted: number;
    chips_paid: number;
    reserved_chips: number;
    constrained_rounds: number;
  } | null;
  bank_chips: number;
  open_rounds: number;
  exposure_chips: number;
  exposure_headroom_chips: number;
  realized_rtp_lifetime: number | null;
  house_take_lifetime_chips: number | null;
  constrained_rate: number | null;
  invariant_ok?: boolean;
  windows: GameMetricsWindow[];
  tables: Array<{
    version: number;
    name: string;
    spec_rtp: number | null;
    sd_chips: number | null;
    hit_rate: number | null;
    max_multiplier_cents: number;
    activated_at: string | null;
  }>;
}

export interface GameConfigFull {
  enabled: boolean;
  min_bet_diamonds: number;
  max_bet_diamonds: number;
  bet_options: number[];
  exposure_allowance_chips: number;
  cap_fraction: number;
  max_multiplier_cents: number;
  growth_k: number;
  purchased_only: boolean;
  allow_fixture_accounts: boolean;
  max_rounds_per_player_per_day: number;
  min_seconds_between_rounds: number;
  updated_at: string;
}

export interface GameConfigPatch {
  enabled?: boolean;
  min_bet_diamonds?: number;
  max_bet_diamonds?: number;
  bet_options?: number[];
  exposure_allowance_chips?: number;
  cap_fraction?: number;
  max_multiplier_cents?: number;
  growth_k?: number;
  purchased_only?: boolean;
  allow_fixture_accounts?: boolean;
  max_rounds_per_player_per_day?: number;
  min_seconds_between_rounds?: number;
}

function normaliseTable(raw: Record<string, unknown>): PlinkoTable {
  return {
    version: num(raw.version),
    name: String(raw.name ?? ''),
    rows: num(raw.rows) || 16,
    multipliers_cents: Array.isArray(raw.multipliers_cents)
      ? (raw.multipliers_cents as unknown[]).map(num)
      : [],
    max_multiplier_cents: num(raw.max_multiplier_cents),
    spec_rtp: num(raw.spec_rtp),
    sd_chips: num(raw.sd_chips),
    hit_rate: num(raw.hit_rate),
    note: String(raw.note ?? ''),
  };
}

function normaliseCrash(raw: Record<string, unknown>): CrashRound {
  const outcome = raw.outcome ? rec(raw.outcome) : null;
  const fairness = rec(raw.fairness);
  const balances = rec(raw.balances);
  const pool = rec(raw.pool);
  return {
    ok: Boolean(raw.ok),
    error: raw.error ? String(raw.error) : undefined,
    detail: raw.detail ? String(raw.detail) : undefined,
    replayed: Boolean(raw.replayed),
    resumed: Boolean(raw.resumed),
    frozen: raw.frozen === undefined ? undefined : Boolean(raw.frozen),
    cap_cents_hint:
      raw.cap_cents !== undefined && raw.round_id === undefined ? num(raw.cap_cents) : undefined,
    round_id: String(raw.round_id ?? ''),
    club_id: String(raw.club_id ?? ''),
    host_id: String(raw.host_id ?? ''),
    status: (raw.status as CrashStatus) ?? 'open',
    bet_diamonds: num(raw.bet_diamonds),
    bet_chips: num(raw.bet_chips),
    diamonds_per_chip: num(raw.diamonds_per_chip),
    cap_cents: num(raw.cap_cents),
    growth_k: num(raw.growth_k),
    auto_cashout_cents: intOrNull(raw.auto_cashout_cents),
    started_at: String(raw.started_at ?? ''),
    server_now: String(raw.server_now ?? ''),
    elapsed_ms: num(raw.elapsed_ms),
    multiplier_now_cents: intOrNull(raw.multiplier_now_cents),
    outcome: outcome
      ? {
          status: (outcome.status as CrashStatus) ?? 'crashed',
          cashout_cents: intOrNull(outcome.cashout_cents),
          crash_cents: num(outcome.crash_cents),
          payout_chips: num(outcome.payout_chips),
          settled_by: String(outcome.settled_by ?? ''),
          settled_at: String(outcome.settled_at ?? ''),
        }
      : null,
    fairness: {
      commit_id: String(fairness.commit_id ?? ''),
      server_seed_hash: String(fairness.server_seed_hash ?? ''),
      client_seed: String(fairness.client_seed ?? ''),
      nonce: num(fairness.nonce),
      server_seed: fairness.server_seed ? String(fairness.server_seed) : undefined,
      roll: fairness.roll === undefined ? undefined : num(fairness.roll),
      crash_cents: fairness.crash_cents === undefined ? undefined : num(fairness.crash_cents),
    },
    balances: { diamonds: num(balances.diamonds), member_chips: numOrNull(balances.member_chips) },
    pool: { chips_minted: numOrNull(pool.chips_minted), chips_paid: numOrNull(pool.chips_paid) },
    created_at: String(raw.created_at ?? ''),
  };
}

function normaliseDrop(raw: Record<string, unknown>): PlinkoDrop {
  const outcome = rec(raw.outcome);
  const fairness = rec(raw.fairness);
  const balances = rec(raw.balances);
  const pool = rec(raw.pool);
  return {
    ok: Boolean(raw.ok),
    error: raw.error ? String(raw.error) : undefined,
    detail: raw.detail ? String(raw.detail) : undefined,
    replayed: Boolean(raw.replayed),
    cap_cents: raw.cap_cents === undefined ? undefined : num(raw.cap_cents),
    drop_id: String(raw.drop_id ?? ''),
    club_id: String(raw.club_id ?? ''),
    host_id: String(raw.host_id ?? ''),
    table_version: num(raw.table_version),
    bet_diamonds: num(raw.bet_diamonds),
    bet_chips: num(raw.bet_chips),
    diamonds_per_chip: num(raw.diamonds_per_chip),
    outcome: {
      slot: num(outcome.slot),
      path_bits: num(outcome.path_bits),
      path: Array.isArray(outcome.path) ? (outcome.path as unknown[]).map(num) : [],
      table_multiplier_cents: num(outcome.table_multiplier_cents),
      cap_multiplier_cents: num(outcome.cap_multiplier_cents),
      multiplier_cents: num(outcome.multiplier_cents),
      capped: Boolean(outcome.capped),
      payout_chips: num(outcome.payout_chips),
    },
    fairness: {
      commit_id: String(fairness.commit_id ?? ''),
      server_seed_hash: String(fairness.server_seed_hash ?? ''),
      server_seed: String(fairness.server_seed ?? ''),
      client_seed: String(fairness.client_seed ?? ''),
      nonce: num(fairness.nonce),
      hmac_hex: String(fairness.hmac_hex ?? ''),
    },
    balances: { diamonds: num(balances.diamonds), member_chips: numOrNull(balances.member_chips) },
    pool: { chips_minted: num(pool.chips_minted), chips_paid: num(pool.chips_paid) },
    created_at: String(raw.created_at ?? ''),
  };
}

function normaliseState(raw: Record<string, unknown>): GameState {
  const config = raw.config ? rec(raw.config) : undefined;
  const pool = raw.pool ? rec(raw.pool) : undefined;
  const player = raw.player ? rec(raw.player) : undefined;
  return {
    ok: Boolean(raw.ok),
    error: raw.error ? String(raw.error) : undefined,
    available: Boolean(raw.available),
    reason: raw.reason ? String(raw.reason) : undefined,
    game: (raw.game as DiamondGame) ?? 'plinko',
    host_id: String(raw.host_id ?? ''),
    host_kind: (raw.host_kind as 'union' | 'club') ?? 'club',
    club_id: String(raw.club_id ?? ''),
    config: config
      ? {
          diamonds_per_chip: num(config.diamonds_per_chip),
          min_bet_diamonds: num(config.min_bet_diamonds),
          max_bet_diamonds: num(config.max_bet_diamonds),
          exposure_allowance_chips: num(config.exposure_allowance_chips),
          cap_fraction: num(config.cap_fraction),
          max_multiplier_cents: num(config.max_multiplier_cents),
          growth_k: num(config.growth_k),
          purchased_only: Boolean(config.purchased_only),
          max_rounds_per_player_per_day: num(config.max_rounds_per_player_per_day),
          min_seconds_between_rounds: num(config.min_seconds_between_rounds),
          spec_rtp: num(config.spec_rtp),
          house_share: num(config.house_share),
        }
      : undefined,
    bets: Array.isArray(raw.bets)
      ? (raw.bets as Record<string, unknown>[]).map((b) => ({
          bet_diamonds: num(b.bet_diamonds),
          bet_chips: num(b.bet_chips),
          cap_cents: num(b.cap_cents),
          playable: Boolean(b.playable),
        }))
      : [],
    tables: Array.isArray(raw.tables)
      ? (raw.tables as Record<string, unknown>[]).map(normaliseTable)
      : [],
    open_round: raw.open_round ? normaliseCrash(rec(raw.open_round)) : null,
    pool: pool
      ? {
          rounds: num(pool.rounds),
          intake_diamonds: num(pool.intake_diamonds),
          chips_minted: num(pool.chips_minted),
          chips_paid: num(pool.chips_paid),
          reserved_chips: num(pool.reserved_chips),
          headroom_chips: num(pool.headroom_chips),
          realized_rtp: numOrNull(pool.realized_rtp),
        }
      : undefined,
    player: player
      ? {
          diamonds: num(player.diamonds),
          purchased_available: num(player.purchased_available),
          spendable: num(player.spendable),
          rounds_today: num(player.rounds_today),
          seconds_until_next: num(player.seconds_until_next),
          is_member: Boolean(player.is_member),
          member_chips: numOrNull(player.member_chips),
        }
      : undefined,
    frozen: Boolean(raw.frozen),
  };
}

const DiamondGamesService = {
  async getState(clubId: string, game: DiamondGame): Promise<GameState> {
    const { data, error } = await supabase.rpc('fn_diamond_game_state', {
      p_club_id: clubId,
      p_game: game,
    });
    if (error) throw error;
    return normaliseState(rec(data));
  },

  async commit(game: DiamondGame): Promise<GameCommit> {
    const { data, error } = await supabase.rpc('fn_diamond_game_commit', { p_game: game });
    if (error) throw error;
    const raw = rec(data);
    return {
      ok: Boolean(raw.ok),
      error: raw.error ? String(raw.error) : undefined,
      commit_id: String(raw.commit_id ?? ''),
      server_seed_hash: String(raw.server_seed_hash ?? ''),
      expires_at: String(raw.expires_at ?? ''),
    };
  },

  /** The drop: idempotent on the commit, so a lost response replays the same ball. */
  async plinkoDrop(
    clubId: string,
    commitId: string,
    clientSeed: string,
    tableVersion: number,
    betDiamonds: number
  ): Promise<PlinkoDrop> {
    const { data, error } = await supabase.rpc('fn_plinko_drop', {
      p_club_id: clubId,
      p_commit_id: commitId,
      p_client_seed: clientSeed,
      p_table_version: tableVersion,
      p_bet_diamonds: betDiamonds,
    });
    if (error) throw error;
    return normaliseDrop(rec(data));
  },

  /** Start a round: the bet is taken, the crash point sealed, the payout reserved. */
  async crashStart(
    clubId: string,
    commitId: string,
    clientSeed: string,
    betDiamonds: number,
    autoCashoutCents: number | null
  ): Promise<CrashRound> {
    const { data, error } = await supabase.rpc('fn_crash_start', {
      p_club_id: clubId,
      p_commit_id: commitId,
      p_client_seed: clientSeed,
      p_bet_diamonds: betDiamonds,
      p_auto_cashout_cents: autoCashoutCents,
    });
    if (error) throw error;
    return normaliseCrash(rec(data));
  },

  /**
   * A tick (cashout = false) asks the server what the round is now; a cash-out
   * (cashout = true) asks it to settle at the multiplier its clock reads.
   */
  async crashSettle(roundId: string, cashout: boolean): Promise<CrashRound> {
    const { data, error } = await supabase.rpc('fn_crash_settle', {
      p_round_id: roundId,
      p_cashout: cashout,
    });
    if (error) throw error;
    return normaliseCrash(rec(data));
  },

  async plinkoHistory(clubId: string, limit = 25): Promise<PlinkoDrop[]> {
    const { data, error } = await supabase.rpc('fn_diamond_game_history', {
      p_club_id: clubId,
      p_game: 'plinko',
      p_limit: limit,
    });
    if (error) throw error;
    return Array.isArray(data) ? (data as Record<string, unknown>[]).map(normaliseDrop) : [];
  },

  async crashHistory(clubId: string, limit = 25): Promise<CrashRound[]> {
    const { data, error } = await supabase.rpc('fn_diamond_game_history', {
      p_club_id: clubId,
      p_game: 'crash',
      p_limit: limit,
    });
    if (error) throw error;
    return Array.isArray(data) ? (data as Record<string, unknown>[]).map(normaliseCrash) : [];
  },

  async metrics(clubId: string, game: DiamondGame): Promise<GameMetrics> {
    const { data, error } = await supabase.rpc('fn_diamond_game_metrics', {
      p_club_id: clubId,
      p_game: game,
    });
    if (error) throw error;
    const raw = rec(data);
    const cfg = raw.config ? rec(raw.config) : undefined;
    const pool = raw.pool ? rec(raw.pool) : null;
    return {
      ok: Boolean(raw.ok),
      error: raw.error ? String(raw.error) : undefined,
      configured: Boolean(raw.configured),
      game: (raw.game as DiamondGame) ?? game,
      host_id: String(raw.host_id ?? ''),
      host_kind: (raw.host_kind as 'union' | 'club') ?? 'club',
      config: cfg
        ? {
            enabled: Boolean(cfg.enabled),
            min_bet_diamonds: num(cfg.min_bet_diamonds),
            max_bet_diamonds: num(cfg.max_bet_diamonds),
            bet_options: Array.isArray(cfg.bet_options)
              ? (cfg.bet_options as unknown[]).map(num)
              : [],
            exposure_allowance_chips: num(cfg.exposure_allowance_chips),
            cap_fraction: num(cfg.cap_fraction),
            max_multiplier_cents: num(cfg.max_multiplier_cents),
            growth_k: num(cfg.growth_k),
            purchased_only: Boolean(cfg.purchased_only),
            allow_fixture_accounts: Boolean(cfg.allow_fixture_accounts),
            max_rounds_per_player_per_day: num(cfg.max_rounds_per_player_per_day),
            min_seconds_between_rounds: num(cfg.min_seconds_between_rounds),
            updated_at: String(cfg.updated_at ?? ''),
          }
        : undefined,
      pool: pool
        ? {
            rounds: num(pool.rounds),
            intake_diamonds: num(pool.intake_diamonds),
            chips_minted: num(pool.chips_minted),
            chips_paid: num(pool.chips_paid),
            reserved_chips: num(pool.reserved_chips),
            constrained_rounds: num(pool.constrained_rounds),
          }
        : null,
      bank_chips: num(raw.bank_chips),
      open_rounds: num(raw.open_rounds),
      exposure_chips: num(raw.exposure_chips),
      exposure_headroom_chips: num(raw.exposure_headroom_chips),
      realized_rtp_lifetime: numOrNull(raw.realized_rtp_lifetime),
      house_take_lifetime_chips: numOrNull(raw.house_take_lifetime_chips),
      constrained_rate: numOrNull(raw.constrained_rate),
      invariant_ok: raw.invariant_ok === undefined ? undefined : Boolean(raw.invariant_ok),
      windows: Array.isArray(raw.windows)
        ? (raw.windows as Record<string, unknown>[]).map((w) => ({
            window: (w.window as GameMetricsWindow['window']) ?? '24h',
            rounds: num(w.rounds),
            intake_chips: num(w.intake_chips),
            paid_chips: num(w.paid_chips),
            realized_rtp: numOrNull(w.realized_rtp),
            z: numOrNull(w.z),
            constrained: num(w.constrained),
            instant_crashes: w.instant_crashes === undefined ? undefined : num(w.instant_crashes),
            drift: Boolean(w.drift),
          }))
        : [],
      tables: Array.isArray(raw.tables)
        ? (raw.tables as Record<string, unknown>[]).map((t) => ({
            version: num(t.version),
            name: String(t.name ?? ''),
            spec_rtp: numOrNull(t.spec_rtp),
            sd_chips: numOrNull(t.sd_chips),
            hit_rate: numOrNull(t.hit_rate),
            max_multiplier_cents: num(t.max_multiplier_cents),
            activated_at: t.activated_at ? String(t.activated_at) : null,
          }))
        : [],
    };
  },

  async setConfig(
    clubId: string,
    game: DiamondGame,
    patch: GameConfigPatch
  ): Promise<{ ok: boolean; error?: string }> {
    const { data, error } = await supabase.rpc('fn_diamond_game_set_config', {
      p_club_id: clubId,
      p_game: game,
      p_patch: patch,
    });
    if (error) throw error;
    const raw = rec(data);
    return { ok: Boolean(raw.ok), error: raw.error ? String(raw.error) : undefined };
  },
};

export default DiamondGamesService;
