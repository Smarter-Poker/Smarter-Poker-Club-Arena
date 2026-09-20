import { getIdentityDNAStatus } from '../core/IdentityDNA';
import { runCreditReduction, type CreditReductionStart } from './CreditReductionOperation';
import type { CreditReductionEnvelope } from '../lib/CreditReductionContract';
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
 * Debt = agents.credit_used, the credit actually drawn.
 * Unused credit capacity and wallet balances are not debt.
 *
 * SETTLEMENT CYCLE:
 * - Sunday 11:59:59 PM PST → Generate invoices
 * - Monday 4:00 AM PST → Process payments
 */

import { supabase } from '../lib/supabase';
import { WalletService } from './WalletService';
import { creditRequestService } from './CreditRequestService';
import { SettlementService } from './SettlementService';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';
import { uuid } from '../utils/uuid';

// AUDIT M17: fn_pay_credit_invoice_from_wallet returns a `reason` for ordinary
// refusals rather than raising, so "you cannot afford this" and "the database is
// down" do not read as the same event.
const CREDIT_PAYMENT_REASON_TEXT: Record<string, string> = {
  non_positive_amount: 'Enter an amount greater than zero',
  invalid_payment: 'Enter a positive amount with no more than two decimal places',
  amount_exceeds_remaining: 'The invoice balance changed. Refresh it before paying.',
  operation_conflict: 'This payment attempt has different details. Refresh the invoice.',
  invoice_voided: 'This invoice was cancelled',
  already_settled: 'This invoice is already paid',
  invoice_not_payable: 'Resolve the invoice dispute before paying',
  payment_reference_required: 'Enter the external payment reference',
  unsupported_payment_method: 'This payment method is not available for chip credit invoices',
  invoice_not_found: 'That invoice no longer exists',
  agent_user_not_found: 'No wallet is linked to that agent',
  not_your_wallet: 'You can only pay an invoice from your own wallet',
  insufficient_balance: 'Not enough chips in your wallet for this payment',
};

function drawnCredit(value: unknown): number {
  const amount =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Drawn credit is unavailable');
  return amount;
}

