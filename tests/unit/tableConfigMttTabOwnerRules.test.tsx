/**
 * THE CREATE-TABLE MTT TAB, RENDERED (owner requirements, 2026-09-20).
 *
 * The pure mappers are pinned elsewhere (TournamentFromTableConfig,
 * mttEntryRulesAndPrizeStyleAreIndependent, quarterHourStartSelect,
 * tableConfigRecurrence). This renders the real page on the MTT tab and drives
 * it the way an owner would, then reads what Start actually hands the
 * services: nothing reaches Supabase, the two creation calls are spied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
const access = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/supabase', () => {
  const chain = (): unknown => {
    const handler: ProxyHandler<object> = {
      get: (_t, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
        return () => new Proxy({}, handler);
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => chain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    getAuthUser: vi.fn().mockResolvedValue({ data: { user: null } }),
  };
});
vi.mock('../../src/core/MasterBus', () => {
  const channel = {
    on() {
      return channel;
    },
    subscribe() {
      return channel;
    },
  };
  return {
    masterBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      getOrCreateChannel: vi.fn(() => channel),
      removeRegisteredChannel: vi.fn(),
    },
  };
});
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
}));
vi.mock('../../src/services/GameAccessService', () => ({ fetchGameCreationAccess: access }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toast }));
// The cash flow is never on screen on the MTT tab; keep its dependencies out.
vi.mock('../../src/components/cash/CashGameCreateFlow', () => ({ default: () => null }));

import TableConfigPage from '../../src/pages/TableConfigPage';
import { tournamentService } from '../../src/services/TournamentService';
import { tournamentScheduleService } from '../../src/services/TournamentScheduleService';
import { MTT_ENTRY_WINDOW_REQUIRED } from '../../src/lib/tournamentFromTableConfig';
import { localDateValue } from '../../src/lib/quarterHourStartSelect';

type Created = Parameters<typeof tournamentService.createTournament>[1];

let create: ReturnType<typeof vi.spyOn>;
let upsert: ReturnType<typeof vi.spyOn>;
const onExit = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  access.mockResolvedValue({ allowed: true, unionId: null, reason: 'ok' });
  create = vi
    .spyOn(tournamentService, 'createTournament')
    .mockResolvedValue({ id: 't-1' } as never);
  upsert = vi.spyOn(tournamentScheduleService, 'upsert').mockResolvedValue('s-1');
  try {
    localStorage.clear();
  } catch {
    /* storage unavailable */
  }
});

afterEach(() => {
  cleanup();
  create.mockRestore();
  upsert.mockRestore();
});

async function openMttTab() {
  render(
    <MemoryRouter>
      <TableConfigPage clubIdOverride="club-1" gameTypeOverride="nlh" embedded onExit={onExit} />
    </MemoryRouter>
  );
  await waitFor(() => expect(access).toHaveBeenCalled());
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'MTT' }));
}

const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const choose = (name: string, value: string) =>
  fireEvent.change(select(name), { target: { value } });
const optionLabels = (name: string) =>
  within(select(name))
    .getAllByRole('option')
    .map((o) => o.textContent);

async function start() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  });
}

const created = (): Created => create.mock.calls[0][1] as Created;

