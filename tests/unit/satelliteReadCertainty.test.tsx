import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), report: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
import { useSatellites } from '../../src/components/tournament/details/useSatellites';
function query(data: unknown) {
  const q: any = { then: (resolve: any) => Promise.resolve({ data, error: null }).then(resolve) };
  for (const key of ['select', 'or', 'in', 'eq', 'order', 'limit']) q[key] = () => q;
  return q;
}
const row = { id: 'satellite', name: 'Satellite', status: 'REGISTERING' };
beforeEach(() => {
  mocks.from.mockReset();
  mocks.report.mockClear();
});
afterEach(cleanup);
describe('satellite reads distinguish an empty answer from no answer', () => {
  it('reports an unreadable list and accepts an explicit retry with a real empty list', async () => {
    mocks.from.mockReturnValueOnce(query(null)).mockReturnValueOnce(query([]));
    const { result } = renderHook(() => useSatellites('target', 'viewer'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Satellites Could Not Be Loaded');
    act(() => result.current.retry());
    await waitFor(() => expect(mocks.from).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.cards).toEqual([]);
  });
  it('keeps unreadable membership unknown instead of authorizing a Register display', async () => {
    mocks.from.mockImplementation((table) => query(table === 'tournaments' ? [row] : null));
    const { result } = renderHook(() => useSatellites('target', 'viewer'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.cards).toHaveLength(1);
    expect(result.current.registration).toBeNull();
    expect(mocks.report).toHaveBeenCalledWith(expect.any(Error), 'useSatellites.registration');
  });
  it('accepts an empty membership answer as not registered', async () => {
    mocks.from.mockImplementation((table) => query(table === 'tournaments' ? [row] : []));
    const { result } = renderHook(() => useSatellites('target', 'viewer'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.registration).toEqual({ satellite: false });
  });
});
