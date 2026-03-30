/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💳 CREDIT SERVICE — Agent Credit Line Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages Credit Lines, Pre-Paid Status, and Debt Calculation.
 *
 * CREDIT TYPES:
 * - PREPAID: Agent pays upfront, no credit extended
 * - CREDIT LINE: Agent plays on credit, settles weekly
 *
 * DEBT FORMULA:
 * Debt = Credit Limit - Current Balance
 * Example: 10,000 Limit - 2,500 Balance = 7,500 Owed
 *
 * SETTLEMENT CYCLE:
 * - Sunday 11:59:59 PM PST → Generate invoices
 * - Monday 4:00 AM PST → Process payments
 */

import { supabase } from '../lib/supabase';
import { WalletService } from './WalletService';
import { FinancialAlertService } from './FinancialAlertService';
import { SettlementService } from './SettlementService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type CreditStatus = 'good_standing' | 'warning' | 'suspended' | 'frozen';
export type InvoiceStatus = 'pending' | 'partial' | 'paid' | 'overdue' | 'disputed';

export interface CreditAccount {
  agentId: string;
  agentName: string;
  creditLimit: number;
  currentBalance: number;
  isPrepaid: boolean;
  status: CreditStatus;
  utilizationPercent: number;
  lastSettlementDate?: string;
  nextSettlementDate: string;
}

export interface DebtCalculation {
  agentId: string;
  creditLimit: number;
  currentBalance: number;
  debtOwed: number;
  isPrepaid: boolean;
  gracePeriodRemaining: number; // hours
}

export interface CreditInvoice {
  id: string;
  agentId: string;
  agentName: string;
  periodStart: string;
  periodEnd: string;
  debtOwed: number;
  amountPaid: number;
  amountRemaining: number;
  status: InvoiceStatus;
  dueDate: string;
  createdAt: string;
  paidAt?: string;
}

export interface CreditPayment {
  id: string;
  invoiceId: string;
  amount: number;
  paymentMethod: 'wallet' | 'diamonds' | 'external';
  transactionId?: string;
  createdAt: string;
}

