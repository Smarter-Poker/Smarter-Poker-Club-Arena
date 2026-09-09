import { supabase } from '../services/supabase.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VerifiedTournamentSeatMoveReceipt {
  requestId: string;
  tournamentId: string;
  userId: string;
  sourceTableId: string;
  destinationTableId: string;
  sourceSeatId: string;
  destinationSeatId: string;
  sourceSeatNumber: number;
  destinationSeatNumber: number;
  stack: number;
  movedAt: string;
  replayed: boolean;
}

export class TournamentSeatMoveRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TournamentSeatMoveRefusedError';
  }
}

export class TournamentSeatMoveOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TournamentSeatMoveOutcomeUnknownError';
  }
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

function exactUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function exactSeat(value: unknown): number | null {
  const seat = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(seat) && seat >= 1 && seat <= 10 ? seat : null;
}

function exactPositiveStack(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[0-9]+(?:[.][0-9]+)?$/.test(value)) return null;
  const stack = Number(value);
  return Number.isFinite(stack) && stack > 0 ? stack : null;
}

function message(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value) {
    return String((value as { message?: unknown }).message ?? value);
  }
  return String(value);
}

function verify(
  raw: unknown,
  expected: {
    requestId: string;
    tournamentId: string;
    userId: string;
    sourceTableId: string;
    destinationTableId: string;
    destinationSeatNumber: number;
  }
): VerifiedTournamentSeatMoveReceipt | null {
  const receipt = asRecord(raw);
  const sourceSeatNumber = exactSeat(receipt.source_seat_number);
  const destinationSeatNumber = exactSeat(receipt.destination_seat_number);
  const stack = exactPositiveStack(receipt.stack);
  const movedAt =
    typeof receipt.moved_at === 'string' && Number.isFinite(Date.parse(receipt.moved_at))
      ? receipt.moved_at
      : null;
  if (
    receipt.ok !== true ||
    exactUuid(receipt.request_id) !== expected.requestId ||
    exactUuid(receipt.tournament_id) !== expected.tournamentId ||
    exactUuid(receipt.user_id) !== expected.userId ||
    exactUuid(receipt.source_table_id) !== expected.sourceTableId ||
    exactUuid(receipt.destination_table_id) !== expected.destinationTableId ||
    exactUuid(receipt.source_seat_id) === null ||
    exactUuid(receipt.destination_seat_id) === null ||
    sourceSeatNumber === null ||
    destinationSeatNumber !== expected.destinationSeatNumber ||
    stack === null ||
    movedAt === null ||
    typeof receipt.replayed !== 'boolean'
  ) {
    return null;
  }
  return {
    requestId: expected.requestId,
    tournamentId: expected.tournamentId,
    userId: expected.userId,
    sourceTableId: expected.sourceTableId,
    destinationTableId: expected.destinationTableId,
    sourceSeatId: receipt.source_seat_id as string,
    destinationSeatId: receipt.destination_seat_id as string,
    sourceSeatNumber,
    destinationSeatNumber,
    stack,
    movedAt,
    replayed: receipt.replayed,
  };
}

/**
 * Submit exactly one durable move identity twice at most. The second call is
 * both the retry and the lost-response resolver because the database serializes
 * on the same global settlement lock and replays the immutable receipt.
 */
export async function moveTournamentPlayerAtomically(input: {
  requestId: string;
  tournamentId: string;
  userId: string;
  sourceTableId: string;
  destinationTableId: string;
  destinationSeatNumber: number;
}): Promise<VerifiedTournamentSeatMoveReceipt> {
  let lastFailure = 'tournament seat move returned no receipt';
  let knownRefusal = false;
  const request = {
    p_request_id: input.requestId,
    p_tournament_id: input.tournamentId,
    p_user_id: input.userId,
    p_source_table_id: input.sourceTableId,
    p_destination_table_id: input.destinationTableId,
    p_destination_seat_number: input.destinationSeatNumber,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await supabase.rpc('fn_move_tournament_player', request);
      if (!error) {
        const receipt = verify(data, input);
        if (receipt) return receipt;
        lastFailure = 'tournament seat move returned an invalid stored receipt';
        knownRefusal = false;
      } else {
        lastFailure = message(error);
        const code = String((error as { code?: unknown }).code ?? '');
        knownRefusal = ['22023', '23505', '28000', '55000', 'P0002', 'P0404'].includes(code);
      }
    } catch (error) {
      lastFailure = message(error);
      knownRefusal = false;
    }
  }

  if (knownRefusal) throw new TournamentSeatMoveRefusedError(lastFailure);
  throw new TournamentSeatMoveOutcomeUnknownError(
    `Tournament seat move outcome is unknown after two identical attempts: ${lastFailure}`
  );
}
