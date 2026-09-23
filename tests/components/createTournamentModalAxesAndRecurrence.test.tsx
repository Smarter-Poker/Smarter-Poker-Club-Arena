/**
 * Create Tournament modal: the 2026-09-20 repairs.
 *
 *  - Entry Rules and Prize Style are independent axes (a matrix, both ways).
 *  - One recurrence control: Does Not Repeat / Daily / Weekly / Monthly, with
 *    the tournament_schedules payload unchanged and the interval mode
 *    unreachable outside Weekly (the spawner's interval loop never reads the
 *    cadence, so an interval under Monthly respawned all month).
 *  - The category select is reachable from an Event, so a Satellite can be made.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { RESTART_WEEKLY_MINUTES } from '../../src/services/TournamentService';
import { supabase } from '../../src/lib/supabase';

const CLUB = 'd6000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ id: 'synthetic-created-event' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(initialFormat?: Parameters<typeof CreateTournamentModal>[0]['initialFormat']) {
  const rendered = render(
    <CreateTournamentModal
      clubId={CLUB}
      initialFormat={initialFormat}
      onClose={vi.fn()}
      onSuccess={vi.fn()}
    />
  );
  fireEvent.change(screen.getByPlaceholderText('E.G. Saturday Night Turbo'), {
    target: { value: 'Synthetic Axes Draft' },
  });
  return rendered;
}

const entryRules = () => screen.getByLabelText('Entry Rules') as HTMLSelectElement;
const prizeStyle = () => screen.getByLabelText('Prize Style') as HTMLSelectElement;
const choose = (select: HTMLSelectElement, value: string) =>
  fireEvent.change(select, { target: { value } });

async function submit(container: HTMLElement, callCount = 1) {
  fireEvent.submit(container.querySelector('form')!);
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(callCount));
  expect(mocks.error).not.toHaveBeenCalled();
  return mocks.create.mock.calls[callCount - 1][1];
}

const ENTRY = [
  ['freezeout', false, false],
  ['rebuy', true, false],
  ['reentry', false, true],
] as const;
const PRIZE = [
  ['regular', 'mtt', undefined],
  ['bounty', 'bounty', 'fixed'],
  ['progressive_bounty', 'progressive_bounty', 'progressive'],
  ['mystery_bounty', 'mystery_bounty', 'mystery'],
] as const;
const MATRIX = ENTRY.flatMap(([rules, isRebuy, isReentry]) =>
  PRIZE.map(([style, type, bountyType]) => ({ rules, isRebuy, isReentry, style, type, bountyType }))
);

describe('entry rules and prize style are independent axes', () => {
  it.each(MATRIX)(
    '$rules x $style, entry rules chosen first',
    async ({ rules, isRebuy, isReentry, style, type, bountyType }) => {
      const { container } = mount();
      choose(entryRules(), rules);
      choose(prizeStyle(), style);
      expect(entryRules().value).toBe(rules);
      expect(prizeStyle().value).toBe(style);
      const config = await submit(container);
      expect(config.type).toBe(type);
      expect(config.isRebuy).toBe(isRebuy);
      expect(config.isReentry).toBe(isReentry);
      expect(config.freeBuy).toBe(false);
      expect(config.bountyConfig?.bountyType).toBe(bountyType);
    }
  );

  it.each(MATRIX)(
    '$rules x $style, prize style chosen first',
    async ({ rules, isRebuy, isReentry, style, type, bountyType }) => {
      const { container } = mount();
      choose(prizeStyle(), style);
      choose(entryRules(), rules);
      expect(prizeStyle().value).toBe(style);
      expect(entryRules().value).toBe(rules);
      const config = await submit(container);
      expect(config.type).toBe(type);
      expect(config.isRebuy).toBe(isRebuy);
      expect(config.isReentry).toBe(isReentry);
      expect(config.bountyConfig?.bountyType).toBe(bountyType);
    }
  );

  it('walks one axis through every value without moving the other', () => {
    mount();
    choose(entryRules(), 'reentry');
    for (const [style] of PRIZE) {
      choose(prizeStyle(), style);
      expect(entryRules().value).toBe('reentry');
    }
    choose(prizeStyle(), 'progressive_bounty');
    for (const [rules] of ENTRY) {
      choose(entryRules(), rules);
      expect(prizeStyle().value).toBe('progressive_bounty');
    }
  });

  it('returning to Regular restores the format the entry rules own', async () => {
    const { container } = mount();
    choose(entryRules(), 'rebuy');
    choose(prizeStyle(), 'mystery_bounty');
    choose(prizeStyle(), 'regular');
    const config = await submit(container);
    expect(config).toMatchObject({ type: 'mtt', isRebuy: true, isReentry: false });
    expect(config.bountyConfig).toBeUndefined();
    expect(screen.getByText('Multi-Day Tournament')).toBeVisible();
  });

  it('never leaves a Free Buy sending a freezeout format, and refuses the unfundable bounty pair', async () => {
    const { container } = mount();
    choose(entryRules(), 'free_buy');
    for (const name of ['Knockout Bounty', 'Progressive Knockout (PKO)', 'Mystery Bounty']) {
      expect(screen.getByRole('option', { name })).toBeDisabled();
    }
    expect(screen.getByText(/A Free Buy Is Always A Regular/)).toBeVisible();
    // Forced past the disabled option (the path that produced the defect:
    // Free Buy, a bounty, then Regular wrote 'mtt_freezeout' with freeBuy true).
    choose(prizeStyle(), 'bounty');
    choose(prizeStyle(), 'regular');
    expect(entryRules().value).toBe('free_buy');
    expect(prizeStyle().value).toBe('regular');
    const config = await submit(container);
    expect(config).toMatchObject({ type: 'mtt_free_buy', freeBuy: true, buyIn: 0 });
    expect(config.bountyConfig).toBeUndefined();
  });

  it('refuses Free Buy while a bounty prize style is selected', () => {
    mount();
    choose(prizeStyle(), 'bounty');
    expect(screen.getByRole('option', { name: 'Free Buy (First Entry Free)' })).toBeDisabled();
    choose(entryRules(), 'free_buy');
    expect(entryRules().value).toBe('freezeout');
    expect(prizeStyle().value).toBe('bounty');
  });

  it('points the locked switches at the Entry Rules control, not at retired formats', () => {
    mount();
    expect(screen.getByText('Set Entry Rules To Rebuy To Turn This On')).toBeVisible();
    expect(screen.getByText('Set Entry Rules To Re-Entry To Turn This On')).toBeVisible();
    expect(screen.queryByText(/Format To Enable/)).toBeNull();
    expect(screen.getByRole('switch', { name: 'Allow Rebuys (Same Seat)' })).toBeDisabled();
    choose(entryRules(), 'rebuy');
    expect(screen.getByRole('switch', { name: 'Allow Rebuys (Same Seat)' })).toBeChecked();
    expect(screen.queryByText('Set Entry Rules To Rebuy To Turn This On')).toBeNull();
  });
});

describe('the tournament category is reachable from an event', () => {
  it('lets an event opened with no initial format become a satellite and come back', () => {
    mount(undefined);
    const category = screen.getByLabelText('Tournament Category') as HTMLSelectElement;
    expect(category.value).toBe('mtt_freezeout');
    expect(screen.getByLabelText('Entry Rules')).toBeVisible();
    choose(category, 'satellite');
    expect(category.value).toBe('satellite');
    expect(screen.getByText('Awards Seats Into')).toBeVisible();
    expect(screen.queryByLabelText('Entry Rules')).toBeNull();
    choose(category, 'mtt_freezeout');
    expect(screen.getByLabelText('Entry Rules')).toBeVisible();
  });

  it('keeps showing Multi-Table Tournament for every MTT prize style', () => {
    mount('progressive_bounty');
    expect((screen.getByLabelText('Tournament Category') as HTMLSelectElement).value).toBe(
      'mtt_freezeout'
    );
    expect(prizeStyle().value).toBe('progressive_bounty');
  });
});

function spyScheduleRpc() {
  return vi.spyOn(supabase, 'rpc').mockResolvedValue({
    data: { ok: true, schedule_id: 'synthetic-schedule' },
    error: null,
  } as never);
}
async function savedSchedule(rpc: ReturnType<typeof spyScheduleRpc>, container: HTMLElement) {
  fireEvent.submit(container.querySelector('form')!);
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith('fn_upsert_tournament_schedule', expect.any(Object))
  );
  expect(mocks.error).not.toHaveBeenCalled();
  return (rpc.mock.calls.find(([name]) => name === 'fn_upsert_tournament_schedule')![1] as any)
    .p_schedule;
}
const repeat = () => screen.getByLabelText('Repeat') as HTMLSelectElement;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

describe('one recurrence control at the foot of the form', () => {
  it('offers exactly Does Not Repeat, Daily, Weekly and Monthly, and is the last control', () => {
    const { container } = mount();
    expect(
      within(repeat())
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['Does Not Repeat', 'Daily', 'Weekly', 'Monthly']);
    expect(repeat().value).toBe('none');
    expect(screen.queryByRole('checkbox', { name: 'Repeats Weekly' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Recurring Tournament' })).toBeNull();
    const controls = [...container.querySelectorAll('form input, form select, form button')].filter(
      (el) => !el.closest('.sc__foot')
    );
    expect(controls.at(-1)).toBe(repeat());
  });

  it('a one-off event saves no schedule', async () => {
    const rpc = spyScheduleRpc();
    const { container } = mount();
    await submit(container);
    expect(rpc).not.toHaveBeenCalledWith('fn_upsert_tournament_schedule', expect.anything());
  });

  it('Daily saves set times on every day with the daily cadence and no interval', async () => {
    const rpc = spyScheduleRpc();
    const { container } = mount();
    choose(repeat(), 'daily');
    expect(screen.queryByText('Repeat Every N Minutes')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Monday' })).toBeNull();
    const schedule = await savedSchedule(rpc, container);
    expect(schedule.daysOfWeek).toEqual(EVERY_DAY);
    expect(schedule.startTimesUtc).toEqual(['18:00']);
    expect(schedule.intervalMinutes).toBeNull();
    expect(schedule.config.recurrenceCadence).toBe('daily');
    expect(schedule.config).not.toHaveProperty('recurrenceDayOfMonth');
    expect(schedule.config).not.toHaveProperty('spawnAheadMinutes');
    expect(schedule.config.startTime).toBeUndefined();
    // Enabling the editor selects "Recurring Schedule Only", as it always did.
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('Monthly saves the chosen day of the month and warns about short months', async () => {
    const rpc = spyScheduleRpc();
    const { container } = mount();
    choose(repeat(), 'monthly');
    const day = screen.getByLabelText('Day Of Month') as HTMLSelectElement;
    expect(day.tagName).toBe('SELECT');
    expect(
      within(day)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(Array.from({ length: 31 }, (_, index) => String(index + 1)));
    choose(day, '12');
    expect(screen.queryByText(/Is Skipped/)).toBeNull();
    choose(day, '31');
    expect(screen.getByText('Counted In UTC. A Month With No Day 31 Is Skipped.')).toBeVisible();
    expect(screen.queryByText('Repeat Every N Minutes')).toBeNull();
    const schedule = await savedSchedule(rpc, container);
    expect(schedule.daysOfWeek).toEqual(EVERY_DAY);
    expect(schedule.intervalMinutes).toBeNull();
    expect(schedule.startTimesUtc).toEqual(['18:00']);
    expect(schedule.config).toMatchObject({
      recurrenceCadence: 'monthly',
      recurrenceDayOfMonth: 31,
    });
  });

  it('Weekly on the event day and time is the old Repeats Weekly payload', async () => {
    const rpc = spyScheduleRpc();
    const { container } = mount();
    choose(repeat(), 'weekly');
    expect(screen.getByRole('switch', { name: "Use This Event's Day And Time" })).toBeChecked();
    expect(screen.queryByText('Repeat Every N Minutes')).toBeNull();
    const schedule = await savedSchedule(rpc, container);
    expect(schedule.daysOfWeek).toHaveLength(1);
    expect(schedule.startTimesUtc).toHaveLength(1);
    expect(schedule.startTimesUtc[0]).toMatch(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
    expect(schedule.intervalMinutes).toBeNull();
    expect(schedule.config).toMatchObject({
      recurrenceCadence: 'weekly',
      spawnAheadMinutes: RESTART_WEEKLY_MINUTES,
    });
    // Spawner-owned: the first instance is never made by hand as well.
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.success).toHaveBeenCalledWith('Saved. This Event Repeats Every Week.');
  });

  it('Weekly with chosen days keeps the interval mode, and leaving Weekly takes it away', async () => {
    const rpc = spyScheduleRpc();
    const { container } = mount();
    choose(repeat(), 'weekly');
    fireEvent.click(screen.getByRole('switch', { name: "Use This Event's Day And Time" }));
    // The editor opens prefilled with this event's own day and time.
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Repeat Every N Minutes'));
    // The interval is live under Weekly...
    expect(screen.getByRole('spinbutton', { name: 'Repeat Interval In Minutes' })).toHaveValue(60);
    // ...and unreachable the moment the cadence is Monthly or Daily.
    choose(repeat(), 'monthly');
    expect(screen.queryByText('Repeat Every N Minutes')).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: 'Repeat Interval In Minutes' })).toBeNull();
    const schedule = await savedSchedule(rpc, container);
    expect(schedule.intervalMinutes).toBeNull();
    expect(schedule.startTimesUtc).toHaveLength(1);
    expect(schedule.startTimesUtc[0]).toMatch(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
    expect(schedule.daysOfWeek).toEqual(EVERY_DAY);
    expect(schedule.config.recurrenceCadence).toBe('monthly');
  });

  it('Weekly with an interval still saves the interval', async () => {
    const rpc = spyScheduleRpc();
    const { container } = mount();
    choose(repeat(), 'weekly');
    fireEvent.click(screen.getByRole('switch', { name: "Use This Event's Day And Time" }));
    const friday = screen.getByRole('button', { name: 'Friday' });
    if (friday.getAttribute('aria-pressed') !== 'true') fireEvent.click(friday);
    fireEvent.click(screen.getByLabelText('Repeat Every N Minutes'));
    const schedule = await savedSchedule(rpc, container);
    expect(schedule).toMatchObject({ startTimesUtc: [], intervalMinutes: 60 });
    expect(schedule.daysOfWeek).toContain(5);
    expect(schedule.config.recurrenceCadence).toBe('weekly');
    expect(schedule.config).not.toHaveProperty('spawnAheadMinutes');
  });

  it('turning recurrence off again returns the start mode to a one-off', async () => {
    const rpc = spyScheduleRpc();
    const { container } = mount();
    choose(repeat(), 'daily');
    expect(screen.getByRole('option', { name: 'Recurring Schedule Only' })).toBeInTheDocument();
    choose(repeat(), 'none');
    expect(screen.queryByRole('option', { name: 'Recurring Schedule Only' })).toBeNull();
    await submit(container);
    expect(rpc).not.toHaveBeenCalledWith('fn_upsert_tournament_schedule', expect.anything());
  });

  it('is not offered on fixed-seat formats', () => {
    mount('spin');
    expect(screen.queryByLabelText('Repeat')).toBeNull();
  });
});

describe('the add-on rule says what the engine does', () => {
  it('prints one 60-second period that opens when the rebuy period closes', () => {
    mount('mtt_rebuy');
    expect(screen.getByText('One 60-Second Period When The Rebuy Period Closes')).toBeVisible();
    expect(screen.getByText(/Play Pauses After The Current Hand/)).toHaveTextContent('No Rake');
    expect(screen.queryByText('1 Minute After Rebuy Period')).toBeNull();
  });
});

describe('chat stays off for multi-table tournaments', () => {
  it('sends banChat true and shows the rule locked', async () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Show Advanced Options' }));
    expect(screen.getByText('Chat: Off')).toBeVisible();
    expect(screen.queryByRole('switch', { name: /Chat/ })).toBeNull();
    const config = await submit(container);
    expect(config.banChat).toBe(true);
  });
});
