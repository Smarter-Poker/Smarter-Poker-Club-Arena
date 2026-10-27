import { beforeEach, expect, it, vi } from 'vitest';
import { PooledPublicProfiles } from '../engine/horseDecision/pooledPublicProfiles.js';
import { freshExploitCounters } from '../engine/HorseOpponentExploit.js';
const mock = vi.hoisted(() => ({
  from: vi.fn(),
  abort: vi.fn(),
  order: vi.fn(),
  range: vi.fn(),
  select: vi.fn(),
}));
vi.mock('./supabase.js', () => ({ supabase: { from: mock.from } }));
import { readHorsePooledPublicBootstrap } from './HorsePooledPublicBootstrap.js';
const row = (n = 1) => ({
  user_id: `90000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
  variant: 'plo5',
  mode: 'cash',
  size: 'short',
  initialized: true,
  observed_hands: 40,
  counters: freshExploitCounters(),
});
beforeEach(() => {
  vi.clearAllMocks();
  const query = {
    select: mock.select,
    order: mock.order,
    range: mock.range,
    abortSignal: mock.abort,
  };
  mock.from.mockReturnValue(query);
  mock.select.mockReturnValue(query);
  mock.order.mockReturnValue(query);
  mock.range.mockReturnValue(query);
});
it('reads only saved public columns and stamps original resolved availability before first decision', async () => {
  const before = Date.now();
  mock.abort.mockResolvedValueOnce({ data: [row()], error: null });
  const result = await readHorsePooledPublicBootstrap();
  expect(result?.profiles).toEqual([row()]);
  expect(result!.availableAtMs).toBeGreaterThanOrEqual(before);
  expect(mock.from).toHaveBeenCalledWith('horse_exploit_profiles');
  expect(mock.select).toHaveBeenCalledWith(
    'user_id,variant,mode,size,counters,observed_hands,initialized'
  );
  expect(mock.range).toHaveBeenCalledWith(0, 999);
  expect(mock.abort).toHaveBeenCalledTimes(1);
});
it('joins bounded pages and refuses malformed, duplicate, over-limit and failed reads atomically', async () => {
  const page = Array.from({ length: 1000 }, (_, i) => row(i + 1));
  mock.abort
    .mockResolvedValueOnce({ data: page, error: null })
    .mockResolvedValueOnce({ data: [row(1001)], error: null });
  expect((await readHorsePooledPublicBootstrap())?.profiles).toHaveLength(1001);
  for (const data of [[{ ...row(), counters: {} }], [row(), row()]]) {
    mock.abort.mockResolvedValueOnce({ data, error: null });
    expect(await readHorsePooledPublicBootstrap()).toBeNull();
  }
  mock.abort.mockResolvedValueOnce({ data: null, error: { code: 'unavailable' } });
  expect(await readHorsePooledPublicBootstrap()).toBeNull();
  mock.abort.mockRejectedValueOnce(Error('transport'));
  expect(await readHorsePooledPublicBootstrap()).toBeNull();
  for (let i = 0; i < 33; i++)
    mock.abort.mockResolvedValueOnce({
      data: Array.from({ length: 1000 }, (_, j) => row(i * 1000 + j + 1)),
      error: null,
    });
  expect(await readHorsePooledPublicBootstrap()).toBeNull();
});

it('loads the production-sized saved population above the old twenty-thousand ceiling', async () => {
  for (let i = 0; i < 25; i++)
    mock.abort.mockResolvedValueOnce({
      data: Array.from({ length: i === 24 ? 369 : 1000 }, (_, j) => row(i * 1000 + j + 1)),
      error: null,
    });
  const snapshot = await readHorsePooledPublicBootstrap();
  expect(snapshot?.profiles).toHaveLength(24369);
  expect(new PooledPublicProfiles().bootstrap(snapshot!)).toBe(true);
});
