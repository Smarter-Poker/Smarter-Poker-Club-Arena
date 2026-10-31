import { afterEach, describe, expect, it, vi } from 'vitest';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import { supabase } from '../services/supabase.js';

afterEach(() => vi.restoreAllMocks());

function fixture(count: unknown, error: unknown = null) {
  const setFirstButtonSeat = vi.fn();
  const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(supabase, 'from').mockImplementation(((relation: string) => {
    if (relation === 'hand_history')
      return {
        select: vi.fn(() => ({ eq: vi.fn(async () => ({ count, error })) })),
      };
    if (relation === 'tables') return { update };
    throw new Error(`unexpected relation ${relation}`);
  }) as never);
  const state = Object.assign(Object.create(TournamentManagerBase.prototype), {
    tournamentId: 'spin-event',
    tableEngines: new Map([['spin-table', { setFirstButtonSeat }]]),
  });
  return { state, setFirstButtonSeat, update };
}

describe('a restored Spin button requires evidence the table never dealt', () => {
  it.each([null, undefined, false, '', '0', [], -1, 0.5, Number.NaN])(
    'does not force the old draw for an unreadable count %j',
    async (count) => {
      const f = fixture(count);
      await f.state.restoreDrawnFirstButtons([{ id: 'spin-table', first_button_seat: 2 }]);
      expect(f.setFirstButtonSeat).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
    }
  );
  it('reapplies the durable draw only for an exact zero', async () => {
    const f = fixture(0);
    await f.state.restoreDrawnFirstButtons([{ id: 'spin-table', first_button_seat: 2 }]);
    expect(f.setFirstButtonSeat).toHaveBeenCalledWith(2);
    expect(f.update).not.toHaveBeenCalled();
  });
  it('clears a consumed draw after proven hand history', async () => {
    const f = fixture(1);
    await f.state.restoreDrawnFirstButtons([{ id: 'spin-table', first_button_seat: 2 }]);
    expect(f.setFirstButtonSeat).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith({ first_button_seat: null });
  });
  it('does not trust a zero accompanied by a read error', async () => {
    const f = fixture(0, { message: 'unavailable' });
    await f.state.restoreDrawnFirstButtons([{ id: 'spin-table', first_button_seat: 2 }]);
    expect(f.setFirstButtonSeat).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });
});