function creditPaymentReasonText(reason: string | undefined): string {
  return CREDIT_PAYMENT_REASON_TEXT[reason ?? ''] ?? `Payment refused (${reason ?? 'unknown'})`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type CreditStatus = 'good_standing' | 'warning' | 'suspended' | 'frozen';
// 'void' arrived with 20260901000001. A cancelled invoice is not payable and
// both payment RPCs refuse one; the type has to be able to say so, or every
// screen keyed on this union falls through to its default branch.
export type InvoiceStatus = 'pending' | 'partial' | 'paid' | 'overdue' | 'disputed' | 'void';

/**
 * The statuses that still represent money owed.
 *
 * One definition, because two screens disagreeing about what "owed" means is
 * how a cancelled invoice got an agent suspended. `checkSuspension` used to
 * ask `status !== 'paid'`, which counts a VOID invoice as debt - and after
 * 20260901000001 there are 224 of those, 184 of them past their due date.
 * A scheduled job (FinancialCronService) reads that answer and suspends people.
 */
export const OWED_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set<InvoiceStatus>([
  'pending',
  'partial',
  'overdue',
]);

export interface CreditAccount {
  agentId: string;
  userId?: string;
  /** The club this agent belongs to. Required by every credit_requests row. */
  clubId: string | null;
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

let creditReadGeneration = 0;
let creditIdentity: string | null | undefined;
function creditIdentityReady(): boolean {
  const snapshot = getIdentityDNAStatus();
  // Do not start debt reads/scans while canonical auth initialization is incomplete.
  if (!snapshot?.loaded) return false;
  if (creditIdentity === undefined)
    creditIdentity = snapshot.authenticated ? snapshot.userId : null;
  return true;
}

masterBus.subscribe('AUTH_STATE_CHANGED', (event) => {
  const nextIdentity = event.payload.isAuthenticated ? event.payload.userId : null;
  if (creditIdentity === nextIdentity) return;
  creditIdentity = nextIdentity;
  creditReadGeneration += 1;
});

function currentCreditRequestActor(): string | null {
  const snapshot = getIdentityDNAStatus();
  const actor = snapshot?.loaded && snapshot.authenticated ? snapshot.userId : null;
  if (actor !== creditIdentity) {
    creditIdentity = actor;
    creditReadGeneration += 1;
  }
  return actor;
}

function assertCreditRequestActor(actor: string, generation: number): void {
  if (currentCreditRequestActor() !== actor || creditReadGeneration !== generation) {
    throw new Error(
      'Account Changed. This Credit Request May Have Committed. Refresh Its Status In The Original Account.'
    );
  }
}

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
      // club_id is selected because credit_requests.club_id is NOT NULL with no
      // default, and requestCreditIncrease had nowhere else to get it.
      .select(
        'id, user_id, club_id, credit_limit, credit_used, agent_wallet_balance, is_prepaid, status'
      )
      .eq('id', agentId)
      .maybeSingle();

    if (error || !agent) return null;

    // Fetch display name separately (safe — no FK hint needed)
    let agentName = 'Unknown';
    try {
      if (agent.user_id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select(PLAYER_NAME_COLUMNS)
          .eq('id', agent.user_id)
          .maybeSingle();
        agentName = playerDisplayName(profile);
      }
    } catch (e) {
      reportError(e, 'CreditService.getCreditAccount');
      /* non-critical */
    }

    const utilization =
      agent.credit_limit > 0 ? (drawnCredit(agent.credit_used) / agent.credit_limit) * 100 : 0;

    return {
      agentId: agent.id,
      userId: agent.user_id,
      clubId: (agent as { club_id?: string | null }).club_id ?? null,
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
  async setCreditLine(
    userId: string,
    clubId: string,
    limit: number,
    isPrepaid: boolean,
    reason?: string
  ): Promise<boolean> {
    // Resolve the agent row for this (user, club). Club owners/admins can read their
    // club's agents under the consolidated agents SELECT policy.
    const { data: agentRow } = await supabase
      .from('agents')
      .select('id')
      .eq('user_id', userId)
      .eq('club_id', clubId)
      .maybeSingle();
    if (!agentRow?.id) throw new Error('No agent found for this club');

    // agents is service-role-write-only under RLS, so a direct client update silently
    // affects 0 rows. Route through fn_admin_update_agent, which authorizes the caller
    // as club owner/admin, enforces the parent-limit rule, sets credit_limit +
    // is_prepaid, and writes the credit_assignments audit — all server-side.
    const { data: res, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: agentRow.id,
      p_credit_limit: limit,
      p_is_prepaid: isPrepaid,
      /* The reason an operator typed, rather than a constant. Both callers
         collected a note and neither passed it, so credit_assignments has been
         recording "Credit line issued" for every change ever made. */
      p_credit_reason: reason || (isPrepaid ? 'Prepaid balance set' : 'Credit line issued'),
    });
    if (error || !res?.success) {
      throw new Error(error?.message || res?.error || 'credit update failed');
    }
    if (res.club_id) {
      masterBus.emit('CREDIT_UPDATED', { clubId: res.club_id, amount: limit });
    }
    return true;
  },

  /** Reduce only a prepared, captured durable intent. Historical receipts never overwrite current balances. */
  async lowerCreditLine(start: CreditReductionStart): Promise<Readonly<CreditReductionEnvelope>> {
    return runCreditReduction(start);
  },

  /**
   * Increase credit limit (with approval tracking)
   */
  async requestCreditIncrease(
    agentId: string,
    requestedLimit: number,
    reason: string
  ): Promise<CreditLimitRequest> {
    const actor = currentCreditRequestActor();
    if (!actor) throw new Error('Sign In To Request Credit');
    const generation = creditReadGeneration;
    const account = await this.getCreditAccount(agentId).catch((error: unknown) => {
      assertCreditRequestActor(actor, generation);
      throw error;
    });
    assertCreditRequestActor(actor, generation);
    if (!account) throw new Error('Agent not found');
    if (!account.clubId || account.userId !== actor || account.agentId !== agentId) {
      throw new Error('This Credit Account Does Not Match Your User And Club');
    }
    const { data: owners, error } = await Promise.resolve(
      supabase.from('clubs').select('id, owner_id').eq('id', account.clubId).limit(2)
    ).catch((error: unknown) => {
      assertCreditRequestActor(actor, generation);
      throw error;
    });
    assertCreditRequestActor(actor, generation);
    if (error) throw error;
    const owner = owners?.length === 1 ? owners[0] : null;
    if (
      !owner ||
      owner.id !== account.clubId ||
      typeof owner.owner_id !== 'string' ||
      !owner.owner_id ||
      owner.owner_id === actor
    ) {
      throw new Error('A Different Current Club Owner Must Review This Credit Request');
    }
    const receipt = await creditRequestService
      .submitRequest(actor, {
        clubId: account.clubId,
        approverId: owner.owner_id,
        requestedAmount: requestedLimit,
        reason,
      })
      .catch((error: unknown) => {
        assertCreditRequestActor(actor, generation);
        throw error;
      });
    assertCreditRequestActor(actor, generation);
    if (
      receipt.status !== 'pending' ||
      receipt.requesterId !== actor ||
      receipt.clubId !== account.clubId ||
      receipt.approverId !== owner.owner_id ||
      receipt.requestedAmount !== requestedLimit
    ) {
      throw new Error('Credit Request Creation Was Not Confirmed By The Server');
    }
    return {
      id: receipt.id,
      agentId: account.agentId,
      agentName: account.agentName,
      currentLimit: account.creditLimit,
      requestedLimit: receipt.requestedAmount,
      reason: receipt.reason,
      status: 'pending',
      createdAt: receipt.createdAt,
    };
  },

  /**
   * Approve/Deny credit increase request
   */
  async reviewCreditRequest(
    requestId: string,
    approved: boolean,
    reviewerId: string
  ): Promise<boolean> {
    if (approved) await creditRequestService.approveRequest(requestId, reviewerId);
    else await creditRequestService.denyRequest(requestId, reviewerId);
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
      .select('credit_limit, credit_used, agent_wallet_balance, is_prepaid')
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

    const debt = drawnCredit(agent.credit_used);

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
      .select('id, credit_limit, credit_used, agent_wallet_balance, is_prepaid')
      .eq('club_id', resolvedId)
      .eq('is_prepaid', false);

    if (error) throw error;

    return (agents || []).map((agent) => ({
      agentId: agent.id,
      creditLimit: agent.credit_limit || 0,
      currentBalance: agent.agent_wallet_balance || 0,
      debtOwed: drawnCredit(agent.credit_used),
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

    try {
      // Service-role RPC — credit_invoices is service-role-write-only under RLS,
      // and generation is idempotent per (agent, period_end).
      const { data, error } = await supabase.rpc('fn_generate_credit_invoice', {
        p_agent_id: agentId,
        p_period_start: periodStart.toISOString(),
        p_period_end: periodEnd.toISOString(),
        p_debt_owed: debt.debtOwed,
        p_due_date: dueDate.toISOString(),
      });

      if (error || !data?.success) {
        reportError(
          error || new Error(data?.error || 'invoice generation failed'),
          'CreditService.generateSundayInvoice',
          {
            agentId,
            debtOwed: debt.debtOwed,
          }
        );
        return null;
      }
      return this.mapInvoice(data.invoice, account.agentName);
    } catch (e) {
      reportError(e, 'CreditService.generateSundayInvoice.tableAccess', {
        agentId,
      });
      return null;
    }
  },

  /**
   * Get invoices for an agent
   */
  async getAgentInvoices(agentId: string): Promise<CreditInvoice[]> {
    if (!creditIdentityReady())
      throw new Error('Invoice identity is not initialized; retry after authentication');
    const generation = creditReadGeneration;
    let data: any[];
    try {
      const result = await supabase
        .from('credit_invoices')
        .select(
          'id, agent_id, period_start, period_end, debt_owed, amount_paid, amount_remaining, status, due_date, created_at, paid_at'
        )
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(QUERY_LIMITS.LIST);
      if (result.error) throw result.error;
      if (!Array.isArray(result.data)) throw new Error('Invoice debt is unavailable');
      data = result.data;
    } catch (error) {
      reportError(error, 'CreditService.getAgentInvoices', { agentId });
      throw error;
    }

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
          .select(PLAYER_NAME_COLUMNS)
          .eq('id', agentData.user_id)
          .maybeSingle();
        agentName = playerDisplayName(profile);
      }
    } catch (e) {
      /* non-critical — agent name lookup is a nice-to-have */
    }

    if (generation !== creditReadGeneration) throw new Error('Invoice account changed');
    return data.map((inv) => this.mapInvoice(inv, agentName));
  },

  /**
   * Process payment on an invoice
   */
  async processPayment(
    invoiceId: string,
    amount: number,
    method: 'wallet' | 'diamonds' | 'external',
    options: { operationId?: string; reference?: string } = {}
  ): Promise<CreditPayment> {
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7
    )
      throw new Error('Enter a positive amount with no more than two decimal places');
    const generation = creditReadGeneration;
    // Reuse this identity for transport retries; callers may preserve it across an uncertain response.
    const operationId = options.operationId ?? uuid();
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('fn_process_credit_invoice_payment', {
          p_invoice_id: invoiceId,
          p_amount: amount,
          p_method: method,
          p_operation_id: operationId,
          p_reference: options.reference ?? null,
        }),
      3
    );
    if (error) {
      reportError(error, 'CreditService.processPayment', { invoiceId, operationId });
      throw new Error(
        'Payment status could not be confirmed. Retry this payment to check its receipt.'
      );
    }
    if (!data?.ok) throw new Error(creditPaymentReasonText(data?.reason));
    const postedAmount = Number(data.amount);
    if (!data.payment?.id || !Number.isFinite(postedAmount) || postedAmount !== amount)
      throw new Error('Payment receipt is incomplete. Refresh the invoice before continuing.');
    if (method === 'wallet' && generation === creditReadGeneration) {
      masterBus.emit('BALANCE_UPDATED', { source: 'credit_payment', amount: -postedAmount });
    }
    return {
      id: data.payment.id,
      invoiceId,
      amount: postedAmount,
      paymentMethod: method,
      transactionId: data.payment.transaction_id,
      createdAt: data.payment.created_at,
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
    // `status !== 'paid'` counted a cancelled invoice as debt. With 224 voided
    // bills on the books, 184 of them past due, that had the cron suspending
    // every credit agent for 18 million chips nobody owed.
    const overdueInvoices = invoices.filter(
      (i) => OWED_INVOICE_STATUSES.has(i.status) && new Date(i.dueDate) < new Date()
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
    // agents is service-role-write-only under RLS — a direct client .update() matches
    // 0 rows and returns { error: null }, so the old code reported success while the
    // row stayed active (credit-enforcement gap). Route through the SECURITY DEFINER
    // RPC (authorizes the caller as the agent's club owner/admin) and verify res.success.
    const { data: res, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: agentId,
      p_status: 'suspended',
      p_credit_reason: reason,
    });

    if (error || !res?.success) {
      throw new Error(
        `Failed to suspend agent: ${error?.message || res?.error || 'update failed'}`
      );
    }

    // Emit CREDIT_UPDATED
    if (res.club_id) {
      masterBus.emit('CREDIT_UPDATED', { clubId: res.club_id });
    }

    return true;
  },

  /**
   * Reinstate suspended agent after payment
   */
  async reinstateAgent(agentId: string): Promise<boolean> {
    const generation = creditReadGeneration;
    // Check nothing is still owed. Same trap as checkSuspension, and worse in
    // the other direction: counting a cancelled invoice as overdue here means
    // an agent who has settled everything can never be let back in.
    const invoices = await this.getAgentInvoices(agentId);
    if (generation !== creditReadGeneration) throw new Error('Invoice account changed');
    const hasOverdue = invoices.some(
      (i) => OWED_INVOICE_STATUSES.has(i.status) && new Date(i.dueDate) < new Date()
    );

    if (hasOverdue) {
      throw new Error('Cannot reinstate: overdue invoices exist');
    }

    // agents is service-role-write-only under RLS — a direct client .update() silently
    // no-ops. Route through the SECURITY DEFINER RPC and verify res.success.
    const { data: res, error } = await supabase.rpc('fn_admin_update_agent', {
      p_agent_id: agentId,
      p_status: 'active',
    });

    if (error || !res?.success) {
      throw new Error(
        `Failed to reinstate agent: ${error?.message || res?.error || 'update failed'}`
      );
    }

    // The dispatched mutation may already have committed; suppress stale local consumption.
    if (generation !== creditReadGeneration)
      throw new Error('Invoice account changed; reinstatement may have committed');

    // Emit CREDIT_UPDATED
    if (res.club_id) {
      masterBus.emit('CREDIT_UPDATED', { clubId: res.club_id });
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
      // `||` not `??` was a live bug the moment any invoice reached zero
      // remaining: 0 is falsy, so a fully paid - or, since 20260901000001, a
      // VOIDED - invoice reported its whole original debt as still due, and
      // AgentInvoicesPanel drew a "Pay now" button on 224 cancelled bills.
      // The RPC refused them, so no money moved; the user just got "Payment
      // failed" on something they did not owe.
      amountRemaining: inv.amount_remaining ?? inv.debt_owed,
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
