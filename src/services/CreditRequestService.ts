/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CREDIT REQUEST SERVICE — Agent Credit Line Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles credit line requests from agents to super agents / club owners.
 * Workflow: Request → Review → Approve/Deny → Execute
 */

import { supabase } from '../lib/supabase';
import { getIdentityDNAStatus } from '../core/IdentityDNA';
import { masterBus } from '../core/MasterBus';
import { QUERY_LIMITS } from '../lib/constants';

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

let reviewIdentity: string | null | undefined;
let reviewGeneration = 0;
const REQUEST_FIELDS = 'id, requester_id, approver_id, club_id, requested_amount::text, approved_amount::text, reason, status, created_at, reviewed_at, reviewed_by, reviewer_notes, decision_authority_version';
masterBus.subscribe('AUTH_STATE_CHANGED', event => {
  const next = event.payload.isAuthenticated ? event.payload.userId : null;
  if (next === reviewIdentity) return;
  reviewIdentity = next;
  reviewGeneration += 1;
});

function currentReviewAccount(): string | null {
  const identity = getIdentityDNAStatus();
  const current = identity?.loaded && identity.authenticated ? identity.userId : null;
  if (current !== reviewIdentity) {
    reviewIdentity = current;
    reviewGeneration += 1;
  }
  return current;
}

function assertReviewAccount(expectedActorId: string, generation: number): void {
  if (currentReviewAccount() !== expectedActorId || generation !== reviewGeneration) {
    throw new Error('Account Changed. This Credit Request Action May Have Committed. Refresh Its Status In The Original Account.');
  }
}

class CreditRequestServiceClass {
  /**
   * Submit a new credit request
   */
  async submitRequest(requesterId: string, request: CreditRequestCreate): Promise<CreditRequest> {
    request = { ...request };
    if (!request.clubId || !request.approverId || !requesterId || request.approverId === requesterId ||
        !this.validCreditAmount(request.requestedAmount) || typeof request.reason !== 'string') {
      throw new Error('Choose The Club And Approver And Enter A Positive Credit Limit');
    }
    if (currentReviewAccount() !== requesterId) {
      throw new Error('Sign In To The Account That Started This Credit Request');
    }
    const generation = reviewGeneration;
    const { data, error } = await Promise.resolve(supabase
      .from('credit_requests')
      .insert({
        requester_id: requesterId,
        approver_id: request.approverId,
        club_id: request.clubId,
        requested_amount: request.requestedAmount.toFixed(2),
        reason: request.reason,
        status: 'pending',
      })
      .select(REQUEST_FIELDS)
      .maybeSingle()).catch((error: unknown) => {
        assertReviewAccount(requesterId, generation);
        throw error;
      });
    assertReviewAccount(requesterId, generation);
    if (error) throw error;
    if (!data || typeof data.id !== 'string' || !data.id ||
        data.requester_id !== requesterId || data.approver_id !== request.approverId ||
        data.club_id !== request.clubId || data.status !== 'pending' ||
        this.exactCreditAmount(data.requested_amount) !== request.requestedAmount ||
        data.approved_amount != null || data.reviewed_at != null || data.reviewed_by != null ||
        data.reviewer_notes != null || data.decision_authority_version != null ||
        data.reason !== request.reason || typeof data.created_at !== 'string' ||
        !Number.isFinite(Date.parse(data.created_at))) {
      throw new Error('Credit Request Creation Was Not Confirmed By The Server');
    }
    // The existing INSERT trigger owns the request notification.
    const names = await this.nameMap([data.requester_id, data.approver_id]).catch((error: unknown) => {
      assertReviewAccount(requesterId, generation);
      throw error;
    });
    assertReviewAccount(requesterId, generation);
    return this.mapRequest(data, names);
  }

  /**
   * Get all requests for an approver (super agent / club owner)
   */
  async getRequestsForApprover(approverId: string, clubId?: string): Promise<CreditRequest[]> {
    let query = supabase
      .from('credit_requests')
      .select(REQUEST_FIELDS)
      .eq('approver_id', approverId);
    if (clubId !== undefined) query = query.eq('club_id', clubId);
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMITS.LIST);

