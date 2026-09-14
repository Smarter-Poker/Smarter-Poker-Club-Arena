import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../../src/services/TournamentService', async (original) => {
  const actual = await original<typeof import('../../src/services/TournamentService')>();
  return { ...actual, tournamentService: { createTournament: mocks.create } };
});
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error }),
}));
import CreateTournamentModal from '../../src/components/club/CreateTournamentModal';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: 'synthetic-created-event' });
});
afterEach(cleanup);

describe('MTT creation publishes a selected paid field', () => {
  it.each([10, 15, 20])('submits %i percent with a bounded provisional ladder', async (depth) => {
    const { container } = render(
      <CreateTournamentModal
        clubId="synthetic-club"
        initialFormat="mtt_freezeout"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );
    const name = screen.getByPlaceholderText('E.G. Saturday Night Turbo');
    fireEvent.change(name, { target: { value: 'Synthetic Paid Field' } });
    fireEvent.change(screen.getByLabelText('Field Paid'), { target: { value: String(depth) } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const [club, config] = mocks.create.mock.calls[0];
    expect(club).toBe('synthetic-club');
    expect(config.maxPlayers).toBe(1_000_000);
    expect(config.payoutPercent).toBe(depth);
    expect(config.payoutStructure).toEqual([{ place: 1, percentage: 100 }]);
    expect(JSON.stringify(config.payoutStructure).length).toBeLessThan(100);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('does not replace the separate Spin prize contract with a paid-field control', () => {
    render(
      <CreateTournamentModal
        clubId="synthetic-club"
        initialFormat="spin"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );
    expect(screen.queryByLabelText('Field Paid')).toBeNull();
  });
});
