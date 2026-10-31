import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import PositionalRadar from '../../src/components/stats/PositionalRadar';
import PositionWinRates from '../../src/components/stats/PositionWinRates';
beforeEach(() => localStorage.clear());
afterEach(cleanup);
const rows = ['BTN', 'SB', 'BB'].map((position) => ({
  position,
  hands_played: 100,
  vpip_count: 20,
  pfr_count: 10,
  three_bet_count: 1,
  three_bet_opps: 4,
  total_profit: 0,
  bb100: 0,
}));
describe('positional three-bet opportunity agreement', () => {
  it('the radar table and focused readout use the same recorded opportunities', () => {
    const { container } = render(<PositionalRadar positions={rows} />);
    fireEvent.click(screen.getByRole('button', { name: '3-Bet', exact: true }));
    expect(within(screen.getByRole('table')).getAllByText('25.0%')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Focus BTN Position' }));
    expect(container.querySelector('.pos-radar-readout')).toHaveTextContent('3-Bet 25.0%');
  });
  it('does not plot an invented zero when one radar axis has no opportunities', () => {
    const { container } = render(
      <PositionalRadar
        positions={rows.map((r, i) =>
          i === 0 ? { ...r, three_bet_opps: 0, three_bet_count: 0 } : r
        )}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '3-Bet', exact: true }));
    expect(within(screen.getByRole('table')).getByText('Not Yet Measured')).toBeInTheDocument();
    expect(container.querySelector('[fill="url(#pos-radar-grad-three_bet)"]')).toBeNull();
  });
  it('position performance does not substitute hands for a missing opportunity denominator', () => {
    render(
      <PositionWinRates
        initialPositions={[{ ...rows[0], three_bet_opps: 0, three_bet_count: 0 }]}
      />
    );
    expect(screen.getAllByText('Not Yet Measured').length).toBeGreaterThan(0);
    expect(screen.getByText(/3-Bet Is Not Yet Measured/)).toBeInTheDocument();
  });
});
