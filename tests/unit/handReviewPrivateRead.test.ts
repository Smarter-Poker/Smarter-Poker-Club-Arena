import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ viewer: 'hero', read: vi.fn() }));
vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ in: state.read }) }) },
}));
vi.mock('@/lib/authUtils', () => ({ readLocalSession: () => ({ userId: state.viewer }) }));
import { handHistoryService } from '@/services/HandHistoryService';
const load = (strict = false) =>
  (handHistoryService as any).fetchOwnHoleCards([{ id: 'hand' }], strict);
beforeEach(() => {
  state.viewer = 'hero';
  state.read.mockReset();
});

describe('private review reads retain ownership and failure', () => {
  it('never maps a different player even if the backend incorrectly returns them', async () => {
    state.read.mockResolvedValue({
      data: [
        { hand_id: 'hand', user_id: 'villain', hole_cards: [{ rank: 'A', suit: 'spades' }] },
        { hand_id: 'hand', user_id: 'hero', hole_cards: [{ rank: 'K', suit: 'hearts' }] },
      ],
      error: null,
    });
    expect((await load()).get('hand').user_id).toBe('hero');
  });
  it('discards a response after the account changes during the read', async () => {
    let resolve!: (value: any) => void;
    state.read.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const pending = load();
    state.viewer = 'other';
    resolve({
      data: [{ hand_id: 'hand', user_id: 'hero', hole_cards: [{ rank: 'K', suit: 'hearts' }] }],
      error: null,
    });
    expect((await pending).size).toBe(0);
  });
  it('throws a failed private lookup only when the detail reader requests that distinction', async () => {
    const error = { message: 'permission denied' };
    state.read.mockResolvedValue({ data: null, error });
    await expect(load(true)).rejects.toEqual(error);
    expect((await load()).size).toBe(0);
  });
});
