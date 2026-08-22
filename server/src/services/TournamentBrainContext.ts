/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TOURNAMENT BRAIN CONTEXT — Real ICM Inputs for the Horses (V12 — 2026-08-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 * V11 gave the horse brain an explicit cash/tournament switch; the ICM layer
 * was still a flat premium because the brain could not see the tournament.
 * This service feeds it the real thing: players left, spots paid, bubble
 * distance, average stack, format (MTT / spin / HU SNG), and the PKO bounty
 * share — everything icmRiskV2 needs to price survival correctly.
 *
 * Access pattern is SYNCHRONOUS from the decision path (horse decisions are
 * sync and budgeted in ms): `get()` returns the cached context immediately
 * (or null before the first fetch lands) and kicks a background refresh when
 * the entry is stale. A missing/failed context degrades to V11's flat
 * premium — never worse than before this service existed.
 *
 * NEVER refer to the horses as "bots" — they are HORSES only.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

export type TournamentFormat = 'mtt' | 'spin' | 'hu_sng';

export interface TournamentBrainContext {
  format: TournamentFormat;
  entrants: number;
  playersLeft: number;
  spotsPaid: number;
  inMoney: boolean;
  /** stone bubble / approaching-bubble flag (playersLeft within 15% of paid) */
  nearBubble: boolean;
  /** average live stack in CHIPS (0 = unknown) */
  avgStackChips: number;
  /** PKO: share of the prize pool sitting in bounties (0 = not a bounty) */
  bountyFactor: number;
}

interface TournamentRowLite {
  tournament_type: string | null;
  variant: string | null;
  max_players: number | null;
  table_size: number | null;
  payout_structure: unknown;
  prize_pool: number | null;
  bounty_pool: number | null;
  is_pko: boolean | null;
  is_bounty: boolean | null;
}

/** Pure derivation — unit-tested. */
export function deriveContext(
  row: TournamentRowLite,
  playersLeft: number,
  entrants: number,
  chipSum: number
): TournamentBrainContext {
  const type = (row.tournament_type || '').toUpperCase();
  const variant = (row.variant || '').toLowerCase();
  const format: TournamentFormat =
    type === 'SPIN' || variant === 'spin'
      ? 'spin'
      : (row.table_size ?? row.max_players ?? 9) <= 2
        ? 'hu_sng'
        : 'mtt';

  let payouts = row.payout_structure;
  if (typeof payouts === 'string') {
    try {
      payouts = JSON.parse(payouts);
    } catch {
      payouts = [];
    }
  }
  // Spins are winner-take-all unless the structure says otherwise.
  const spotsPaid = Array.isArray(payouts) && payouts.length > 0 ? payouts.length : format === 'spin' ? 1 : 0;

  const inMoney = spotsPaid > 0 && playersLeft > 0 && playersLeft <= spotsPaid;
  const nearBubble =
    spotsPaid > 0 &&
    !inMoney &&
    playersLeft <= Math.max(spotsPaid + 1, Math.ceil(spotsPaid * 1.15));

  const prizePool = Number(row.prize_pool) || 0;
  const bountyPool = Number(row.bounty_pool) || 0;
  const bountyFactor =
    (row.is_pko || row.is_bounty) && prizePool + bountyPool > 0
      ? bountyPool / (prizePool + bountyPool)
      : 0;

  return {
    format,
    entrants: Math.max(entrants, playersLeft),
    playersLeft,
    spotsPaid,
    inMoney,
    nearBubble,
    avgStackChips: playersLeft > 0 ? chipSum / playersLeft : 0,
    bountyFactor: Math.max(0, Math.min(1, bountyFactor)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

const TTL_MS = 20_000;
const MAX_CACHED = 500;

interface CacheEntry {
  ctx: TournamentBrainContext | null;
  fetchedAt: number;
  inFlight: boolean;
}

const cache = new Map<string, CacheEntry>();

/**
 * Synchronous read for the decision path. Returns the last known context (or
 * null before the first fetch resolves) and refreshes in the background when
 * stale.
 */
export function getTournamentBrainContext(tournamentId: string): TournamentBrainContext | null {
  const now = Date.now();
  let e = cache.get(tournamentId);
  if (!e) {
    if (cache.size > MAX_CACHED) cache.clear();
    e = { ctx: null, fetchedAt: 0, inFlight: false };
    cache.set(tournamentId, e);
  }
  if (!e.inFlight && now - e.fetchedAt > TTL_MS) {
    e.inFlight = true;
    void refresh(tournamentId, e);
  }
  return e.ctx;
}

/** Test hook. */
export function __clearTournamentBrainCache(): void {
  cache.clear();
}

async function refresh(tournamentId: string, e: CacheEntry): Promise<void> {
  try {
    const [tRes, pRes] = await Promise.all([
      supabase
        .from('tournaments')
        .select(
          'tournament_type, variant, max_players, table_size, payout_structure, prize_pool, bounty_pool, is_pko, is_bounty'
        )
        .eq('id', tournamentId)
        .maybeSingle(),
      supabase
        .from('tournament_players')
        .select('chips, status')
        .eq('tournament_id', tournamentId)
        .limit(5000),
    ]);
    if (tRes.error) throw new Error(tRes.error.message);
    if (pRes.error) throw new Error(pRes.error.message);
    if (!tRes.data) {
      e.ctx = null;
      return;
    }
    const rows = (pRes.data ?? []) as Array<{ chips: number | null; status: string | null }>;
    const entrants = rows.length;
    let playersLeft = 0;
    let chipSum = 0;
    for (const r of rows) {
      const st = (r.status || '').toLowerCase();
      if (st === 'eliminated' || st === 'busted' || st === 'unregistered') continue;
      playersLeft++;
      chipSum += Number(r.chips) || 0;
    }
    e.ctx = deriveContext(tRes.data as TournamentRowLite, playersLeft, entrants, chipSum);
  } catch (err) {
    reportError(err, 'TournamentBrainContext.refresh');
    // keep the last known ctx — stale beats nothing
  } finally {
    e.fetchedAt = Date.now();
    e.inFlight = false;
  }
}
