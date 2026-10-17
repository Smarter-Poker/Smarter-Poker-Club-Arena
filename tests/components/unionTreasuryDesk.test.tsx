import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  rakeDetail: vi.fn(),
  bbjDetail: vi.fn(),
  bbjBackupTransfer: vi.fn(),
}));
vi.mock('../../src/services/UnionApiService', () => ({ default: api }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import UnionTreasuryDetailModal from '../../src/components/union/UnionTreasuryDetailModal';

const rake = {
  balance: 2849954.4,
  updatedAt: null,
  windowDays: 30,
  ledger: {
    credits: 10239130.75,
    debits: 7389176.35,
    net: 2849954.4,
    rowsSeen: 3665989,
    asOf: '2026-10-17T03:55:00Z',
    lastVerifiedAt: null,
    throughDay: '2026-10-16',
  },
  drift: 0,
  byDay: [{ day: '2026-10-16', rake: 74000, players: 900, player_hands: 120000 }],
  byClub: [
    { club_id: 'c1', club_name: 'SHARK CLUB', rake: 50000, players: 500, player_hands: 80000 },
  ],
  transactions: [
    {
      id: 't1',
      direction: 'credit',
      amount: 1.5,
      tx_type: 'rake_credit',
      notes: null,
      created_at: '2026-10-17T03:50:00Z',
      clubs: { name: 'Club JAQK' },
    },
  ],
};

const bbj = {
  poolId: 'p',
  banks: { main: 50000, backup: 118742.29, promo: 10, total: 168752.29 },
  splitPct: { main: 30, backup: 70, promo: 0 },
  allocatedLifetime: 300000,
  updatedAt: null,
  creditedBy: [],
  byDay: [],
  transactions: [],
};

beforeEach(() => {
  api.rakeDetail.mockReset().mockResolvedValue(rake);
  api.bbjDetail.mockReset().mockResolvedValue(bbj);
  api.bbjBackupTransfer.mockReset().mockResolvedValue({ message: 'Moved 100 To Main' });
});

describe('the union treasury opens on the Cashier desk (sweep 2026-10-17)', () => {
  it('portals a WalletDesk to the page body and prints the rake as desk rows', async () => {
    const { container } = render(
      <UnionTreasuryDetailModal isOpen onClose={() => {}} unionId="u" mode="rake" />
    );
    const desk = await screen.findByRole('dialog', { name: 'Rake Treasury' });
    expect(desk.className).toContain('wdesk');
    expect(container.contains(desk)).toBe(false);
    expect(desk.parentElement).toBe(document.body);
    await within(desk).findByText('Ledger Credits');
    expect(within(desk).getByText('Wallet And Ledger Agree')).toBeTruthy();
    expect(within(desk).getByText('SHARK CLUB')).toBeTruthy();
    expect(within(desk).getByText('Rake Credit')).toBeTruthy();
  });

  it('moves backup through the dock and refuses more than backup holds', async () => {
    render(<UnionTreasuryDetailModal isOpen onClose={() => {}} unionId="u" mode="backup" />);
    const desk = await screen.findByRole('dialog', { name: 'Backup Jackpot' });
    await within(desk).findByText('Move Money Out Of Backup');
    fireEvent.change(within(desk).getByLabelText('Amount To Move'), {
      target: { value: '999999' },
    });
    fireEvent.click(within(desk).getByRole('button', { name: 'Move Funds' }));
    expect(await within(desk).findByText(/Backup Holds Only/)).toBeTruthy();
    expect(api.bbjBackupTransfer).not.toHaveBeenCalled();
    fireEvent.click(within(desk).getByRole('button', { name: 'To Promo Fund' }));
    fireEvent.change(within(desk).getByLabelText('Amount To Move'), { target: { value: '100' } });
    fireEvent.click(within(desk).getByRole('button', { name: 'Move Funds' }));
    await waitFor(() => expect(api.bbjBackupTransfer).toHaveBeenCalledWith('u', 100, 'promo'));
  });
});