describe('the mode tabs', () => {
  it('say which format is chosen', async () => {
    await openMttTab();
    expect(screen.getByRole('button', { name: 'MTT' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'SNG' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Regular' }).getAttribute('aria-pressed')).toBe(
      'false'
    );
    expect(screen.getByRole('group', { name: 'Game Format' })).toBeTruthy();
  });
});

describe('chat is banned on an MTT', () => {
  it('shows the rule locked On and creates the event with chat banned', async () => {
    await openMttTab();
    const banChat = screen.getByRole('switch', { name: 'Ban Chat' }) as HTMLInputElement;
    expect(banChat.checked).toBe(true);
    expect(banChat.disabled).toBe(true);
    await start();
    expect(create).toHaveBeenCalledTimes(1);
    expect(created().banChat).toBe(true);
  });

  it('leaves the Sit And Go switch editable and off by default', async () => {
    await openMttTab();
    fireEvent.click(screen.getByRole('button', { name: 'SNG' }));
    const banChat = screen.getByRole('switch', { name: 'Ban Chat' }) as HTMLInputElement;
    expect(banChat.checked).toBe(false);
    expect(banChat.disabled).toBe(false);
  });
});

describe('Entry Rules and Prize Style are two controls', () => {
  it('offers exactly the supported choices', async () => {
    await openMttTab();
    expect(optionLabels('Entry Rules')).toEqual(['Freezeout', 'Rebuy', 'Re-Entry']);
    expect(optionLabels('Prize Style')).toEqual([
      'Regular',
      'Bounty',
      'Progressive Bounty',
      'Mystery Bounty',
    ]);
    expect(screen.queryByRole('switch', { name: 'KO Bounty' })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Number Of Rebuys/Re-Entries' })).toBeNull();
  });

  it('changing one never changes the other, all the way to the created event', async () => {
    await openMttTab();
    choose('Entry Rules', 'reentry');
    choose('Prize Style', 'progressive_bounty');
    expect(select('Entry Rules').value).toBe('reentry');
    choose('Entry Rules', 'freezeout');
    expect(select('Prize Style').value).toBe('progressive_bounty');
    choose('Entry Rules', 'reentry');
    choose('Prize Style', 'mystery_bounty');
    choose('Prize Style', 'progressive_bounty');
    expect(select('Entry Rules').value).toBe('reentry');
    expect(screen.getByRole('slider', { name: 'Number Of Re-Entries' })).toBeTruthy();

    await start();
    const c = created();
    expect(c.type).toBe('progressive_bounty');
    expect(c.bountyConfig?.bountyType).toBe('progressive');
    expect(c.isRebuy).toBe(false);
    expect(c.isReentry).toBe(true);
    expect(c.maxReentries).toBe(3);
    expect(c.maxRebuys).toBeUndefined();
    expect(c.maxPlayers).toBeNull();
  });

  it('a Freeroll locks Prize Style to Regular and keeps its Free Buy lock', async () => {
    await openMttTab();
    choose('Prize Style', 'bounty');
    fireEvent.click(screen.getByRole('switch', { name: 'Custom Buy-In' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Buy-In' }), {
      target: { value: '0' },
    });
    expect(screen.getByTestId('free-buy-lock')).toBeTruthy();
    expect(select('Prize Style').disabled).toBe(true);
    expect(select('Prize Style').value).toBe('regular');
    expect(screen.queryByRole('combobox', { name: 'Entry Rules' })).toBeNull();
  });
});

describe('the add-on break length', () => {
  it('is not offered on a paid MTT, and a paid event sends one minute', async () => {
    await openMttTab();
    expect(screen.getByRole('slider', { name: 'Add-On' })).toBeTruthy();
    expect(screen.queryByRole('slider', { name: 'Add-On Break Length' })).toBeNull();
    await start();
    expect(created().addOnAvailable).toBe(true);
    expect(created().addonBreakMinutes).toBe(1);
  });

  it('stays on a Free Buy, where the window really uses it', async () => {
    await openMttTab();
    fireEvent.click(screen.getByRole('switch', { name: 'Custom Buy-In' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Buy-In' }), {
      target: { value: '0' },
    });
    const slider = screen.getByRole('slider', { name: 'Add-On Break Length' });
    fireEvent.change(slider, { target: { value: '6' } });
    await start();
    expect(created().addonBreakMinutes).toBe(6);
  });
});

describe('a Rebuy event needs late registration to close', () => {
  it('refuses a 0 level before anything is created, and says so beside the slider', async () => {
    await openMttTab();
    expect(select('Entry Rules').value).toBe('rebuy');
    fireEvent.change(screen.getByRole('slider', { name: 'Late Registration' }), {
      target: { value: '0' },
    });
    expect(screen.getByRole('alert').textContent).toBe(MTT_ENTRY_WINDOW_REQUIRED);
    await start();
    expect(toast.error).toHaveBeenCalledWith(MTT_ENTRY_WINDOW_REQUIRED);
    expect(create).not.toHaveBeenCalled();

    choose('Entry Rules', 'freezeout');
    expect(screen.queryByText(MTT_ENTRY_WINDOW_REQUIRED)).toBeNull();
    await start();
    expect(create).toHaveBeenCalledTimes(1);
    expect(created().lateRegistrationLevels).toBe(0);
  });
});

describe('the start date and time are dropdowns', () => {
  it('replaces the native picker and hands the service the same local instant', async () => {
    await openMttTab();
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(optionLabels('Start Time')).toHaveLength(97); // No Time + 96 quarter hours
    const day = localDateValue(new Date(Date.now() + 3 * 86_400_000));
    choose('Start Date', day);
    choose('Start Time', '19:15');
    await start();
    const when = created().startTime as Date;
    expect(localDateValue(when)).toBe(day);
    expect([when.getHours(), when.getMinutes()]).toEqual([19, 15]);
  });

  it('refuses half a start instead of quietly dropping it', async () => {
    await openMttTab();
    choose('Start Date', localDateValue(new Date(Date.now() + 3 * 86_400_000)));
    await start();
    expect(toast.error).toHaveBeenCalledWith(
      'Choose Both A Start Date And A Start Time, Or Clear Both.'
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a start that has already passed today, as the club modal does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 15, 0));
    try {
      await openMttTab();
      choose('Start Date', '2026-10-15');
      choose('Start Time', '09:00');
      await start();
      expect(toast.error).toHaveBeenCalledWith('Pick A Start Time In The Future');
      expect(create).not.toHaveBeenCalled();
      choose('Start Time', '16:00');
      await start();
      expect(create).toHaveBeenCalledTimes(1);
      expect((created().startTime as Date).getHours()).toBe(16);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a remembered off-grid start selected rather than moving it', async () => {
    const day = localDateValue(new Date(Date.now() + 5 * 86_400_000));
    localStorage.setItem('ca_saved_start_time_club-1', `${day}T19:05`);
    await openMttTab();
    await waitFor(() => expect(select('Start Time').value).toBe('19:05'));
    expect(select('Start Date').value).toBe(day);
    expect(optionLabels('Start Time')).toContain('7:05 PM');
  });
});

describe('Repeat: Does Not Repeat, Daily, Weekly or Monthly', () => {
  it('is one control and replaces the weekly-only switch', async () => {
    await openMttTab();
    expect(optionLabels('Repeat')).toEqual(['Does Not Repeat', 'Daily', 'Weekly', 'Monthly']);
    expect(screen.queryByRole('switch', { name: 'Tournament Schedule' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Days Of The Week' })).toBeNull();
  });

  it('weekly offers days and both modes', async () => {
    await openMttTab();
    choose('Repeat', 'weekly');
    expect(screen.getByRole('group', { name: 'Days Of The Week' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'How This Schedule Repeats' })).toBeTruthy();
  });

  it('monthly asks for a day of the month, warns about short months, and saves the cadence keys', async () => {
    await openMttTab();
    choose('Repeat', 'monthly');
    expect(optionLabels('Day Of Month')).toHaveLength(31);
    // Set times only, on every day: no day buttons and no interval mode.
    expect(screen.queryByRole('group', { name: 'Days Of The Week' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'How This Schedule Repeats' })).toBeNull();
    choose('Day Of Month', '31');
    expect(screen.getByText('Months With Fewer Than 31 Days Are Skipped.')).toBeTruthy();
    choose('Start Time 1 (UTC)', '19:30');

    await start();
    expect(upsert).toHaveBeenCalledTimes(1);
    const saved = upsert.mock.calls[0][0] as Parameters<typeof tournamentScheduleService.upsert>[0];
    expect(saved.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(saved.startTimesUtc).toEqual(['19:30']);
    expect(saved.intervalMinutes).toBeNull();
    expect(saved.config.recurrenceCadence).toBe('monthly');
    expect(saved.config.recurrenceDayOfMonth).toBe(31);
    expect(saved.config.banChat).toBe(true);
    expect(saved.config).not.toHaveProperty('startTime');
    // No start date picked: only the schedule is created.
    expect(create).not.toHaveBeenCalled();
  });

  it('daily saves every day with the daily cadence', async () => {
    await openMttTab();
    choose('Repeat', 'daily');
    expect(screen.queryByRole('combobox', { name: 'Day Of Month' })).toBeNull();
    await start();
    const saved = upsert.mock.calls[0][0] as Parameters<typeof tournamentScheduleService.upsert>[0];
    expect(saved.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(saved.config.recurrenceCadence).toBe('daily');
    expect(saved.config).not.toHaveProperty('recurrenceDayOfMonth');
  });
});

describe('paid places', () => {
  it('a new MTT is offered 10 to 15 percent of the field', async () => {
    await openMttTab();
    const payout = screen
      .getAllByRole('combobox')
      .find((el) => within(el).queryByRole('option', { name: 'Top 10% Of Field' }))!;
    expect(
      within(payout)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['Top 10% Of Field', 'Top 15% Of Field (Standard)']);
  });
});

describe('help on the tournament form', () => {
  it.each([
    'VIP Only',
    'Hide Club Name',
    'Prize Style',
    'Entry Rules',
    'Table Size',
    'Action Time',
    'Buy-In',
    'Starting Chips',
    'Blinds Up',
    'Late Registration',
    'Start Date',
    'Start Time',
    'Repeat',
  ])('%s has a help button that opens by click or keyboard', async (label) => {
    await openMttTab();
    const help = screen.getByRole('button', { name: `Help: ${label}` });
    expect(help.hasAttribute('title')).toBe(false);
    fireEvent.click(help);
    expect(screen.getByRole('tooltip').textContent?.length).toBeGreaterThan(10);
  });

  it('Restart Every, Rebuy Cost and Add-On Cost have help where they appear', async () => {
    await openMttTab();
    fireEvent.click(screen.getByRole('switch', { name: 'Restart The Tournament' }));
    expect(screen.getByRole('button', { name: 'Help: Restart Every' })).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Custom Buy-In' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Buy-In' }), {
      target: { value: '0' },
    });
    expect(screen.getByRole('button', { name: 'Help: Rebuy Cost' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Help: Add-On Cost' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Help: Add-On Break Length' })).toBeTruthy();
  });
});

describe('no entry ceiling on an MTT', () => {
  it('shows no maximum player field and creates with no cap', async () => {
    await openMttTab();
    expect(screen.queryByText(/Max(imum)? Players/i)).toBeNull();
    await start();
    expect(created().maxPlayers).toBeNull();
  });
});
