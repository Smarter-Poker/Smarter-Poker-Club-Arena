/**
 * The owner's Spin panel (2026-09-20): one sheet of its own so it is the same
 * picture on the settings page, in the lobby's Spins Wallet popup and on the
 * union dashboard; state printed as text rather than a switch that cannot be
 * pressed; chips with no decimals, exact where the owner is being charged; and
 * a refusal that stays on the panel. Each case failed against the panel as it
 * was, which borrowed another page's class names.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requiredSeed } from '../../src/config/spinSpec';

const { getState, activate, deactivate, toastSuccess, toastError } = vi.hoisted(() => ({
  getState: vi.fn(),
  activate: vi.fn(),
  deactivate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/services/SpinActivationService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/SpinActivationService')>()),
  spinActivationApi: { getState, activate, deactivate },
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: toastSuccess, error: toastError }),
}));

import SpinActivationPanel from '../../src/components/club/SpinActivationPanel';

const source = readFileSync('src/components/club/SpinActivationPanel.tsx', 'utf8');
const sheet = readFileSync('src/components/club/SpinActivationPanel.css', 'utf8');

const inactive = {
  ok: true,
  owner_id: 'club-1',
  owner_kind: 'club',
  is_active: false,
  balance: 0,
  offered_max_stake: 0,
  required_seed: 0,
  seeded_amount: 0,
  seed_returned_amount: 0,
  seed_repayable_in: 0,
  collected_from_play: 0,
  total_drawn: 0,
};

describe('the panel carries its own sheet', () => {
  it('imports it and borrows no class name from another page', () => {
    expect(source).toContain("import './SpinActivationPanel.css';");
    for (const borrowed of [
      'settings-section',
      'toggle-row',
      'toggle-btn',
      'form-hint',
      'form-row',
      'form-group',
      'btn-primary',
      'btn-secondary',
    ]) {
      expect(source).not.toContain(borrowed);
    }
  });

  it('defines every class the panel prints, and only under its own prefix', () => {
    const used = new Set(
      [...source.matchAll(/className="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/))
    );
    expect(used.size).toBeGreaterThan(5);
    for (const name of used) {
      expect(name).toMatch(/^sap(-|$)/);
      expect(sheet).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
    }
  });

  it('draws nothing: no hover, no gradient, no rounded corner, no container that can collapse', () => {
    const rules = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/:hover|gradient\(|border-radius:\s*[1-9]|container-type/);
  });
});

describe('what the panel prints', () => {
  beforeEach(() => {
    getState.mockReset();
    activate.mockReset();
    deactivate.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('prints Spins Are Off as text, and the one control quotes the exact whole seed it moves', async () => {
    // 600.4 already in the pool: the charge is the rest, 1,399.6, quoted up.
    getState.mockResolvedValue({
      state: {
        ...inactive,
        offered_max_stake: 10,
        seeded_amount: 600.4,
        seed_is_repayable: true,
        seed_source_wallet: 'chip_treasury',
      },
      canManage: true,
    });
    render(<SpinActivationPanel clubId="club-1" />);

    const status = await screen.findByText('Spins Are Off');
    expect(status.tagName).toBe('DD');
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    const charge = requiredSeed(10) - 600.4;
    const quoted = Math.ceil(charge).toLocaleString('en-US');
    expect(buttons[0]).toHaveTextContent(`Activate Spins And Seed ${quoted}`);
    expect(screen.getByText('You Pay Now').parentElement).toHaveTextContent(`${quoted} Chips`);
    expect(document.body.textContent).not.toMatch(/\d\.\d/);

    // The request still carries the exact amount the pool is short.
    activate.mockRejectedValue(new Error('Chip Treasury Cannot Cover This Seed'));
    await userEvent.setup().click(buttons[0]);
    await waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
    expect(activate.mock.calls[0][1]).toBeCloseTo(charge, 6);
    // A refusal stays on the panel after the toast has gone.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Chip Treasury Cannot Cover This Seed'
    );
  });

  it('prints a running pool compact, with no decimals, and Spins Are On as text', async () => {
    getState.mockResolvedValue({
      state: {
        ...inactive,
        is_active: true,
        balance: 12_345.67,
        offered_max_stake: 10,
        collected_from_play: 25_000.5,
        total_drawn: 12_654.83,
        seeded_amount: 1_250,
        seed_is_repayable: true,
        seed_source_wallet: 'chip_treasury',
        seed_returned_amount: 750,
        repay_floor: 2_000,
        repay_trigger_at: 2_500,
        next_instalment: 740.9,
      },
      canManage: true,
    });
    render(<SpinActivationPanel clubId="club-1" />);

    expect((await screen.findByText('Spins Are On')).tagName).toBe('DD');
    const row = (label: string) => screen.getByText(label).parentElement as HTMLElement;
    expect(within(row('Wallet Balance')).getByText('12.3K')).toBeInTheDocument();
    expect(within(row('Collected From Play')).getByText('25K')).toBeInTheDocument();
    expect(within(row('Paid Out As Multipliers')).getByText('12.6K')).toBeInTheDocument();
    expect(screen.getByText(/Next Instalment 740, Due On The Next Spin\./)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d\.\d{2}/);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('Turn Spins Off');
  });
});
