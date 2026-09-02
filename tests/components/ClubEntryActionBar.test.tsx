import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ClubEntryActionBar from '../../src/components/home/ClubEntryActionBar';

describe('ClubEntryActionBar interactions', () => {
  it('routes each available control exactly once', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onFind = vi.fn();
    const onJoin = vi.fn();
    render(
      <ClubEntryActionBar
        flags={{ create_club: true, find_player: true, join_club: true }}
        onCreate={onCreate}
        onFind={onFind}
        onJoin={onJoin}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Create A Club' }));
    await user.click(screen.getByRole('button', { name: 'Find A Player' }));
    await user.click(screen.getByRole('button', { name: 'Join A Club' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onFind).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it('makes rollout-disabled controls non-interactive', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <ClubEntryActionBar
        flags={{ create_club: false, find_player: true, join_club: true }}
        onCreate={onCreate}
        onFind={() => undefined}
        onJoin={() => undefined}
      />
    );

    const create = screen.getByRole('button', { name: 'Create A Club' });
    expect(create).toBeDisabled();
    await user.click(create);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
