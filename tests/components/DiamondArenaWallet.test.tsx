import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/components/wallet/DiamondWalletModal', () => ({
  default: ({ onClose, onBuyClick }: { onClose: () => void; onBuyClick: () => void }) => (
    <section aria-label="Shared Diamond Wallet">
      <button onClick={onClose}>Close Wallet</button>
      <button
        onClick={() => {
          onClose();
          onBuyClick();
        }}
      >
        Buy Diamonds
      </button>
    </section>
  ),
}));
vi.mock('../../src/components/vip/DiamondTopUpModal', () => ({
  DiamondTopUpModal: ({ onClose }: { onClose: () => void }) => (
    <section aria-label="Existing Diamond Checkout">
      <button onClick={onClose}>Back To Wallet</button>
    </section>
  ),
}));
import DiamondArenaWallet from '../../src/components/arena/DiamondArenaWallet';

describe('Diamond lobby wallet entry', () => {
  it('opens and closes the shared wallet without replacing the lobby', async () => {
    render(
      <>
        <p>Active Table Remains Mounted</p>
        <DiamondArenaWallet />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Diamond Wallet' }));
    await screen.findByRole('region', { name: 'Shared Diamond Wallet' });
    expect(screen.getByText('Active Table Remains Mounted')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Wallet' }));
    expect(screen.queryByRole('region', { name: 'Shared Diamond Wallet' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Diamond Wallet' })).toBeTruthy();
  });
  it('continues to the existing checkout and returns to the wallet on close', async () => {
    render(<DiamondArenaWallet />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Diamond Wallet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Buy Diamonds' }));
    await screen.findByRole('region', { name: 'Existing Diamond Checkout' });
    expect(screen.queryByRole('region', { name: 'Shared Diamond Wallet' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back To Wallet' }));
    await screen.findByRole('region', { name: 'Shared Diamond Wallet' });
  });
});