export interface CreditLimitRequest {
  id: string;
  agentId: string;
  agentName: string;
  currentLimit: number;
  requestedLimit: number;
  reason: string;
  status: 'pending' | 'approved' | 'denied';
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const CreditService = {
  // ─────────────────────────────────────────────────────────────────────────────
  // CREDIT LINE MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get credit account for an agent
   */
  async getCreditAccount(agentId: string): Promise<CreditAccount | null> {
    const { data: agent, error } = await supabase
      .from('agents')
      .select('id, user_id, credit_limit, agent_wallet_balance, is_prepaid, status')
      .eq('id', agentId)
      .maybeSingle();

    if (error || !agent) return null;

    // Fetch display name separately (safe — no FK hint needed)
    let agentName = 'Unknown';
    try {
      if (agent.user_id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('display_name')
          .eq('id', agent.user_id)
          .maybeSingle();
        agentName = profile?.display_name || 'Unknown';
      }
    } catch {
      /* non-critical */
    }

    const utilization =
      agent.credit_limit > 0
        ? ((agent.credit_limit - agent.agent_wallet_balance) / agent.credit_limit) * 100
        : 0;

    return {
      agentId: agent.id,
      agentName,
      creditLimit: agent.credit_limit || 0,
      currentBalance: agent.agent_wallet_balance || 0,
      isPrepaid: agent.is_prepaid || false,
      status: this.calculateStatus(utilization),
      utilizationPercent: Math.round(utilization),
      nextSettlementDate: this.getNextSettlementDate(),
    };
  },

  /**
   * Set credit line for an agent
   */
  async setCreditLine(agentId: string, limit: number, isPrepaid: boolean): Promise<boolean> {
    const { error } = await supabase
      .from('agents')
      .update({
        credit_limit: limit,
        is_prepaid: isPrepaid,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agentId);

    if (error) throw error;

    // Emit CREDIT_UPDATED
    const { data: agent } = await supabase
      .from('agents')
      .select('club_id')
      .eq('id', agentId)
      .maybeSingle();
    if (agent?.club_id) {
      masterBus.emit('CREDIT_UPDATED', { clubId: agent.club_id, amount: limit });
    }

    return true;
  },

  /**
   * Increase credit limit (with approval tracking)
   */
  async requestCreditIncrease(
    agentId: string,
    requestedLimit: number,
    reason: string
  ): Promise<CreditLimitRequest> {
    const account = await this.getCreditAccount(agentId);
    if (!account) throw new Error('Agent not found');

    const { data, error } = await supabase
      .from('credit_requests')
      .insert({
        // credit_requests schema: requester_id, requested_amount (NOT agent_id, current_limit, requested_limit)
        requester_id: agentId,
        requested_amount: requestedLimit,
        reason,
        status: 'pending',
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    return this.mapCreditRequest(data, account.agentName);
  },

  /**
   * Approve/Deny credit increase request
   */
  async reviewCreditRequest(
    requestId: string,
    approved: boolean,
    reviewerId: string
  ): Promise<boolean> {
    const status = approved ? 'approved' : 'denied';

    const { data: request, error: fetchError } = await supabase
      .from('credit_requests')
      .select('requester_id, requested_amount')
      .eq('id', requestId)
      .maybeSingle();

    if (fetchError || !request) throw fetchError || new Error('Credit request not found');

    // Update request
    const { error: reqUpdateErr } = await supabase
      .from('credit_requests')
      .update({
        status,
        reviewed_by: reviewerId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', requestId);

    if (reqUpdateErr) throw new Error(`Failed to update credit request: ${reqUpdateErr.message}`);

    // If approved, update credit limit
    if (approved) {
      const { error: limitErr } = await supabase
        .from('agents')
        .update({ credit_limit: request.requested_amount })
        .eq('id', request.requester_id);

      if (limitErr) throw new Error(`Failed to update credit limit: ${limitErr.message}`);

      // Emit CREDIT_UPDATED
      const { data: agent } = await supabase
        .from('agents')
        .select('club_id')
        .eq('id', request.requester_id)
        .maybeSingle();
      if (agent?.club_id) {
        masterBus.emit('CREDIT_UPDATED', {
          clubId: agent.club_id,
          amount: request.requested_amount,
        });
      }
    }

    return true;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // DEBT CALCULATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Calculate current debt for an agent
   */
  async calculateDebt(agentId: string): Promise<DebtCalculation> {
    const { data: agent, error } = await supabase
      .from('agents')
      .select('credit_limit, agent_wallet_balance, is_prepaid')
      .eq('id', agentId)
      .maybeSingle();

    if (error || !agent) throw error || new Error('Agent not found');

    if (agent.is_prepaid) {
      return {
        agentId,
        creditLimit: 0,
        currentBalance: agent.agent_wallet_balance,
        debtOwed: 0,
        isPrepaid: true,
        gracePeriodRemaining: 0,
      };
    }

    const debt = agent.credit_limit - agent.agent_wallet_balance;

    return {
      agentId,
      creditLimit: agent.credit_limit,
      currentBalance: agent.agent_wallet_balance,
      debtOwed: Math.max(0, debt),
      isPrepaid: false,
      gracePeriodRemaining: this.getGracePeriodRemaining(),
    };
  },

  /**
   * Calculate debt for all agents in a club
   */
  async calculateClubDebt(clubId: string): Promise<DebtCalculation[]> {
    const resolvedId = await resolveClubUUID(clubId);
    const { data: agents, error } = await supabase
      .from('agents')
      .select('id, credit_limit, agent_wallet_balance, is_prepaid')
      .eq('club_id', resolvedId)
      .eq('is_prepaid', false);

    if (error) throw error;

    return (agents || []).map((agent) => ({
      agentId: agent.id,
      creditLimit: agent.credit_limit || 0,
      currentBalance: agent.agent_wallet_balance || 0,
      debtOwed: Math.max(0, (agent.credit_limit || 0) - (agent.agent_wallet_balance || 0)),
      isPrepaid: false,
      gracePeriodRemaining: this.getGracePeriodRemaining(),
    }));
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // INVOICING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Generate Sunday invoice for an agent
   */
  async generateSundayInvoice(agentId: string): Promise<CreditInvoice | null> {
    const debt = await this.calculateDebt(agentId);
    if (debt.debtOwed <= 0 || debt.isPrepaid) return null;

    const account = await this.getCreditAccount(agentId);
    if (!account) return null;

    const now = new Date();
    const periodEnd = new Date(now);
    const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const dueDate = new Date(now.getTime() + 48 * 60 * 60 * 1000); // 48 hour grace

    const { data, error } = await supabase
      .from('credit_invoices')
      .insert({
        agent_id: agentId,
        period_start: periodStart.toISOString(),
        period_end: periodEnd.toISOString(),
        debt_owed: debt.debtOwed,
        amount_paid: 0,
        amount_remaining: debt.debtOwed,
        status: 'pending',
        due_date: dueDate.toISOString(),
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    return this.mapInvoice(data, account.agentName);
  },

  /**
   * Get invoices for an agent
   */
  async getAgentInvoices(agentId: string): Promise<CreditInvoice[]> {
    const { data, error } = await supabase
      .from('credit_invoices')
      .select(
        'id, agent_id, period_start, period_end, debt_owed, amount_paid, amount_remaining, status, due_date, created_at, paid_at'
      )
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMITS.LIST);

    if (error) throw error;

    // Fetch agent display name separately (safe — no FK hint needed)
    let agentName = 'Unknown';
    try {
      const { data: agentData } = await supabase
        .from('agents')
        .select('user_id')
        .eq('id', agentId)
        .maybeSingle();
      if (agentData?.user_id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('display_name')
          .eq('id', agentData.user_id)
          .maybeSingle();
        agentName = profile?.display_name || 'Unknown';
      }
    } catch {
      /* non-critical */
    }

    return (data || []).map((inv) => this.mapInvoice(inv, agentName));
  },

  /**
   * Process payment on an invoice
   */
  async processPayment(
    invoiceId: string,
    amount: number,
    method: 'wallet' | 'diamonds' | 'external'
  ): Promise<CreditPayment> {
    // Get current invoice
    const { data: invoiceResult, error: invoiceError } = await supabase
      .from('settlement_invoices')
      .select(
        'id, agent_id, period_start, period_end, debt_owed, amount_paid, amount_remaining, status, due_date, created_at, paid_at'
      )
      .eq('id', invoiceId)
      .maybeSingle();

    if (invoiceError) throw invoiceError;
    if (!invoiceResult) throw new Error(`Invoice not found: ${invoiceId}`);

    // STEP 1: If paying from wallet, deduct FIRST (before recording anything)
    if (method === 'wallet') {
      // Get agent's user_id for wallet deduction
      const { data: agentData } = await supabase
        .from('agents')
        .select('user_id')
        .eq('id', invoiceResult.agent_id)
        .maybeSingle();

      if (!agentData?.user_id) {
        throw new Error('Agent user not found for wallet deduction');
      }

      const amt = Math.trunc(amount * 100) / 100;
      const { data: deductResult, error: deductError } = await retryAsync(
        () =>
          supabase.rpc('atomic_deduct_wallet_and_log', {
            p_user_id: agentData.user_id,
            p_amount: amt,
            p_category: 'settlement',
            p_description: `Credit invoice payment: ${invoiceId}`,
            p_table_id: null,
            p_hand_id: null,
            p_related_entity_id: null,
          }),
        3
      );
      if (deductError) {
        throw new Error(`Wallet deduction failed: ${deductError.message}`);
      }
      if (!deductResult) {
        throw new Error('Insufficient wallet balance for payment');
      }

      // Emit bus event so UI (header balances, cashier) updates immediately
      masterBus.emit('BALANCE_UPDATED', {
        source: 'credit_payment',
        userId: agentData.user_id,
        amount: -amt,
      });
    }

    // STEP 2: Atomically update invoice amounts using ALREADY-FETCHED invoice data (no re-fetch TOCTOU)
    const { error: updateError } = await supabase
      .from('credit_invoices')
      .update({
        amount_remaining: Math.max(0, invoiceResult.amount_remaining - amount),
        status: invoiceResult.amount_remaining - amount <= 0 ? 'paid' : 'pending',
      })
      .eq('id', invoiceId);

    if (updateError) {
      // Rollback wallet deduction if invoice update failed — MUST BE LOGGED atomically
      if (method === 'wallet') {
        try {
          const { data: agentForRollback } = await supabase
            .from('agents')
            .select('user_id')
            .eq('id', invoiceResult.agent_id)
            .maybeSingle();

          if (agentForRollback?.user_id) {
            const { error: rollbackErr2 } = await retryAsync(
              () =>
                supabase.rpc('atomic_credit_wallet_and_log', {
                  p_user_id: agentForRollback.user_id,
                  p_amount: amount,
                  p_category: 'refund',
                  p_description: `Refund: Credit invoice update failed for ${invoiceId}`,
                  p_table_id: null,
                  p_hand_id: null,
                  p_related_entity_id: null,
                }),
              3
            );
            if (rollbackErr2) {
              reportError(rollbackErr2, 'CreditService.processPayment.rollback', {
                invoiceId,
                agentId: invoiceResult.agent_id,
                amount,
              });
              FinancialAlertService.logCritical(
                'CreditService',
                'Wallet rollback failed after invoice update failure',
                {
                  invoiceId,
                  agentId: invoiceResult.agent_id,
                  amount,
                  rollbackError: rollbackErr2.message,
                }
              );
            } else {
              masterBus.emit('BALANCE_UPDATED', {
                source: 'credit_payment_rollback',
                userId: agentForRollback.user_id,
              });
            }
          }
        } catch (rollbackErr) {
          reportError(rollbackErr, 'CreditService.processPayment.rollbackOuter', { invoiceId });
        }
      }
      throw new Error(`Invoice update failed: ${updateError.message}`);
    }

    // STEP 3: Record payment (after money has moved)
    const { data: payment, error: payError } = await supabase
      .from('credit_payments')
      .insert({
        invoice_id: invoiceId,
        amount,
        payment_method: method,
      })
      .select()
      .maybeSingle();

    if (payError) throw payError;

    return {
      id: payment.id,
      invoiceId,
      amount,
      paymentMethod: method,
      transactionId: payment.transaction_id,
      createdAt: payment.created_at,
    };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // SUSPENSION & ENFORCEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check if agent should be suspended for overdue debt
   */
  async checkSuspension(agentId: string): Promise<{ shouldSuspend: boolean; reason?: string }> {
    const invoices = await this.getAgentInvoices(agentId);
    const overdueInvoices = invoices.filter(
      (i) => i.status !== 'paid' && new Date(i.dueDate) < new Date()
    );

    if (overdueInvoices.length === 0) {
      return { shouldSuspend: false };
    }

    const totalOverdue = overdueInvoices.reduce((sum, i) => sum + i.amountRemaining, 0);

    return {
      shouldSuspend: true,
      reason: `${overdueInvoices.length} overdue invoice(s) totaling ${totalOverdue} chips`,
    };
  },

  /**
   * Suspend agent for overdue debt
   */
  async suspendAgent(agentId: string, reason: string): Promise<boolean> {
    const { error } = await supabase
      .from('agents')
      .update({
        status: 'suspended',
        suspension_reason: reason,
        suspended_at: new Date().toISOString(),
      })
      .eq('id', agentId);

    if (error) throw new Error(`Failed to suspend agent: ${error.message}`);

    // Emit CREDIT_UPDATED
    const { data: agent } = await supabase
      .from('agents')
      .select('club_id')
      .eq('id', agentId)
      .maybeSingle();
    if (agent?.club_id) {
      masterBus.emit('CREDIT_UPDATED', { clubId: agent.club_id });
    }

    return true;
  },

  /**
   * Reinstate suspended agent after payment
   */
  async reinstateAgent(agentId: string): Promise<boolean> {
    // Check all invoices are paid
    const invoices = await this.getAgentInvoices(agentId);
    const hasOverdue = invoices.some(
      (i) => i.status !== 'paid' && new Date(i.dueDate) < new Date()
    );

    if (hasOverdue) {
      throw new Error('Cannot reinstate: overdue invoices exist');
    }

    const { error } = await supabase
      .from('agents')
      .update({
        status: 'active',
        suspension_reason: null,
        suspended_at: null,
      })
      .eq('id', agentId);

    if (error) throw new Error(`Failed to reinstate agent: ${error.message}`);

    // Emit CREDIT_UPDATED
    const { data: agent } = await supabase
      .from('agents')
      .select('club_id')
      .eq('id', agentId)
      .maybeSingle();
    if (agent?.club_id) {
      masterBus.emit('CREDIT_UPDATED', { clubId: agent.club_id });
    }

    return true;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  calculateStatus(utilizationPercent: number): CreditStatus {
    if (utilizationPercent >= 100) return 'frozen';
    if (utilizationPercent >= 90) return 'suspended';
    if (utilizationPercent >= 75) return 'warning';
    return 'good_standing';
  },

  getNextSettlementDate(): string {
    const now = new Date();
    const dayOfWeek = now.getDay();
    // Sunday = 0 → settlement is today; otherwise, days until next Sunday
    const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
    const nextSunday = new Date(now.getTime() + daysUntilSunday * 24 * 60 * 60 * 1000);
    nextSunday.setHours(23, 59, 59, 0);
    return nextSunday.toISOString();
  },

  getGracePeriodRemaining(): number {
    const now = new Date();
    const dayOfWeek = now.getDay();

    // If it's Sunday or Monday, we're in grace period
    if (dayOfWeek === 0) return 48;
    if (dayOfWeek === 1) {
      const hoursToday = now.getHours();
      return Math.max(0, 48 - 24 - hoursToday);
    }
    return 0;
  },

  mapInvoice(inv: any, agentName?: string): CreditInvoice {
    return {
      id: inv.id,
      agentId: inv.agent_id,
      agentName: agentName || 'Unknown',
      periodStart: inv.period_start,
      periodEnd: inv.period_end,
      debtOwed: inv.debt_owed,
      amountPaid: inv.amount_paid || 0,
      amountRemaining: inv.amount_remaining || inv.debt_owed,
      status: inv.status,
      dueDate: inv.due_date,
      createdAt: inv.created_at,
      paidAt: inv.paid_at,
    };
  },

  mapCreditRequest(req: any, agentName: string): CreditLimitRequest {
    return {
      id: req.id,
      agentId: req.requester_id || req.agent_id,
      agentName,
      currentLimit: req.current_limit || 0,
      requestedLimit: req.requested_amount || req.requested_limit || 0,
      reason: req.reason,
      status: req.status,
      reviewedBy: req.reviewed_by,
      reviewedAt: req.reviewed_at,
      createdAt: req.created_at,
    };
  },
};

export default CreditService;
