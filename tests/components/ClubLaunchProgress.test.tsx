import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClubLaunchProgress, {
  type ClubLaunchTask,
} from '../../src/components/club/ClubLaunchProgress';

const makeTask = (id: string, complete: boolean): ClubLaunchTask => ({
  id,
  label: `Task ${id}`,
  detail: `Finish Task ${id}`,
  complete,
  actionLabel: `Start Task ${id}`,
  onAction: vi.fn(),
});

describe('ClubLaunchProgress Completion Visibility', () => {
  beforeEach(() => localStorage.clear());

  it('shows the opening checklist while a launch step remains', () => {
    render(
      <ClubLaunchProgress
        clubId="club-a"
        viewerId="owner-a"
        clubName="Shark Club"
        openingBank={100_000}
        tasks={[makeTask('One', true), makeTask('Two', false)]}
      />
    );

    expect(screen.getByText('New Club Opening Checklist')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('removes the checklist once every launch step is complete', () => {
    const { container } = render(
      <ClubLaunchProgress
        clubId="club-a"
        viewerId="owner-a"
        clubName="Shark Club"
        openingBank={100_000}
        tasks={[makeTask('One', true), makeTask('Two', true)]}
      />
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('New Club Opening Checklist')).not.toBeInTheDocument();
  });

  it('removes the checklist when every remaining optional step was skipped', () => {
    localStorage.setItem('club-launch-skips:club-a:owner-a', JSON.stringify(['Two']));

    const { container } = render(
      <ClubLaunchProgress
        clubId="club-a"
        viewerId="owner-a"
        clubName="Shark Club"
        openingBank={100_000}
        tasks={[makeTask('One', true), makeTask('Two', false)]}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('does not hide an unfinished checklist because of percentage rounding', () => {
    const tasks = Array.from({ length: 201 }, (_, index) =>
      makeTask(String(index + 1), index < 200)
    );

    render(
      <ClubLaunchProgress
        clubId="club-a"
        viewerId="owner-a"
        clubName="Shark Club"
        openingBank={100_000}
        tasks={tasks}
      />
    );

    expect(screen.getByText('New Club Opening Checklist')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '99');
  });

  it('does not leak skips between same-named clubs or different operators', () => {
    localStorage.setItem('club-launch-skips:club-a:owner-a', JSON.stringify(['Two']));

    const tasks = [makeTask('One', true), makeTask('Two', false)];
    const { container, rerender } = render(
      <ClubLaunchProgress
        key="club-a:owner-a"
        clubId="club-a"
        viewerId="owner-a"
        clubName="Shared Name"
        openingBank={100_000}
        tasks={tasks}
      />
    );
    expect(container).toBeEmptyDOMElement();

    rerender(
      <ClubLaunchProgress
        key="club-b:owner-a"
        clubId="club-b"
        viewerId="owner-a"
        clubName="Shared Name"
        openingBank={100_000}
        tasks={tasks}
      />
    );
    expect(screen.getByText('New Club Opening Checklist')).toBeInTheDocument();

    rerender(
      <ClubLaunchProgress
        key="club-a:owner-b"
        clubId="club-a"
        viewerId="owner-b"
        clubName="Shared Name"
        openingBank={100_000}
        tasks={tasks}
      />
    );
    expect(screen.getByText('New Club Opening Checklist')).toBeInTheDocument();
  });

  it('survives valid JSON with the wrong shape instead of crashing the lobby', () => {
    localStorage.setItem('club-launch-skips:club-a:owner-a', JSON.stringify({ Two: true }));

    render(
      <ClubLaunchProgress
        clubId="club-a"
        viewerId="owner-a"
        clubName="Club A"
        openingBank={100_000}
        tasks={[makeTask('One', true), makeTask('Two', false)]}
      />
    );

    expect(screen.getByText('New Club Opening Checklist')).toBeInTheDocument();
  });
});
