/**
 * A schedule keeps its time zone (migration 20260924045822): the client half.
 *
 * "Repeats Weekly, 8:00 PM" in Chicago used to be saved as the UTC weekday and
 * time of this week's start, so the event moved one local hour at each
 * daylight-saving change. The schedule UI now saves the creator's own
 * wall-clock day and time WITH their IANA zone, shows the zone by name, and the
 * enable/disable toggle never sends a zone (so it can never re-time a row).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
import WeeklyScheduleEditor, {
  DEFAULT_WEEKLY_SCHEDULE,
  describeSchedule,
} from '../../src/components/tournament/WeeklyScheduleEditor';
import {
  deviceTimeZone,
  scheduleWriteTimeZone,
  SCHEDULE_ZONES_REACH_THE_ENGINE,
} from '../../src/utils/scheduleTimeZone';
import { tournamentScheduleService } from '../../src/services/TournamentScheduleService';
import { supabase } from '../../src/lib/supabase';

const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockRpc() {
  const rpc = vi.spyOn(supabase, 'rpc');
  rpc.mockClear();
  return rpc.mockResolvedValue({
    data: { ok: true, schedule_id: 'synthetic-schedule' },
    error: null,
  } as never);
}

describe('the device zone', () => {
  it('is the IANA name the runtime reports', () => {
    expect(deviceTimeZone()).toBe('America/Chicago');
  });

  it('is null, never a guess, when the runtime reports no usable name', () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    for (const timeZone of [undefined, 'CST', 'EST5EDT', 'UTC+3']) {
      vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
        this: Intl.DateTimeFormat
      ) {
        return { ...real.call(this), timeZone } as Intl.ResolvedDateTimeFormatOptions;
      });
      expect(deviceTimeZone()).toBeNull();
      vi.restoreAllMocks();
    }
  });
});

describe('the schedule UI names the zone its times are in', () => {
  it('the editor labels its times with the zone, and says UTC without one', () => {
    const { unmount } = render(
      <WeeklyScheduleEditor
        value={{ ...DEFAULT_WEEKLY_SCHEDULE }}
        onChange={vi.fn()}
        timeZone="America/Chicago"
      />
    );
    expect(screen.getByText('At Set Times (America/Chicago)')).toBeTruthy();
    expect(screen.getByText(/Days And Times Are In America\/Chicago\./)).toBeTruthy();
    unmount();
    render(<WeeklyScheduleEditor value={{ ...DEFAULT_WEEKLY_SCHEDULE }} onChange={vi.fn()} />);
    expect(screen.getByText('At Set Times (UTC)')).toBeTruthy();
  });

  it('a stored row is described in its own zone, and a legacy row in UTC', () => {
    // Title Case since the visual acceptance pass (2026-09-24): the summary
    // prints on the union's schedule cards, and "at" / "every day" did not.
    expect(describeSchedule([5], ['20:00'], null, 'America/Chicago')).toBe(
      'Fri At 20:00 America/Chicago'
    );
    expect(describeSchedule([5], ['01:00'], null, null)).toBe('Fri At 01:00 UTC');
    expect(describeSchedule([5], ['01:00'], null)).toBe('Fri At 01:00 UTC');
  });

  it('every word of a summary is capitalised, and a zone id prints without underscores', () => {
    expect(describeSchedule([0, 1, 2, 3, 4, 5, 6], [], 60, null)).toBe(
      'Every Day, Every 60 Minutes'
    );
    expect(
      describeSchedule([1, 3], ['18:00', '21:30'], null, 'America/Argentina/Buenos_Aires')
    ).toBe('Mon, Wed At 18:00, 21:30 America/Argentina/Buenos Aires');
    for (const text of [
      describeSchedule([0, 1, 2, 3, 4, 5, 6], [], 1440, null),
      describeSchedule([2], ['09:00'], null, 'America/New_York'),
    ]) {
      for (const word of text.split(/[\s,/]+/).filter((w) => /^[a-z]/i.test(w))) {
        expect(word[0], `"${word}" in "${text}"`).toBe(word[0].toUpperCase());
      }
      expect(text).not.toContain('_');
    }
  });
});

describe('the service sends the zone only when the caller states one', () => {
  it('create carries the zone', async () => {
    const rpc = mockRpc();
    await tournamentScheduleService.upsert({
      clubId: 'club',
      name: 'Friday 8 PM',
      daysOfWeek: [5],
      startTimesUtc: ['20:00'],
      timeZone: 'America/Chicago',
      config: { type: 'mtt' },
    });
    const sent = (rpc.mock.calls[0][1] as { p_schedule: Record<string, unknown> }).p_schedule;
    expect(sent).toMatchObject({
      daysOfWeek: [5],
      startTimesUtc: ['20:00'],
      timeZone: 'America/Chicago',
    });
  });

  it('an omitted zone is not sent, so an update keeps the stored one', async () => {
    const rpc = mockRpc();
    await tournamentScheduleService.upsert({
      id: 'existing',
      clubId: 'club',
      name: 'Friday 8 PM',
      daysOfWeek: [5],
      startTimesUtc: ['20:00'],
      config: { type: 'mtt' },
    });
    const sent = (rpc.mock.calls[0][1] as { p_schedule: Record<string, unknown> }).p_schedule;
    expect(sent).not.toHaveProperty('timeZone');
  });

  it('the enable toggle sends only the id and active flag', async () => {
    const rpc = mockRpc();
    await tournamentScheduleService.setActive('existing', true);
    expect(rpc).toHaveBeenCalledWith('fn_upsert_tournament_schedule', {
      p_schedule: { id: 'existing', active: true },
    });
  });
});

describe('a schedule is written with a zone only once the engine reads zones', () => {
  // The running engine (8825af51) reads every row as UTC; a zoned row would
  // start hours early. The write stays on the UTC contract until the engine
  // release carrying scheduleWallClock is verified live.
  it('the gate is closed while that engine release is not live', () => {
    expect(SCHEDULE_ZONES_REACH_THE_ENGINE).toBe(false);
    expect(scheduleWriteTimeZone()).toBeNull();
  });

  it('once the engine reads zones, a write carries the device zone', () => {
    expect(scheduleWriteTimeZone(true)).toBe('America/Chicago');
    expect(scheduleWriteTimeZone(false)).toBeNull();
  });

  it('Repeats Weekly saves the UTC day and time with no zone while the gate is closed', async () => {
    // Friday 2026-10-30, 19:50 CDT: "starts now" means ten minutes from now,
    // 20:00 local = Saturday 01:00 UTC, exactly what every engine reads.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T00:50:00Z'));
    const rpc = mockRpc();
    const { container } = render(
      <CreateTournamentModal
        clubId="synthetic-club"
        initialFormat="mtt_freezeout"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );
    fireEvent.change(screen.getByPlaceholderText('E.G. Saturday Night Turbo'), {
      target: { value: 'Friday 8 PM' },
    });
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'weekly' } });
    expect(screen.getByTestId('repeats-weekly-local-time')).toHaveTextContent(
      'Every Saturday At 01:00 UTC'
    );
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('fn_upsert_tournament_schedule', expect.any(Object))
    );
    const sent = (
      rpc.mock.calls.find(([name]) => name === 'fn_upsert_tournament_schedule')![1] as {
        p_schedule: Record<string, unknown>;
      }
    ).p_schedule;
    expect(sent).toMatchObject({ daysOfWeek: [6], startTimesUtc: ['01:00'] });
    expect(sent.timeZone ?? null).toBeNull();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
