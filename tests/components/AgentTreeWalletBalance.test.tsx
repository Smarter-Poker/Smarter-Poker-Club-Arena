import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/AgentService', () => ({
  AgentService: {
    getAgents: async () => [
      {
        id: 'agent-a',
        role: 'agent',
        displayName: 'Agent A',
        businessBalance: 1000,
        activePlayerCount: 2,
        subAgentCount: 0,
        commissionRate: 10,
      },
    ],
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import AgentTree from '../../src/components/agent/AgentTree';
describe('agent hierarchy wallet balances', () => {
  it('prints a thousand-chip balance to cents without changing player counts', async () => {
    render(<AgentTree clubId="club-a" />);
    expect(await screen.findByText('1,000.00')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.queryByText('1K')).toBeNull();
  });
});
