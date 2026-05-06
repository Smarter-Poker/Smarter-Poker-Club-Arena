/**
 * ADMIN STATS SERVICE — Engine/tournament dashboard telemetry
 *
 * Replaces the client-side `cashGameOrchestrator` and `tournamentOrchestrator`
 * singletons (Phase U2 Stage B, 2026-04-23). Those singletons were the last
 * client-authoritative engine code referenced outside `src/engine/`. The
 * Hetzner game server is now the single source of game truth — the admin
 * dashboard reads durable state from Supabase instead.
 *
 * start()/stop() are intentionally no-ops on the client: engine lifecycle is
 * managed by the Hetzner `club-arena-engine` container (SSH/systemd). The
 * existing `POST /admin/pause` + `POST /admin/resume` endpoints on
 * engine.smarter.poker are the right mutation surface and should be called
 * from a separate admin action if/when that flow is needed from the UI.
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export interface CashEngineStats {
  running: boolean;
  activeTables: number;
  totalHandsDealt: number;
}

export interface TournamentEngineStats {
  running: boolean;
  activeTournaments: number;
  totalPlayers: number;
}

// Cached latest values so synchronous reads (first render) don't return zeros
// when we've already fetched. Seed with a safe default; refreshers update
// asynchronously.
const cache = {
  cash: { running: true, activeTables: 0, totalHandsDealt: 0 } as CashEngineStats,
  tournament: { running: true, activeTournaments: 0, totalPlayers: 0 } as TournamentEngineStats,
};

/** Refresh cash stats from Supabase. Returns the new snapshot. */
export async function refreshCashStats(): Promise<CashEngineStats> {
  try {
    const [{ count: activeTables }, { count: totalHands }] = await Promise.all([
      supabase.from('tables').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('hand_history').select('id', { count: 'exact', head: true }),
    ]);
    cache.cash = {
      running: true, // engine liveness is Hetzner's concern; surfaced via health endpoint
      activeTables: activeTables ?? 0,
      totalHandsDealt: totalHands ?? 0,
    };
  } catch (err) {
    reportError(err, 'AdminStatsService.refreshCashStats');
  }
  return cache.cash;
}

/** Refresh tournament stats from Supabase. Returns the new snapshot. */
export async function refreshTournamentStats(): Promise<TournamentEngineStats> {
  try {
    const [{ count: activeTournaments }, { count: totalPlayers }] = await Promise.all([
      supabase
        .from('tournaments')
        .select('id', { count: 'exact', head: true })
        .in('status', ['running', 'late_reg', 'on_break']),
      supabase.from('tournament_players').select('id', { count: 'exact', head: true }),
    ]);
    cache.tournament = {
      running: true,
      activeTournaments: activeTournaments ?? 0,
      totalPlayers: totalPlayers ?? 0,
    };
  } catch (err) {
    reportError(err, 'AdminStatsService.refreshTournamentStats');
  }
  return cache.tournament;
}

/** Synchronous read of the most recent cached snapshot. */
export function getCashStats(): CashEngineStats {
  return { ...cache.cash };
}

/** Synchronous read of the most recent cached snapshot. */
export function getTournamentStats(): TournamentEngineStats {
  return { ...cache.tournament };
}
