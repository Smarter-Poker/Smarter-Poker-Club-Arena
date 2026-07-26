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
import { masterBus } from '../core/MasterBus';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

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
      reportError(e, 'CreditRequestService.submitRequest.notify', {
        approverId: request.approverId,
      });
    }

    return this.mapRequest(data, await this.nameMap([data?.requester_id, data?.approver_id]));
  }

  /**
   * Get all requests for an approver (super agent / club owner)
   */
  async getRequestsForApprover(approverId: string): Promise<CreditRequest[]> {
    const { data, error } = await supabase
      .from('credit_requests')
      .select(
        'id, requester_id, approver_id, club_id, requested_amount, approved_amount, reason, status, created_at, reviewed_at, reviewer_notes'
      )
      .eq('approver_id', approverId)
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMITS.LIST);

    if (error) throw error;
    {
      const rows = data || [];
      const names = await this.nameMap(rows.flatMap((r: any) => [r.requester_id, r.approver_id]));
      return rows.map((r: any) => this.mapRequest(r, names));
    }
  }

  /**
   * Get all requests made by a requester
   */
  async getMyRequests(requesterId: string): Promise<CreditRequest[]> {
    const { data, error } = await supabase
      .from('credit_requests')
      .select(
        'id, requester_id, approver_id, club_id, requested_amount, approved_amount, reason, status, created_at, reviewed_at, reviewer_notes'
      )
      .eq('requester_id', requesterId)
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMITS.LIST);

    if (error) throw error;
    {
      const rows = data || [];
      const names = await this.nameMap(rows.flatMap((r: any) => [r.requester_id, r.approver_id]));
      return rows.map((r: any) => this.mapRequest(r, names));
    }
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
        'id, requester_id, approver_id, club_id, requested_amount, approved_amount, reason, status, created_at, reviewed_at, reviewer_notes'
      )
      .eq('id', requestId)
      .maybeSingle();

    if (!request || request.approver_id !== approverId) {
      throw new Error('Request not found or unauthorized');
    }

    const amount = approvedAmount || request.requested_amount;

    // STEP 1: Execute credit transfer atomically
    await this.executeCreditTransfer(approverId, request.requester_id, amount, requestId);

    // STEP 2: Update request status to 'approved' with the approved amount
    // (executeCreditTransfer no longer sets status — this is the single source of truth)
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

    // STEP 3: Emit bus events so all listening pages (AgentDashboard, CreditAdmin, etc.) refresh
    masterBus.emit('CREDIT_UPDATED', {
      clubId: request.club_id || '',
      userId: request.requester_id,
      amount,
    });
    masterBus.emit('BALANCE_UPDATED', { source: 'credit_request_approved', userId: approverId });
    masterBus.emit('BALANCE_UPDATED', {
      source: 'credit_request_approved',
      userId: request.requester_id,
    });

    // Notify requester
    try {
      await pushNotificationService.sendToUser(request.requester_id, {
        title: ' Credit Approved!',
        message: `Your credit request for ${amount.toLocaleString()} chips was approved`,
        category: 'wallet_credit',
        url: '/wallet',
      });
    } catch (e: unknown) {
      reportError(e, 'CreditRequestService.approveRequest.notify', {
        requesterId: request.requester_id,
      });
    }

    return this.mapRequest(data, await this.nameMap([data?.requester_id, data?.approver_id]));
  }

  /**
   * Deny a credit request
   */
  async denyRequest(requestId: string, approverId: string, notes?: string): Promise<CreditRequest> {
    const { data: request } = await supabase
      .from('credit_requests')
      .select(
        'id, requester_id, approver_id, club_id, requested_amount, approved_amount, reason, status, created_at, reviewed_at, reviewer_notes'
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
      reportError(e, 'CreditRequestService.denyRequest.notify', {
        requesterId: request.requester_id,
      });
    }

    return this.mapRequest(data, await this.nameMap([data?.requester_id, data?.approver_id]));
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
      reportError(error, 'CreditRequestService.executeCreditTransfer', {
        fromUserId,
        toUserId,
        amount,
      });
      throw new Error('Credit transfer failed');
    }

    // NOTE: Status transition is handled by the caller (approveRequest/denyRequest)
    // to prevent status overwrite conflicts. Do NOT set status here.
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

  /** Resolve id -> username for requester/approver display (no FK to embed). */
  private async nameMap(ids: (string | null | undefined)[]): Promise<Record<string, string>> {
    const uniq = [...new Set(ids.filter(Boolean) as string[])];
    if (!uniq.length) return {};
    const { data } = await supabase.from('profiles').select('id, username').in('id', uniq);
    const m: Record<string, string> = {};
    (data || []).forEach((p: any) => {
      m[p.id] = p.username || 'Unknown';
    });
    return m;
  }

  private mapRequest(row: any, names: Record<string, string> = {}): CreditRequest {
    return {
      id: row.id,
      requesterId: row.requester_id,
      requesterName: names[row.requester_id] || 'Unknown',
      approverId: row.approver_id,
      approverName: names[row.approver_id] || 'Unknown',
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
