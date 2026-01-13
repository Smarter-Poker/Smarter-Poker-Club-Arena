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

import { supabase, isDemoMode } from '../lib/supabase';

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
// DEMO DATA
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_CREDIT_ACCOUNTS: CreditAccount[] = [
    {
        agentId: 'agent_1', agentName: 'Agent Smith', creditLimit: 10000, currentBalance: 7500,
        isPrepaid: false, status: 'good_standing', utilizationPercent: 25,
        lastSettlementDate: '2026-01-06T00:00:00Z', nextSettlementDate: '2026-01-13T00:00:00Z',
    },
    {
        agentId: 'agent_2', agentName: 'Agent Jones', creditLimit: 5000, currentBalance: 1000,
        isPrepaid: false, status: 'warning', utilizationPercent: 80,
        lastSettlementDate: '2026-01-06T00:00:00Z', nextSettlementDate: '2026-01-13T00:00:00Z',
    },
];

const DEMO_INVOICES: CreditInvoice[] = [
    {
        id: 'inv_1', agentId: 'agent_1', agentName: 'Agent Smith',
        periodStart: '2025-12-30T00:00:00Z', periodEnd: '2026-01-05T23:59:59Z',
        debtOwed: 2500, amountPaid: 2500, amountRemaining: 0, status: 'paid',
        dueDate: '2026-01-07T00:00:00Z', createdAt: '2026-01-06T00:00:00Z', paidAt: '2026-01-06T08:00:00Z',
    },
];

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
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 200));
            return DEMO_CREDIT_ACCOUNTS.find(a => a.agentId === agentId) || null;
        }

        const { data: agent, error } = await supabase
            .from('agents')
            .select('id, user_id, credit_limit, agent_wallet_balance, is_prepaid, status, profiles:user_id(display_name)')
            .eq('id', agentId)
            .single();

        if (error || !agent) return null;

        const utilization = agent.credit_limit > 0
            ? ((agent.credit_limit - agent.agent_wallet_balance) / agent.credit_limit) * 100
            : 0;

        return {
            agentId: agent.id,
            agentName: (agent.profiles as any)?.display_name || 'Unknown',
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
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            const account = DEMO_CREDIT_ACCOUNTS.find(a => a.agentId === agentId);
            if (account) {
                account.creditLimit = limit;
                account.isPrepaid = isPrepaid;
            }
            return true;
        }

        const { error } = await supabase
            .from('agents')
            .update({
                credit_limit: limit,
                is_prepaid: isPrepaid,
                updated_at: new Date().toISOString(),
            })
            .eq('id', agentId);

        if (error) throw error;
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

        if (isDemoMode) {
            return {
                id: `req_${Date.now()}`,
                agentId,
                agentName: account.agentName,
                currentLimit: account.creditLimit,
                requestedLimit,
                reason,
                status: 'pending',
                createdAt: new Date().toISOString(),
            };
        }

        const { data, error } = await supabase
            .from('credit_limit_requests')
            .insert({
                agent_id: agentId,
                current_limit: account.creditLimit,
                requested_limit: requestedLimit,
                reason,
                status: 'pending',
            })
            .select()
            .single();

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
        if (isDemoMode) {
            return true;
        }

        const status = approved ? 'approved' : 'denied';

        const { data: request, error: fetchError } = await supabase
            .from('credit_limit_requests')
            .select('agent_id, requested_limit')
            .eq('id', requestId)
            .single();

        if (fetchError) throw fetchError;

        // Update request
        await supabase
            .from('credit_limit_requests')
            .update({
                status,
                reviewed_by: reviewerId,
                reviewed_at: new Date().toISOString(),
            })
            .eq('id', requestId);

        // If approved, update credit limit
        if (approved) {
            await supabase
                .from('agents')
                .update({ credit_limit: request.requested_limit })
                .eq('id', request.agent_id);
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
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 150));
            const account = DEMO_CREDIT_ACCOUNTS.find(a => a.agentId === agentId);
            if (!account) throw new Error('Agent not found');

            const debt = account.creditLimit - account.currentBalance;
            return {
                agentId,
                creditLimit: account.creditLimit,
                currentBalance: account.currentBalance,
                debtOwed: Math.max(0, debt),
                isPrepaid: account.isPrepaid,
                gracePeriodRemaining: 48, // 48 hours grace period
            };
        }

        const { data: agent, error } = await supabase
            .from('agents')
            .select('credit_limit, agent_wallet_balance, is_prepaid')
            .eq('id', agentId)
            .single();

        if (error) throw error;

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
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            return DEMO_CREDIT_ACCOUNTS.map(a => ({
                agentId: a.agentId,
                creditLimit: a.creditLimit,
                currentBalance: a.currentBalance,
                debtOwed: Math.max(0, a.creditLimit - a.currentBalance),
                isPrepaid: a.isPrepaid,
                gracePeriodRemaining: 48,
            }));
        }

        const { data: agents, error } = await supabase
            .from('agents')
            .select('id, credit_limit, agent_wallet_balance, is_prepaid')
            .eq('club_id', clubId)
            .eq('is_prepaid', false);

        if (error) throw error;

        return (agents || []).map(agent => ({
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

        if (isDemoMode) {
            return {
                id: `inv_${Date.now()}`,
                agentId,
                agentName: account.agentName,
                periodStart: periodStart.toISOString(),
                periodEnd: periodEnd.toISOString(),
                debtOwed: debt.debtOwed,
                amountPaid: 0,
                amountRemaining: debt.debtOwed,
                status: 'pending',
                dueDate: dueDate.toISOString(),
                createdAt: now.toISOString(),
            };
        }

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
            .single();

        if (error) throw error;
        return this.mapInvoice(data, account.agentName);
    },

    /**
     * Get invoices for an agent
     */
    async getAgentInvoices(agentId: string): Promise<CreditInvoice[]> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 200));
            return DEMO_INVOICES.filter(i => i.agentId === agentId);
        }

        const { data, error } = await supabase
            .from('credit_invoices')
            .select('*, agents:agent_id(profiles:user_id(display_name))')
            .eq('agent_id', agentId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        return (data || []).map(inv => this.mapInvoice(inv, inv.agents?.profiles?.display_name));
    },

    /**
     * Process payment on an invoice
     */
    async processPayment(
        invoiceId: string,
        amount: number,
        method: 'wallet' | 'diamonds' | 'external'
    ): Promise<CreditPayment> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            return {
                id: `pay_${Date.now()}`,
                invoiceId,
                amount,
                paymentMethod: method,
                createdAt: new Date().toISOString(),
            };
        }

        // Get current invoice
        const { data: invoice, error: fetchError } = await supabase
            .from('credit_invoices')
            .select('*')
            .eq('id', invoiceId)
            .single();

        if (fetchError) throw fetchError;

        const newAmountPaid = (invoice.amount_paid || 0) + amount;
        const newRemaining = invoice.debt_owed - newAmountPaid;
        const newStatus = newRemaining <= 0 ? 'paid' : newRemaining < invoice.debt_owed ? 'partial' : 'pending';

        // Update invoice
        await supabase
            .from('credit_invoices')
            .update({
                amount_paid: newAmountPaid,
                amount_remaining: Math.max(0, newRemaining),
                status: newStatus,
                paid_at: newStatus === 'paid' ? new Date().toISOString() : null,
            })
            .eq('id', invoiceId);

        // Record payment
        const { data: payment, error: payError } = await supabase
            .from('credit_payments')
            .insert({
                invoice_id: invoiceId,
                amount,
                payment_method: method,
            })
            .select()
            .single();

        if (payError) throw payError;

        // If paying from wallet, deduct from agent balance
        if (method === 'wallet') {
            await supabase.rpc('deduct_agent_balance', {
                p_agent_id: invoice.agent_id,
                p_amount: amount,
            });
        }

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
        const overdueInvoices = invoices.filter(i =>
            i.status !== 'paid' && new Date(i.dueDate) < new Date()
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
        if (isDemoMode) return true;

        await supabase
            .from('agents')
            .update({
                status: 'suspended',
                suspension_reason: reason,
                suspended_at: new Date().toISOString(),
            })
            .eq('id', agentId);

        return true;
    },

    /**
     * Reinstate suspended agent after payment
     */
    async reinstateAgent(agentId: string): Promise<boolean> {
        // Check all invoices are paid
        const invoices = await this.getAgentInvoices(agentId);
        const hasOverdue = invoices.some(i => i.status !== 'paid' && new Date(i.dueDate) < new Date());

        if (hasOverdue) {
            throw new Error('Cannot reinstate: overdue invoices exist');
        }

        if (isDemoMode) return true;

        await supabase
            .from('agents')
            .update({
                status: 'active',
                suspension_reason: null,
                suspended_at: null,
            })
            .eq('id', agentId);

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
        const daysUntilSunday = (7 - dayOfWeek) % 7 || 7;
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
            agentId: req.agent_id,
            agentName,
            currentLimit: req.current_limit,
            requestedLimit: req.requested_limit,
            reason: req.reason,
            status: req.status,
            reviewedBy: req.reviewed_by,
            reviewedAt: req.reviewed_at,
            createdAt: req.created_at,
        };
    },
};

export default CreditService;
