import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MttPremiumCard } from '../../src/components/lobby/game-cards/MttPremiumCard';
import type { ArenaGameCardData } from '../../src/components/lobby/game-cards/arenaGameCardTypes';
afterEach(cleanup);
const data: ArenaGameCardData = {
  id: 'mtt',
  family: 'mtt',
  title: 'Sunday Deep Stack',
  gameType: 'NLH',
  status: 'registering',
  statusLabel: 'Registering',
  startsIn: 'Starting In 10:00',
  startTime: 'Oct 11, 12:00 PM',
  buyIn: '200',
  guarantee: '20,000 GTD',
  registered: '29',
  startingStack: '30,000',
  currentLevel: '1',
  currentBlinds: '25/50',
  rules: [],
};
describe('cash-style tournament card', () => {
  it('shows live tournament facts, status and variant together', () => {
    render(<MttPremiumCard data={data} actions={{ primaryLabel: 'Register' }} />);
    for (const value of [
      'Sunday Deep Stack',
      'Registering · Starting In 10:00',
      'NLH',
      'Oct 11, 12:00 PM',
      '200',
      '20,000 GTD',
      '29',
      '30,000',
      '1',
      '25/50',
    ])
      expect(screen.getByText(value)).toBeTruthy();
  });
  it('keeps register and details actions, and prevents repeated busy registration', () => {
    const primary = vi.fn(),
      secondary = vi.fn();
    const { rerender } = render(
      <MttPremiumCard
        data={data}
        actions={{
          primaryLabel: 'Register',
          secondaryLabel: 'Details',
          onPrimary: primary,
          onSecondary: secondary,
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
    rerender(
      <MttPremiumCard
        data={data}
        actions={{ primaryLabel: 'Register', busy: true, onPrimary: primary }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Working...' }));
    expect(primary).toHaveBeenCalledTimes(1);
  });
});
