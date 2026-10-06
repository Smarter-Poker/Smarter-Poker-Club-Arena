/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DISPUTE SERVICE — Settlement Dispute Resolution Workflow
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * P2-16: Manages the lifecycle of financial disputes:
 *   Agent submits dispute → Owner reviews → Resolved / Escalated
 *
 * Dispute targets: agent settlements, cashout requests, credit invoices
 * Dispute states:  open → under_review → resolved | escalated | withdrawn
 */

import { supabase } from '../lib/supabase';
import { FinancialAlertService } from './FinancialAlertService';
import { masterBus } from '../core/MasterBus';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

// AUDIT M17: fn_resolve_dispute returns a `reason` for ordinary refusals rather
// than raising, so an admin sees why the server said no.
const DISPUTE_REASON_TEXT: Record<string, string> = {
  not_found: 'That dispute no longer exists',
  not_authorized: 'You do not have admin rights on this club',
  already_resolved: 'That dispute has already been resolved',
  invalid_adjustment_type: 'Adjustment type must be none, credit or debit',
  no_submitter_to_adjust: 'That dispute has no submitter to adjust',
  dispute_has_no_amount: 'That dispute has no amount, so it cannot carry an adjustment',
};

function disputeReasonText(reason: string | undefined): string {
  return (
    DISPUTE_REASON_TEXT[reason ?? ''] ?? `Dispute could not be resolved (${reason ?? 'unknown'})`
  );
}

// fn_dispute_submit refuses the same way fn_resolve_dispute does: an envelope
// with a reason, not an exception, for anything a caller can correct.
const DISPUTE_SUBMIT_REASON_TEXT: Record<string, string> = {
  invalid_target_type: 'That is not something a dispute can be filed against',
  target_required: 'A dispute needs to name what it is about',
  reason_required: 'A dispute needs a reason',
  invalid_amount: 'A disputed amount cannot be negative',
  club_not_found: 'That club no longer exists',
  already_open: 'You already have an open dispute about this',
};

function disputeSubmitReasonText(reason: string | undefined): string {
  return (
    DISPUTE_SUBMIT_REASON_TEXT[reason ?? ''] ??
    `Dispute could not be filed (${reason ?? 'unknown'})`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'escalated' | 'withdrawn';
export type DisputeTarget =
  | 'agent_settlement'
  | 'cashout_request'
  | 'credit_invoice'
  | 'commission_payout';

export interface Dispute {
  id: string;
  submittedBy: string;
  submitterName: string;
  targetType: DisputeTarget;
  targetId: string;
  clubId: string;
  amount: number;
  reason: string;
  status: DisputeStatus;
  assignedTo?: string;
  resolution?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface DisputeCreate {
  targetType: DisputeTarget;
  targetId: string;
  clubId: string;
  amount: number;
  reason: string;
}

export interface DisputeResolution {
  resolution: string;
  adjustmentAmount?: number;
  adjustmentType?: 'credit' | 'debit' | 'none';
}

const DISPUTE_TARGETS = new Set<DisputeTarget>([
  'agent_settlement',
  'cashout_request',
  'credit_invoice',
  'commission_payout',
]);
const DISPUTE_STATUSES = new Set<DisputeStatus>([
  'open',
  'under_review',
  'resolved',
  'escalated',
  'withdrawn',
]);

function disputeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Dispute record could not be verified');
  }
  return value as Record<string, unknown>;
}

function disputeText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} could not be verified`);
  }
  return value;
}

function nullableDisputeText(value: unknown, label: string): string | undefined {
  return value === null ? undefined : disputeText(value, label);
}

function disputeTimestamp(value: unknown, label: string): string {
  const timestamp = disputeText(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} could not be verified`);
  return timestamp;
}

