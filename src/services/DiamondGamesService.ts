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
  /** Every diamond this player has put through all three games at this host today. */
  diamonds_today: number;
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
  pool: { chips_paid: number };
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
  pool: { chips_paid: number | null };
  created_at: string;
}

/** One window of the operator's P and L, all three games together. */
export interface GamePnlWindow {
  window: string;
  rounds: number;
  intake_diamonds: number;
  intake_chips: number;
  chips_paid: number;
  diamonds_paid: number;
  welcome_chips: number;
  net_chips: number;
  games: Array<{
    game: string;
    rounds: number;
    intake_diamonds: number;
    chips_paid: number;
    diamonds_paid: number;
    net_chips: number;
  }>;
}

export interface GamePnl {
  ok: boolean;
  error?: string;
  diamonds_per_chip: number;
  windows: GamePnlWindow[];
}

/** open: the cover is not what limits the game. thin: it is. stopped: it cannot pay. */
export type GameRoomState = 'open' | 'thin' | 'stopped' | 'closed';

export interface GameRoom {
  ok: boolean;
  error?: string;
  cover_chips: number;
  promo_chips: number;
  bank_chips: number;
  owner_diamonds: number;
  games: Array<{
    game: string;
    enabled: boolean;
    state: GameRoomState;
    /** The three multiplier games: what a player could win at the largest bet. */
    max_win_chips?: number;
    intake_win_chips?: number;
    ceiling_win_chips?: number;
    capped_by_cover: boolean;
    capped_by_intake: boolean;
    /** The wheel, whose prizes are a fixed table rather than a multiplier. */
    top_chip_prize_chips?: number;
    top_diamond_prize_diamonds?: number;
    chip_prize_covered?: boolean;
    diamond_prize_covered?: boolean;
  }>;
}

export interface GamePlayers {
  ok: boolean;
  error?: string;
  spins_cap: number;
  rounds_cap: number;
  players: Array<{
    user_id: string;
    name: string;
    spins: number;
    rounds: number;
    spins_cap: number;
    rounds_cap: number;
    at_spin_cap: boolean;
    at_round_cap: boolean;
    spent_diamonds: number;
    spent_chips: number;
    won_chips: number;
    won_diamonds: number;
    net_chips: number;
  }>;
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
    chips_paid: number;
    reserved_chips: number;
    constrained_rounds: number;
  } | null;
  /**
   * COVER and its two halves: the promo wallet a payout comes out of first, and
   * the host's own chip bank standing behind it (Dan 2026-09-10, "the back up is
   * the union or club main bank, if the promo pool runs dry").
   */
  cover_chips: number;
  promo_chips: number;
  bank_chips: number;
  /** What the game has taken in, in chips at the bridge rate. */
  intake_chips: number;
  /** The host's owner, and the diamond wallet the intake lands in. */
  owner_id: string | null;
  owner_diamonds: number;
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

/** One win on the club's floor: who, which game, what it paid. Never a user id. */
export interface FloorWin {
  game: 'wheel' | 'plinko' | 'crash';
  at: string;
  kind: 'chips' | 'diamonds';
  amount: number;
  value_chips: number;
  multiplier_cents: number | null;
  name: string;
  avatar: string | null;
  mine: boolean;
}

export interface FloorCrashPoint {
  crash_cents: number;
  cashed: boolean;
  at: string;
}

/**
 * THE DOOR (Dan 2026-09-10): "when a player is out of chips or doesn't have
 * enough to rebuy into a tournament or rebuy into a cash game, they be prompted
 * to play diamonds to chips. there also needs to be a button for this inside
 * the club lobby." One read answers both, for a union host and a standalone
 * club alike: which games this club's host has open, what the cheapest way in
 * costs, what the player holds, and whether today's free spin is still there.
 */
export interface DiamondGamesEntry {
  ok: boolean;
  error?: string;
  host_kind: 'union' | 'club';
  diamonds_per_chip: number;
  games: { wheel: boolean; plinko: boolean; crash: boolean };
  /** The host has at least one game switched on. */
  open: boolean;
  /** Open, this player is a member, and the platform is not on its break. */
  available: boolean;
  spin_price_diamonds: number | null;
  min_bet_diamonds: number | null;
  /** The cheapest way in: a spin or the smallest bet. */
  entry_diamonds: number | null;
  diamonds: number;
  /** What those diamonds are worth in chips at the bridge rate. */
  chips_from_diamonds: number;
  is_member: boolean;
  member_chips: number | null;
  /**
   * This member still has their one free welcome spin here (2026-09-11). The
   * server answers under both names while the older one is still on the wire;
   * `free_spin_ready` was accurate when the spin was a daily one.
   */
  welcome_spin_ready: boolean;
  frozen: boolean;
}

