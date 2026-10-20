import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/SoundService', () => ({ haptic: { light: vi.fn() } }));
import { WaitListModal } from '../../src/components/table/WaitListModal';

describe('a reserved seat offers a real queue action', () => {
  it('joins from the ordinary table queue and suppresses double taps until confirmed', async () => {
    let done!: () => void;
    const join = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        })
    );
    render(
      <WaitListModal
        isOpen
        onClose={vi.fn()}
        tableName="NLH 1/2"
        blinds="1/2"
        players={[]}
        myPlayerId="hero"
        onLeaveWaitList={vi.fn()}
        onJoinWaitList={join}
      />
    );
    const button = screen.getByRole('button', { name: 'Join The List' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(join).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Joining' })).toBeDisabled();
    await act(async () => done());
    expect(screen.getByRole('button', { name: 'Join The List' })).not.toBeDisabled();
  });
  it('wires the reserved refusal to the actionable queue after resolving the original receipt', () => {
    const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
    const start = page.indexOf('/^SEAT_RESERVED:/');
    const branch = page.slice(start, page.indexOf('toast.error(message);', start));
    expect(branch).toContain('setShowBuyInModal(false)');
    expect(branch).toContain('setPendingSeat(null)');
    expect(branch).toContain('handleOpenWaitlist()');
    expect(branch).toContain('return false');
    expect(page.indexOf('.complete(attempt)')).toBeLessThan(start);
    expect(page).toContain('const entry = await waitlistService.joinWaitlist(tableId)');
    expect(page).toContain('if (buyInScopeRef.current !== scope) return');
    const layer = readFileSync(
      resolve(__dirname, '../../src/components/table/TableModalsLayer.tsx'),
      'utf8'
    );
    expect(layer).toContain('onJoinWaitList={onJoinWaitList}');
  });
});