    if (error) throw error;
    {
      const rows = data || [];
      const names = await this.nameMap(rows.flatMap((r: any) => [r.requester_id, r.approver_id]));
      return rows.map((r: any) => this.mapRequest(r, names));
    }
  }

  /** Current club managers can review pending requests addressed to a former manager. */
  async getPendingForClub(clubId: string, expectedActorId: string): Promise<CreditRequest[]> {
    if (!clubId || !expectedActorId || currentReviewAccount() !== expectedActorId) {
      throw new Error('Sign In To The Account Viewing This Club');
    }
    const generation = reviewGeneration;
    const { data, error } = await Promise.resolve(supabase.from('credit_requests')
      .select(REQUEST_FIELDS).eq('club_id', clubId).eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(QUERY_LIMITS.LIST))
      .catch((error: unknown) => { assertReviewAccount(expectedActorId, generation);throw error; });
    assertReviewAccount(expectedActorId, generation);
    if (error) throw error;
    const rows = data ?? [];
    if (rows.some((row: any) => row.club_id !== clubId || row.status !== 'pending' ||
        typeof row.id !== 'string' || !row.id || typeof row.requester_id !== 'string' || !row.requester_id)) {
      throw new Error('Pending Credit Requests Were Not Confirmed For This Club');
    }
    const requests = rows.map((row: any) => this.mapRequest(row));
    const names = await this.nameMap(rows.flatMap((row: any) => [row.requester_id, row.approver_id]))
      .catch((error: unknown) => { assertReviewAccount(expectedActorId, generation);throw error; });
    assertReviewAccount(expectedActorId, generation);
    return requests.map((request: CreditRequest) => ({ ...request,
      requesterName: names[request.requesterId] || 'Unknown',
      approverName: names[request.approverId] || 'Unknown' }));
  }

  /**
   * Get all requests made by a requester
   */
  async getMyRequests(requesterId: string, clubId?: string): Promise<CreditRequest[]> {
    let query = supabase
      .from('credit_requests')
      .select(REQUEST_FIELDS)
      .eq('requester_id', requesterId);
    if (clubId !== undefined) query = query.eq('club_id', clubId);
    const { data, error } = await query
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
    return this.reviewRequest(requestId, approverId, 'approved', approvedAmount, notes);
  }

  /** The database derives reviewer identity and checks current club authority. */
  async denyRequest(requestId: string, approverId: string, notes?: string): Promise<CreditRequest> {
    return this.reviewRequest(requestId, approverId, 'denied', undefined, notes);
  }

  /** Cancellation is fenced with approval by the same pending request lock. */
  async cancelRequest(requestId: string, requesterId: string): Promise<void> {
    await this.reviewRequest(requestId, requesterId, 'cancelled');
  }

  private async reviewRequest(
    requestId: string,
    expectedActorId: string,
    decision: 'approved' | 'denied' | 'cancelled',
    approvedAmount?: number,
    notes?: string
  ): Promise<CreditRequest> {
    if (approvedAmount !== undefined && !this.validCreditAmount(approvedAmount)) {
      throw new Error('Enter A Positive Credit Limit With At Most Two Decimal Places');
    }
    if (!expectedActorId || currentReviewAccount() !== expectedActorId) {
      throw new Error('Sign In To The Account That Started This Credit Request Review');
    }
    const generation = reviewGeneration;
    // The request ID plus decision is the server's durable retry identity.
    // The expected actor is only an account-change fence; the server still
    // derives and authorizes auth.uid(). No direct writes follow a receipt.
    const { data, error } = await Promise.resolve(supabase.rpc('fn_review_credit_request', {
      p_request_id: requestId,
      p_expected_actor_id: expectedActorId,
      p_decision: decision,
      ...(approvedAmount === undefined ? {} : { p_approved_amount: approvedAmount.toFixed(2) }),
      p_notes: notes ?? null,
    })).catch((error: unknown) => {
      assertReviewAccount(expectedActorId, generation);
      throw error;
    });
    assertReviewAccount(expectedActorId, generation);
    if (error) throw error;
    const row = data?.request;
    const amount = this.exactCreditAmount(row?.approved_amount);
    const requested = this.exactCreditAmount(row?.requested_amount, true);
    const expected = approvedAmount ?? requested;
    if (
      data?.success !== true ||
      !row || row.id !== requestId || row.status !== decision ||
      typeof row.club_id !== 'string' || !row.club_id ||
      typeof row.requester_id !== 'string' || !row.requester_id ||
      !Number.isFinite(requested) ||
      row.reviewed_by !== expectedActorId || row.decision_authority_version !== 1 ||
      (row.reviewer_notes?.trim() || null) !== (notes?.trim() || null) ||
      typeof row.reviewed_at !== 'string' || !Number.isFinite(Date.parse(row.reviewed_at)) ||
      (decision === 'approved' && (!this.validCreditAmount(amount) || amount !== expected)) ||
      (decision !== 'approved' && row.approved_amount != null)
    ) {
      throw new Error('Credit Request Decision Was Not Confirmed By The Server');
    }
    const names = await this.nameMap([row.requester_id, row.approver_id]).catch((error: unknown) => {
      assertReviewAccount(expectedActorId, generation);
      throw error;
    });
    assertReviewAccount(expectedActorId, generation);
    if (decision === 'approved') {
      masterBus.emit('CREDIT_UPDATED', {
        clubId: row.club_id,
        userId: row.requester_id,
        amount,
      });
    }
    return this.mapRequest(row, names);
  }

  // The RPC transports stored decimals as text. Check cents before converting
  // to Number and require both display and JSON-number roundtrips to agree.
  private exactCreditAmount(value: unknown, allowZero = false): number {
    if (typeof value !== 'string' || value.length > 128) return NaN;
    const centsOf = (text: string): bigint | null => {
      const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(text);
      if (!match || !/^0*$/.test((match[2] ?? '').slice(2))) return null;
      return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').slice(0, 2).padEnd(2, '0'));
    };
    const cents = centsOf(value);
    if (cents === null || cents < 0n || (!allowZero && cents === 0n) || cents > BigInt(Number.MAX_SAFE_INTEGER)) return NaN;
    const amount = Number(value);
    if (!Number.isFinite(amount) || centsOf(String(amount)) !== cents || centsOf(amount.toFixed(2)) !== cents) return NaN;
    return amount;
  }

  private validCreditAmount(amount: number): boolean {
    return typeof amount === 'number' && this.exactCreditAmount(String(amount)) === amount;
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
    const requestedAmount = this.exactCreditAmount(row.requested_amount, true);
    const approvedAmount = row.approved_amount == null ? undefined : this.exactCreditAmount(row.approved_amount);
    if (!Number.isFinite(requestedAmount) || (approvedAmount !== undefined && !Number.isFinite(approvedAmount))) {
      throw new Error('Credit Request Amount Was Not Confirmed By The Server');
    }
    return {
      id: row.id,
      requesterId: row.requester_id,
      requesterName: names[row.requester_id] || 'Unknown',
      approverId: row.approver_id,
      approverName: names[row.approver_id] || 'Unknown',
      clubId: row.club_id,
      requestedAmount,
      approvedAmount,
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
