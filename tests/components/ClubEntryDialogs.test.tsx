import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../src/components/common/Toast';
import CreateClubModal from '../../src/components/modals/CreateClubModal';
import FindPlayerModal from '../../src/components/modals/FindPlayerModal';
import JoinClubModal from '../../src/components/modals/JoinClubModal';

function surface(node: React.ReactNode) {
  return render(
    <MemoryRouter>
      <ToastProvider>{node}</ToastProvider>
    </MemoryRouter>
  );
}

describe('Club Entry dialog runtime surfaces', () => {
  it('mounts and closes Create Club through its semantic control', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    surface(<CreateClubModal isOpen onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Create A Club' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mounts Find Player, explains its access boundary, and closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    surface(<FindPlayerModal isOpen onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Find A Player' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Access Rules' }));
    expect(screen.getByLabelText('Player Search Access Rules')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByLabelText('Player Search Access Rules')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mounts Join Club with its import paths and closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    surface(<JoinClubModal isOpen onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Join A Club' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Paste Invitation' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Scan QR Image' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
