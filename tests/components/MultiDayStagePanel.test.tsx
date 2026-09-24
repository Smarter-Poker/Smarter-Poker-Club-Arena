/**
 * The multi-day stage panel on the tournament Overview (design section 7).
 *
 * Two gates, both required: the capability registry says
 * tournament.multi_day.single_flight is available, AND fn_tournament_stage_view
 * reports a sealed plan for this event. Either missing, nothing multi-day
 * renders. With both: the schedule in the plan's zone, the caller's OWN bag,
 * the post-bag chip leaders, and after the resume "Your Day 2 Seat" with an
 * Open Table button that navigates only when tapped (CLAUDE.md 10.6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { supabase } from '../../src/lib/supabase';
import MultiDayStagePanel from '../../src/components/tournament/details/MultiDayStagePanel';
import { resetPlatformCapabilityCache } from '../../src/hooks/usePlatformCapability';

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigateSpy,
}));

const T = 'a1000000-0000-4000-8000-000000000001';

const capability = (readiness: string, available: boolean) => ({
  id: 'tournament.multi_day.single_flight',
  version: 'multi-day-v1',
  title: 'Multi-Day Tournaments',
  scope: 'tournament',
  variants: [],
  compatibility: {},
  readiness,
  available,
});

const stages = [
  {
    stage_no: 1,
    day_no: 1,
    end_after_level: 12,
    scheduled_start_utc: null,
    schedule_generation: 1,
    state: 'bagged',
  },
  {
    stage_no: 2,
    day_no: 2,
    end_after_level: null,
    scheduled_start_utc: '2026-10-03T17:00:00Z',
    schedule_generation: 1,
    state: 'scheduled',
  },
];

const baggedView = {
  ok: true,
  tournament_id: T,
  status: 'BAGGED',
  plan: { rule_version: 'multi-day-v1', time_zone: 'America/Chicago', stage_count: 2 },
  stages,
  current_stage: { stage_no: 1, day_no: 1, state: 'bagged' },
  next_start: {
    stage_no: 2,
    day_no: 2,
    scheduled_start_utc: '2026-10-03T17:00:00Z',
    time_zone: 'America/Chicago',
    schedule_generation: 1,
    state: 'scheduled',
  },
  bag: { stage_no: 1, day_no: 1, players: 6 },
  my_bag: { stage_no: 1, day_no: 1, stack: 12000, bounty_head: 100 },
  my_seat: null,
  chip_leaders: [
    { rank: 1, display_name: 'Lucky Seven', stack: 20000 },
    { rank: 2, display_name: 'Grinder', stack: 12000 },
  ],
};

const resumedView = {
  ...baggedView,
  status: 'RUNNING',
  stages: [
    { ...stages[0], state: 'closed' },
    { ...stages[1], state: 'running' },
  ],
  current_stage: { stage_no: 2, day_no: 2, state: 'running' },
  next_start: null,
  my_seat: {
    stage_no: 2,
    day_no: 2,
    table_id: 'd2000000-0000-4000-8000-000000000001',
    table_name: 'Table 4',
    seat_number: 7,
  },
};

function answer(caps: unknown, view: unknown) {
  vi.mocked(supabase.rpc).mockImplementation(((fn: string) => {
    if (fn === 'fn_platform_capabilities') return Promise.resolve({ data: caps, error: null });
    if (fn === 'fn_tournament_stage_view') return Promise.resolve({ data: view, error: null });
    return Promise.resolve({ data: null, error: null });
  }) as never);
}

function mount(status = 'BAGGED') {
  return render(
    <MemoryRouter>
      <MultiDayStagePanel tournamentId={T} status={status} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  resetPlatformCapabilityCache();
  navigateSpy.mockReset();
  // 2026-10-01: the start is inside six days, so it prints as a weekday.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-01T12:00:00Z') });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(supabase.rpc).mockImplementation((() =>
    Promise.resolve({ data: null, error: null })) as never);
});

describe('the two gates', () => {
  it('shows nothing while the capability is below deployed, and never asks for the view', async () => {
    answer([capability('tested', false)], baggedView);
    const { container } = mount();
    await waitFor(() =>
      expect(vi.mocked(supabase.rpc)).toHaveBeenCalledWith('fn_platform_capabilities')
    );
    await Promise.resolve();
    expect(container.textContent).toBe('');
    expect(vi.mocked(supabase.rpc)).not.toHaveBeenCalledWith(
      'fn_tournament_stage_view',
      expect.anything()
    );
  });

  it('shows nothing when the registry could not be read', async () => {
    answer(null, baggedView);
    const { container } = mount();
    await waitFor(() =>
      expect(vi.mocked(supabase.rpc)).toHaveBeenCalledWith('fn_platform_capabilities')
    );
    await Promise.resolve();
    expect(container.textContent).toBe('');
  });

  it('shows nothing for an event with no sealed plan, even with the capability on', async () => {
    answer([capability('deployed', true)], {
      ok: true,
      tournament_id: T,
      status: 'RUNNING',
      plan: null,
    });
    const { container } = mount('RUNNING');
    await waitFor(() =>
      expect(vi.mocked(supabase.rpc)).toHaveBeenCalledWith('fn_tournament_stage_view', {
        p_tournament_id: T,
      })
    );
    await Promise.resolve();
    expect(container.textContent).toBe('');
  });
});

describe('a bagged event', () => {
  it('prints the schedule in the plan zone, only the caller bag, and the leaders', async () => {
    answer([capability('deployed', true)], baggedView);
    mount();
    expect(await screen.findByText('Stage Schedule')).toBeTruthy();
    expect(screen.getByText('Day 1 Complete')).toBeTruthy();
    expect(screen.getByText('Day 2 Starts Sat 12:00 PM CDT')).toBeTruthy();
    expect(screen.getByText('Ends After Level 12')).toBeTruthy();
    expect(screen.getByText('Your Bag')).toBeTruthy();
    expect(screen.getByText(`${(12000).toLocaleString()} Chips`)).toBeTruthy();
    expect(screen.getByText('Bounty 100')).toBeTruthy();
    expect(screen.getByText('Lucky Seven')).toBeTruthy();
    expect(screen.getByText((20000).toLocaleString())).toBeTruthy();
    expect(screen.queryByText('Open Table')).toBeNull();
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('the Day 2 seat never moves the player', () => {
  it('names the chair and navigates only when Open Table is tapped', async () => {
    answer([capability('production_verified', true)], resumedView);
    mount('RUNNING');
    expect(await screen.findByText('Your Day 2 Seat')).toBeTruthy();
    expect(screen.getByText('Table 4, Seat 7')).toBeTruthy();
    // Rendering, re-reading and waiting never navigate.
    await Promise.resolve();
    expect(navigateSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Table' }));
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith('/table/d2000000-0000-4000-8000-000000000001');
    // The leaders are a between-days list; once Day 2 runs they are gone.
    expect(screen.queryByText('Chip Leaders')).toBeNull();
  });
});