export interface GameFloor {
  ok: boolean;
  error?: string;
  wins: FloorWin[];
  crash_points: FloorCrashPoint[];
  /** The host's five biggest wins of the last seven days, biggest first. */
  top_week: FloorWin[];
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
    pool: { chips_paid: numOrNull(pool.chips_paid) },
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
    pool: { chips_paid: num(pool.chips_paid) },
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
          diamonds_today: num(player.diamonds_today),
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
            chips_paid: num(pool.chips_paid),
            reserved_chips: num(pool.reserved_chips),
            constrained_rounds: num(pool.constrained_rounds),
          }
        : null,
      cover_chips: num(raw.cover_chips),
      promo_chips: num(raw.promo_chips),
      bank_chips: num(raw.bank_chips),
      intake_chips: num(raw.intake_chips),
      owner_id: raw.owner_id ? String(raw.owner_id) : null,
      owner_diamonds: num(raw.owner_diamonds),
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

  /**
   * The floor: the host's recent wins across all three games and its last
   * twenty crash points, named the way the club names a winner. No ids.
   */
  async floor(clubId: string, limit = 20): Promise<GameFloor> {
    const { data, error } = await supabase.rpc('fn_diamond_game_floor', {
      p_club_id: clubId,
      p_limit: limit,
    });
    if (error) throw error;
    const raw = rec(data);
    const wins = Array.isArray(raw.wins) ? (raw.wins as Record<string, unknown>[]) : [];
    const top = Array.isArray(raw.top_week) ? (raw.top_week as Record<string, unknown>[]) : [];
    const points = Array.isArray(raw.crash_points)
      ? (raw.crash_points as Record<string, unknown>[])
      : [];
    const win = (w: Record<string, unknown>): FloorWin => ({
      game: (w.game as FloorWin['game']) ?? 'wheel',
      at: String(w.at ?? ''),
      kind: (w.kind as FloorWin['kind']) ?? 'chips',
      amount: num(w.amount),
      value_chips: num(w.value_chips),
      multiplier_cents: intOrNull(w.multiplier_cents),
      name: String(w.name ?? 'Player'),
      avatar: w.avatar ? String(w.avatar) : null,
      mine: Boolean(w.mine),
    });
    return {
      ok: Boolean(raw.ok),
      error: raw.error ? String(raw.error) : undefined,
      wins: wins.map(win),
      top_week: top.map(win),
      crash_points: points.map((p) => ({
        crash_cents: num(p.crash_cents),
        cashed: Boolean(p.cashed),
        at: String(p.at ?? ''),
      })),
    };
  },

  /** Can this player turn diamonds into chips at this club, and what does it cost? */
  async entry(clubId: string): Promise<DiamondGamesEntry> {
    const { data, error } = await supabase.rpc('fn_diamond_games_entry', { p_club_id: clubId });
    if (error) throw error;
    const raw = rec(data);
    const games = rec(raw.games);
    return {
      ok: Boolean(raw.ok),
      error: raw.error ? String(raw.error) : undefined,
      host_kind: (raw.host_kind as 'union' | 'club') ?? 'club',
      diamonds_per_chip: num(raw.diamonds_per_chip) || 100,
      games: {
        wheel: Boolean(games.wheel),
        plinko: Boolean(games.plinko),
        crash: Boolean(games.crash),
      },
      open: Boolean(raw.open),
      available: Boolean(raw.available),
      spin_price_diamonds: intOrNull(raw.spin_price_diamonds),
      min_bet_diamonds: intOrNull(raw.min_bet_diamonds),
      entry_diamonds: intOrNull(raw.entry_diamonds),
      diamonds: num(raw.diamonds),
      chips_from_diamonds: num(raw.chips_from_diamonds),
      is_member: Boolean(raw.is_member),
      member_chips:
        raw.member_chips === null || raw.member_chips === undefined ? null : num(raw.member_chips),
      welcome_spin_ready: Boolean(raw.welcome_spin_ready ?? raw.free_spin_ready),
      frozen: Boolean(raw.frozen),
    };
  },

  /**
   * MOVE CHIPS FROM THE HOST'S BANK INTO ITS PROMO WALLET (Dan 2026-09-10).
   * The bank backs the promo wallet automatically, but an operator who wants
   * the float where it belongs should be able to put it there from the console
   * they are already looking at. Union owners and club owners alike; the server
   * decides who may.
   *
   * `key` is the caller's idempotency token and is REQUIRED. The server spends
   * it once: a press whose reply was lost must be retried under the same key or
   * the chips move twice. Mint one per intent and hold it across a failure.
   */
  async fundPromo(
    clubId: string,
    amountChips: number,
    key: string
  ): Promise<{
    ok: boolean;
    error?: string;
    replayed?: boolean;
    promo_chips?: number;
    bank_chips?: number;
  }> {
    const { data, error } = await supabase.rpc('fn_diamond_game_fund_promo', {
      p_club_id: clubId,
      p_amount: amountChips,
      p_key: key,
    });
    if (error) throw error;
    const raw = rec(data);
    return {
      ok: Boolean(raw.ok),
      error: raw.error ? String(raw.error) : undefined,
      replayed: Boolean(raw.replayed),
      promo_chips: raw.promo_chips === undefined ? undefined : Number(raw.promo_chips),
      bank_chips: raw.bank_chips === undefined ? undefined : Number(raw.bank_chips),
    };
  },

  /**
   * WHAT THE HOST IS UP OR DOWN (2026-09-11), across all three games, over four
   * windows, with a per-game breakdown. Stated in chips because a chip is a
   * dollar and an owner thinks in dollars. The server decides who may read it.
   */
  async pnl(clubId: string): Promise<GamePnl> {
    const { data, error } = await supabase.rpc('fn_diamond_game_pnl', { p_club_id: clubId });
    if (error) throw error;
    const raw = rec(data);
    return {
      ok: Boolean(raw.ok),
      error: raw.error ? String(raw.error) : undefined,
      diamonds_per_chip: num(raw.diamonds_per_chip),
      windows: Array.isArray(raw.windows)
        ? (raw.windows as Record<string, unknown>[]).map((w) => ({
            window: String(w.window ?? ''),
            rounds: num(w.rounds),
            intake_diamonds: num(w.intake_diamonds),
            intake_chips: num(w.intake_chips),
            chips_paid: num(w.chips_paid),
            diamonds_paid: num(w.diamonds_paid),
            welcome_chips: num(w.welcome_chips),
            net_chips: num(w.net_chips),
            games: Array.isArray(w.games)
              ? (w.games as Record<string, unknown>[]).map((g) => ({
                  game: String(g.game ?? ''),
                  rounds: num(g.rounds),
                  intake_diamonds: num(g.intake_diamonds),
                  chips_paid: num(g.chips_paid),
                  diamonds_paid: num(g.diamonds_paid),
                  net_chips: num(g.net_chips),
                }))
              : [],
          }))
        : [],
    };
  },

  /**
   * HOW MUCH GAME IS LEFT IN THE COVER (2026-09-11). Per game, the biggest win
   * a player could take right now next to the biggest the configuration allows,
   * and which of the two ceilings is binding: the intake headroom (the law
   * working, nothing to act on) or the cover (the operator's to fix).
   */
  async room(clubId: string): Promise<GameRoom> {
    const { data, error } = await supabase.rpc('fn_diamond_game_room', { p_club_id: clubId });
    if (error) throw error;
    const raw = rec(data);
    return {
      ok: Boolean(raw.ok),
      error: raw.error ? String(raw.error) : undefined,
      cover_chips: num(raw.cover_chips),
      promo_chips: num(raw.promo_chips),
      bank_chips: num(raw.bank_chips),
      owner_diamonds: num(raw.owner_diamonds),
      games: Array.isArray(raw.games)
        ? (raw.games as Record<string, unknown>[]).map((g) => ({
            game: String(g.game ?? ''),
            enabled: Boolean(g.enabled),
            state: (['open', 'thin', 'stopped', 'closed'] as const).includes(
              String(g.state) as GameRoomState
            )
              ? (String(g.state) as GameRoomState)
              : 'closed',
            max_win_chips: g.max_win_chips === undefined ? undefined : num(g.max_win_chips),
            intake_win_chips:
              g.intake_win_chips === undefined ? undefined : num(g.intake_win_chips),
            ceiling_win_chips:
              g.ceiling_win_chips === undefined ? undefined : num(g.ceiling_win_chips),
            capped_by_cover: Boolean(g.capped_by_cover),
            capped_by_intake: Boolean(g.capped_by_intake),
            top_chip_prize_chips:
              g.top_chip_prize_chips === undefined ? undefined : num(g.top_chip_prize_chips),
            top_diamond_prize_diamonds:
              g.top_diamond_prize_diamonds === undefined
                ? undefined
                : num(g.top_diamond_prize_diamonds),
            chip_prize_covered:
              g.chip_prize_covered === undefined ? undefined : Boolean(g.chip_prize_covered),
            diamond_prize_covered:
              g.diamond_prize_covered === undefined ? undefined : Boolean(g.diamond_prize_covered),
          }))
        : [],
    };
  },

  /** WHO IS PLAYING TODAY (2026-09-11), against the two daily ceilings. */
  async players(clubId: string, limit = 25): Promise<GamePlayers> {
    const { data, error } = await supabase.rpc('fn_diamond_game_players', {
      p_club_id: clubId,
      p_limit: limit,
    });
    if (error) throw error;
    const raw = rec(data);
    return {
      ok: Boolean(raw.ok),
      error: raw.error ? String(raw.error) : undefined,
      spins_cap: num(raw.spins_cap),
      rounds_cap: num(raw.rounds_cap),
      players: Array.isArray(raw.players)
        ? (raw.players as Record<string, unknown>[]).map((p) => ({
            user_id: String(p.user_id ?? ''),
            name: String(p.name ?? ''),
            spins: num(p.spins),
            rounds: num(p.rounds),
            spins_cap: num(p.spins_cap),
            rounds_cap: num(p.rounds_cap),
            at_spin_cap: Boolean(p.at_spin_cap),
            at_round_cap: Boolean(p.at_round_cap),
            spent_diamonds: num(p.spent_diamonds),
            spent_chips: num(p.spent_chips),
            won_chips: num(p.won_chips),
            won_diamonds: num(p.won_diamonds),
            net_chips: num(p.net_chips),
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
