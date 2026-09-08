import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  drainPendingWrites,
  enqueuePendingWrite,
  pendingWriteCount,
  resetPendingWrites,
} from './pendingWrites.js';
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  resetPendingWrites();
});
afterEach(() => {
  resetPendingWrites();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('removes a handled refusal without reporting that the write landed', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const onGiveUp = vi.fn();
  enqueuePendingWrite({
    key: 'test:refused',
    describedAs: 'refused write',
    attempt: async () => ({ done: true, refused: true }),
    onGiveUp,
  });
  await drainPendingWrites('test:');
  expect(pendingWriteCount()).toBe(0);
  expect(log.mock.calls.flat().some((v) => String(v).includes('landed'))).toBe(false);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused'));
  expect(onGiveUp).not.toHaveBeenCalled();
});
it('reports a confirmed write as landed', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  enqueuePendingWrite({
    key: 'test:paid',
    describedAs: 'confirmed write',
    attempt: async () => ({ done: true }),
    onGiveUp: vi.fn(),
  });
  await drainPendingWrites('test:');
  expect(pendingWriteCount()).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('landed'));
});
