import { supabase } from '../services/supabase.js';
import { isUuidShape } from '../lib/uuidShape.js';

/**
 * The one door a launch uses to release a registrant it cannot seat.
 *
 * A launch seats its roster one atomic RPC at a time. Until 2026-09-09 one
 * refused chair failed the whole launch: the receipt stayed incomplete, the
 * event stayed REGISTERING, and everybody else sat on felt that never
 * dealt. A player the platform cannot seat at start must not hold the start
 * hostage: he is released with his exact refund through
 * fn_ca_release_unseatable_registrant_at_launch (service-only; requires the
 * event's incomplete launch receipt by launch id; refuses a player who holds
 * a live seat; settles through fn_ca_unregister_tournament_player_exact
 * under a deterministic (launch, player) request id, so a lost response
 * replays the same receipt instead of refunding twice).
 *
 * There is no client-side fallback and no compensating write. A refusal or
 * an unknown outcome leaves the launch receipt incomplete, and the next
 * lifecycle pass rereads the roster.
 */
/**
 * What a launch does with one refused chair. The database is the seating
 * authority and every seat is its own transaction, so each refusal is
 * answered on its own and the loop always finishes the roster.
 */
export type SeatRefusalDisposition = 'retry_seat' | 'retry_table' | 'skip' | 'release';

export function classifySeatRefusal(reason: string): SeatRefusalDisposition {
  switch (reason) {
    case 'seat_taken':
      // the inventory was stale for THAT chair - mark it, try the next
      return 'retry_seat';
    case 'table_not_assignable':
      // that table is closed or deleted - retire it, try the next
      return 'retry_table';
    case 'player_already_seated_elsewhere':
    case 'player_not_registered':
    case 'player_not_assignable':
      // seated already, or nothing on the roster to seat
      return 'skip';
    default:
      // the platform cannot seat him at start: released with his exact refund
      return 'release';
  }
}

export interface TournamentLaunchReleaseResult {
  released: boolean;
  replayed: boolean;
  reason: string | null;
  refundedChips: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function releaseUnseatableRegistrantAtLaunch(input: {
  tournamentId: string;
  userId: string;
  launchId: string;
  reason: string;
}): Promise<TournamentLaunchReleaseResult> {
  if (
    !isUuidShape(input.tournamentId) ||
    !isUuidShape(input.userId) ||
    !isUuidShape(input.launchId)
  ) {
    return { released: false, replayed: false, reason: 'invalid_identity', refundedChips: 0 };
  }
  const { data, error } = await supabase.rpc('fn_ca_release_unseatable_registrant_at_launch', {
    p_tournament_id: input.tournamentId,
    p_user_id: input.userId,
    p_launch_id: input.launchId,
    p_reason: input.reason.slice(0, 200),
  });
  if (error) {
    return {
      released: false,
      replayed: false,
      reason: `rpc_error:${error.message || 'unknown'}`,
      refundedChips: 0,
    };
  }
  const raw = asRecord(data);
  const released = raw.released === true && raw.ok === true;
  const refunded = Number(raw.refunded_chips ?? raw.total_refunded ?? 0);
  return {
    released,
    replayed: raw.replayed === true,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    refundedChips: Number.isFinite(refunded) ? refunded : 0,
  };
}
