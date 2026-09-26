/**
 * A ONE-OFF START DATE IS THE DAY ITS LABEL SAYS, IN EVERY TIMEZONE
 * (integration I2, 2026-09-23).
 *
 * The Create Tournament modal built each date option's VALUE from
 * toISOString() of local noon, which is the UTC calendar date. For anyone at
 * UTC+12:45 to UTC+14 - New Zealand daylight time from 27 September - local
 * noon is the previous UTC day, so every value was the day before its label
 * and the event was created a day early (or refused as "in the past"). The
 * options now come from upcomingDateOptions (src/lib/quarterHourStartSelect),
 * which reads local fields for value and label alike.
 *
 * The timezone is really moved for this file: Node re-reads process.env.TZ
 * when it is assigned. The first case proves the move took (and that the old
 * arithmetic would have produced the wrong day), so the rest can never pass
 * vacuously on a UTC runner.
 *
 * Also here: the satellite-target read binds its error and reports it, and the
 * picker no longer claims a club has "No Upcoming Tournaments" when the read
 * failed.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  reportError: vi.fn(),
}));
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
vi.mock('../../src/utils/errorReporter', async (original) => ({
  ...(await original<typeof import('../../src/utils/errorReporter')>()),
  reportError: mocks.reportError,
}));

import CreateTournamentModal from '../../src/components/club/CreateTournamentModal';
import { localDateLabel } from '../../src/lib/quarterHourStartSelect';
import { supabase } from '../../src/lib/supabase';

const CLUB = 'd6000000-0000-4000-8000-000000000001';
const ORIGINAL_TZ = process.env.TZ;

function mount() {
  const rendered = render(
    <CreateTournamentModal clubId={CLUB} onClose={vi.fn()} onSuccess={vi.fn()} />
  );
  fireEvent.change(screen.getByPlaceholderText('E.G. Saturday Night Turbo'), {
    target: { value: 'Synthetic Auckland Draft' },
  });
  return rendered;
}

describe('one-off start dates at UTC+13 (New Zealand daylight time)', () => {
  beforeAll(() => {
    process.env.TZ = 'Pacific/Auckland';
  });
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ id: 'synthetic-created-event' });
    vi.useFakeTimers({ toFake: ['Date'] });
    // Monday 28 September 2026, 10:00 in Auckland (21:00 UTC on the 27th).
    vi.setSystemTime(new Date('2026-09-27T21:00:00.000Z'));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs in a zone where local noon is the previous UTC day', () => {
    const localNoon = new Date(2026, 8, 28, 12);
    expect(localNoon.getTimezoneOffset()).toBe(-780);
    expect(localNoon.getDate()).toBe(28);
    // The arithmetic the modal used to do, which is why its values were a day early.
    expect(localNoon.toISOString().slice(0, 10)).toBe('2026-09-27');
  });

  it('gives every date option the value of the day its label names, starting today', () => {
    mount();
    fireEvent.change(screen.getByDisplayValue('Start In 1 Min'), {
      target: { value: 'scheduled' },
    });
    const dates = within(screen.getByLabelText('Tournament Start Date')).getAllByRole(
      'option'
    ) as HTMLOptionElement[];
    const days = dates.filter((option) => option.value !== '');
    expect(days).toHaveLength(366);
    expect(days[0].value).toBe('2026-09-28');
    expect(days[0].textContent).toBe('Mon, Sep 28, 2026');
    for (const option of days) {
      expect(option.textContent).toBe(localDateLabel(option.value));
    }
  });

  it('starts the event at the local time on the chosen day, not a day early', async () => {
    const { container } = mount();
    fireEvent.change(screen.getByDisplayValue('Start In 1 Min'), {
      target: { value: 'scheduled' },
    });
    fireEvent.change(screen.getByLabelText('Tournament Start Date'), {
      target: { value: '2026-09-28' },
    });
    fireEvent.change(screen.getByLabelText('Tournament Start Time'), {
      target: { value: '19:00' },
    });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.error).not.toHaveBeenCalled();
    const config = mocks.create.mock.calls[0][1];
    // 19:00 on Monday 28 September in Auckland is 06:00 UTC that same day.
    expect((config.startTime as Date).toISOString()).toBe('2026-09-28T06:00:00.000Z');
  });
});

describe('the satellite-target read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('reports a refused read and says so, instead of "No Upcoming Tournaments"', async () => {
    const refusal = { message: 'permission denied for table tournaments', code: '42501' };
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: null, error: refusal }),
    };
    vi.spyOn(supabase, 'from').mockReturnValue(query as never);
    mount();
    fireEvent.change(screen.getByLabelText('Tournament Category'), {
      target: { value: 'satellite' },
    });
    expect(
      await screen.findByText(
        'Target Tournaments Could Not Be Loaded. Close And Reopen To Try Again.'
      )
    ).toBeInTheDocument();
    expect(mocks.reportError).toHaveBeenCalledWith(
      refusal,
      'CreateTournamentModal.loadSatelliteTargets'
    );
    expect(screen.queryByText(/No Upcoming Tournaments/)).not.toBeInTheDocument();
  });
});
