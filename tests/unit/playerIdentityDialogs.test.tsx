import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UserProfileEdit from '../../src/components/social/UserProfileEdit';
import PlayerBlockModal from '../../src/components/social/PlayerBlockModal';

const profile = {
  id: 'player-1',
  username: 'riverking',
  displayName: 'River King',
  avatarUrl: 'https://example.com/original.svg',
  bio: 'Mixed games.',
  tags: ['Grinder'],
};

afterEach(cleanup);

describe('profile editor account mutation states', () => {
  it('stays open and reports a rejected profile update', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockRejectedValue(new Error('Profile write failed'));
    render(<UserProfileEdit isOpen onClose={onClose} initialData={profile} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Profile write failed');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit Profile' })).toBeInTheDocument();
  });

  it('submits a keyboard-operable avatar choice and closes after success', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<UserProfileEdit isOpen onClose={onClose} initialData={profile} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose Profile Avatar' }));
    const choices = screen.getAllByRole('button', { name: 'Select This Avatar' });
    fireEvent.click(choices[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].avatarUrl).toContain('seed=Aneka');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('public profile block confirmation', () => {
  it('associates the reason field and submits the entered reason', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<PlayerBlockModal playerName="Opponent" onConfirm={onConfirm} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Reason (Optional)'), {
      target: { value: 'Repeated harassment' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Block Player' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Repeated harassment'));
  });

  it('can be dismissed with Escape when no request is in flight', () => {
    const onCancel = vi.fn();
    render(<PlayerBlockModal playerName="Opponent" onConfirm={vi.fn()} onCancel={onCancel} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('stays recoverable when the block request rejects', async () => {
    const onCancel = vi.fn();
    render(
      <PlayerBlockModal
        playerName="Opponent"
        onConfirm={vi.fn().mockRejectedValue(new Error('Block request failed'))}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Block Player' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Block request failed');
    expect(screen.getByRole('dialog', { name: 'Block Opponent?' })).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
