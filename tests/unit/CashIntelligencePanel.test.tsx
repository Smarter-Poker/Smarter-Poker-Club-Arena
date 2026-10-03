import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import CashIntelligencePanel from '../../src/components/stats/CashIntelligencePanel';
import type { CashOpportunityStats } from '../../src/services/StatsFactsService';

vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({ children, title }: { children: ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
}));

const counts = (opportunities: number, actions: number) => ({ opportunities, actions });
const data: CashOpportunityStats = {
  contract_version: 2,
  coverage: {
    source: 'ca_hand_facts',
    from: '2026-10-01T00:00:00Z',
    club_id: null,
    exact_hands: 42,
    unavailable_hands: 7,
  },
  opportunities: {
    three_bet: counts(20, 4),
    four_bet: counts(0, 0),
    steal: counts(10, 3),
    squeeze: counts(5, 1),
    blind_defense: counts(8, 6),
    cbet_flop: counts(12, 7),
    barrel_turn: counts(7, 4),
    barrel_river: counts(4, 2),
    check_raise: counts(6, 1),
    donk: counts(3, 0),
    probe: counts(2, 1),
  },
  actions_by_street: {
    preflop: { aggressive: 8, passive: 12 },
    flop: { aggressive: 5, passive: 7 },
    turn: { aggressive: 3, passive: 4 },
    river: { aggressive: 1, passive: 2 },
  },
  context: { in_position_hands: 18, position_measured_hands: 40, average_effective_stack_bb: 87.5 },
};

describe('CashIntelligencePanel', () => {
  it('renders exact rates, opportunity confidence, coverage and evidence actions', () => {
    const open = vi.fn();
    render(<CashIntelligencePanel data={data} onOpenEvidence={open} />);
    expect(screen.getAllByText('20.0%').length).toBeGreaterThan(0);
    expect(screen.getByText(/20 Opportunities/i)).toBeInTheDocument();
    expect(screen.getByText(/Older \/ Unavailable/i)).toBeInTheDocument();
    expect(screen.getByText('87.5 BB')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Open Hands/i })[0]);
    expect(open).toHaveBeenCalledWith('three_bet');
  });

  it('labels a zero-opportunity decision as not measured rather than 0%', () => {
    render(<CashIntelligencePanel data={data} />);
    expect(screen.getAllByText('Not Yet Measured').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/No Decision Sample Yet/i).length).toBeGreaterThan(0);
  });
});
