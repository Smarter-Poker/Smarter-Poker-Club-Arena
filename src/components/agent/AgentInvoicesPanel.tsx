/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT INVOICES PANEL — view + pay weekly credit invoices
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Lists the agent's credit_invoices (CreditService.getAgentInvoices) and lets them
 *  pay an outstanding balance from their player wallet in that club (CreditService.processPayment).
 *  Invoices are generated weekly by fn_generate_all_credit_invoices on the server weekly close. Mobile-first, no emoji.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  CreditService,
  OWED_INVOICE_STATUSES,
  type CreditInvoice,
} from '../../services/CreditService';
import { useToast } from '../common/Toast';
import { masterBus } from '../../core/MasterBus';
import { reportError } from '../../utils/errorReporter';
import { uuid } from '../../utils/uuid';

interface Props {
  /** agents.id PK (NOT auth.uid) */
  agentId: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#f0b429',
  partial: '#f0b429',
  overdue: '#e53e3e',
  disputed: '#e53e3e',
  paid: '#38a169',
  // Cancelled, not owed. Grey so it reads as settled history rather than as an
  // unknown state, which is what the fallback colour said about 224 of them.
  void: '#718096',
};

// Which statuses still owe money is defined once, in CreditService, because
// this panel and CreditService.checkSuspension disagreeing about it is how a
// cancelled invoice ends up suspending an agent.

function fmt(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

export default function AgentInvoicesPanel({ agentId }: Props) {
  const toast = useToast();
  const [state, setState] = useState<{
    agentId: string | null;
    rows: CreditInvoice[];
    loading: boolean;
    unavailable: boolean;
  }>({ agentId, rows: [], loading: true, unavailable: false });
  const [payingId, setPayingId] = useState<string | null>(null);
  const scope = useRef(0);
  const request = useRef(0);
  const payment = useRef<string | null>(null);
  const paymentOperations = useRef(new Map<string, { amount: number; operationId: string }>());

  const load = useCallback(async () => {
    const generation = scope.current;
    const read = ++request.current;
    const current = () => generation === scope.current && read === request.current;
    setState({ agentId, rows: [], loading: !!agentId, unavailable: false });
    if (!agentId) return;
    try {
      const rows = await CreditService.getAgentInvoices(agentId);
      if (current()) setState({ agentId, rows, loading: false, unavailable: false });
    } catch (e) {
      if (!current()) return;
      reportError(e, 'AgentInvoicesPanel.load', { agentId });
      setState({ agentId, rows: [], loading: false, unavailable: true });
    }
  }, [agentId]);

  useLayoutEffect(() => {
    scope.current++;
    payment.current = null;
    paymentOperations.current.clear();
    setPayingId(null);
    void load();
    return () => {
      scope.current++;
      request.current++;
    };
  }, [load]);

  const visible = state.agentId === agentId;
  const invoices = visible && !state.loading && !state.unavailable ? state.rows : [];
  const loading = !visible || state.loading;
  const unavailable = visible && state.unavailable;
  const actionScope = scope.current;
  const actionRequest = request.current;
  const handlePay = async (inv: CreditInvoice) => {
    const current = () => actionScope === scope.current && actionRequest === request.current;
    if (
      !current() ||
      payment.current ||
      !invoices.includes(inv) ||
      !OWED_INVOICE_STATUSES.has(inv.status) ||
      inv.status === 'disputed' ||
      inv.amountRemaining <= 0
    )
      return;
    payment.current = inv.id;
    setPayingId(inv.id);
    try {
      let attempt = paymentOperations.current.get(inv.id);
      if (!attempt || attempt.amount !== inv.amountRemaining) {
        attempt = { amount: inv.amountRemaining, operationId: uuid() };
        paymentOperations.current.set(inv.id, attempt);
      }
      const receipt = await CreditService.processPayment(inv.id, inv.amountRemaining, 'wallet', {
        operationId: attempt.operationId,
      });
      // A sent payment may commit; only consume its result in the original selection.
      if (!current()) return;
      paymentOperations.current.delete(inv.id);
      toast.success(`Paid ${fmt(receipt.amount)} chips toward invoice`);
      masterBus.emit('BALANCE_UPDATED', { source: 'credit_invoice_payment' });
      await load();
    } catch (e) {
      if (!current()) return;
      const msg = e instanceof Error ? e.message : 'Payment failed';
      reportError(e, 'AgentInvoicesPanel.handlePay', { invoiceId: inv.id });
      toast.error(msg);
    } finally {
      if (actionScope === scope.current) {
        payment.current = null;
        setPayingId(null);
      }
    }
  };

  const outstanding = invoices.filter((i) => i.amountRemaining > 0);

  return (
    <div
      style={{
        padding: '16px',
        background: 'rgba(255,255,255,0.03)',
        borderRadius: '12px',
        border: '1px solid rgba(255,255,255,0.08)',
        margin: '0 0 16px 0',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '12px',
        }}
      >
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>Credit Invoices</h3>
        {outstanding.length > 0 && (
          <span style={{ fontSize: '12px', color: '#e53e3e', fontWeight: 600 }}>
            {outstanding.length} Outstanding
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ fontSize: '13px', opacity: 0.6, padding: '8px 0' }}>Loading Invoices...</div>
      ) : unavailable ? (
        <div role="alert">
          Invoices Unavailable. Try Again To Check Your Balance.
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : invoices.length === 0 ? (
        <div style={{ fontSize: '13px', opacity: 0.6, padding: '8px 0' }}>
          No Invoices. Weekly Invoices Appear Here When Your Account Carries A Balance.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {invoices.map((inv) => {
            const color = STATUS_COLORS[inv.status] || '#a0aec0';
            // A number alone was not enough. Ask the STATUS as well, so a
            // cancelled or settled invoice can never offer a button the server
            // is going to refuse.
            const canPay =
              OWED_INVOICE_STATUSES.has(inv.status) &&
              inv.status !== 'disputed' &&
              inv.amountRemaining > 0;
            return (
              <div
                key={inv.id}
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '8px',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  background: 'rgba(0,0,0,0.2)',
                  borderRadius: '8px',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>
                    Week Of {fmtDate(inv.periodStart)}
                  </div>
                  <div style={{ fontSize: '11px', opacity: 0.6 }}>
                    Due {fmtDate(inv.dueDate)} &middot;{' '}
                    <span style={{ color, fontWeight: 600, textTransform: 'capitalize' }}>
                      {inv.status}
                    </span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700 }}>
                    {fmt(inv.amountRemaining)}{' '}
                    <span style={{ fontSize: '10px', opacity: 0.6 }}>Due</span>
                  </div>
                  {inv.amountPaid > 0 && (
                    <div style={{ fontSize: '10px', opacity: 0.5 }}>
                      {fmt(inv.amountPaid)} / {fmt(inv.debtOwed)} Paid
                    </div>
                  )}
                </div>
                {canPay && (
                  <button
                    type="button"
                    title="Pay From Your Player Wallet In This Club"
                    onClick={() => handlePay(inv)}
                    disabled={payingId === inv.id}
                    style={{
                      padding: '8px 14px',
                      fontSize: '13px',
                      fontWeight: 600,
                      borderRadius: '8px',
                      border: 'none',
                      cursor: payingId === inv.id ? 'default' : 'pointer',
                      background: payingId === inv.id ? '#4a5568' : '#3182ce',
                      color: '#fff',
                      minWidth: '84px',
                    }}
                  >
                    {payingId === inv.id ? 'Paying...' : 'Pay Now'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
