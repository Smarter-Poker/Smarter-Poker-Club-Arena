import { supabase } from '../services/supabase.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TournamentSeatMoveSourceMode = 'live_source' | 'closed_orphan';

export interface TournamentSeatMoveInput {
  requestId: string;
  tournamentId: string;
  userId: string;
  sourceTableId: string;
  destinationTableId: string;
  destinationSeatNumber: number;
  sourceMode: TournamentSeatMoveSourceMode;
}

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
  sourceMode: TournamentSeatMoveSourceMode;
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
  expected: TournamentSeatMoveInput
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
    receipt.source_mode !== expected.sourceMode ||
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
    sourceMode: expected.sourceMode,
  };
}

/**
 * Read one immutable move receipt without borrowing a tournament manager's
 * expired lease. This transport is deliberately not a second Supabase client:
 * it can call only the receipt-only RPC, stamps ordinary service authority,
 * and exposes no general query or mutation surface.
 */
async function resolveCommittedTournamentSeatMove(
  input: TournamentSeatMoveInput
): Promise<VerifiedTournamentSeatMoveReceipt | null> {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required to resolve an ambiguous move receipt');
  }
  const baseUrl = (process.env.SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co').replace(
    /\/$/,
    ''
  );
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(new Error('move_receipt_timeout')), 15_000);
  try {
    const response = await fetch(
      `${baseUrl}/rest/v1/rpc/fn_resolve_committed_tournament_seat_move`,
      {
        method: 'POST',
        signal: ctl.signal,
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          'content-type': 'application/json',
          'x-smarter-data-actor': 'service',
          'x-smarter-data-protocol': '1',
        },
        body: JSON.stringify({
          p_request_id: input.requestId,
          p_tournament_id: input.tournamentId,
          p_user_id: input.userId,
          p_source_table_id: input.sourceTableId,
          p_destination_table_id: input.destinationTableId,
          p_destination_seat_number: input.destinationSeatNumber,
          p_source_mode: input.sourceMode,
        }),
      }
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 512);
      throw new Error(
        `committed tournament move receipt lookup failed (${response.status}): ${detail}`
      );
    }
    const raw = (await response.json()) as unknown;
    if (raw === null) return null;
    const receipt = verify(raw, input);
    if (!receipt) {
      throw new Error('committed tournament move resolver returned a mismatched receipt');
    }
    return receipt;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Submit exactly one durable move identity twice at most. If manager admission
 * fails after an ambiguous response, the final receipt-only lookup can certify
 * the committed result without reopening move authority.
 */
export async function moveTournamentPlayerAtomically(
  input: TournamentSeatMoveInput,
  options: { outcomeWasAlreadyUnknown?: boolean } = {}
): Promise<VerifiedTournamentSeatMoveReceipt> {
  let lastFailure = 'tournament seat move returned no receipt';
  let knownRefusal = false;
  let sawAmbiguousAttempt = false;
  const request = {
    p_request_id: input.requestId,
    p_tournament_id: input.tournamentId,
    p_user_id: input.userId,
    p_source_table_id: input.sourceTableId,
    p_destination_table_id: input.destinationTableId,
    p_destination_seat_number: input.destinationSeatNumber,
    p_source_mode: input.sourceMode,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await supabase.rpc('fn_move_tournament_player', request);
      if (!error) {
        const receipt = verify(data, input);
        if (receipt) return receipt;
        lastFailure = 'tournament seat move returned an invalid stored receipt';
        knownRefusal = false;
        sawAmbiguousAttempt = true;
      } else {
        lastFailure = message(error);
        const code = String((error as { code?: unknown }).code ?? '');
        knownRefusal = ['22023', '23505', '28000', '55000', 'P0002', 'P0404'].includes(code);
        if (!knownRefusal) sawAmbiguousAttempt = true;
      }
    } catch (error) {
      lastFailure = message(error);
      knownRefusal = false;
      sawAmbiguousAttempt = true;
    }
  }

  if (sawAmbiguousAttempt || options.outcomeWasAlreadyUnknown === true) {
    try {
      const committed = await resolveCommittedTournamentSeatMove(input);
      if (committed) return committed;
      lastFailure = `${lastFailure}; no exact committed receipt was visible`;
    } catch (error) {
      lastFailure = `${lastFailure}; receipt-only resolution failed: ${message(error)}`;
    }
  }

  // A refusal from a later attempt cannot prove that an earlier ambiguous
  // attempt did not commit. Only a verified receipt for this exact UUID may
  // resolve that uncertainty and let the source engine fence go.
  if (knownRefusal && !sawAmbiguousAttempt && options.outcomeWasAlreadyUnknown !== true) {
    throw new TournamentSeatMoveRefusedError(lastFailure);
  }
  throw new TournamentSeatMoveOutcomeUnknownError(
    `Tournament seat move outcome is unknown after two identical attempts: ${lastFailure}`
  );
}
