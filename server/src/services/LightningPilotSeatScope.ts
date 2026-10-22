/**
 * THE STANDING LIGHTNING PILOT ASSIGNMENT, AS THE HORSE FLEET READS IT
 * (2026-10-22).
 *
 * `public.lightning_pilot_assignment` names the funded pilot horses (the
 * manifest's 72) and the club whose two private six-seat games they keep alive
 * (Action 0.01/0.02 and Madness 0.02/0.04). The owner's standing reason, set
 * through lightning-pilot-assignment.yml at 2026-10-22 07:09 UTC: "keep the
 * funded 72 on the Action and Madness six-seat pilots". Until today the only
 * thing that read it was the database's own door, which keeps those horses out
 * of new automated tournament entries. Nothing in the fleet read it, and the
 * measured result on 2026-10-22:
 *
 *   - Madness (one six-seat table live, feeder open) reverted to must-move at
 *     17:14 UTC with live_eligible 6 against an ON threshold of 12. The fleet
 *     log said `No available horses for "Lightning Pilot NLH Madness 6 Feeder"
 *     (need 6, ... candidates 0)` every cycle.
 *   - Every one of the 11 assigned horses that were idle, under their daily cap
 *     and not on a rest day failed the BANKROLL gate there and only there:
 *     Madness's reference buy-in is 4.00, and 25 / 40 / 12 buy-ins (standard /
 *     nit / gambler) is 100 / 160 / 48 chips, while the pilot wallets were
 *     funded at about 100 and sat at 23-139 by the afternoon. The same horses
 *     passed at Action (reference 2.00) but one. The share-of-roll sizing refuses
 *     thinner wallets a second time: 5% of a 77.70 roll is under the 4.00
 *     minimum.
 *   - 24 of the 42 seated assigned horses were sitting in Midway Union (20)
 *     and Diamond Arena (4) games, spending their daily-cap minutes away from
 *     the pilots they were assigned to.
 *
 * So, while the assignment is ACTIVE and only for the horses it names:
 *
 *   1. AN ASSIGNED HORSE TAKES NEW CASH SEATS ONLY IN THE PILOT CLUB. Nothing
 *      is moved: a seat it already holds elsewhere plays out and ends the
 *      ordinary way (session end, cap, stop-loss). It is a no-new-seating
 *      rule, exactly like the database's tournament door.
 *   2. AT A PILOT TABLE THE PILOT WALLET IS JUDGED AS A DEDICATED FUND. The
 *      pilot club exists only for these two micro games, so the stake-ladder
 *      bar ("cover 25 buy-ins of the game before sitting it, else move down")
 *      has nowhere to move down to and simply idles the horse. The bar there
 *      is PILOT_BUY_INS_TO_SIT buy-ins and the per-seat share is
 *      PILOT_MAX_BANKROLL_FRACTION; both only ever LOOSEN the temperament's
 *      own numbers, never tighten them. Every other rule is untouched: daily
 *      cap, rest day, activity window, four-game limit, rejoin floor, VPIP
 *      door, aggregate ceiling, and `atomic_table_buyin`, which still refuses
 *      any buy-in the wallet cannot pay. No chips are added from anywhere.
 *
 * FAILS OPEN TO TODAY'S BEHAVIOUR. An unreadable, inactive or malformed
 * assignment is `null`, and `null` changes nothing anywhere.
 */
import { bankrollPolicyFor, type BankrollPolicy } from './HorseBankroll.js';

export interface PilotSeatScope {
  clubId: string;
  playerIds: ReadonlySet<string>;
}

/** Buy-ins of a PILOT game a pilot wallet must hold to sit it (10 x 4.00 =
 *  40 at Madness, 10 x 2.00 = 20 at Action). */
export const PILOT_BUY_INS_TO_SIT = 10;
/** Largest share of a pilot wallet one pilot seat may take (0.10 x 40 = the
 *  4.00 Madness minimum). */
export const PILOT_MAX_BANKROLL_FRACTION = 0.1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let current: PilotSeatScope | null = null;

/** Parse `fn_lightning_pilot_assignment_status()`. Anything but an active,
 *  well-formed assignment is null (no opinion). */
export function parsePilotAssignmentStatus(raw: unknown): PilotSeatScope | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { active?: unknown; club_id?: unknown; player_ids?: unknown };
  if (r.active !== true) return null;
  if (typeof r.club_id !== 'string' || !UUID.test(r.club_id)) return null;
  if (!Array.isArray(r.player_ids) || r.player_ids.length === 0) return null;
  if (r.player_ids.some((id) => typeof id !== 'string' || !UUID.test(id))) return null;
  return { clubId: r.club_id, playerIds: new Set(r.player_ids as string[]) };
}

export function setPilotSeatScope(scope: PilotSeatScope | null): void {
  current = scope;
}

export function getPilotSeatScope(): PilotSeatScope | null {
  return current;
}

/**
 * Read the assignment once per fleet cycle. A failed read clears the scope
 * (today's behaviour) and returns 'unread' so the caller can say so.
 */
export async function loadPilotSeatScope(client: {
  rpc: (fn: string) => PromiseLike<{ data: unknown; error: unknown }>;
}): Promise<'active' | 'inactive' | 'unread'> {
  try {
    const { data, error } = await client.rpc('fn_lightning_pilot_assignment_status');
    if (error) {
      current = null;
      return 'unread';
    }
    current = parsePilotAssignmentStatus(data);
    return current ? 'active' : 'inactive';
  } catch {
    current = null;
    return 'unread';
  }
}

/**
 * Where may this horse take a NEW cash seat paid by `seatClub`?
 *  - 'free'      not an assigned horse, or no active assignment: unchanged.
 *  - 'pilot'     an assigned horse at a pilot-club seat.
 *  - 'elsewhere' an assigned horse at any other club's seat: refused.
 * An unknown seat club (`undefined`, the membership map failed to load) is
 * 'free', the same fail-open answer the club gate gives.
 */
export function pilotSeatVerdict(
  horseId: string,
  seatClub: string | null | undefined,
  scope: PilotSeatScope | null = current
): 'free' | 'pilot' | 'elsewhere' {
  if (!scope || !scope.playerIds.has(horseId)) return 'free';
  if (seatClub === undefined || seatClub === null) return 'free';
  return seatClub === scope.clubId ? 'pilot' : 'elsewhere';
}

/** The bankroll policy for this horse at a seat paid by `seatClub`: the
 *  temperament's own, loosened only for an assigned horse at a pilot seat. */
export function seatPolicyFor(
  horseId: string,
  seatClub: string | null | undefined,
  scope: PilotSeatScope | null = current
): BankrollPolicy {
  const base = bankrollPolicyFor(horseId);
  if (pilotSeatVerdict(horseId, seatClub, scope) !== 'pilot') return base;
  return {
    ...base,
    buyInsToSit: Math.min(base.buyInsToSit, PILOT_BUY_INS_TO_SIT),
    maxBankrollFraction: Math.max(base.maxBankrollFraction, PILOT_MAX_BANKROLL_FRACTION),
  };
}
