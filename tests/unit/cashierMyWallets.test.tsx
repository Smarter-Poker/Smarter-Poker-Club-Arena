import { useLayoutEffect } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/wallet/DynamicWallet', () => ({
  default: function MockDynamicWallet(props: Record<string, unknown>) {
    useLayoutEffect(() => {
      (props.onVisibleWalletCountChange as (count: number) => void)(5);
    }, [props.onVisibleWalletCountChange]);
    return (
      <div data-testid="directory" data-role={String(props.role)} data-club={String(props.clubId)}>
        <button onClick={props.onOpenPlayerWallet as () => void}>Open Player Wallet</button>
        <button onClick={props.onOpenClubBank as () => void}>Open Club Bank</button>
        <button onClick={props.onOpenPromoWallet as () => void}>Open Promo Wallet</button>
        <button onClick={props.onOpenAgentWallet as () => void}>Open Agent Wallet</button>
      </div>
    );
  },
}));
vi.mock('../../src/components/wallet/WalletCashierModal', () => ({
  default: (props: { isOpen: boolean; walletType: string; clubId: string; onClose: () => void }) =>
    props.isOpen ? (
      <div role="dialog" aria-label={props.walletType} data-club={props.clubId}>
        <button onClick={props.onClose}>Close Wallet</button>
      </div>
    ) : null,
}));
vi.mock('../../src/components/wallet/PlayerWalletModal', () => ({
  default: (props: { isOpen: boolean }) =>
    props.isOpen ? <div role="dialog" aria-label="Player Wallet" /> : null,
}));
vi.mock('../../src/components/wallet/DiamondWalletModal', () => ({ default: () => null }));
vi.mock('../../src/components/union/UnionWalletModal', () => ({ default: () => null }));
vi.mock('../../src/components/union/UnionTreasuryDetailModal', () => ({ default: () => null }));
vi.mock('../../src/components/admin/RakeReports', () => ({ RakeReports: () => null }));
vi.mock('../../src/components/club/SpinActivationPanel', () => ({ default: () => null }));
vi.mock('../../src/services/HapticService', () => ({
  default: { selection: vi.fn(), medium: vi.fn() },
}));
import CashierMyWallets from '../../src/components/wallet/CashierMyWallets';

function mount() {
  return render(
    <MemoryRouter>
      <CashierMyWallets userId="viewer" clubId="selected-club" role="owner" />
    </MemoryRouter>
  );
}
describe('the relocated Cashier wallet directory', () => {
  it('publishes its count while collapsed, exposes rows only after a click, and collapses again', () => {
    mount();
    const trigger = screen.getByRole('button', { name: 'My Wallets 5 Balances' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Open Player Wallet' })).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByTestId('directory').getAttribute('data-role')).toBe('owner');
    expect(screen.getByTestId('directory').getAttribute('data-club')).toBe('selected-club');
    expect(screen.getByRole('button', { name: 'Open Player Wallet' })).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByRole('button', { name: 'Open Player Wallet' })).toBeNull();
    expect(trigger.textContent).toContain('5 Balances');
  });
  it.each([
    ['Club Bank', 'club_bank'],
    ['Promo Wallet', 'promo_wallet'],
    ['Agent Wallet', 'agent_wallet'],
  ])('opens %s in the selected club through the existing wallet modal', (label, type) => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'My Wallets 5 Balances' }));
    fireEvent.click(screen.getByRole('button', { name: `Open ${label}` }));
    expect(screen.getByRole('dialog', { name: type }).getAttribute('data-club')).toBe(
      'selected-club'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close Wallet' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
