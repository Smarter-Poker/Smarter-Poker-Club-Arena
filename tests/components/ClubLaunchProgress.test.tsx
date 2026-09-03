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
        clubName="Shark Club"
        openingBank={100_000}
        tasks={[makeTask('One', true), makeTask('Two', true)]}
      />
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('New Club Opening Checklist')).not.toBeInTheDocument();
  });

  it('removes the checklist when every remaining optional step was skipped', () => {
    localStorage.setItem('club-launch-skips:Shark Club', JSON.stringify(['Two']));

    const { container } = render(
      <ClubLaunchProgress
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

    render(<ClubLaunchProgress clubName="Shark Club" openingBank={100_000} tasks={tasks} />);

    expect(screen.getByText('New Club Opening Checklist')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '99');
  });
});