function disputeMoney(value: unknown, positive = false): number | null {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    return null;
  }
  const source = String(value).trim();
  if (!source || source.length > 128) return null;
  const match = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(source);
  const fraction = match?.[2] ?? match?.[3] ?? '';
  if (!match || /[1-9]/.test(fraction.slice(2))) return null;
  const cents = BigInt(match[1] ?? '0') * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  if ((positive && cents === 0n) || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const amount = Number(cents) / 100;
  return Math.round(amount * 100) === Number(cents) ? amount : null;
}

/** A dispute adjustment is optional, but when selected it is positive exact cents. */
export function parseDisputeAdjustmentAmount(value: string): number | null {
  return disputeMoney(value, true);
}

export function parseDispute(value: unknown): Dispute {
  const row = disputeRecord(value);
  const targetType = disputeText(row.target_type, 'Dispute target type') as DisputeTarget;
  const status = disputeText(row.status, 'Dispute status') as DisputeStatus;
  const amount = disputeMoney(row.amount);
  if (!DISPUTE_TARGETS.has(targetType) || !DISPUTE_STATUSES.has(status) || amount === null) {
    throw new Error('Dispute financial state could not be verified');
  }
  const createdAt = disputeTimestamp(row.created_at, 'Dispute creation time');
  const updatedAt = disputeTimestamp(row.updated_at, 'Dispute update time');
  const resolvedAt =
    row.resolved_at === null
      ? undefined
      : disputeTimestamp(row.resolved_at, 'Dispute resolution time');
  if (
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (resolvedAt !== undefined && Date.parse(resolvedAt) < Date.parse(createdAt))
  ) {
    throw new Error('Dispute timeline could not be verified');
  }
  return {
    id: disputeText(row.id, 'Dispute identity'),
    submittedBy: disputeText(row.submitted_by, 'Dispute submitter'),
    submitterName: disputeText(row.submitter_name, 'Dispute submitter name'),
    targetType,
    targetId: disputeText(row.target_id, 'Dispute target'),
    clubId: disputeText(row.club_id, 'Dispute club'),
    amount,
    reason: disputeText(row.reason, 'Dispute reason'),
    status,
    assignedTo: nullableDisputeText(row.assigned_to, 'Dispute assignee'),
    resolution: nullableDisputeText(row.resolution, 'Dispute resolution'),
    createdAt,
    updatedAt,
    resolvedAt,
  };
}

function disputeMutationOutcome(value: unknown): Record<string, unknown> {
  const outcome = disputeRecord(value);
  if (outcome.ok !== true && outcome.ok !== false) {
    throw new Error('Dispute mutation receipt could not be verified');
  }
  if (outcome.ok === false && (typeof outcome.reason !== 'string' || !outcome.reason.trim())) {
    throw new Error('Dispute refusal receipt could not be verified');
  }
  return outcome;
}

function requireMutationReceipt(
  outcome: Record<string, unknown>,
  disputeId: string,
  expectedStatus: DisputeStatus
): void {
  if (
    outcome.ok !== true ||
    outcome.dispute_id !== disputeId ||
    outcome.status !== expectedStatus
  ) {
    throw new Error('Dispute mutation receipt did not match the requested transition');
  }
}

