import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import CashierConservationReport from '../../src/components/wallet/CashierConservationReport';
import {
  conservationChips,
  validateCashierConservation,
} from '../../src/services/CashierConservation';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), resolve: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUIDStrict: mocks.resolve }));
const club = '22222222-2222-4222-8222-222222222222';
const props = {
  userId: '11111111-1111-4111-8111-111111111111',
  clubId: club,
  role: 'owner',
  ready: true,
  getAuthorityEpoch: () => 0,
};
function report() {
  return {
    schema_version: 1,
    club_id: club,
    as_of: '2026-10-11T12:00:00Z',
    scope: 'bank_and_player_baselines',
    bank: {
      status: 'verified',
      actual: '500.00',
      expected: '500',
      drift: '0.00',
      baseline_at: '2026-01-01T00:00:00Z',
    },
    players: {
      status: 'verified',
      positions: 2,
      checked: 2,
      missing: 0,
      mismatches: 0,
      actual: '300',
      expected: '300.00',
      net_drift: '0',
      absolute_drift: '0',
    },
    inventory: { agent_wallets: '7', promo_wallets: '0', held_chips: '0', cash_stacks: '25' },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockImplementation(async (id: string) => id);
  mocks.rpc.mockResolvedValue({ data: report(), error: null });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
it('runs the real validated read only after an explicit click and labels its limited scope', async () => {
  render(<CashierConservationReport {...props} />);
  expect(mocks.rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile Now' }));
  const region = await screen.findByRole('region', { name: 'Accounting Report' });
  expect(within(region).getByRole('status')).toHaveTextContent('Covered Balances Match');
  expect(within(region).getByText(/Inventory Is Unverified/)).toBeTruthy();
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_cashier_conservation_report', {
    p_club_id: club,
  });
});
it('keeps missing baselines incomplete even when all covered differences are zero', async () => {
  const r = report();
  Object.assign(r.players, { status: 'incomplete', positions: 3, missing: 1 });
  mocks.rpc.mockResolvedValue({ data: r, error: null });
  render(<CashierConservationReport {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile Now' }));
  expect(await screen.findByText('Coverage Incomplete')).toBeTruthy();
  expect(screen.queryByText('Covered Balances Match')).toBeNull();
});
it('opposite cent discrepancies remain visible despite a zero net difference', async () => {
  const r = report();
  Object.assign(r.players, { status: 'attention', mismatches: 2, absolute_drift: '0.02' });
  mocks.rpc.mockResolvedValue({ data: r, error: null });
  render(<CashierConservationReport {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile Now' }));
  expect(await screen.findByText('Discrepancies Found')).toBeTruthy();
  expect(screen.getByText('Less Than 1 Chip')).toBeTruthy();
});
it.each([
  null,
  [],
  {},
  { ...report(), club_id: 'another-club' },
  { ...report(), schema_version: 2 },
])('rejects malformed or misowned reports %j', async (data) => {
  mocks.rpc.mockResolvedValue({ data, error: null });
  render(<CashierConservationReport {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile Now' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable');
  expect(screen.queryByRole('region', { name: 'Accounting Report' })).toBeNull();
});
it('reports a denied or failed read without changing a balance', async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
  render(<CashierConservationReport {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile Now' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No Balances Were Changed');
  expect(mocks.rpc.mock.calls.map((c) => c[0])).toEqual(['fn_cashier_conservation_report']);
});
it('refuses double taps while the read is in flight', async () => {
  let finish!: (value: unknown) => void;
  mocks.rpc.mockImplementation(() => new Promise((done) => (finish = done)));
  render(<CashierConservationReport {...props} />);
  const button = screen.getByRole('button', { name: 'Reconcile Now' });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
  await act(async () => finish({ data: report(), error: null }));
  expect(await screen.findByText('Covered Balances Match')).toBeTruthy();
});
it.each(['club', 'account', 'authority', 'ABA', 'unmount'])(
  'drops a detached %s response',
  async (kind) => {
    let finish!: (value: unknown) => void;
    let epoch = 0;
    mocks.rpc.mockImplementation(() => new Promise((done) => (finish = done)));
    const base = { ...props, getAuthorityEpoch: () => epoch };
    const view = render(<CashierConservationReport {...base} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile Now' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    if (kind === 'club')
      view.rerender(<CashierConservationReport {...base} clubId="another-club" />);
    if (kind === 'account')
      view.rerender(<CashierConservationReport {...base} userId="another-user" />);
    if (kind === 'authority') epoch++;
    if (kind === 'ABA') {
      view.rerender(<CashierConservationReport {...base} ready={false} />);
      view.rerender(<CashierConservationReport {...base} />);
    }
    if (kind === 'unmount') view.unmount();
    await act(async () => finish({ data: report(), error: null }));
    expect(screen.queryByRole('region', { name: 'Accounting Report' })).toBeNull();
  }
);
it('refuses offline reads and enables the same explicit action on reconnect', async () => {
  render(<CashierConservationReport {...props} />);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  fireEvent(window, new Event('offline'));
  const button = screen.getByRole('button', { name: 'Reconcile Now' });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(mocks.rpc).not.toHaveBeenCalled();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  fireEvent(window, new Event('online'));
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(await screen.findByText('Covered Balances Match')).toBeTruthy();
});
it.each(['player', 'agent', 'super_agent', 'sub_agent'])(
  'does not expose club-wide data to %s',
  (role) => {
    render(<CashierConservationReport {...props} role={role} />);
    expect(screen.queryByRole('button', { name: 'Reconcile Now' })).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  }
);
it('keeps a failed required page refresh an error rather than a report', async () => {
  render(<CashierConservationReport {...props} onRefresh={async () => false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile Now' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('validates exact amounts, coverage and the server verdict independently', () => {
  const invalid = [
    () => ({ ...report(), bank: { ...report().bank, drift: '0.01' } }),
    () => ({ ...report(), players: { ...report().players, missing: 1 } }),
    () => ({ ...report(), players: { ...report().players, absolute_drift: '0.02' } }),
    () => ({ ...report(), players: { ...report().players, status: 'attention' } }),
    () => ({ ...report(), inventory: { ...report().inventory, agent_wallets: undefined } }),
  ];
  for (const build of invalid) expect(() => validateCashierConservation(build(), club)).toThrow();
  expect(() => validateCashierConservation(report(), club)).not.toThrow();
});
it('never rounds a nonzero difference to an apparent zero', () => {
  expect(conservationChips('0.000000001')).toBe('Less Than 1 Chip');
  expect(conservationChips('-0.01')).toBe('Minus Less Than 1 Chip');
  expect(conservationChips(null)).toBe('Unknown');
  expect(conservationChips('1200.99')).toBe('1.2K');
  expect(() => conservationChips('NaN')).toThrow();
});

it('withdraws a completed report when authority changes before the next render', async () => {
  let epoch = 0;
  const base = { ...props, getAuthorityEpoch: () => epoch };
  const view = render(<CashierConservationReport {...base} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile Now' }));
  expect(await screen.findByText('Covered Balances Match')).toBeTruthy();
  epoch++;
  view.rerender(<CashierConservationReport {...base} />);
  expect(screen.queryByRole('region', { name: 'Accounting Report' })).toBeNull();
});
