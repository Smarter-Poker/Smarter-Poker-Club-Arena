import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reported = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: reported.reportError }));

import ClubLaunchProgress, {
  type ClubLaunchTask,
  useClubLaunchSkips,
} from '../../src/components/club/ClubLaunchProgress';

const KEY = 'club-launch-skips:club-a:owner-a';

const task = (
  id: string,
  overrides: Partial<ClubLaunchTask> = {}
): ClubLaunchTask & { onAction: ReturnType<typeof vi.fn> } => ({
  id,
  label: `Task ${id}`,
  detail: `Finish Task ${id}`,
  complete: false,
  optional: true,
  actionLabel: `Start Task ${id}`,
  ...overrides,
  onAction: vi.fn(),
});

const mount = (tasks: ClubLaunchTask[]) =>
  render(
    <ClubLaunchProgress
      clubId="club-a"
      viewerId="owner-a"
      clubName="Test Club"
      openingBank={100_000}
      tasks={tasks}
    />
  );

const row = (label: string) => screen.getByText(label).closest('article') as HTMLElement;

describe('opening checklist skip rules', () => {
  beforeEach(() => {
    localStorage.clear();
    reported.reportError.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('draws Skip on optional steps only, never on the required setup wizard', () => {
    mount([task('Wizard', { optional: false }), task('Picture')]);

    expect(within(row('Task Wizard')).queryByRole('button', { name: /skip/i })).toBeNull();
    expect(
      within(row('Task Picture')).getByRole('button', { name: 'Skip Task Picture' })
    ).toBeTruthy();
    expect(within(row('Task Wizard')).getByText('Required · Finish Task Wizard')).toBeTruthy();
  });

  it('ignores a stored skip for a required step, so an older skip cannot lock the wizard away', () => {
    localStorage.setItem(KEY, JSON.stringify(['Wizard']));
    const wizard = task('Wizard', { optional: false });
    mount([wizard, task('Done', { complete: true })]);

    const start = within(row('Task Wizard')).getByRole('button', { name: 'Start Task Wizard' });
    expect(start).not.toBeDisabled();
    fireEvent.click(start);
    expect(wizard.onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Skipped')).toBeNull();
  });

  it('keeps a skipped step actionable and lets the skip be undone', () => {
    const picture = task('Picture');
    mount([task('Wizard', { optional: false }), picture]);

    fireEvent.click(screen.getByRole('button', { name: 'Skip Task Picture' }));
    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['Picture']);

    const skippedRow = row('Task Picture');
    expect(within(skippedRow).getByText('Skipped')).toBeTruthy();
    const action = within(skippedRow).getByRole('button', { name: 'Start Task Picture' });
    expect(action).not.toBeDisabled();
    fireEvent.click(action);
    expect(picture.onAction).toHaveBeenCalledTimes(1);

    fireEvent.click(within(skippedRow).getByRole('button', { name: 'Undo Skip Task Picture' }));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(within(row('Task Picture')).getByText('Finish Task Picture')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip Task Picture' })).toBeTruthy();
  });

  it('states completed and skipped counts separately and never counts a skip as progress', () => {
    localStorage.setItem(KEY, JSON.stringify(['Two', 'Three']));
    mount([
      task('Wizard', { optional: false }),
      task('One', { complete: true }),
      task('Two'),
      task('Three'),
    ]);

    expect(screen.getByText('1 Of 4 Steps Complete · 2 Skipped')).toBeTruthy();
    expect(screen.queryByText(/3 Of 4/)).toBeNull();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  });

  it('renders nothing once every step is complete or validly skipped, and never as a 100% banner', () => {
    const tasks = [task('Wizard', { optional: false, complete: true }), task('One'), task('Two')];
    const { container } = mount(tasks);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33');

    fireEvent.click(screen.getByRole('button', { name: 'Skip Task One' }));
    expect(container).not.toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole('button', { name: 'Skip Task Two' }));

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('100%')).toBeNull();
  });

  it('stays open while the required step is unfinished, however many steps are skipped', () => {
    localStorage.setItem(KEY, JSON.stringify(['Wizard', 'One']));
    const { container } = mount([task('Wizard', { optional: false }), task('One')]);

    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByText('0 Of 2 Steps Complete · 1 Skipped')).toBeTruthy();
  });

  it('reports a failed storage write and still resolves the step for this session', () => {
    const failure = new Error('QuotaExceededError');
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw failure;
    });
    mount([task('Wizard', { optional: false }), task('Picture')]);

    fireEvent.click(screen.getByRole('button', { name: 'Skip Task Picture' }));

    expect(reported.reportError).toHaveBeenCalledWith(failure, 'ClubLaunchSkips.write_failed');
    expect(within(row('Task Picture')).getByText('Skipped')).toBeTruthy();
  });

  it('reports an unreadable store instead of swallowing it', () => {
    const failure = new Error('SecurityError');
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw failure;
    });
    mount([task('Wizard', { optional: false }), task('Picture')]);

    expect(reported.reportError).toHaveBeenCalledWith(failure, 'ClubLaunchSkips.read_failed');
    expect(screen.getByText('New Club Opening Checklist')).toBeTruthy();
  });

  it('resolves from the parent skip state when the lobby supplies it (single source)', () => {
    const skips = { skippedIds: ['Picture'], skip: vi.fn(), undoSkip: vi.fn() };
    /* Local storage says nothing is skipped; the parent says Picture is. The
       parent wins, and changes are handed back to it. */
    render(
      <ClubLaunchProgress
        clubId="club-a"
        viewerId="owner-a"
        clubName="Test Club"
        openingBank={100_000}
        tasks={[task('Wizard', { optional: false }), task('Picture'), task('Tagline')]}
        skips={skips}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Undo Skip Task Picture' }));
    expect(skips.undoSkip).toHaveBeenCalledWith('Picture');
    fireEvent.click(screen.getByRole('button', { name: 'Skip Task Tagline' }));
    expect(skips.skip).toHaveBeenCalledWith('Tagline');
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('useClubLaunchSkips', () => {
  beforeEach(() => {
    localStorage.clear();
    reported.reportError.mockClear();
  });

  it('never carries one club skips into the next club when the route changes', () => {
    localStorage.setItem('club-launch-skips:club-a:owner-a', JSON.stringify(['Picture']));
    const { result, rerender } = renderHook(
      ({ clubId }: { clubId: string }) => useClubLaunchSkips(clubId, 'owner-a'),
      { initialProps: { clubId: 'club-a' } }
    );
    expect(result.current.skippedIds).toEqual(['Picture']);

    rerender({ clubId: 'club-b' });
    expect(result.current.skippedIds).toEqual([]);

    act(() => result.current.skip('Tagline'));
    expect(result.current.skippedIds).toEqual(['Tagline']);
    expect(JSON.parse(localStorage.getItem('club-launch-skips:club-b:owner-a') || '[]')).toEqual([
      'Tagline',
    ]);
    expect(JSON.parse(localStorage.getItem('club-launch-skips:club-a:owner-a') || '[]')).toEqual([
      'Picture',
    ]);
  });

  it('touches no storage while the club is unknown', () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem');
    const { result } = renderHook(() => useClubLaunchSkips('', 'owner-a'));

    act(() => result.current.skip('Picture'));
    expect(result.current.skippedIds).toEqual([]);
    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
  });
});
