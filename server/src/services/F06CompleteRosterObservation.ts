import type { SupabaseClient } from '@supabase/supabase-js';
import type { OriginalAdmissionIdentity } from './F06OriginalIntentSession.js';
import type { OriginalRosterObservation } from './F06OriginalRosterAdmission.js';
import type { MTTRosterObservation } from '../engine/MTTPreReserveRoster.js';
import type { SeatedPlayer } from '../types.js';

const fail = (reason: string): never => {
  throw new Error('f06_roster_observation_' + reason);
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('row');
  return value as Record<string, unknown>;
};
const uuid = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    return fail('uuid');
  return value;
};
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail('integer');
  return value;
};
const lifecycle = (value: unknown): string => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  )
    return value;
  return fail('lifecycle');
};
const stamp = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return fail('timestamp');
  return value;
};
function localStamp(rows: readonly SeatedPlayer[]): string {
  return JSON.stringify(
    rows.map((r) => [
      r.user_id,
      r.seat_id,
      r.occupancy_id,
      r.seat_joined_at,
      r.seat_number,
      r.stack,
    ])
  );
}
/** Uses the existing Manager client, never creates credentials or a new session.
 * Two equal complete reads detect observed drift; they are not a DB snapshot.
 * Canonical admission SQL must independently validate under the original locks. */
