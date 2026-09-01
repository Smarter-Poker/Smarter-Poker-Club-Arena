import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('../../src/components/common/confirmDialog', () => ({
  confirmDialog: mocks.confirm,
}));

import { ContractHistoryDialog, EditGameDialog } from '../../src/pages/GameManagementPage';

const game = {
  id: 'game-1',
  kind: 'table' as const,
  name: 'Friday Cash',
  status: 'waiting',
  clubId: 'club-1',
  hostName: 'Shark Club',
  variant: 'NLH',
  players: 0,
  maxPlayers: 9,
  startTime: null,
  smallBlind: 1,
  bigBlind: 2,
  minBuyIn: 40,
  maxBuyIn: 200,
  buyIn: 0,
  contract: {
    gameId: 'game-1',
    version: 2,
    contractHash: 'abcdef1234567890',
    publishedAt: '2026-09-01T12:00:00Z',
    changeReason: 'operator_update',
    contractLocked: false,
    readiness: {
      state: 'ready' as const,
      canStart: true,
      contractLocked: false,
      guaranteeEnforced: false,
      guaranteedPrize: 0,
      currentPrizePool: 0,
      overlayRequired: 0,
      bankType: null,
      bankBalance: 0,
      bankFloor: 0,
      otherLiveExposure: 0,
      shortBy: 0,
    },
  },
  lastCommand: null,
};

function EditHarness({ onSave = vi.fn() }: { onSave?: (patch: unknown) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open Editor
      </button>
      {open && (
        <EditGameDialog game={game} busy={false} onClose={() => setOpen(false)} onSave={onSave} />
      )}
    </>
  );
}

describe('Table Management dialogs', () => {
  beforeEach(() => {
    mocks.confirm.mockReset();
    mocks.confirm.mockResolvedValue(true);
  });

  it('announces the editor as a named modal and restores its trigger focus', async () => {
    const user = userEvent.setup();
    render(<EditHarness />);
    const opener = screen.getByRole('button', { name: 'Open Editor' });
    opener.focus();
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Edit Table' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-describedby', 'edit-game-description');
    await waitFor(() => expect(screen.getByLabelText('Game Name')).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('identifies cross-field errors inside the dialog and sends no invalid command', async () => {
    const onSave = vi.fn();
    render(<EditGameDialog game={game} busy={false} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Big Blind'), { target: { value: '0.5' } });
    fireEvent.submit(screen.getByRole('dialog'));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The big blind cannot be lower than the small blind.'
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('asks before Escape discards a changed editor', async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    render(<EditGameDialog game={game} busy={false} onClose={vi.fn()} onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Game Name'), { target: { value: 'Changed' } });
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Discard the unsaved game changes?' })
      )
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('makes contract history keyboard dismissible and gives empty history a status', async () => {
    const onClose = vi.fn();
    render(<ContractHistoryDialog game={game} versions={[]} loading={false} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Friday Cash' })).toHaveAttribute(
      'aria-modal',
      'true'
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'No Published Contract Revisions Were Returned.'
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
