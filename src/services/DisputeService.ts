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
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
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

    const out = (data || {}) as { ok?: boolean; reason?: string; dispute_id?: string };
    if (!out.ok) throw new Error(disputeSubmitReasonText(out.reason));
    if (!out.dispute_id) {
      throw new Error('The dispute was filed but did not come back with an id');
    }

    // The club owner is told by trg_notify_dispute, which fires on the INSERT
    // itself, so a dispute filed from Commander or a back-office script
    // notifies identically. Nothing is sent from here.
    const { data: row, error: readError } = await supabase
      .from('disputes')
      .select('*')
      .eq('id', out.dispute_id)
      .maybeSingle();
    if (readError) throw readError;
    if (!row) throw new Error('This dispute could not be read back.');

    return this.mapDispute(row);
  },

  /**
   * Get disputes for a club (owner/admin view)
   */
  async getClubDisputes(clubId: string, status?: DisputeStatus): Promise<Dispute[]> {
    let query = supabase
      .from('disputes')
      .select(
        'id, submitted_by, submitter_name, target_type, target_id, club_id, amount, reason, status, assigned_to, resolution, created_at, updated_at, resolved_at'
      )
      .eq('club_id', await resolveClubUUID(clubId))
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMITS.LIST);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(this.mapDispute);
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
    return (data || []).map(this.mapDispute);
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

    if (error) return 0;
    return count || 0;
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
    const outcome = (data || {}) as { ok?: boolean; reason?: string };
    if (!outcome.ok) {
      throw new Error(
        outcome.reason === 'not_open'
          ? 'This dispute is no longer open.'
          : 'This dispute could not be moved into review.'
      );
    }
    const { data: row, error: readError } = await supabase
      .from('disputes')
      .select('*')
      .eq('id', disputeId)
      .maybeSingle();
    if (readError) throw readError;
    if (!row) throw new Error('This dispute could not be read back.');
    return this.mapDispute(row);
  },

  /**
   * Resolve a dispute
   */
  async resolveDispute(
    disputeId: string,
    reviewerId: string,
    resolution: DisputeResolution
  ): Promise<Dispute> {
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
      p_adjustment_type: resolution.adjustmentType ?? 'none',
      p_adjustment_amount: resolution.adjustmentAmount ?? 0,
    });

    if (error) {
      reportError(error, 'DisputeService.resolveDispute', { disputeId, reviewerId });
      throw new Error('Could not resolve the dispute');
    }

    const out = res as {
      ok: boolean;
      reason?: string;
      cap?: number;
      amount?: number;
      adjustment_type?: string;
    } | null;

    if (!out?.ok) {
      if (out?.reason === 'adjustment_exceeds_disputed_amount') {
        throw new Error(
          `Adjustment exceeds the disputed amount (cap ${(out.cap ?? 0).toLocaleString()})`
        );
      }
      throw new Error(disputeReasonText(out?.reason));
    }

    if ((out.amount ?? 0) > 0) {
      masterBus.emit('BALANCE_UPDATED', { source: 'dispute_resolution', disputeId });
    }

    // Re-read for the return value. The RPC owns the write; this is display
    // state, and a failure here must not imply the resolution did not happen.
    const { data } = await supabase.from('disputes').select('*').eq('id', disputeId).maybeSingle();

    // Notify the submitter
    if (data?.submitted_by) {
      try {
        // Notification removed 2026-08-30 (#1498) - trg_notify_dispute fires on the
        // status transition to 'resolved'.
      } catch (e: unknown) {
        reportError(e, 'DisputeService.notification');
      }
    }

    return this.mapDispute(data);
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
    const outcome = (data || {}) as { ok?: boolean; reason?: string };
    if (!outcome.ok) {
      throw new Error(
        outcome.reason?.startsWith('already_')
          ? `This dispute is already ${outcome.reason.replace('already_', '')}.`
          : 'This dispute could not be escalated.'
      );
    }

    // Raise financial alert for ops team
    await FinancialAlertService.logWarning(
      'DisputeService',
      `Dispute ${disputeId} escalated: ${reason}`,
      { disputeId, reason }
    );

    // `data` is the RPC's outcome envelope, not a dispute row - read the row
    // back rather than mapping the envelope into a Dispute shape.
    const { data: row, error: readError } = await supabase
      .from('disputes')
      .select('*')
      .eq('id', disputeId)
      .maybeSingle();
    if (readError) throw readError;
    if (!row) throw new Error('This dispute could not be read back.');
    return this.mapDispute(row);
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

    const out = (data || {}) as { ok?: boolean; reason?: string; status?: string };
    if (!out.ok) {
      throw new Error(
        out.reason === 'not_withdrawable'
          ? `This dispute is already ${out.status ?? 'closed'} and cannot be withdrawn.`
          : 'This dispute could not be withdrawn.'
      );
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  mapDispute(row: any): Dispute {
    return {
      id: row.id,
      submittedBy: row.submitted_by,
      submitterName: row.submitter_name,
      targetType: row.target_type,
      targetId: row.target_id,
      clubId: row.club_id,
      amount: row.amount,
      reason: row.reason,
      status: row.status,
      assignedTo: row.assigned_to,
      resolution: row.resolution,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
    };
  },
};

export default DisputeService;
