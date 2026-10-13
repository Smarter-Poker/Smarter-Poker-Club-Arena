import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));
import BBJInfoModal from '../../src/components/bbj/BBJInfoModal';
import { parseDiamondJackpotSnapshot } from '../../src/lib/diamondJackpotFeed';
import { BBJCelebration } from '../../src/components/table/BBJCelebration';
import { BadBeatJackpot } from '../../src/components/table/BadBeatJackpot';
afterEach(cleanup);
it('Diamond loading, read failure and recovery render distinct truthful states', () => {
  const props = {
    isOpen: true,
    onClose: () => {},
    poolId: null,
    poolAmount: 0,
    asset: 'diamonds' as const,
  };
  const { rerender } = render(<BBJInfoModal {...props} diamond={null} />);
  expect(screen.getByText('Reading Diamond Jackpot Winners')).toBeTruthy();
  rerender(<BBJInfoModal {...props} diamond={null} diamondUnavailable />);
  expect(screen.getByText('Could Not Read Diamond Jackpot Winners.')).toBeTruthy();
  expect(screen.queryByText('Reading Diamond Jackpot Winners')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Basic' }));
  expect(screen.getByText('Could Not Read Diamond Jackpot Settings.')).toBeTruthy();
  rerender(<BBJInfoModal {...props} diamond={snapshot} diamondUnavailable={false} />);
  expect(screen.queryByText(/Could Not Read/)).toBeNull();
  expect(screen.getByText('200')).toBeTruthy();
});
const snapshot = {
  version: 1 as const,
  pool_id: 'pool',
  enabled: true,
  main_balance: 105,
  mini_enabled: true,
  backup_balance: 5100,
  reserve_floor: 5000,
  stakes: [
    {
      big_blind: 20,
      drop: 1,
      min_pot: 200,
      payout_percent: 70,
      loser_percent: 50,
      winner_percent: 25,
      table_percent: 25,
      mini_amount: 1500,
      mini_payable: false,
    },
  ],
  hits: [],
};
it('whole-Diamond feed refuses unknown/malformed money instead of printing zero', () => {
  expect(parseDiamondJackpotSnapshot(snapshot).main_balance).toBe(105);
  expect(() => parseDiamondJackpotSnapshot({ ...snapshot, main_balance: '105' })).toThrow(
    'invalid_money'
  );
  expect(() => parseDiamondJackpotSnapshot({ ...snapshot, main_balance: 105.5 })).toThrow(
    'invalid_money'
  );
  expect(() => parseDiamondJackpotSnapshot({ ...snapshot, enabled: null })).toThrow('invalid');
});
it('Diamond plate never prints cents for a small real pool', () => {
  const { container } = render(
    <BadBeatJackpot amount={105} asset="diamonds" qualifyingHand="Aces Full Of Jacks" />
  );
  expect(container.querySelector('.bbj-widget__amount')?.textContent).toBe('105');
});
it('Diamond rules read exact published stake prices and Mini reserve eligibility', () => {
  render(
    <BBJInfoModal
      isOpen
      onClose={() => {}}
      poolId="pool"
      poolAmount={105}
      asset="diamonds"
      diamond={snapshot}
      gameType="nlh"
      bigBlind={20}
    />
  );
  expect(screen.getByText('No Diamond Jackpot Has Been Paid Yet.')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Basic' }));
  expect(screen.getByText('50% / 25% / 25%')).toBeTruthy();
  expect(screen.getByText('200')).toBeTruthy();
  expect(screen.queryByText(/Chips Are Credited/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Mini', exact: true }));
  expect(screen.getAllByText('Paused').length).toBeGreaterThan(0);
  expect(screen.getByText(/5,000 Diamonds/)).toBeTruthy();
});

it('paid Diamond celebration names the wallet, while chip celebrations retain table credit', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const props = {
    visible: true,
    totalPayout: 105,
    loser: { userId: 'loser', username: 'Loser', share: 54, handName: 'Aces Full Of Jacks' },
    winner: { userId: 'winner', username: 'Winner', share: 26, handName: 'Four Jacks' },
    tableShare: 25,
    perPlayerShare: 25,
    tablePlayerCount: 1,
    heroShare: 54,
    soundsAllowed: false,
  };
  const { rerender } = render(<BBJCelebration {...props} asset="diamonds" />);
  expect(screen.getByText('Diamonds Added Directly To Your Diamond Wallet!')).toBeTruthy();
  expect(screen.queryByText('Chips Added Directly To Your Table Balance!')).toBeNull();
  rerender(<BBJCelebration {...props} asset="chips" />);
  expect(screen.getByText('Chips Added Directly To Your Table Balance!')).toBeTruthy();
});
