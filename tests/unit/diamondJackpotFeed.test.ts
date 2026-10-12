import { it, expect, vi, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  channel: vi.fn(),
  removeChannel: vi.fn(),
  emit: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: mocks }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));
import { subscribeDiamondJackpot } from '../../src/lib/diamondJackpotFeed';
const snapshot = {
  version: 1,
  pool_id: 'pool',
  enabled: true,
  main_balance: 0,
  mini_enabled: true,
  backup_balance: 0,
  reserve_floor: 5000,
  stakes: [],
  hits: [],
};
afterEach(() => vi.useRealTimers());
it('shares one club observer and closes it only after the last consumer, dropping delayed responses', async () => {
  vi.useFakeTimers();
  const channel = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() };
  mocks.channel.mockReturnValue(channel);
  let answer: (value: unknown) => void = () => {};
  mocks.rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  );
  const first = vi.fn(),
    second = vi.fn();
  const stopFirst = subscribeDiamondJackpot('arena', first),
    stopSecond = subscribeDiamondJackpot('arena', second);
  expect(mocks.channel).toHaveBeenCalledTimes(1);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  answer({ data: snapshot, error: null });
  await Promise.resolve();
  await Promise.resolve();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  stopFirst();
  expect(mocks.removeChannel).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  stopSecond();
  expect(mocks.removeChannel).toHaveBeenCalledTimes(1);
  answer({ data: { ...snapshot, main_balance: 500 }, error: null });
  await Promise.resolve();
  await Promise.resolve();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  expect(mocks.emit).not.toHaveBeenCalled();
});
