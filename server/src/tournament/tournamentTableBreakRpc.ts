import { supabase } from '../services/supabase.js';
import { UUID_SHAPE } from '../lib/uuidShape.js';
import {
  verifyTournamentSeatMoveReceipt,
  type VerifiedTournamentSeatMoveReceipt,
} from './tournamentSeatMoveRpc.js';

/** Wire contract v3 from Accounting's RPC_CONTRACT.json. Bigints stay strings. */
export interface TableBreakMemberInput {
  user_id: string;
  source_seat_id: string;
  source_seat_number: number;
  occupancy_id: string;
  request_id: string;
  destination_table_id: string;
  destination_seat_number: number;
}
export interface TableBreakMember {
  user_id: string;
  source_seat_id: string;
  source_seat_number: number;
  occupancy_id: string;
  request_id: string;
  original_destination_table_id: string;
  original_destination_seat_number: number;
  winning_receipt: VerifiedTournamentSeatMoveReceipt | null;
  active_request_id: string | null;
  winner_request_id: string | null;
  destination_table_id: string;
  destination_seat_number: number;
  attempt_revision: number;
}
/** Only the exact correlated SQL capacity failure permits placement resolution. */
export class TournamentTableBreakCapacityError extends Error {
  constructor(
    readonly rpc: string,
    readonly parameters: Readonly<Record<string, unknown>>
  ) {
    super('F06_CAPACITY_UNAVAILABLE');
  }
}
export class TournamentTableBreakRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`F06 refused: ${reason}`);
  }
}
export interface TournamentTableBreakState {
  ok: boolean;
  reason: string | null;
  break_id: string;
  tournament_id: string;
  source_table_id: string;
  lifecycle: string;
  state: 'park_requested' | 'begun' | 'close_confirmed' | 'acknowledged';
  revision: string;
  custody_id: string | null;
  custody_generation: string | null;
  members: TableBreakMember[];
  terminal_handoff_required: boolean;
}
export interface TournamentBreakTableState {
  ok: boolean;
  table_id: string;
  lifecycle: string;
  excluded: boolean;
  break_id: string | null;
}
export interface TournamentBreakDiscovery {
  ok: boolean;
  cursor_revision: string;
  wrapped: boolean;
  operations: TournamentTableBreakState[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('F06 invalid object');
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_SHAPE.test(value)) throw new Error('F06 invalid UUID');
  return value;
}
function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('F06 invalid boolean');
  return value;
}
function decimal(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new Error('F06 invalid bigint string');
  return value;
}
function seat(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10)
    throw new Error('F06 invalid seat');
  return value;
}
function reason(value: unknown): string | null {
  if (value === undefined) return null;
  if (value !== null && typeof value !== 'string') throw new Error('F06 invalid reason');
  return value;
}
function memberInput(value: unknown): TableBreakMemberInput {
  const row = record(value);
  return {
    user_id: uuid(row.user_id),
    source_seat_id: uuid(row.source_seat_id),
    source_seat_number: seat(row.source_seat_number),
    occupancy_id: uuid(row.occupancy_id),
    request_id: uuid(row.request_id),
    destination_table_id: uuid(row.destination_table_id),
    destination_seat_number: seat(row.destination_seat_number),
  };
}
function member(
  value: unknown,
  tournamentId: string,
  breakId: string,
  sourceId: string,
  lifecycle: string
): TableBreakMember {
  const row = record(value);
  if (
    typeof row.attempt_revision !== 'number' ||
    !Number.isSafeInteger(row.attempt_revision) ||
    row.attempt_revision < 1
  )
    throw new Error('F06 invalid attempt revision');
  const active = nullableUuid(row.active_request_id);
  const winner = nullableUuid(row.winner_request_id);
  if ((!active && !winner) || (active && winner)) throw new Error('F06 invalid attempt projection');
  const input = memberInput(row);
  let receipt: VerifiedTournamentSeatMoveReceipt | null = null;
  if (winner) {
    const raw = record(row.winning_receipt);
    // v3 embeds the immutable receipt ROW rather than the RPC envelope.
    // Only envelope flags are normalized; every financial/identity field is verified unchanged.
    receipt = verifyTournamentSeatMoveReceipt(
      { ...raw, ok: true, replayed: true },
      {
        requestId: winner,
        tournamentId,
        userId: input.user_id,
        sourceTableId: sourceId,
        destinationTableId: input.destination_table_id,
        destinationSeatNumber: input.destination_seat_number,
        sourceMode: 'live_source',
      }
    );
    if (
      !receipt ||
      receipt.sourceSeatId !== input.source_seat_id ||
      receipt.sourceSeatNumber !== input.source_seat_number ||
      raw.source_occupancy_id !== input.occupancy_id ||
      raw.source_lifecycle !== lifecycle ||
      raw.break_id !== breakId
    )
      throw new Error('F06 winning receipt provenance mismatch');
  } else if (row.winning_receipt !== null)
    throw new Error('F06 unresolved member has winning receipt');
  return {
    ...input,
    active_request_id: active,
    winner_request_id: winner,
    original_destination_table_id: uuid(row.original_destination_table_id),
    original_destination_seat_number: seat(row.original_destination_seat_number),
    winning_receipt: receipt,
    attempt_revision: row.attempt_revision,
  };
}
export function verifyTournamentTableBreakState(
  value: unknown,
  tournamentId: string,
  expectedBreakId?: string
): TournamentTableBreakState {
  const row = record(value);
  const event = uuid(row.tournament_id);
  const id = uuid(row.break_id);
  if (event !== tournamentId || (expectedBreakId !== undefined && id !== expectedBreakId))
    throw new Error('F06 operation identity mismatch');
  const states = ['park_requested', 'begun', 'close_confirmed', 'acknowledged'] as const;
  if (!states.includes(row.state as (typeof states)[number])) throw new Error('F06 invalid state');
  if (!Array.isArray(row.members) || row.members.length > 10)
    throw new Error('F06 invalid members');
  const source = uuid(row.source_table_id);
  const lifecycle = decimal(row.lifecycle);
  if (row.ok !== true || row.reason !== null)
    throw new Error('F06 state is not successful evidence');
  const members = row.members.map((item) => member(item, tournamentId, id, source, lifecycle));
  for (const key of [
    'user_id',
    'source_seat_id',
    'occupancy_id',
    'request_id',
    'active_request_id',
  ] as const) {
    if (
      new Set(members.map((m) => m[key]).filter((value) => value != null)).size !==
      members.map((m) => m[key]).filter((value) => value != null).length
    )
      throw new Error('F06 duplicate member identity');
  }
  if (row.state !== 'park_requested' && members.length === 0)
    throw new Error('F06 missing original members');
  const winners = members.flatMap((m) => (m.winner_request_id ? [m.winner_request_id] : []));
  if (new Set(winners).size !== winners.length) throw new Error('F06 duplicate winner');
  if (
    (row.state === 'close_confirmed' || row.state === 'acknowledged') &&
    winners.length !== members.length
  )
    throw new Error('F06 close lacks complete winner evidence');
  if (members.some((m) => m.destination_table_id === source))
    throw new Error('F06 destination is source');
  const custody = nullableUuid(row.custody_id);
  const generation = nullableUuid(row.custody_generation);
  if ((custody === null) !== (generation === null))
    throw new Error('F06 incomplete custody identity');
  return {
    ok: boolean(row.ok),
    reason: reason(row.reason),
    break_id: id,
    tournament_id: event,
    source_table_id: source,
    lifecycle: decimal(row.lifecycle),
    state: row.state as (typeof states)[number],
    revision: decimal(row.revision),
    custody_id: custody,
    custody_generation: generation,
    members,
    terminal_handoff_required: boolean(row.terminal_handoff_required),
  };
}

