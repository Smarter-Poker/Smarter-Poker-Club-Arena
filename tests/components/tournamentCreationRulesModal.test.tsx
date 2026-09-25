/**
 * The Create Game modal reads the SHARED creation rules (20260924033701):
 * the rebuy late window, the satellite target and the past start time come
 * from src/lib/tournamentCreationRules.ts, with the same sentences the other
 * surfaces and the database use. The modal no longer keeps its own copies.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../../src/services/TournamentService', async (original) => {
  const actual = await original<typeof import('../../src/services/TournamentService')>();
  return {
    ...actual,
    tournamentService: {
      createTournament: mocks.create,
      buildRpcConfig: actual.tournamentService.buildRpcConfig.bind(actual.tournamentService),
    },
  };
});
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error }),
}));
import CreateTournamentModal from '../../src/components/club/CreateTournamentModal';
import { TOURNAMENT_CREATE_ERRORS } from '../../src/lib/tournamentCreationRules';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: 'synthetic-created-event' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount(initialFormat: Parameters<typeof CreateTournamentModal>[0]['initialFormat']) {
  const rendered = render(
    <CreateTournamentModal
      clubId="d6000000-0000-4000-8000-000000000001"
      initialFormat={initialFormat}
      onClose={vi.fn()}
      onSuccess={vi.fn()}
    />
  );
  fireEvent.change(screen.getByPlaceholderText('E.G. Saturday Night Turbo'), {
    target: { value: 'Rules Draft' },
  });
  return rendered;
}

const createButton = () => screen.getByRole('button', { name: 'Create Tournament' });

describe('the modal applies the shared creation rules', () => {
  it('a rebuy event with no late registration says why and cannot be created', () => {
    mount('mtt_rebuy');
    fireEvent.change(screen.getByDisplayValue(/Through Level 8/), { target: { value: '0' } });
    expect(
      screen.getByText(TOURNAMENT_CREATE_ERRORS.rebuy_requires_late_registration)
    ).toBeTruthy();
    expect((createButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('a re-entry event with a late window can be created', () => {
    mount('mtt_reentry');
    expect(
      screen.queryByText(TOURNAMENT_CREATE_ERRORS.rebuy_requires_late_registration)
    ).toBeNull();
    expect((createButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('a satellite with no target is refused with the shared sentence', async () => {
    const { container } = mount('satellite');
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(TOURNAMENT_CREATE_ERRORS.satellite_target_required)
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('a scheduled start in the past is refused with the shared sentence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T15:00:00'));
    const { container } = mount('mtt_freezeout');
    fireEvent.change(screen.getByDisplayValue('Start In 1 Min'), {
      target: { value: 'scheduled' },
    });
    const date = screen.getByRole('combobox', {
      name: 'Tournament Start Date',
    }) as HTMLSelectElement;
    fireEvent.change(date, { target: { value: date.options[1].value } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Tournament Start Time' }), {
      target: { value: '00:00' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(TOURNAMENT_CREATE_ERRORS.start_time_in_past)
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('a default event passes the shared payout rule and reaches creation', async () => {
    const { container } = mount('mtt_freezeout');
    expect(screen.queryByText(/Payouts Must Total 100 Percent/)).toBeNull();
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  });
});
