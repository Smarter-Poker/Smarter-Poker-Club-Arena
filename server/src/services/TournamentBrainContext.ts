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
import { resolvePayoutStructure, type PayoutSubject } from '../tournament/payoutStructure.js';

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

  // V13: use the CANONICAL parser instead of a local JSON.parse. The old code
  // only understood the array shape [{place, percentage}] and silently scored
  // 0 paid spots for the object shape {"1": 100} that other services in this
  // repo write and read — which made inMoney and nearBubble permanently false
  // and left the whole bubble model inert for that tournament, degrading
  // quietly so nobody would ever notice. It also counted [null, null] as two
  // paid places. parsePayoutStructure rejects a structure with no place 1, a
  // negative percentage, or percentages summing to zero, and for a Spin with a
  // missing structure resolvePayoutStructure rebuilds it from the multiplier
  // rather than assuming winner-take-all.
  const places = resolvePayoutStructure(row as PayoutSubject);
  const spotsPaid = places && places.length > 0 ? places.length : format === 'spin' ? 1 : 0;

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

const REFRESH_TIMEOUT_MS = 5000;
const STUCK_MS = 60_000;
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
  // V13: `inFlight` is only cleared in refresh()'s finally, which never runs
  // if the promise never settles. One hung Supabase fetch used to pin the flag
  // for the process lifetime and freeze that tournament's ICM context — or
  // leave it null forever if the hang was on the first attempt, so the horses
  // played the whole event, bubble included, on the flat premium with no
  // signal. The stuck-guard lets a later call retry regardless.
  const stuck = e.inFlight && now - e.fetchedAt > STUCK_MS;
  if ((!e.inFlight || stuck) && now - e.fetchedAt > TTL_MS) {
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
    // V13: bound the whole refresh. Neither query carries an AbortSignal, and
    // a decision never waits on this — a timeout simply keeps the last known
    // context, which is exactly the documented fail-safe.
    const deadline = new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error('tournament context refresh timed out')),
        REFRESH_TIMEOUT_MS
      ).unref?.()
    );
    const [tRes, pRes] = await Promise.race([
      deadline,
      Promise.all([
        supabase
          .from('tournaments')
          .select(
            'tournament_type, variant, max_players, table_size, payout_structure, spin_multiplier, prize_pool, bounty_pool, is_pko, is_bounty'
          )
          .eq('id', tournamentId)
          .maybeSingle(),
        supabase
          .from('tournament_players')
          .select('chips, status')
          .eq('tournament_id', tournamentId)
          .order('id', { ascending: true })
          .limit(5000),
      ]),
    ]);
    if (tRes.error) throw new Error(tRes.error.message);
    if (pRes.error) throw new Error(pRes.error.message);
    if (!tRes.data) {
      // V13: maybeSingle() returns null for zero rows, which includes a
      // read-replica blip or an RLS hiccup — not only a genuinely absent
      // tournament. This used to discard a good context mid-event, dropping
      // the horses back to the flat premium at the worst possible moment (the
      // bubble is exactly when query volume peaks). The catch below already
      // treats stale as better than nothing; this now agrees with it.
      if (e.ctx)
        reportError(
          new Error(`tournament ${tournamentId} read returned no row`),
          'TournamentBrainContext.missing'
        );
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
