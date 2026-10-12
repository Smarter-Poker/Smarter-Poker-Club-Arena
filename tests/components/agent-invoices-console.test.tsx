import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgentInvoices: vi.fn(),
  processPayment: vi.fn(),
  reportError: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('../../src/services/CreditService', () => ({
  CreditService: {
    getAgentInvoices: mocks.getAgentInvoices,
    processPayment: mocks.processPayment,
  },
  OWED_INVOICE_STATUSES: new Set(['pending', 'partial', 'overdue']),
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error }),
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: mocks.emit },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: mocks.reportError,
}));

vi.mock('../../src/utils/uuid', () => ({
  uuid: () => '11111111-1111-4111-8111-111111111111',
}));

import AgentInvoicesPanel from '../../src/components/agent/AgentInvoicesPanel';

type InvoiceStatus = 'pending' | 'partial' | 'paid' | 'overdue' | 'disputed' | 'void';

function invoice(status: InvoiceStatus, id: string, amountRemaining = 1299.99) {
  return {
    id,
    agentId: 'agent-a',
    agentName: 'Agent',
    periodStart: '2026-09-21T00:00:00.000Z',
    periodEnd: '2026-09-27T00:00:00.000Z',
    debtOwed: 1599.99,
    amountPaid: 300,
    amountRemaining,
    status,
    dueDate: '2026-10-01T00:00:00.000Z',
    createdAt: '2026-09-28T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe('AgentInvoicesPanel console', () => {
  it('counts only genuinely owed rows and prints compact title-cased invoice data', async () => {
    mocks.getAgentInvoices.mockResolvedValue([
      invoice('pending', 'pending'),
      invoice('disputed', 'disputed'),
      invoice('void', 'void'),
    ]);

    render(<AgentInvoicesPanel agentId="agent-a" />);

    await screen.findByRole('list', { name: 'Credit Invoice History' });
    expect(screen.getByText('1 Due')).toBeDefined();
    expect(screen.getByText('Pending')).toBeDefined();
    expect(screen.getByText('Disputed')).toBeDefined();
    expect(screen.getByText('Void')).toBeDefined();
    expect(screen.getAllByText('1.2K', { exact: false })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Pay Now' })).toHaveLength(1);
    expect(document.body.textContent).not.toContain('1299.99');
  });

  it('treats a malformed successful list as unavailable rather than empty', async () => {
    mocks.getAgentInvoices.mockResolvedValue(null);

    render(<AgentInvoicesPanel agentId="agent-a" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Invoices Unavailable');
    expect(screen.queryByText(/No Invoices\. Weekly Invoices/)).toBeNull();
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Invoice list is unavailable' }),
      'AgentInvoicesPanel.load',
      { agentId: 'agent-a' }
    );
  });

  it('pays the exact invoice balance while keeping the forward display compact', async () => {
    mocks.getAgentInvoices.mockResolvedValueOnce([invoice('pending', 'pending')]);
    mocks.getAgentInvoices.mockResolvedValueOnce([]);
    mocks.processPayment.mockResolvedValue({
      id: 'payment',
      invoiceId: 'pending',
      amount: 1299.99,
      paymentMethod: 'wallet',
      createdAt: '2026-10-03T00:00:00.000Z',
    });

    render(<AgentInvoicesPanel agentId="agent-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pay Now' }));

    await waitFor(() =>
      expect(mocks.processPayment).toHaveBeenCalledWith('pending', 1299.99, 'wallet', {
        operationId: '11111111-1111-4111-8111-111111111111',
      })
    );
    expect(mocks.success).toHaveBeenCalledWith('Paid 1.2K Chips Toward Invoice');
    expect(mocks.emit).toHaveBeenCalledWith('BALANCE_UPDATED', {
      source: 'credit_invoice_payment',
    });
  });
});