/** No automatic fresh IDs or mutation retries. Caller retains every original identity. */
export class TournamentTableBreakRpc {
  constructor(
    private readonly tournamentId: string,
    private readonly leaseGeneration: string
  ) {
    uuid(tournamentId);
    uuid(leaseGeneration);
  }
  private async call(name: string, parameters: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await supabase.rpc(name, {
      p_tournament_id: this.tournamentId,
      p_lease_generation: this.leaseGeneration,
      ...parameters,
    });
    if (error) {
      if (
        (name === 'fn_f06_begin_break' || name === 'fn_f06_amend_attempt') &&
        error.code === '55000' &&
        error.message === 'F06_CAPACITY_UNAVAILABLE'
      )
        throw new TournamentTableBreakCapacityError(name, Object.freeze({ ...parameters }));
      throw new Error(`F06 ${name} outcome unproven: ${String(error.message ?? error)}`);
    }
    return data;
  }
  private async operation(name: string, breakId: string, extra: Record<string, unknown> = {}) {
    uuid(breakId);
    const value = await this.call(name, { p_break_id: breakId, ...extra });
    const row = record(value);
    if (row.ok === false && row.break_id === undefined && typeof row.reason === 'string')
      throw new TournamentTableBreakRefusedError(row.reason);
    return verifyTournamentTableBreakState(value, this.tournamentId, breakId);
  }
  async tableState(tableId: string): Promise<TournamentBreakTableState> {
    uuid(tableId);
    const row = record(await this.call('fn_f06_table_state', { p_table_id: tableId }));
    if (row.ok === false && typeof row.reason === 'string')
      throw new TournamentTableBreakRefusedError(row.reason);
    if (uuid(row.table_id) !== tableId) throw new Error('F06 table identity mismatch');
    return {
      ok: boolean(row.ok),
      table_id: tableId,
      lifecycle: decimal(row.lifecycle),
      excluded: boolean(row.excluded),
      break_id: nullableUuid(row.break_id),
    };
  }
  requestPark(breakId: string, tableId: string, lifecycle: string, boundaryId: string) {
    return this.operation('fn_f06_request_park', breakId, {
      p_table_id: uuid(tableId),
      p_lifecycle: decimal(lifecycle),
      p_boundary_id: uuid(boundaryId),
    });
  }
  begin(breakId: string, members: readonly TableBreakMemberInput[]) {
    if (!members.length || members.length > 10)
      throw new Error('F06 begin requires full nonempty roster');
    return this.operation('fn_f06_begin_break', breakId, {
      p_members: members.map(memberInput),
    });
  }
  reconcile(breakId: string) {
    return this.operation('fn_f06_reconcile_break', breakId);
  }
  close(breakId: string) {
    return this.operation('fn_f06_close_break', breakId);
  }
  claimCustody(breakId: string, custodyId: string, expectedRevision: string) {
    return this.operation('fn_f06_claim_custody', breakId, {
      p_custody_id: uuid(custodyId),
      p_expected_revision: decimal(expectedRevision),
    });
  }
  ackCleanup(
    breakId: string,
    custodyId: string,
    revision: string,
    kind: 'retired' | 'verified_absent'
  ) {
    if (kind !== 'retired' && kind !== 'verified_absent')
      throw new Error('F06 invalid cleanup kind');
    return this.operation('fn_f06_ack_cleanup', breakId, {
      p_custody_id: uuid(custodyId),
      p_revision: decimal(revision),
      p_cleanup_kind: kind,
    });
  }
  amend(input: {
    breakId: string;
    userId: string;
    expectedRequestId: string;
    amendmentId: string;
    newRequestId: string;
    destinationTableId: string;
    destinationSeatNumber: number;
    reason: string;
  }) {
    if (!input.reason.trim() || input.newRequestId === input.expectedRequestId)
      throw new Error('F06 invalid amendment');
    return this.operation('fn_f06_amend_attempt', input.breakId, {
      p_user_id: uuid(input.userId),
      p_expected_request_id: uuid(input.expectedRequestId),
      p_amendment_id: uuid(input.amendmentId),
      p_new_request_id: uuid(input.newRequestId),
      p_destination_table_id: uuid(input.destinationTableId),
      p_destination_seat_number: seat(input.destinationSeatNumber),
      p_reason: input.reason,
    });
  }
  async discover(cursorRevision: string, limit: number): Promise<TournamentBreakDiscovery> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32)
      throw new Error('F06 invalid discovery budget');
    const row = record(
      await this.call('fn_f06_discover_breaks', {
        p_expected_cursor_revision: decimal(cursorRevision),
        p_limit: limit,
      })
    );
    if (row.ok === false && row.reason === 'cursor_revision_conflict') {
      return {
        ok: false,
        cursor_revision: decimal(row.cursor_revision),
        wrapped: false,
        operations: [],
      };
    }
    if (!Array.isArray(row.operations) || row.operations.length > limit)
      throw new Error('F06 invalid discovery page');
    const operations = row.operations.map((op) =>
      verifyTournamentTableBreakState(op, this.tournamentId)
    );
    if (new Set(operations.map((op) => op.break_id)).size !== operations.length)
      throw new Error('F06 duplicate discovery identity');
    return {
      ok: boolean(row.ok),
      cursor_revision: decimal(row.cursor_revision),
      wrapped: boolean(row.wrapped),
      operations,
    };
  }
}
