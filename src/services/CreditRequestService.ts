/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CREDIT REQUEST SERVICE — Agent Credit Line Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles credit line requests from agents to super agents / club owners.
 * Workflow: Request → Review → Approve/Deny → Execute
 */

import { supabase } from '../lib/supabase';
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

    // STEP 1: Raise the agent's credit LINE to the approved amount (server-
    // authoritative). A credit request is a credit-limit increase, not a chip
    // gift — fn_admin_update_agent authorizes the approver as club owner/admin,
    // enforces the parent-limit rule, sets credit_limit, and writes the
    // credit_assignments audit. (agents is service-role-write-only, so a direct
    // client agents.update would silently affect 0 rows.)
    await this.raiseAgentCreditLimit(
      request.requester_id,
      request.club_id,
      amount,
      approverId,
      notes || 'Credit line increase approved'
    );

    // STEP 2: Update request status to 'approved' with the approved amount
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
    // Notify requester
    try {
      // Notification removed 2026-08-30 (#1498) - trg_notify_credit_request fires on status -> 'approved'.
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
      // Notification removed 2026-08-30 (#1498) - trg_notify_credit_request fires on status -> 'denied'.
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

  /**
   * Raise an agent's credit LIMIT to `newLimit` via the server-authoritative
   * fn_admin_update_agent RPC (agents is service-role-write-only). Resolves the
   * agent row from (requester user, club) first. Throws on any failure so the
   * caller does not mark the request approved when nothing changed.
   */
  private async raiseAgentCreditLimit(
    requesterUserId: string,
    clubId: string | null | undefined,
    newLimit: number,
    approverId: string,
    reason: string
  ): Promise<void> {
    // Resolve the agent row for this user (scoped to the request's club when known).
    let agentQuery = supabase.from('agents').select('id, club_id').eq('user_id', requesterUserId);
    if (clubId) agentQuery = agentQuery.eq('club_id', clubId);
    const { data: agentRows, error: agentErr } = await agentQuery.limit(2);
    if (agentErr) {
      reportError(agentErr, 'CreditRequestService.raiseAgentCreditLimit.resolve', {
        requesterUserId,
      });
      throw new Error('Could not resolve agent for credit request');
    }
    if (!agentRows || agentRows.length === 0) {
      throw new Error('No agent record found for this requester');
    }
    if (agentRows.length > 1) {
      // Ambiguous (agent in multiple clubs) and the request carried no club_id —
      // refuse rather than raise the wrong club's line.
      throw new Error('Ambiguous agent (multiple clubs) - request is missing a club');
    }
    const agentId = agentRows[0].id;

    const { data: res, error } = await retryAsync(
      () =>
        supabase.rpc('fn_admin_update_agent', {
          p_agent_id: agentId,
          p_credit_limit: newLimit,
          p_assigned_by: approverId,
          p_credit_reason: reason,
        }),
      3
    );

    if (error || !res?.success) {
      reportError(error || res?.error, 'CreditRequestService.raiseAgentCreditLimit', {
        agentId,
        newLimit,
      });
      throw new Error(error?.message || res?.error || 'Credit line update failed');
    }
  }

  private async notifyApprover(
    approverId: string,
    requesterName: string,
    amount: number
  ): Promise<void> {
    // Notification removed 2026-08-30 (#1498) - trg_notify_credit_request fires on INSERT.
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
