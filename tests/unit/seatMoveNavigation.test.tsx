import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSeatMoveNavigation } from '../../src/hooks/useSeatMoveNavigation';

const move = (user = 'alice', from = 'source', to = 'destination') => ({
  type: 'seat_moved',
  table_id: from,
  user_id: user,
  to_table_id: to,
});
const start = (userId = 'guest', event: Record<string, unknown> | null = move()) => {
  const follow = vi.fn();
  const initialProps = { tableId: 'source', userId, event, follow };
  const hook = renderHook(useSeatMoveNavigation, { initialProps });
  return { ...hook, follow, props: initialProps };
};

describe('a completed seat move survives identity hydration', () => {
  it('follows once after identity arrives, even if another event replaced the move', () => {
    const h = start();
    expect(h.follow).not.toHaveBeenCalled();
    h.rerender({ ...h.props, event: { type: 'hand_complete' } });
    h.rerender({ ...h.props, event: { type: 'hand_complete' }, userId: 'alice' });
    expect(h.follow).toHaveBeenCalledExactlyOnceWith('destination');
    h.rerender({ ...h.props, event: { type: 'hand_complete' }, userId: 'alice' });
    expect(h.follow).toHaveBeenCalledTimes(1);
  });

  it('keeps both swap recipients separate while their identities load', () => {
    for (const user of ['alice', 'bob']) {
      const h = start('guest', move('alice', 'source', 'alice-destination'));
      const second = move('bob', 'source', 'bob-destination');
      h.rerender({ ...h.props, event: second });
      h.rerender({ ...h.props, event: second, userId: user });
      expect(h.follow).toHaveBeenCalledExactlyOnceWith(`${user}-destination`);
      h.unmount();
    }
  });

  it('ignores another player and does not replay it when the account changes', () => {
    const h = start('bob');
    h.rerender({ ...h.props, userId: 'alice' });
    expect(h.follow).not.toHaveBeenCalled();
  });

  it('drops the pending move when the open table changes', () => {
    const h = start();
    h.rerender({ ...h.props, tableId: 'different', userId: 'alice' });
    expect(h.follow).not.toHaveBeenCalled();
  });

  it('follows a known player immediately, without repeating on callback changes', () => {
    const h = start('alice');
    expect(h.follow).toHaveBeenCalledExactlyOnceWith('destination');
    const next = vi.fn();
    h.rerender({ ...h.props, follow: next });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    move('alice', 'different'),
    move('alice', 'source', 'source'),
    { type: 'seat_moved', user_id: 'alice', to_table_id: 'destination' },
    { type: 'seat_move_pending', table_id: 'source', user_id: 'alice', to_table_id: 'destination' },
  ])('does not follow malformed, unrelated or merely proposed moves: %j', (event) => {
    const h = start('alice', event);
    expect(h.follow).not.toHaveBeenCalled();
  });
});
