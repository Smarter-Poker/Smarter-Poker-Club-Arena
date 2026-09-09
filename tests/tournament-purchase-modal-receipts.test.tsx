import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RebuyModal } from '../src/components/tournament/RebuyModal';
import { AddOnModal } from '../src/components/tournament/AddOnModal';
const { rebuy, addon } = vi.hoisted(() => ({ rebuy: vi.fn(), addon: vi.fn() }));
vi.mock('../src/services/TournamentService', () => ({
  tournamentService: { processRebuy: rebuy, processAddOn: addon },
}));
vi.mock('../src/services/SoundService', () => ({
  soundService: { playBuyInConfirm: vi.fn() },
}));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));

describe('Tournament Modal Receipt Stacks', () => {
  it.each([0, 2300])('passes the exact rebuy receipt stack %s to its caller', async (stack) => {
    rebuy.mockResolvedValue({ success: true, newStack: stack });
    const onSuccess = vi.fn();
    render(
      <RebuyModal
        tournamentId="event"
        userId="player"
        tournamentName="Event"
        rebuyCost={10}
        rebuyChips={1000}
        currentStack={50}
        rebuyWindowLevel={5}
        currentLevel={2}
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Rebuy - 10/ }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledExactlyOnceWith(stack));
  });
  it.each([0, 2300])('passes the exact add-on receipt stack %s to its caller', async (stack) => {
    addon.mockResolvedValue({ success: true, newStack: stack });
    const onSuccess = vi.fn();
    render(
      <AddOnModal
        tournamentId="event"
        userId="player"
        tournamentName="Event"
        addOnCost={10}
        addOnChips={2000}
        currentStack={50}
        onClose={vi.fn()}
        onSuccess={onSuccess}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Add-On - 10/ }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledExactlyOnceWith(stack));
  });
});
