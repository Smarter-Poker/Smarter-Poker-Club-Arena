/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CREDIT REQUEST SERVICE — Agent Credit Line Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles credit line requests from agents to super agents / club owners.
 * Workflow: Request → Review → Approve/Deny → Execute
 */

import { supabase } from '../lib/supabase';
import { pushNotificationService } from './PushNotificationService';
import { retryAsync } from '../utils/retryAsync';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type CreditRequestStatus = 'pending' | 'approved' | 'denied' | 'executed' | 'cancelled';

export interface CreditRequest {
  id: string;
  requesterId: string;
  requesterName: string;
  approverId: string;
  approverName?: string;
  clubId?: string;
  requestedAmount: number;
  approvedAmount?: number;
  reason: string;
  status: CreditRequestStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewerNotes?: string;
}

export interface CreditRequestCreate {
  approverId: string;
  clubId?: string;
  requestedAmount: number;
  reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class CreditRequestServiceClass {
  /**
   * Submit a new credit request
   */
  async submitRequest(requesterId: string, request: CreditRequestCreate): Promise<CreditRequest> {
    // Get requester name
    const { data: profile } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', requesterId)
      .maybeSingle();

    const { data, error } = await supabase
      .from('credit_requests')
      .insert({
        requester_id: requesterId,
        requester_name: profile?.username || 'Unknown',
        approver_id: request.approverId,
        club_id: request.clubId,
        requested_amount: request.requestedAmount,
        reason: request.reason,
        status: 'pending',
      })
      .select()
      .maybeSingle();

    if (error) throw error;

    // Notify approver
    try {
      await this.notifyApprover(
        request.approverId,
        profile?.username || 'An agent',
        request.requestedAmount
      );
    } catch (e: unknown) {
      console.error('[CreditRequest] Notification failed:', e);
    }

    return this.mapRequest(data);
  }

  /**
   * Get all requests for an approver (super agent / club owner)
   */
  async getRequestsForApprover(approverId: string): Promise<CreditRequest[]> {
    const { data, error } = await supabase
      .from('credit_requests')
      .select(
        'id, requester_id, requester_name, approver_id, approver_name, club_id, requested_amount, approved_amount, reason, status, created_at, reviewed_at, reviewer_notes'
      )
      .eq('approver_id', approverId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;
    return (data || []).map(this.mapRequest);
  }

  /**
   * Get all requests made by a requester
   */
  async getMyRequests(requesterId: string): Promise<CreditRequest[]> {
    const { data, error } = await supabase
      .from('credit_requests')
      .select(
        'id, requester_id, requester_name, approver_id, approver_name, club_id, requested_amount, approved_amount, reason, status, created_at, reviewed_at, reviewer_notes'
      )
      .eq('requester_id', requesterId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;
    return (data || []).map(this.mapRequest);
  }

  /**
   * Get pending request count for badge display
   */
  async getPendingCount(approverId: string): Promise<number> {
    const { count, error } = await supabase
      .from('credit_requests')
      .select('*', { count: 'exact', head: true })
      .eq('approver_id', approverId)
      .eq('status', 'pending');

    if (error) return 0;
    return count || 0;
  }

  /**
   * Approve a credit request
   */
  async approveRequest(
    requestId: string,
    approverId: string,
    approvedAmount?: number,
    notes?: string
  ): Promise<CreditRequest> {
    // Get request first
    const { data: request } = await supabase
      .from('credit_requests')
      .select(
        'id, requester_id, requester_name, approver_id, approver_name, club_id, requested_amount, approved_amount, reason, status, created_at, reviewed_at, reviewer_notes'
      )
      .eq('id', requestId)
      .maybeSingle();

    if (!request || request.approver_id !== approverId) {
      throw new Error('Request not found or unauthorized');
    }

    const amount = approvedAmount || request.requested_amount;

    // IMPORTANT: Execute credit transfer BEFORE marking as approved
    // to prevent approved status without actual transfer on failure
    await this.executeCreditTransfer(approverId, request.requester_id, amount, requestId);

    // Only update request status after successful transfer
    const { data, error } = await supabase
      .from('credit_requests')
      .update({
        status: 'approved',
        approved_amount: amount,
        reviewed_at: new Date().toISOString(),
        reviewer_notes: notes,
      })
      .eq('id', requestId)
      .select()
      .maybeSingle();

    if (error) throw error;

    // Notify requester
    try {
      await pushNotificationService.sendToUser(request.requester_id, {
        title: ' Credit Approved!',
        message: `Your credit request for ${amount.toLocaleString()} chips was approved`,
        category: 'wallet_credit',
        url: '/wallet',
      });
    } catch (e: unknown) {
      console.error('[CreditRequest] Notification failed:', e);
    }

    return this.mapRequest(data);
  }

  /**
   * Deny a credit request
   */
  async denyRequest(requestId: string, approverId: string, notes?: string): Promise<CreditRequest> {
    const { data: request } = await supabase
      .from('credit_requests')
      .select(
        'id, requester_id, requester_name, approver_id, approver_name, club_id, requested_amount, approved_amount, reason, status, created_at, reviewed_at, reviewer_notes'
      )
      .eq('id', requestId)
      .maybeSingle();

    if (!request || request.approver_id !== approverId) {
      throw new Error('Request not found or unauthorized');
    }

    const { data, error } = await supabase
      .from('credit_requests')
      .update({
        status: 'denied',
        reviewed_at: new Date().toISOString(),
        reviewer_notes: notes,
      })
      .eq('id', requestId)
      .select()
      .maybeSingle();

    if (error) throw error;

    // Notify requester
    try {
      await pushNotificationService.sendToUser(request.requester_id, {
        title: ' Credit Request Denied',
        message: notes || 'Your credit request was not approved',
        category: 'wallet_credit',
      });
    } catch (e: unknown) {
      console.error('[CreditRequest] Notification failed:', e);
    }

    return this.mapRequest(data);
  }

  /**
   * Cancel a pending request (by requester)
   */
  async cancelRequest(requestId: string, requesterId: string): Promise<void> {
    const { error } = await supabase
      .from('credit_requests')
      .update({ status: 'cancelled' })
      .eq('id', requestId)
      .eq('requester_id', requesterId)
      .eq('status', 'pending');

    if (error) throw error;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  private async executeCreditTransfer(
    fromUserId: string,
    toUserId: string,
    amount: number,
    requestId: string
  ): Promise<void> {
    // Use RPC for atomic credit transfer
    const { error } = await retryAsync(
      () =>
        supabase.rpc('wallet_user_transfer', {
          p_from_user_id: fromUserId,
          p_to_user_id: toUserId,
          p_amount: amount,
          p_reference_id: requestId,
        }),
      3
    );

    if (error) {
      console.error('[CreditRequest] Transfer failed:', error);
      throw new Error('Credit transfer failed');
    }

    // Update request status to executed
    const { error: statusErr } = await supabase
      .from('credit_requests')
      .update({ status: 'executed' })
      .eq('id', requestId);
    if (statusErr)
      console.error(
        '[CreditRequest] WARN: Transfer succeeded but status update to executed failed:',
        statusErr
      );
  }

  private async notifyApprover(
    approverId: string,
    requesterName: string,
    amount: number
  ): Promise<void> {
    await pushNotificationService.sendToUser(approverId, {
      title: '📨 Credit Request',
      message: `${requesterName} requested ${amount.toLocaleString()} chips credit`,
      category: 'wallet_credit',
      url: '/agent/credit-requests',
    });
  }

  private mapRequest(row: any): CreditRequest {
    return {
      id: row.id,
      requesterId: row.requester_id,
      requesterName: row.requester_name,
      approverId: row.approver_id,
      approverName: row.approver_name,
      clubId: row.club_id,
      requestedAmount: row.requested_amount,
      approvedAmount: row.approved_amount,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      reviewerNotes: row.reviewer_notes,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export const creditRequestService = new CreditRequestServiceClass();
export default creditRequestService;
