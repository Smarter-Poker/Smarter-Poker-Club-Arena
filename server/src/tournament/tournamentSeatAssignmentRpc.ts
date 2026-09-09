import { supabase } from '../services/supabase.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VerifiedTournamentSeatAssignmentReceipt {
  tournamentId: string;
  userId: string;
  tableId: string;
  seatId: string;
  seatNumber: number;
  stack: number;
  currentPlayers: number;
  assignedAt: string;
  replayed: boolean;
}

export class TournamentSeatAssignmentRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TournamentSeatAssignmentRefusedError';
  }
}

export class TournamentSeatAssignmentOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TournamentSeatAssignmentOutcomeUnknownError';
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

function exactCount(value: unknown): number | null {
  const count = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(count) && count >= 1 && count <= 10 ? count : null;
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
    tournamentId: string;
    userId: string;
    tableId: string;
    seatNumber: number;
  }
): VerifiedTournamentSeatAssignmentReceipt | null {
  const receipt = asRecord(raw);
  const seatNumber = exactSeat(receipt.seat_number);
  const stack = exactPositiveStack(receipt.stack);
  const currentPlayers = exactCount(receipt.current_players);
  const assignedAt =
    typeof receipt.assigned_at === 'string' && Number.isFinite(Date.parse(receipt.assigned_at))
      ? receipt.assigned_at
      : null;
  if (
    receipt.ok !== true ||
    exactUuid(receipt.tournament_id) !== expected.tournamentId ||
    exactUuid(receipt.user_id) !== expected.userId ||
    exactUuid(receipt.table_id) !== expected.tableId ||
    exactUuid(receipt.seat_id) === null ||
    seatNumber !== expected.seatNumber ||
    stack === null ||
    currentPlayers === null ||
    assignedAt === null ||
    typeof receipt.replayed !== 'boolean'
  ) {
    return null;
  }
  return {
    tournamentId: expected.tournamentId,
    userId: expected.userId,
    tableId: expected.tableId,
    seatId: receipt.seat_id as string,
    seatNumber,
    stack,
    currentPlayers,
    assignedAt,
    replayed: receipt.replayed,
  };
}

/**
 * One service call assigns the seat, roster coordinates and exact table count.
 * The database derives the stack from the locked tournament-player row. There
 * is intentionally no client-side fallback or compensating write: an unknown
 * transport outcome is reread by the manager's normal durable lifecycle pass,
 * and the RPC returns the same exact receipt when that assignment committed.
 */
export async function assignTournamentPlayerSeatAtomically(input: {
  tournamentId: string;
  userId: string;
  tableId: string;
  seatNumber: number;
}): Promise<VerifiedTournamentSeatAssignmentReceipt> {
  const request = {
    p_tournament_id: input.tournamentId,
    p_user_id: input.userId,
    p_table_id: input.tableId,
    p_seat_number: input.seatNumber,
  };

  let data: unknown;
  let error: unknown;
  try {
    const response = await supabase.rpc('fn_assign_tournament_player_seat_atomic', request);
    data = response.data;
    error = response.error;
  } catch (caught) {
    throw new TournamentSeatAssignmentOutcomeUnknownError(
      `Tournament seat assignment outcome is unknown: ${message(caught)}`
    );
  }

  if (error) {
    const code = String((error as { code?: unknown }).code ?? '');
    const detail = message(error);
    if (['22023', '23505', '28000', '55000', 'P0002', 'P0404'].includes(code)) {
      throw new TournamentSeatAssignmentRefusedError(detail);
    }
    throw new TournamentSeatAssignmentOutcomeUnknownError(
      `Tournament seat assignment outcome is unknown: ${detail}`
    );
  }

  const raw = asRecord(data);
  if (raw.ok === false) {
    throw new TournamentSeatAssignmentRefusedError(
      typeof raw.reason === 'string' && raw.reason ? raw.reason : 'assignment refused'
    );
  }
  const receipt = verify(raw, input);
  if (!receipt) {
    throw new TournamentSeatAssignmentOutcomeUnknownError(
      'Tournament seat assignment returned an invalid exact receipt'
    );
  }
  return receipt;
}