async function readBackDispute(disputeId: string, expectedStatus: DisputeStatus): Promise<Dispute> {
  const { data, error } = await supabase
    .from('disputes')
    .select('*')
    .eq('id', disputeId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('This dispute could not be read back.');
  const dispute = parseDispute(data);
  if (dispute.id !== disputeId || dispute.status !== expectedStatus) {
    throw new Error('Dispute read-back did not match the requested transition');
  }
  return dispute;
}

function parseDisputeList(
  value: unknown,
  expected: { clubId?: string; submitterId?: string } = {}
): Dispute[] {
  if (!Array.isArray(value)) throw new Error('Dispute list could not be verified');
  const disputes = value.map(parseDispute);
  if (
    new Set(disputes.map((dispute) => dispute.id)).size !== disputes.length ||
    disputes.some(
      (dispute) =>
        (expected.clubId !== undefined && dispute.clubId !== expected.clubId) ||
        (expected.submitterId !== undefined && dispute.submittedBy !== expected.submitterId)
    )
  ) {
    throw new Error('Dispute list scope could not be verified');
  }
  return disputes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const DisputeService = {
  /**
   * Submit a new dispute.
   *
   * THIS WAS A CLIENT INSERT AGAINST A TABLE WITH NO INSERT GRANT. `disputes`
   * gives authenticated exactly SELECT, and its one policy is SELECT only, so
   * the insert was refused for every user who ever pressed this button, and
   * the table has held ZERO rows since it was created. Not one dispute has
   * ever been filed on this platform.
   *
   * That is the same fault startReview, resolveDispute and escalateDispute
   * each turned out to have, and each was given a definer entry point. This
   * is the last one and the one that mattered most: repairing the middle of a
   * workflow whose front door refuses every caller leaves the whole feature
   * inert and looking finished.
   *
   * fn_dispute_submit takes the submitter from the session, never from this
   * argument, so `userId` is no longer sent. The old code passed it in from
   * the browser, which in a working version would have let anyone file a
   * dispute in somebody else's name. The parameter stays so call sites do not
   * change, exactly as startReview keeps `_reviewerId`.
   */
  async submitDispute(_userId: string, dispute: DisputeCreate): Promise<Dispute> {
    const { data, error } = await supabase.rpc('fn_dispute_submit', {
      p_target_type: dispute.targetType,
      p_target_id: dispute.targetId,
      p_club_id: dispute.clubId,
      p_amount: dispute.amount,
      p_reason: dispute.reason,
    });

    if (error) {
      reportError(error, 'DisputeService.submitDispute', {
        targetType: dispute.targetType,
        clubId: dispute.clubId,
      });
      throw new Error('Could not file the dispute');
    }

    const out = disputeMutationOutcome(data);
    if (out.ok === false) throw new Error(disputeSubmitReasonText(out.reason as string));
    if (typeof out.dispute_id !== 'string' || !out.dispute_id.trim() || out.status !== 'open') {
      throw new Error('The dispute filing receipt could not be verified');
    }
    const disputeId = out.dispute_id;

    // The club owner is told by trg_notify_dispute, which fires on the INSERT
    // itself, so a dispute filed from Commander or a back-office script
    // notifies identically. Nothing is sent from here.
    const row = await readBackDispute(disputeId, 'open');
    if (
      row.clubId !== dispute.clubId ||
      row.targetType !== dispute.targetType ||
      row.targetId !== dispute.targetId ||
      row.amount !== dispute.amount ||
      row.reason !== dispute.reason
    ) {
      throw new Error('The filed dispute did not match the submitted request');
    }
    return row;
  },

  /**
   * Get disputes for a club (owner/admin view)
   */
  async getClubDisputes(clubId: string, status?: DisputeStatus): Promise<Dispute[]> {
    const resolvedClubId = await resolveClubUUID(clubId);
    let query = supabase
      .from('disputes')
      .select(
        'id, submitted_by, submitter_name, target_type, target_id, club_id, amount, reason, status, assigned_to, resolution, created_at, updated_at, resolved_at'
      )
      .eq('club_id', resolvedClubId)
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMITS.LIST);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    return parseDisputeList(data, { clubId: resolvedClubId });
  },

  /**
   * Get disputes submitted by a specific user
   */
  async getMyDisputes(userId: string): Promise<Dispute[]> {
    const { data, error } = await supabase
      .from('disputes')
      .select(
        'id, submitted_by, submitter_name, target_type, target_id, club_id, amount, reason, status, assigned_to, resolution, created_at, updated_at, resolved_at'
      )
      .eq('submitted_by', userId)
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMITS.LIST);

    if (error) throw error;
    return parseDisputeList(data, { submitterId: userId });
  },

  /**
   * Get open dispute count for badge display
   */
  async getOpenCount(clubId: string): Promise<number> {
    const { count, error } = await supabase
      .from('disputes')
      .select('*', { count: 'exact', head: true })
      .eq('club_id', await resolveClubUUID(clubId))
      .in('status', ['open', 'under_review']);

    if (error) throw error;
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error('Open dispute count could not be verified');
    }
    return count as number;
  },

  /**
   * Start reviewing a dispute (assign to reviewer).
   *
   * THIS WAS A CLIENT UPDATE AGAINST A TABLE WITH NO UPDATE POLICY. `disputes`
   * carries exactly one policy - disputes_party_or_admin_select - so the write
   * matched zero rows for every operator who ever pressed the button, the
   * maybeSingle() came back null, and the page said "Failed to start review".
   * The open -> under_review transition has therefore never happened on this
   * platform, which is also why the page's own `under_review` filter tab could
   * never fill. fn_dispute_start_review is the definer path: it locks the row,
   * checks the club, refuses a dispute that is not open, and assigns the
   * caller.
   */
  async startReview(disputeId: string, _reviewerId: string): Promise<Dispute> {
    const { data, error } = await supabase.rpc('fn_dispute_start_review', {
      p_dispute_id: disputeId,
    });
    if (error) throw error;
    const outcome = disputeMutationOutcome(data);
    if (outcome.ok === false) {
      throw new Error(
        outcome.reason === 'not_open'
          ? 'This dispute is no longer open.'
          : 'This dispute could not be moved into review.'
      );
    }
    requireMutationReceipt(outcome, disputeId, 'under_review');
    if (outcome.assigned_to !== _reviewerId) {
      throw new Error('Dispute review receipt did not name the signed-in reviewer');
    }
    const row = await readBackDispute(disputeId, 'under_review');
    if (row.assignedTo !== _reviewerId) {
      throw new Error('Dispute review read-back did not name the signed-in reviewer');
    }
    return row;
  },

  /**
   * Resolve a dispute
   */
  async resolveDispute(
    disputeId: string,
    reviewerId: string,
    resolution: DisputeResolution
  ): Promise<Dispute> {
    const adjustmentType = resolution.adjustmentType ?? 'none';
    const adjustmentAmount =
      adjustmentType === 'none' ? 0 : disputeMoney(resolution.adjustmentAmount, true);
    if (adjustmentAmount === null) {
      throw new Error('Adjustment amount must be a positive whole-cent amount');
    }
    // AUDIT M17: this used to mark the dispute resolved, then adjust the wallet
    // in a second round trip. The comment above that ordering argued it was the
    // safe direction — "if wallet adjustment fails after status update, we can
    // alert ops but we won't double-pay" — and that reasoning was sound for two
    // independent calls. It was also moot: the adjustment RPC
    // (atomic_credit_wallet_and_log / atomic_deduct_wallet_and_log) was
    // permission-denied on every call from a browser, so no dispute has ever
    // been adjusted, and the disputes UPDATE itself matched zero rows.
    //
    // fn_resolve_dispute makes the choice unnecessary: the status change and the
    // adjustment are one transaction, so neither can happen without the other
    // and there is nothing to reconcile afterwards.
    //
    // This is the ONE money function in M17 that still takes a caller-supplied
    // amount, because "what should this dispute pay" is a judgement rather than
    // a lookup. It is made safe two other ways instead: it requires club-admin
    // authority over the dispute's own club, and the server CAPS the adjustment
    // at the disputed amount. An adjustment larger than the sum in dispute is
    // not a resolution, and it is refused with the cap reported back.
    const { data: res, error } = await supabase.rpc('fn_resolve_dispute', {
      p_dispute_id: disputeId,
      p_resolution: resolution.resolution,
      p_adjustment_type: adjustmentType,
      p_adjustment_amount: adjustmentAmount,
    });

    if (error) {
      reportError(error, 'DisputeService.resolveDispute', { disputeId, reviewerId });
      throw new Error('Could not resolve the dispute');
    }

    const out = disputeMutationOutcome(res);

    if (out.ok === false) {
      if (out.reason === 'adjustment_exceeds_disputed_amount') {
        const cap = disputeMoney(out.cap);
        if (cap === null) throw new Error('Dispute adjustment cap could not be verified');
        throw new Error(`Adjustment exceeds the disputed amount (cap ${cap.toLocaleString()})`);
      }
      throw new Error(disputeReasonText(out.reason as string));
    }

    requireMutationReceipt(out, disputeId, 'resolved');
    const receiptAmount = disputeMoney(out.amount);
    if (out.adjustment_type !== adjustmentType || receiptAmount !== adjustmentAmount) {
      throw new Error('Dispute resolution receipt did not match the requested adjustment');
    }

    if (receiptAmount > 0) {
      masterBus.emit('BALANCE_UPDATED', { source: 'dispute_resolution', disputeId });
    }

    const row = await readBackDispute(disputeId, 'resolved');
    if (row.resolution !== resolution.resolution || row.resolvedAt === undefined) {
      throw new Error('Dispute resolution read-back did not match the requested resolution');
    }
    return row;
  },

  /**
   * Escalate a dispute (for critical or complex cases)
   */
  async escalateDispute(disputeId: string, reason: string): Promise<Dispute> {
    // Same story as startReview: a client UPDATE with no UPDATE policy behind
    // it. Escalation has never been written down either.
    const { data, error } = await supabase.rpc('fn_dispute_escalate', {
      p_dispute_id: disputeId,
      p_note: `Escalated: ${reason}`,
    });
    if (error) throw error;
    const outcome = disputeMutationOutcome(data);
    if (outcome.ok === false) {
      throw new Error(
        (outcome.reason as string).startsWith('already_')
          ? `This dispute is already ${(outcome.reason as string).replace('already_', '')}.`
          : 'This dispute could not be escalated.'
      );
    }
    requireMutationReceipt(outcome, disputeId, 'escalated');

    const row = await readBackDispute(disputeId, 'escalated');
    if (row.resolution !== `Escalated: ${reason}`) {
      throw new Error('Dispute escalation read-back did not match the requested reason');
    }

    // Raise financial alert for ops team
    try {
      await FinancialAlertService.logWarning(
        'DisputeService',
        `Dispute ${disputeId} escalated: ${reason}`,
        { disputeId, reason }
      );
    } catch (alertError) {
      reportError(alertError, 'DisputeService.escalation_alert', { disputeId });
    }
    return row;
  },

  /**
   * Withdraw a dispute (by submitter).
   *
   * Same story as submitDispute: a client UPDATE against a table with no
   * UPDATE grant and no UPDATE policy. It matched zero rows and reported
   * success every time, because a filtered UPDATE that matches nothing is not
   * an error. No dispute has ever been withdrawn, and the screen said it had
   * been.
   *
   * fn_dispute_withdraw locks the row, refuses anyone but the submitter, and
   * refuses a dispute that is already resolved, escalated or withdrawn.
   */
  async withdrawDispute(disputeId: string, _userId: string): Promise<void> {
    const { data, error } = await supabase.rpc('fn_dispute_withdraw', {
      p_dispute_id: disputeId,
    });

    if (error) {
      reportError(error, 'DisputeService.withdrawDispute', { disputeId });
      throw new Error('Could not withdraw the dispute');
    }

    const out = disputeMutationOutcome(data);
    if (out.ok === false) {
      throw new Error(
        out.reason === 'not_withdrawable'
          ? `This dispute is already ${out.status ?? 'closed'} and cannot be withdrawn.`
          : 'This dispute could not be withdrawn.'
      );
    }
    requireMutationReceipt(out, disputeId, 'withdrawn');
    await readBackDispute(disputeId, 'withdrawn');
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  mapDispute(row: unknown): Dispute {
    return parseDispute(row);
  },
};

export default DisputeService;
