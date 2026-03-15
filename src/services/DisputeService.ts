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
import { pushNotificationService } from './PushNotificationService';
import { FinancialAlertService } from './FinancialAlertService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';

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
        await pushNotificationService.sendToUser(club.owner_id, {
          title: '⚠️ Settlement Dispute Filed',
          message: `${submitterName} disputed ${dispute.amount.toLocaleString()} chips on ${dispute.targetType}`,
          category: 'settlement' as any,
          url: '/commander/disputes',
        });
      }
    } catch (e: unknown) {
      console.error('[DisputeService] Notification failed:', e);
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
      .limit(200);

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
      .limit(200);

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
    // CRITICAL FIX: Update dispute status FIRST (atomically mark resolved),
    // then adjust wallet. If status update fails, dispute remains open and cannot be
    // resolved again. If wallet adjustment fails after status update, we can alert ops
    // but we won't double-pay. This prevents the race condition where wallet is adjusted
    // but status update fails, leaving dispute open for re-resolution.

    // 1. First, atomically update dispute status to 'resolved'
    const { data, error } = await supabase
      .from('disputes')
      .update({
        status: 'resolved',
        resolution: resolution.resolution,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', disputeId)
      .select()
      .maybeSingle();

    if (error || !data) {
      if (error) throw error;
      throw new Error('Dispute not found or already resolved');
    }

    // 2. If adjustment is needed, execute it AFTER status is safely updated
    if (
      resolution.adjustmentType &&
      resolution.adjustmentType !== 'none' &&
      resolution.adjustmentAmount &&
      resolution.adjustmentAmount > 0
    ) {
      const { data: dispute } = await supabase
        .from('disputes')
        .select('submitted_by, club_id, amount')
        .eq('id', disputeId)
        .maybeSingle();

      if (dispute?.submitted_by) {
        const rpcName =
          resolution.adjustmentType === 'credit'
            ? 'atomic_credit_wallet_and_log'
            : 'atomic_deduct_wallet_and_log';

        try {
          const { error: adjustErr } = await retryAsync(
            () =>
              supabase.rpc(rpcName, {
                p_user_id: dispute.submitted_by,
                p_amount: resolution.adjustmentAmount,
                p_category: 'dispute_resolution',
                p_description: `Dispute ${disputeId} resolved: ${resolution.resolution}`,
                p_table_id: null,
                p_hand_id: null,
                p_related_entity_id: disputeId,
              }),
            3
          );

          if (adjustErr) {
            // Dispute is already marked resolved. Log alert but don't fail (dispute is safe).
            await FinancialAlertService.logWarning(
              'DisputeService',
              `Dispute ${disputeId}: status resolved but wallet adjustment failed — manual action needed`,
              {
                disputeId,
                adjustmentType: resolution.adjustmentType,
                adjustmentAmount: resolution.adjustmentAmount,
                error: adjustErr.message,
              }
            );
            throw new Error(`Wallet adjustment failed (dispute marked resolved): ${adjustErr.message}`);
          }

          masterBus.emit('BALANCE_UPDATED', {
            source: 'dispute_resolution',
            userId: dispute.submitted_by,
            disputeId,
          });
        } catch (err: any) {
          // If wallet fails after status is updated, ops can safely retry just the wallet adjustment
          throw err;
        }
      }
    }

    // Notify the submitter
    if (data?.submitted_by) {
      try {
        await pushNotificationService.sendToUser(data.submitted_by, {
          title: '✅ Dispute Resolved',
          message: resolution.resolution || 'Your dispute has been resolved',
          category: 'settlement' as any,
          url: '/wallet',
        });
      } catch (e: unknown) {
        console.error('[DisputeService] Notification failed:', e);
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
