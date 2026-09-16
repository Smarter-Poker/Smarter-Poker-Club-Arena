import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllRows } from './pagination.js';

vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));

afterEach(() => vi.useRealTimers());

describe('a withdrawn paginated read joins its current request and stops', () => {
  it('does not start a request after its owner stops', async () => {
    const query = vi.fn(async () => ({ data: [], error: null }));
    expect(await fetchAllRows(query, { label: 'stopped', shouldContinue: () => false })).toEqual({
      rows: [],
      complete: false,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['full', 'empty', 'failed'] as const)(
    'joins a %s response without admitting more work',
    async (kind) => {
      let current = true;
      let release!: (value: { data: { id: string }[] | null; error: unknown }) => void;
      const first = new Promise<{ data: { id: string }[] | null; error: unknown }>((resolve) => {
        release = resolve;
      });
      const query = vi.fn().mockReturnValueOnce(first).mockResolvedValue({ data: [], error: null });
      let settled = false;
      const read = fetchAllRows(query, {
        label: 'stopped',
        pageSize: 1,
        shouldContinue: () => current,
      }).then((result) => {
        settled = true;
        return result;
      });
      current = false;
      await Promise.resolve();
      expect(settled).toBe(false);
      release({
        data: kind === 'failed' ? null : kind === 'empty' ? [] : [{ id: 'a' }],
        error: kind === 'failed' ? new Error('timeout') : null,
      });
      expect(await read).toEqual({ rows: [], complete: false });
      expect(query).toHaveBeenCalledOnce();
    }
  );

  it('does not retry when its owner stops during retry backoff', async () => {
    vi.useFakeTimers();
    let current = true;
    const query = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: new Error('timeout') })
      .mockResolvedValue({ data: [], error: null });
    const read = fetchAllRows(query, { label: 'stopped', shouldContinue: () => current });
    await vi.advanceTimersByTimeAsync(1);
    current = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await read).toEqual({ rows: [], complete: false });
    expect(query).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains earlier evidence as incomplete when stopped during a later page', async () => {
    let current = true;
    const query = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: 'a' }], error: null })
      .mockImplementationOnce(async () => {
        current = false;
        return { data: [{ id: 'b' }], error: null };
      })
      .mockResolvedValue({ data: [], error: null });
    expect(
      await fetchAllRows(query, { label: 'stopped', pageSize: 1, shouldContinue: () => current })
    ).toEqual({ rows: [{ id: 'a' }], complete: false });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
