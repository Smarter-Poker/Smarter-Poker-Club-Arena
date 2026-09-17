import { validateCashoutAmount } from '../utils/cashoutAmount';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CASHOUT SERVICE — Player Chip Cashout Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Player requests -> chips leave their balance into escrow -> the agent accepts
 * (the chips land in THAT AGENT'S WALLET) or declines (they go back).
 *
 * ── WHY THIS STOPPED GOING THROUGH THE API ROUTES (2026-08-25) ───────────────
 *
 * Every leg used to be a fetch to a World Hub route holding the service role
 * key, because the underlying functions were SECURITY INVOKER and a browser
 * calling them got 42501. That indirection hid three real faults:
 *
 *  - `fn_approve_cashout_atomic` credited the approving agent's
 *    club_members.chip_balance, which is their PLAYER wallet, not their agent
 *    float. Dan: "Once approved the chips go into the agent's wallet."
 *  - it never checked that the escrow row it was releasing existed, while an
 *    RLS policy let a player INSERT a cashout_requests row directly. An
 *    unescrowed request, approved, credited an agent out of nothing.
 *  - `cashout_requests` could only be SELECTed by the player, so the agent
 *    panel built to work the queue was empty for every agent alive.
 *
 * The legs are now SECURITY DEFINER RPCs that derive the actor from auth.uid()
 * and do the whole thing in one transaction: money, status, escrow release,
 * ledger row and the in-app notification. The server owns the durable push
 * outbox too; this client never sends a second notification.
 *
 * ── THE TEN MINUTE WINDOW IS NOT HERE ──────────────────────────────────────
 *
 * It belongs to the AGENT WALLET SEND, not to the cashout. See
 * fn_agent_wallet_claim_back and `sendChipsToPlayer` below.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { getIdentityDNAStatus } from '../core/IdentityDNA';
import { masterBus } from '../core/MasterBus';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
// The file is PushNotificationService.ts. macOS resolves './push...' anyway and
// Linux CI does not, which is exactly how a red test reached main on 2026-08-21.

/**
 * crypto.randomUUID is not in every embedded webview; fall back rather than throw.
 *
 * EXPORTED ON PURPOSE (2026-08-25). An op id minted INSIDE the service is fresh
 * on every call, which protects nothing: the retry a lost response provokes is a
 * SECOND call, and a second call used to carry a second op id and move the money
 * twice. Cashout lifecycle calls require the caller's retained UUID at runtime.
 * Their callers preserve uncertain operations in the durable operation store.
 * The legacy send/claim/admin paths below retain their separate existing API.
 */
export function newOpId(): string {
  try {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Legacy send/claim/admin responses. Cashout lifecycle mutations require v2 receipts below. */
interface CashoutRpcResult {
  success?: boolean;
  error?: string;
  replayed?: boolean;
  cashout_id?: string;
  club_id?: string;
  agent_id?: string;
  player_id?: string;
  player_name?: string;
  amount?: number;
  agent_wallet_after?: number;
  player_balance_after?: number;
}

function unwrap(data: unknown): CashoutRpcResult | null {
  return (Array.isArray(data) ? data[0] : data) as CashoutRpcResult | null;
}

/** Caller-owned view generation; captures the original account, club and intent. */
export interface CashoutMutationIntent {
  clubId: string;
  amount: number;
  playerId: string;
  isCurrent: () => boolean;
}

type CashoutEventKind = 'hold' | 'approval' | 'cancellation' | 'decline';
type JsonObject = Record<string, unknown>;
interface CashoutContext extends CashoutMutationIntent {
  actorId: string;
  generation: number;
  opId: string;
  cashoutId?: string;
  dispatched: boolean;
}

/** Keep the original operation identity on uncertain outcomes; never auto-resubmit. */
export class CashoutOutcomeUnknownError extends Error {
  readonly operationId: string;
  readonly clubId: string;
  readonly cashoutId?: string;
  constructor(message: string, context: CashoutContext) {
    super(message);
    this.name = 'CashoutOutcomeUnknownError';
    this.operationId = context.opId;
    this.clubId = context.clubId;
    this.cashoutId = context.cashoutId;
  }
}

let cashoutAccount: string | null | undefined;
let cashoutGeneration = 0;
masterBus.subscribe('AUTH_STATE_CHANGED', (event) => {
  const next = event.payload.isAuthenticated ? event.payload.userId : null;
  if (next !== cashoutAccount) {
    cashoutAccount = next;
    cashoutGeneration += 1;
  }
});
function currentCashoutAccount(): string | null {
  const identity = getIdentityDNAStatus();
  const next = identity?.loaded && identity.authenticated ? identity.userId : null;
  if (next !== cashoutAccount) {
    cashoutAccount = next;
    cashoutGeneration += 1;
  }
  return next;
}
/** Capture the same account generation for non-React callers and every await. */
export function captureCashoutAccountGuard(expectedActorId: string): () => boolean {
  if (!uuidValue(expectedActorId) || currentCashoutAccount() !== expectedActorId) {
    throw new Error('Sign In To The Account That Started This Cashout');
  }
  const generation = cashoutGeneration;
  let valid = true;
  return () => {
    valid =
      valid && currentCashoutAccount() === expectedActorId && cashoutGeneration === generation;
    return valid;
  };
}
const uuidValue = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000';
const objectValue = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function timestampValue(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}
function receiptMoney(value: unknown, allowZero = false): number | null {
  if (typeof value !== 'string' || value.length > 128 || !/^(0|[1-9]\d*)\.\d{2}$/.test(value))
    return null;
  const cents = BigInt(value.replace('.', ''));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || (!allowZero && cents === 0n)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) &&
    amount.toFixed(2) === value &&
    BigInt(Math.round(amount * 100)) === cents
    ? amount
    : null;
}
function assertCashoutCurrent(context: CashoutContext): void {
  let current = false;
  try {
    current = context.isCurrent() === true;
  } catch {
    /* A failed view fence refuses. */
  }
  if (
    currentCashoutAccount() !== context.actorId ||
    cashoutGeneration !== context.generation ||
    !current
  ) {
    throw new CashoutOutcomeUnknownError(
      context.dispatched
        ? 'Cashout Account Or Club Changed. This Operation May Have Committed. Refresh Its Status In The Original Account Before Retrying The Same Operation.'
        : 'Cashout Account Or Club Changed Before Dispatch. Refresh The Original Intent.',
      context
    );
  }
}
function cashoutContext(
  actorId: string,
  intent: CashoutMutationIntent | undefined,
  opId: string | undefined,
  cashoutId?: string
): CashoutContext {
  if (
    !intent ||
    typeof intent.isCurrent !== 'function' ||
    !intent.clubId ||
    !uuidValue(intent.playerId) ||
    !uuidValue(actorId) ||
    !uuidValue(opId) ||
    (cashoutId !== undefined && !uuidValue(cashoutId))
  ) {
    throw new Error(
      'Cashout Requires A Verified Account, Club, Amount, View Intent And Retained Operation ID'
    );
  }
  const validation = validateCashoutAmount(typeof intent.amount === 'number' ? intent.amount : NaN);
  if (!validation.ok) throw new Error(validation.error);
  if (currentCashoutAccount() !== actorId)
    throw new Error('Sign In To The Account That Started This Cashout');
  // PostgreSQL emits UUIDs in canonical lowercase. Normalize validated intent
  // identities before role comparisons, dispatch and receipt matching so casing
  // cannot turn a self-decline into a committed player cancellation.
  const context = {
    ...intent,
    playerId: intent.playerId.toLowerCase(),
    actorId,
    opId: opId.toLowerCase(),
    cashoutId: cashoutId?.toLowerCase(),
    generation: cashoutGeneration,
    dispatched: false,
  };
  assertCashoutCurrent(context);
  return context;
}

const CASHIER_SHARED_FIELDS = [
  'contract_version',
  'event_id',
  'invoice_id',
  'cashout_id',
  'escrow_id',
  'source_transaction_id',
  'source_ledger_id',
  'club_id',
  'player_id',
  'assigned_agent_id',
  'issuer_representative_id',
  'actor_user_id',
  'actor_role',
  'event_kind',
  'display_state',
  'amount',
  'occurred_at',
  'issued_at',
  'hold_event_id',
  'hold_invoice_id',
  'ledger_from_type',
  'ledger_from_entity_id',
  'ledger_to_type',
  'ledger_to_entity_id',
  'custody_movement_recorded',
  'cashout_completed',
  'refund_recorded',
] as const;
const EVENT_STATE = {
  hold: ['pending', 'held'],
  approval: ['approved', 'approved'],
  cancellation: ['cancelled', 'refunded'],
  decline: ['rejected', 'refunded'],
} as const;

function verifiedCashoutReceipt(
  data: unknown,
  context: CashoutContext,
  kind: CashoutEventKind,
  acceptedNote: string | null
): CashoutRequest {
  const refuse = (): never => {
    throw new CashoutOutcomeUnknownError(
      'Cashout Receipt Was Not Confirmed. Refresh Its Status Before Retrying The Same Operation.',
      context
    );
  };
  if (
    !objectValue(data) ||
    data.success !== true ||
    data.contract_version !== 1 ||
    typeof data.replayed !== 'boolean' ||
    !objectValue(data.cashier) ||
    !objectValue(data.request)
  )
    return refuse();
  const cashier = data.cashier;
  if (
    CASHIER_SHARED_FIELDS.some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(data, key) ||
        !Object.prototype.hasOwnProperty.call(cashier, key) ||
        data[key] !== cashier[key]
    )
  )
    return refuse();
  const row = data.request;
  for (const key of [
    'event_id',
    'invoice_id',
    'cashout_id',
    'escrow_id',
    'source_transaction_id',
    'source_ledger_id',
    'club_id',
    'player_id',
    'assigned_agent_id',
    'issuer_representative_id',
    'actor_user_id',
  ] as const) {
    if (!uuidValue(data[key])) return refuse();
  }
  if (
    data.actor_user_id !== context.actorId ||
    data.club_id !== context.clubId ||
    data.player_id !== context.playerId ||
    data.op_id !== context.opId ||
    data.accepted_note !== acceptedNote ||
    (context.cashoutId !== undefined && data.cashout_id !== context.cashoutId) ||
    data.event_kind !== kind ||
    data.request_status !== EVENT_STATE[kind][0] ||
    data.display_state !== EVENT_STATE[kind][1] ||
    receiptMoney(data.amount) !== context.amount ||
    !timestampValue(data.occurred_at) ||
    !timestampValue(data.issued_at) ||
    ![
      'player',
      'member',
      'sub_agent',
      'agent',
      'super_agent',
      'admin',
      'co_owner',
      'owner',
    ].includes(String(data.actor_role)) ||
    data.custody_movement_recorded !== true ||
    data.cashout_completed !== (kind === 'approval') ||
    data.refund_recorded !== (kind === 'cancellation' || kind === 'decline')
  )
    return refuse();
  const playerAction = kind === 'hold' || kind === 'cancellation';
  if (
    playerAction
      ? context.actorId !== context.playerId
      : context.actorId === context.playerId ||
        !['sub_agent', 'agent', 'super_agent', 'admin', 'co_owner', 'owner'].includes(
          String(data.actor_role)
        )
  )
    return refuse();
  const hold = kind === 'hold';
  if (
    hold
      ? data.hold_event_id !== null || data.hold_invoice_id !== null
      : !uuidValue(data.hold_event_id) ||
        !uuidValue(data.hold_invoice_id) ||
        data.hold_event_id === data.event_id ||
        data.hold_invoice_id === data.invoice_id
  )
    return refuse();
  if (
    data.ledger_from_type !== (hold ? 'player_wallet' : 'escrow') ||
    data.ledger_from_entity_id !== (hold ? context.playerId : data.escrow_id) ||
    data.ledger_to_type !==
      (hold ? 'escrow' : kind === 'approval' ? 'agent_wallet' : 'player_wallet') ||
    data.ledger_to_entity_id !==
      (hold ? data.escrow_id : kind === 'approval' ? context.actorId : context.playerId)
  )
    return refuse();
  if (
    kind === 'decline'
      ? data.actor_wallet_after !== null
      : receiptMoney(data.actor_wallet_after, true) === null
  )
    return refuse();
  if (
    row.id !== data.cashout_id ||
    row.club_id !== context.clubId ||
    row.player_id !== context.playerId ||
    row.agent_id !== data.assigned_agent_id ||
    receiptMoney(row.amount) !== context.amount ||
    !timestampValue(row.created_at) ||
    !timestampValue(row.updated_at) ||
    !['pending', 'approved', 'cancelled', 'rejected', 'expired'].includes(String(row.status)) ||
    (!hold && row.status !== EVENT_STATE[kind][0]) ||
    (hold && data.replayed === false && row.status !== 'pending') ||
    (hold && data.occurred_at !== row.created_at)
  )
    return refuse();
  for (const key of ['acknowledged_at', 'completed_at', 'cancelled_at'] as const) {
    if (
      !Object.prototype.hasOwnProperty.call(row, key) ||
      (row[key] !== null && !timestampValue(row[key]))
    )
      return refuse();
  }
  for (const key of ['player_note', 'agent_note'] as const) {
    if (
      !Object.prototype.hasOwnProperty.call(row, key) ||
      (row[key] !== null && typeof row[key] !== 'string')
    )
      return refuse();
  }
  // Match fn_cashier_operation_receipt's current request invariants, including
  // terminal rows returned with a replayed historical hold receipt.
  if (
    (!hold && row.updated_at !== data.occurred_at) ||
    (row.status === 'pending' && row.updated_at !== row.created_at) ||
    row.acknowledged_at !==
      (row.status === 'approved' || row.status === 'rejected' ? row.updated_at : null) ||
    row.completed_at !== (row.status === 'approved' ? row.updated_at : null) ||
    row.cancelled_at !==
      (['cancelled', 'rejected', 'expired'].includes(String(row.status)) ? row.updated_at : null) ||
    (hold && row.player_note !== acceptedNote) ||
    ((kind === 'approval' || kind === 'decline') && row.agent_note !== acceptedNote)
  )
    return refuse();
  return {
    id: row.id as string,
    clubId: row.club_id as string,
    playerId: row.player_id as string,
    agentId: row.agent_id as string,
    amount: context.amount,
    status: row.status as CashoutStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: (row.acknowledged_at as string | null) ?? undefined,
    completedAt: (row.completed_at as string | null) ?? undefined,
    cancelledAt: (row.cancelled_at as string | null) ?? undefined,
    playerNote: (row.player_note as string | null) ?? undefined,
    agentNote: (row.agent_note as string | null) ?? undefined,
  };
}

async function mutateCashout(
  context: CashoutContext,
  kind: CashoutEventKind,
  note?: string
): Promise<CashoutRequest> {
  if (note !== undefined && typeof note !== 'string') throw new Error('Cashout Note Must Be Text');
  const normalizedNote = note?.trim() || null;
  try {
    context.clubId = await resolveClubUUID(context.clubId);
  } catch (error) {
    assertCashoutCurrent(context);
    throw error;
  }
  assertCashoutCurrent(context);
  if (!uuidValue(context.clubId)) throw new Error('Cashout Club Could Not Be Verified');
  context.clubId = context.clubId.toLowerCase();
  const rpc =
    kind === 'hold'
      ? 'fn_cashout_request_v2'
      : kind === 'approval'
        ? 'fn_cashout_approve_v2'
        : 'fn_cashout_release_v2';
  context.dispatched = true;
  let response: unknown;
  try {
    response = await supabase.rpc(rpc, {
      p_club_id: context.clubId,
      p_amount: context.amount.toFixed(2),
      p_expected_actor_id: context.actorId,
      p_op_id: context.opId,
      p_note: normalizedNote,
      ...(context.cashoutId ? { p_cashout_id: context.cashoutId } : {}),
    });
  } catch {
    assertCashoutCurrent(context);
    throw new CashoutOutcomeUnknownError(
      'Cashout Response Was Lost. This Operation May Have Committed. Refresh Its Status Before Retrying The Same Operation.',
      context
    );
  }
  assertCashoutCurrent(context);
  if (!objectValue(response))
    throw new CashoutOutcomeUnknownError(
      'Cashout Response Was Not Confirmed. Refresh Its Status Before Retrying The Same Operation.',
      context
    );
  const { data, error } = response;
  if (error)
    throw new CashoutOutcomeUnknownError(
      'Cashout Could Not Be Confirmed. Refresh Its Status Before Retrying The Same Operation.',
      context
    );
  if (objectValue(data) && data.success === false)
    throw new Error(typeof data.error === 'string' ? data.error : 'Cashout Was Refused');
  const request = verifiedCashoutReceipt(data, context, kind, normalizedNote);
  assertCashoutCurrent(context);
  return request;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 'expired' was missing until 2026-08-25, and it is a status the database
 * genuinely writes: fn_expire_stale_cashouts flips a request that nobody acted
 * on and refunds the escrow. Without it here, an expired row narrowed to a
 * status this union says is impossible, and every `status === ...` branch in the
 * UI silently treated it as pending.
 */
export type CashoutStatus =
  | 'pending'
  | 'approved'
  | 'completed'
  | 'cancelled'
  | 'rejected'
  | 'expired';

export interface CashoutRequest {
  id: string;
  clubId: string;
  playerId: string;
  playerName?: string;
  playerAvatar?: string;
  agentId: string;
  agentName?: string;
  amount: number;
  status: CashoutStatus;
  playerNote?: string;
  agentNote?: string;
  createdAt: string;
  /** Legacy queue rows do not expose update time; mutation receipts always do. */
  updatedAt?: string;
  acknowledgedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

/** Cashout-specific transaction (distinct from the canonical ChipTransaction in database.types) */
export interface CashoutTransaction {
  id: string;
  clubId: string;
  fromUserId?: string;
  toUserId?: string;
  amount: number;
  transactionType: 'send' | 'remove' | 'cashout' | 'escrow_lock' | 'escrow_release';
  relatedCashoutId?: string;
  reversibleUntil?: string;
  isReversed: boolean;
  createdAt: string;
  notes?: string;
}

/** Validate the existing read APIs without upgrading their statuses to payer proof. */
function readCashoutRow(value: unknown): CashoutRequest {
  const refuse = (): never => {
    throw new Error('Cashout Row Could Not Be Verified');
  };
  if (!objectValue(value)) return refuse();
  for (const key of ['id', 'club_id', 'player_id', 'agent_id'] as const)
    if (!uuidValue(value[key])) return refuse();
  if (
    typeof value.amount !== 'number' &&
    (typeof value.amount !== 'string' ||
      value.amount.length > 128 ||
      !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value.amount))
  )
    return refuse();
  const amount = validateCashoutAmount(value.amount as number | string);
  if (
    !amount.ok ||
    !timestampValue(value.created_at) ||
    !['pending', 'approved', 'completed', 'cancelled', 'rejected', 'expired'].includes(
      String(value.status)
    )
  )
    return refuse();
  for (const key of ['updated_at', 'acknowledged_at', 'completed_at', 'cancelled_at'] as const) {
    if (value[key] != null && !timestampValue(value[key])) return refuse();
  }
  for (const key of ['player_note', 'agent_note', 'player_name', 'player_avatar'] as const) {
    if (value[key] != null && typeof value[key] !== 'string') return refuse();
  }
  const player = objectValue(value.player) ? value.player : {};
  const agent = objectValue(value.agent) ? value.agent : {};
  return {
    id: value.id as string,
    clubId: value.club_id as string,
    playerId: value.player_id as string,
    agentId: value.agent_id as string,
    amount: amount.amount,
    status: value.status as CashoutStatus,
    createdAt: value.created_at,
    updatedAt: (value.updated_at as string | null | undefined) ?? undefined,
    acknowledgedAt: (value.acknowledged_at as string | null | undefined) ?? undefined,
    completedAt: (value.completed_at as string | null | undefined) ?? undefined,
    cancelledAt: (value.cancelled_at as string | null | undefined) ?? undefined,
    playerNote: (value.player_note as string | null | undefined) ?? undefined,
    agentNote: (value.agent_note as string | null | undefined) ?? undefined,
    playerName:
      (value.player_name as string | undefined) ??
      (typeof player.display_name === 'string' ? player.display_name : undefined),
    playerAvatar:
      (value.player_avatar as string | undefined) ??
      (typeof player.avatar_url === 'string' ? player.avatar_url : undefined),
    agentName: typeof agent.display_name === 'string' ? agent.display_name : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class CashoutServiceClass {
  /**
   * Requires the matching v2 database component, a retained operation key and
   * the caller's account/club generation fence. No old success-only fallback.
   * The server owns money, immutable documents and notification delivery.
   */
  /** Exact past-operation lookup. Locks may be taken; no business records are written. */
  async lookupCashoutOperation(
    actorId: string,
    opId: string,
    intent: CashoutMutationIntent,
    kind: CashoutEventKind,
    cashoutId?: string,
    note?: string
  ): Promise<{ found: true; request: CashoutRequest } | { found: false }> {
    const context = cashoutContext(actorId, intent, opId, cashoutId);
    if (
      !['hold', 'approval', 'cancellation', 'decline'].includes(kind) ||
      (kind === 'hold' ? cashoutId !== undefined : cashoutId === undefined) ||
      (kind === 'hold' || kind === 'cancellation'
        ? context.actorId !== context.playerId
        : context.actorId === context.playerId) ||
      (note !== undefined && typeof note !== 'string')
    ) {
      throw new Error('The Cashout Lookup Does Not Match Its Original Intent');
    }
    const acceptedNote = note?.trim() || null;
    try {
      context.clubId = await resolveClubUUID(context.clubId);
    } catch (error) {
      assertCashoutCurrent(context);
      throw error;
    }
    assertCashoutCurrent(context);
    if (!uuidValue(context.clubId)) throw new Error('Cashout Club Could Not Be Verified');
    context.clubId = context.clubId.toLowerCase();
    const action = kind === 'hold' ? 'hold' : kind === 'approval' ? 'approval' : 'release';
    const refuse = (): never => {
      throw new CashoutOutcomeUnknownError(
        'The Previous Cashout Outcome Could Not Be Verified. No New Cashout Was Sent. Check The Same Operation Again.',
        context
      );
    };
    let response: unknown;
    try {
      response = await supabase.rpc('fn_cashout_operation_receipt_v2', {
        p_expected_actor_id: context.actorId,
        p_op_id: context.opId,
        p_action: action,
        p_club_id: context.clubId,
        p_amount: context.amount.toFixed(2),
        p_cashout_id: context.cashoutId ?? null,
        p_note: acceptedNote,
      });
    } catch {
      assertCashoutCurrent(context);
      return refuse();
    }
    assertCashoutCurrent(context);
    if (!objectValue(response) || response.error || !objectValue(response.data)) return refuse();
    const data = response.data;
    const keys = [
      'contract_version',
      'actor_user_id',
      'op_id',
      'action',
      'club_id',
      'amount',
      'cashout_id',
      'accepted_note',
      'found',
      'receipt',
    ];
    if (
      Object.keys(data).length !== keys.length ||
      keys.some((key) => !Object.prototype.hasOwnProperty.call(data, key)) ||
      data.contract_version !== 1 ||
      data.actor_user_id !== context.actorId ||
      data.op_id !== context.opId ||
      data.action !== action ||
      data.club_id !== context.clubId ||
      data.amount !== context.amount.toFixed(2) ||
      data.cashout_id !== (context.cashoutId ?? null) ||
      data.accepted_note !== acceptedNote
    )
      return refuse();
    if (data.found === false && data.receipt === null) return { found: false };
    if (data.found !== true || !objectValue(data.receipt) || data.receipt.replayed !== true)
      return refuse();
    const request = verifiedCashoutReceipt(data.receipt, context, kind, acceptedNote);
    assertCashoutCurrent(context);
    return { found: true, request };
  }

  async requestCashout(
    playerId: string,
    clubId: string,
    amount: number,
    note?: string,
    opId?: string,
    isCurrent?: () => boolean
  ): Promise<CashoutRequest> {
    const validation = validateCashoutAmount(typeof amount === 'number' ? amount : NaN);
    if (!validation.ok) throw new Error(validation.error);
    const context = cashoutContext(
      playerId,
      { clubId, amount, playerId, isCurrent: isCurrent as () => boolean },
      opId
    );
    const request = await mutateCashout(context, 'hold', note);
    assertCashoutCurrent(context);
    // A replay may describe an original hold whose request has since closed.
    // Return the verified current row; never fabricate a pending state.
    masterBus.emit('BALANCE_UPDATED', { source: 'cashout_request', userId: playerId });
    masterBus.emit('CASHOUT_REQUESTED', { clubId: context.clubId, amount, userId: playerId });
    return request;
  }

  async cancelCashout(
    cashoutId: string,
    playerId: string,
    opId?: string,
    intent?: CashoutMutationIntent
  ): Promise<boolean> {
    const context = cashoutContext(playerId, intent, opId, cashoutId);
    if (context.playerId !== playerId)
      throw new Error('Only The Original Player Can Cancel This Cashout');
    await mutateCashout(context, 'cancellation');
    assertCashoutCurrent(context);
    masterBus.emit('BALANCE_UPDATED', { source: 'cashout_cancel', userId: context.playerId });
    masterBus.emit('CASHOUT_CANCELLED', { cashoutId: context.cashoutId!, clubId: context.clubId });
    return true;
  }

  async approveCashout(
    cashoutId: string,
    agentId: string,
    note?: string,
    opId?: string,
    intent?: CashoutMutationIntent
  ): Promise<boolean> {
    const context = cashoutContext(agentId, intent, opId, cashoutId);
    if (context.playerId === agentId) throw new Error('You Cannot Approve Your Own Cashout');
    await mutateCashout(context, 'approval', note);
    assertCashoutCurrent(context);
    masterBus.emit('CASHOUT_APPROVED', { cashoutId: context.cashoutId!, clubId: context.clubId });
    // The player debit happened at hold time. This is a refresh, not a second debit.
    masterBus.emit('BALANCE_UPDATED', { source: 'cashout_approved', userId: context.playerId });
    return true;
  }

  /** Retired: approval is the only terminal payer; no receipt can be inferred here. */
  async completeCashout(_cashoutId: string, _agentId: string): Promise<boolean> {
    throw new Error(
      'Separate Cashout Completion Is Retired. Refresh The Canonical Approval Receipt.'
    );
  }

  async rejectCashout(
    cashoutId: string,
    agentId: string,
    reason?: string,
    opId?: string,
    intent?: CashoutMutationIntent
  ): Promise<boolean> {
    const context = cashoutContext(agentId, intent, opId, cashoutId);
    if (context.playerId === agentId)
      throw new Error('Use Player Cancellation For Your Own Cashout');
    await mutateCashout(context, 'decline', reason);
    assertCashoutCurrent(context);
    masterBus.emit('BALANCE_UPDATED', { source: 'cashout_reject', userId: context.playerId });
    masterBus.emit('CASHOUT_CANCELLED', { cashoutId: context.cashoutId!, clubId: context.clubId });
    return true;
  }

  /**
   * Get a single cashout by ID
   */
  async getCashout(cashoutId: string): Promise<CashoutRequest | null> {
    const { data, error } = await supabase
      .from('cashout_requests')
      .select(
        `
                *,
                player:player_id(display_name, avatar_url:arena_avatar_url),
                agent:agent_id(display_name)
            `
      )
      .eq('id', cashoutId)
      .maybeSingle();

    if (error || !data) return null;

    return this.mapCashout(data);
  }

  /**
   * The queue an agent has to work.
   *
   * This used to select cashout_requests directly. Until 2026-08-25 the table's
   * ONLY select policy was `player_id = auth.uid()`, so this returned an empty
   * array to every agent it was written for, and AgentCashoutPanel rendered
   * "No Pending Cashout Requests" no matter how many were waiting.
   *
   * fn_cashout_queue answers the scoped question instead: the requests assigned
   * to you, plus anyone in your downline, plus everything in a club you run.
   */
  async getAgentPendingCashouts(agentId: string, clubId?: string): Promise<CashoutRequest[]> {
    const isCurrent = captureCashoutAccountGuard(agentId);
    const check = () => {
      if (!isCurrent())
        throw new Error('Cashout Account Changed While Reading. Refresh The Queue.');
    };
    const resolvedInput = clubId ? await resolveClubUUID(clubId) : null;
    check();
    if (clubId && !uuidValue(resolvedInput)) throw new Error('Cashout Club Could Not Be Verified');
    const resolved = resolvedInput?.toLowerCase() ?? null;
    const { data, error } = await supabase.rpc('fn_cashout_queue', {
      p_club_id: resolved,
      p_status: 'pending',
    });
    check();
    if (error) {
      reportError(error, 'CashoutService.getAgentCashouts');
      throw new Error(error.message || 'Failed to load cashout requests');
    }
    if (!Array.isArray(data)) throw new Error('Cashout Queue Could Not Be Verified');
    const seen = new Set<string>();
    return data.map((row) => {
      const request = readCashoutRow(row);
      if (
        (resolved && request.clubId !== resolved) ||
        request.status !== 'pending' ||
        seen.has(request.id)
      ) {
        throw new Error('Cashout Queue Scope Could Not Be Verified');
      }
      seen.add(request.id);
      return request;
    });
  }

  /** At most 100 scoped requests; statuses are not money movement receipts. */
  async getPlayerCashouts(
    playerId: string,
    clubId?: string,
    status?: 'pending'
  ): Promise<CashoutRequest[]> {
    const isCurrent = captureCashoutAccountGuard(playerId);
    const check = () => {
      if (!isCurrent())
        throw new Error('Cashout Account Changed While Reading. Refresh The Queue.');
    };
    const resolvedInput = clubId ? await resolveClubUUID(clubId) : null;
    check();
    if (clubId && !uuidValue(resolvedInput)) throw new Error('Cashout Club Could Not Be Verified');
    const resolved = resolvedInput?.toLowerCase() ?? null;
    let query = supabase
      .from('cashout_requests')
      .select(
        `
      *, player:player_id(display_name, avatar_url:arena_avatar_url), agent:agent_id(display_name)
    `
      )
      .eq('player_id', playerId);
    if (resolved) query = query.eq('club_id', resolved);
    if (status !== undefined && status !== 'pending')
      throw new Error('Cashout Status Filter Could Not Be Verified');
    if (status) query = query.eq('status', status);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(100);
    check();
    if (error) {
      reportError(error, 'CashoutService.getPlayerCashouts');
      throw new Error(error.message || 'Failed to load cashout requests');
    }
    if (!Array.isArray(data)) throw new Error('Cashout History Could Not Be Verified');
    const seen = new Set<string>();
    return data.map((row) => {
      const request = readCashoutRow(row);
      if (
        request.playerId !== playerId ||
        (resolved && request.clubId !== resolved) ||
        (status && request.status !== status) ||
        seen.has(request.id)
      ) {
        throw new Error('Cashout History Scope Could Not Be Verified');
      }
      seen.add(request.id);
      return request;
    });
  }

  /**
   * Agent: send chips from THE AGENT WALLET to a downline member.
   *
   * This used to call ChipFlowService.transfer, which capped the send against
   * agents.agent_wallet_balance and then debited `wallets` instead, and then
   * hand-inserted a chip_transactions row from the browser. That insert had no
   * INSERT policy behind it, so the ledger row it was trying to write for the
   * reversal window never landed either. Both halves are now one RPC.
   */
  async sendChipsToPlayer(
    agentId: string,
    playerId: string,
    clubId: string,
    amount: number,
    notes?: string,
    opId?: string
  ): Promise<boolean> {
    void agentId; // the server takes the sender from auth.uid()
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data, error } = await supabase.rpc('fn_agent_wallet_send', {
      p_club_id: resolvedClubId,
      p_to_user_id: playerId,
      p_amount: amount,
      p_destination: 'player_wallet',
      p_reason: notes || null,
      p_op_id: opId || newOpId(),
    });
    if (error) {
      reportError(error, 'CashoutService.sendChipsToPlayer');
      throw new Error(error.message || 'Failed to send chips');
    }
    const res = unwrap(data);
    if (!res?.success) throw new Error(res?.error || 'Failed to send chips');

    masterBus.emit('BALANCE_UPDATED', { source: 'agent_wallet_send', userId: playerId, amount });
    return true;
  }

  /**
   * THE TEN MINUTE MISTAKE ERASER (Dan 2026-08-25, binding).
   *
   * "Agents can only claim back chips that were sent in the first 10 minutes
   *  (reconciling a mistake); after that they cannot remove chips from downline
   *  wallets unless the downline requests a cash out."
   *
   * Takes a TRANSACTION id, never a member id, because the power granted is
   * "undo that send" and not "take chips from that person". The window is
   * enforced against chip_transactions.reversible_until inside the RPC, so a
   * client with a wrong clock, or none, cannot widen it.
   */
  async claimBackSend(
    clubId: string,
    transactionId: string,
    amount?: number,
    reason?: string,
    opId?: string
  ): Promise<{ amount: number; agentWalletAfter: number }> {
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data, error } = await supabase.rpc('fn_agent_wallet_claim_back', {
      p_club_id: resolvedClubId,
      p_transaction_id: transactionId,
      p_amount: amount ?? null,
      p_reason: reason || null,
      p_op_id: opId || newOpId(),
    });
    if (error) {
      reportError(error, 'CashoutService.claimBackSend');
      throw new Error(error.message || 'Failed to claim those chips back');
    }
    const res = unwrap(data) as (CashoutRpcResult & { source?: string }) | null;
    if (!res?.success) throw new Error(res?.error || 'Failed to claim those chips back');

    masterBus.emit('BALANCE_UPDATED', { source: 'agent_wallet_claim_back' });
    return {
      amount: Number(res.amount || 0),
      agentWalletAfter: Number(res.agent_wallet_after || 0),
    };
  }

  /**
   * FORBIDDEN by the chip-removal authority policy. Agents take chips only
   * through the player-initiated cashout flow (requestCashout -> approveCashout)
   * or, inside ten minutes, by undoing their own send (`claimBackSend`).
   * Club owners, co owners and admins use `adminRemovePlayerChips`.
   */
  async removeChipsFromPlayer(
    _agentId: string,
    _playerId: string,
    _clubId: string,
    _amount: number,
    _notes?: string
  ): Promise<boolean> {
    throw new Error(
      'Agents cannot remove chips from a player. The player must request a cashout; ' +
        'the chips are held in escrow immediately and transfer to you when you accept it.'
    );
  }

  /**
   * Club OWNER/ADMIN only: pull chips from any member at any time.
   * Enforced server-side by fn_admin_remove_player_chips, which derives the
   * actor from auth.uid(), refuses agents, row-locks the member, returns the
   * chips to the club pool and writes a chip_transactions audit row.
   *
   * `opId` closes the lost-response window. This was the ONE staff money path
   * with no idempotency key: a retry after a dropped reply pulled the chips a
   * second time. Migration 20260826 added p_op_id, a replay branch and a
   * partial unique index over (club_id, op_id) for admin_removal rows. Proved
   * against production inside a rolled-back transaction: two calls with one
   * key moved 300 chips once and wrote one ledger row.
   *
   * Pass a key HELD ACROSS A FAILURE. Minting one per call - which is what
   * every leg here used to do - makes the parameter decorative.
   */
  async adminRemovePlayerChips(
    clubId: string,
    playerId: string,
    amount: number,
    reason?: string,
    opId?: string
  ): Promise<{ removed: number; balanceAfter: number }> {
    const resolvedClubId = await resolveClubUUID(clubId);
    const { data, error } = await supabase.rpc('fn_admin_remove_player_chips', {
      p_club_id: resolvedClubId,
      p_player_id: playerId,
      p_amount: amount,
      p_reason: reason || null,
      p_op_id: opId || newOpId(),
    });
    if (error) {
      reportError(error, 'CashoutService.adminRemovePlayerChips');
      throw new Error(error.message || 'Failed to remove chips');
    }
    const res = data as {
      success?: boolean;
      error?: string;
      removed?: number;
      balance_after?: number;
    };
    if (!res?.success) throw new Error(res?.error || 'Failed to remove chips');

    masterBus.emit('BALANCE_UPDATED', { source: 'admin_removal', userId: playerId });
    return { removed: Number(res.removed || 0), balanceAfter: Number(res.balance_after || 0) };
  }

  /**
   * Map database record to CashoutRequest
   */
  private mapCashout(data: Record<string, unknown>): CashoutRequest {
    return {
      id: data.id as string,
      clubId: data.club_id as string,
      playerId: data.player_id as string,
      playerName: (data.player as Record<string, unknown>)?.display_name as string,
      playerAvatar: (data.player as Record<string, unknown>)?.avatar_url as string,
      agentId: data.agent_id as string,
      agentName: (data.agent as Record<string, unknown>)?.display_name as string,
      amount: data.amount as number,
      status: data.status as CashoutStatus,
      playerNote: data.player_note as string,
      agentNote: data.agent_note as string,
      createdAt: data.created_at as string,
      updatedAt: data.updated_at as string,
      acknowledgedAt: data.acknowledged_at as string,
      completedAt: data.completed_at as string,
      cancelledAt: data.cancelled_at as string,
    };
  }

  /** System expiry belongs to the service-only scheduler and its durable receipts. */
  async expireStale(_maxHours = 72): Promise<{ expired: number }> {
    throw new Error(
      'Browser Cashout Expiry Is Retired. Only The Canonical Server Scheduler May Expire Holds.'
    );
  }
}

// Export singleton
export const cashoutService = new CashoutServiceClass();
