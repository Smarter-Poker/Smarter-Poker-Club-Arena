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
   * Submit a new dispute
   */
  async submitDispute(userId: string, dispute: DisputeCreate): Promise<Dispute> {
    // Get submitter name
    const { data: profile } = await supabase
      .from('profiles')
      .select('display_name, username')
      .eq('id', userId)
      .maybeSingle();

    const submitterName = profile?.display_name || profile?.username || 'Unknown';

    const { data, error } = await supabase
      .from('disputes')
      .insert({
        submitted_by: userId,
        submitter_name: submitterName,
        target_type: dispute.targetType,
        target_id: dispute.targetId,
        club_id: dispute.clubId,
        amount: dispute.amount,
        reason: dispute.reason,
        status: 'open',
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Failed to create dispute');

    // Notify club owner
    try {
      const { data: club } = await supabase
        .from('clubs')
        .select('owner_id, name')
        .eq('id', dispute.clubId)
        .maybeSingle();

      if (club?.owner_id) {
        // Notification removed 2026-08-30 (#1498). The club owner is now told by
        // trg_notify_dispute, which fires on the INSERT itself, so a dispute filed
        // from Commander or a back-office script notifies identically. This call
        // had delivered nothing since OneSignal was retired on 2026-08-19.
      }
    } catch (e: unknown) {
      reportError(e, 'DisputeService.notification');
    }

    return this.mapDispute(data);
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
   * Start reviewing a dispute (assign to reviewer)
   */
  async startReview(disputeId: string, reviewerId: string): Promise<Dispute> {
    const { data, error } = await supabase
      .from('disputes')
      .update({
        status: 'under_review',
        assigned_to: reviewerId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', disputeId)
      .eq('status', 'open')
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Dispute not found or already under review');

    return this.mapDispute(data);
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
    const { data, error } = await supabase
      .from('disputes')
      .update({
        status: 'escalated',
        resolution: `Escalated: ${reason}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', disputeId)
      .in('status', ['open', 'under_review'])
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Dispute not found');

    // Raise financial alert for ops team
    await FinancialAlertService.logWarning(
      'DisputeService',
      `Dispute ${disputeId} escalated: ${reason}`,
      { disputeId, reason }
    );

    return this.mapDispute(data);
  },

  /**
   * Withdraw a dispute (by submitter)
   */
  async withdrawDispute(disputeId: string, userId: string): Promise<void> {
    const { error } = await supabase
      .from('disputes')
      .update({
        status: 'withdrawn',
        updated_at: new Date().toISOString(),
      })
      .eq('id', disputeId)
      .eq('submitted_by', userId)
      .in('status', ['open', 'under_review']);

    if (error) throw error;
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
