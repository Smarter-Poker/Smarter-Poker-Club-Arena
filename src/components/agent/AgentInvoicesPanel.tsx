/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT INVOICES PANEL — view + pay weekly credit invoices
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Lists the agent's credit_invoices (CreditService.getAgentInvoices) and lets them
 *  pay an outstanding balance from their agent wallet (CreditService.processPayment).
 *  Invoices are generated weekly by fn_generate_all_credit_invoices (triggered on the
 *  FinancialCronService suspension cadence). Mobile-first, no emoji.
 */

import { useCallback, useEffect, useState } from 'react';
import { CreditService, type CreditInvoice } from '../../services/CreditService';
import { useToast } from '../common/Toast';
import { masterBus } from '../../core/MasterBus';
import { reportError } from '../../utils/errorReporter';

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
};

function fmt(n: number): string {
  return Math.round(n).toLocaleString();
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
  const [invoices, setInvoices] = useState<CreditInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [payingId, setPayingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!agentId) {
      setInvoices([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await CreditService.getAgentInvoices(agentId);
      setInvoices(rows);
    } catch (e) {
      reportError(e, 'AgentInvoicesPanel.load', { agentId });
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    load();
  }, [load]);

  const handlePay = useCallback(
    async (inv: CreditInvoice) => {
      if (payingId || inv.amountRemaining <= 0) return;
      setPayingId(inv.id);
      try {
        await CreditService.processPayment(inv.id, inv.amountRemaining, 'wallet');
        toast.success(`Paid ${fmt(inv.amountRemaining)} chips toward invoice`);
        masterBus.emit('BALANCE_UPDATED', { source: 'credit_invoice_payment' });
        await load();
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Payment failed';
        reportError(e, 'AgentInvoicesPanel.handlePay', { invoiceId: inv.id });
        toast.error(msg.includes('insufficient') ? 'Insufficient wallet balance' : 'Payment failed');
      } finally {
        setPayingId(null);
      }
    },
    [payingId, toast, load]
  );

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
            {outstanding.length} outstanding
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ fontSize: '13px', opacity: 0.6, padding: '8px 0' }}>Loading invoices...</div>
      ) : invoices.length === 0 ? (
        <div style={{ fontSize: '13px', opacity: 0.6, padding: '8px 0' }}>
          No invoices. Weekly invoices appear here when your account carries a balance.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {invoices.map((inv) => {
            const color = STATUS_COLORS[inv.status] || '#a0aec0';
            const canPay = inv.amountRemaining > 0;
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
                    Week of {fmtDate(inv.periodStart)}
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
                    {fmt(inv.amountRemaining)} <span style={{ fontSize: '10px', opacity: 0.6 }}>due</span>
                  </div>
                  {inv.amountPaid > 0 && (
                    <div style={{ fontSize: '10px', opacity: 0.5 }}>
                      {fmt(inv.amountPaid)} / {fmt(inv.debtOwed)} paid
                    </div>
                  )}
                </div>
                {canPay && (
                  <button
                    type="button"
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
                    {payingId === inv.id ? 'Paying...' : 'Pay now'}
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
