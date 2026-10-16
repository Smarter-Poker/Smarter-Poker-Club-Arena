import { beforeEach, describe, expect, it, vi } from 'vitest';
const query = vi.hoisted(() => ({ select: vi.fn(), in: vi.fn(), abortSignal: vi.fn() }));
const from = vi.hoisted(() => vi.fn());
vi.mock('./client.js', () => ({ supabase: { from } }));
import { readAutoTimeBankPreferences } from './timeBankPreferences.js';
beforeEach(() => {
  vi.clearAllMocks();
  from.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.in.mockReturnValue(query);
});
describe('cold-start automatic bank preferences', () => {
  it('keeps an explicit opt-out and defaults only missing accounts to on', async () => {
    query.abortSignal.mockResolvedValue({
      data: [{ user_id: 'off', auto_time_bank: false }],
      error: null,
    });
    expect(await readAutoTimeBankPreferences(['off', 'new'])).toEqual(
      new Map([
        ['off', false],
        ['new', true],
      ])
    );
    expect(from).toHaveBeenCalledWith('user_table_settings');
    expect(query.in).toHaveBeenCalledWith('user_id', ['off', 'new']);
    expect(query.abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });
  it('reports unreadable preferences instead of claiming an empty result', async () => {
    query.abortSignal.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
    await expect(readAutoTimeBankPreferences(['off'])).rejects.toThrow('unavailable');
  });
  it('does no database work for an already adopted roster', async () => {
    expect(await readAutoTimeBankPreferences([])).toEqual(new Map());
    expect(from).not.toHaveBeenCalled();
  });
});