export function completeOriginalRosterObservation(
  client: Pick<SupabaseClient, 'from'>,
  original: Readonly<OriginalAdmissionIdentity>,
  currentOwner: () => boolean,
  currentChairs: () => readonly { user_id: string; seat_number: number }[]
): OriginalRosterObservation {
  const identity = Object.freeze({ ...original });
  const check = () => {
    if (!currentOwner()) fail('owner_changed');
  };
  const chairs = () =>
    JSON.stringify(
      currentChairs()
        .map((r) => [r.user_id, r.seat_number])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
  async function one() {
    check();
    const tableReply = await client
      .from('tables')
      .select(
        'id,tournament_id,f06_lifecycle,max_players,game_variant,pineapple_holdem,bomb_pot_enabled'
      )
      .eq('id', identity.table_id)
      .eq('tournament_id', identity.tournament_id)
      .single(); // single-allow: Missing original table is rejected below.
    check();
    if (tableReply.error) fail('table_read');
    const table = record(tableReply.data);
    if (
      table.id !== identity.table_id ||
      table.tournament_id !== identity.tournament_id ||
      lifecycle(table.f06_lifecycle) !== identity.lifecycle
    )
      fail('table_binding');
    const capacity = integer(table.max_players);
    if (
      capacity < 2 ||
      capacity > 10 ||
      table.game_variant !== 'nlh' ||
      table.pineapple_holdem !== false ||
      table.bomb_pot_enabled !== false
    )
      fail('profile_unqualified');
    const tournamentReply = await client
      .from('tournaments')
      .select('id,tournament_type')
      .eq('id', identity.tournament_id)
      .single(); // single-allow: Missing original tournament is rejected below.
    check();
    if (tournamentReply.error) fail('tournament_read');
    const tournament = record(tournamentReply.data);
    if (
      tournament.id !== identity.tournament_id ||
      typeof tournament.tournament_type !== 'string' ||
      tournament.tournament_type !== 'MTT'
    )
      fail('tournament_binding');
    // Fetch capacity overflow sentinel plus exact total; no silently truncated page.
    const seatReply = await client
      .from('table_seats')
      .select('id,user_id,table_id,seat_number,occupancy_id,joined_at,stack,left_at,entry_hold', {
        count: 'exact',
      })
      .eq('table_id', identity.table_id)
      .is('left_at', null)
      .order('seat_number')
      .order('id')
      .limit(11);
    check();
    if (
      seatReply.error ||
      !Array.isArray(seatReply.data) ||
      !Number.isSafeInteger(seatReply.count) ||
      seatReply.count !== seatReply.data.length ||
      seatReply.data.length > capacity
    )
      fail('incomplete_seats');
    const participantReply = await client
      .from('tournament_players')
      .select('id,user_id,tournament_id,table_id,seat_number,registered_at,rebuys,status', {
        count: 'exact',
      })
      .eq('tournament_id', identity.tournament_id)
      .eq('table_id', identity.table_id)
      .eq('status', 'playing')
      .order('id')
      .limit(11);
    check();
    if (
      participantReply.error ||
      !Array.isArray(participantReply.data) ||
      !Number.isSafeInteger(participantReply.count) ||
      participantReply.count !== participantReply.data.length ||
      participantReply.data.length > capacity
    )
      fail('incomplete_participants');
    const seats = (seatReply.data as unknown[]).map((value) => {
      const r = record(value);
      if (
        r.table_id !== identity.table_id ||
        r.left_at !== null ||
        typeof r.stack !== 'number' ||
        !Number.isFinite(r.stack) ||
        r.stack < 0 ||
        Math.abs(r.stack) > Number.MAX_SAFE_INTEGER ||
        (r.entry_hold !== null && r.entry_hold !== 'moved')
      )
        fail('seat_unresolved');
      const seat_number = integer(r.seat_number);
      if (seat_number < 1 || seat_number > capacity) fail('seat_number');
      return {
        id: uuid(r.id),
        user_id: uuid(r.user_id),
        table_id: identity.table_id,
        seat_number,
        occupancy_id: uuid(r.occupancy_id),
        joined_at: stamp(r.joined_at),
        stack: r.stack as number,
        left_at: null,
        entry_hold: r.entry_hold as null | 'moved',
      };
    });
    const participants = (participantReply.data as unknown[]).map((value) => {
      const r = record(value);
      if (
        r.tournament_id !== identity.tournament_id ||
        r.table_id !== identity.table_id ||
        r.status !== 'playing'
      )
        fail('participant_binding');
      const rebuys = integer(r.rebuys);
      if (rebuys < 0) fail('rebuy');
      return {
        id: uuid(r.id),
        user_id: uuid(r.user_id),
        tournament_id: identity.tournament_id,
        table_id: identity.table_id,
        seat_number: integer(r.seat_number),
        registered_at: stamp(r.registered_at),
        rebuys,
        status: 'playing',
      };
    });
    for (const key of ['id', 'user_id', 'occupancy_id', 'seat_number'] as const)
      if (new Set(seats.map((s) => s[key])).size !== seats.length) fail('duplicate_seat');
    if (
      new Set(participants.map((p) => p.id)).size !== participants.length ||
      new Set(participants.map((p) => p.user_id)).size !== participants.length
    )
      fail('duplicate_participant');
    for (const p of participants)
      if (!seats.some((s) => s.user_id === p.user_id && s.seat_number === p.seat_number))
        fail('orphan_participant');
    for (const seat of seats)
      if (
        seat.stack > 0 &&
        !participants.some((p) => p.user_id === seat.user_id && p.seat_number === seat.seat_number)
      )
        fail('missing_participant');
    return {
      table: {
        id: identity.table_id,
        tournament_id: identity.tournament_id,
        f06_lifecycle: identity.lifecycle,
        max_players: capacity,
        game_variant: 'nlh',
        pineapple_holdem: false,
        bomb_pot_enabled: false,
      },
      tournament: {
        id: identity.tournament_id,
        tournament_type: tournament.tournament_type as string,
      },
      seats,
      participants,
    };
  }
  return async (selected, current) => {
    check();
    const beforeSelected = localStamp(selected),
      beforeCurrent = localStamp(current),
      beforeChairs = chairs();
    const local = current.map((r) => ({ ...r }));
    const first = await one();
    const second = await one();
    check();
    if (JSON.stringify(first) !== JSON.stringify(second)) fail('database_changed');
    if (
      beforeSelected !== localStamp(selected) ||
      beforeCurrent !== localStamp(current) ||
      beforeChairs !== chairs()
    )
      fail('local_changed');
    if (local.length !== second.seats.length) fail('local_incomplete');
    const seats: MTTRosterObservation['seats'] = second.seats.map((r) => {
      const matches = local.filter(
        (s) => s.user_id === r.user_id && s.seat_number === r.seat_number
      );
      if (matches.length !== 1) fail('local_membership');
      const s = matches[0];
      // Preserve exact local representation only when canonical read anchors agree.
      if (
        s.seat_id !== r.id ||
        s.occupancy_id !== r.occupancy_id ||
        s.stack !== r.stack ||
        s.seat_joined_at !== r.joined_at
      )
        fail('local_anchor');
      return {
        ...s,
        seat_id: r.id,
        occupancy_id: r.occupancy_id,
        seat_joined_at: r.joined_at,
        stack: r.stack,
        left_at: null,
        entry_hold: r.entry_hold,
      };
    });
    // Lease overwrites local waiting/swap/effective facts synchronously after await.
    return {
      table: second.table,
      tournament: second.tournament,
      participants: second.participants,
      seats,
      selected: selected.map((r) => ({ ...r })),
      waitingForBB: new Set(),
      swapHeld: new Set(),
      effectiveVariant: 'nlh',
      ordinaryHand: true,
    };
  };
}
