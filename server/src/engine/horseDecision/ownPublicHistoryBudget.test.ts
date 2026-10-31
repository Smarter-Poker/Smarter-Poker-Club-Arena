import { expect, it } from 'vitest';
import { getHeapStatistics } from 'node:v8';
import {
  HorseHistoryRetentionBudget,
  HISTORY_AGGREGATE_MAX_BYTES,
  HISTORY_PACKET_MAX_BYTES,
  HISTORY_ACTIVE_LOADS,
} from './ownPublicHistoryBudget.js';
it('derives the aggregate encoded ceiling from one existing bank and reads the actual current isolate heap', () => {
  const budget = new HorseHistoryRetentionBudget();
  expect(budget.status().maxEncodedBytes).toBe(2048 * 256 * 1024);
  expect(HISTORY_AGGREGATE_MAX_BYTES).toBe(512 * 1024 * 1024);
  const owner = {};
  const heap = getHeapStatistics();
  expect(heap.heap_size_limit).toBeGreaterThan(heap.used_heap_size);
  expect(budget.reserve(owner, 1024, () => {})).toBe(true);
  expect(budget.status().encodedBytes).toBe(1024);
  budget.release(owner);
  budget.release(owner);
  expect(budget.status()).toMatchObject({ encodedBytes: 0, reservations: 0 });
});
it('cannot exceed capacity across pending owners, and shrinking preserves FIFO identity', () => {
  const budget = new HorseHistoryRetentionBudget(2 * HISTORY_PACKET_MAX_BYTES, () => ({
    heap_size_limit: 1024 ** 3,
    used_heap_size: 0,
    total_available_size: 1024 ** 3,
  }));
  const removed: number[] = [];
  const owners = Array.from({ length: 8 }, () => ({}));
  owners.forEach((owner, i) => {
    expect(budget.reserve(owner, HISTORY_PACKET_MAX_BYTES, () => removed.push(i))).toBe(true);
  });
  expect(removed).toEqual([0, 1, 2, 3, 4, 5]);
  expect(budget.status()).toMatchObject({
    encodedBytes: 2 * HISTORY_PACKET_MAX_BYTES,
    reservations: 2,
  });
  expect(budget.reserve(owners[6]!, 100, () => {})).toBe(true);
  expect(budget.status().encodedBytes).toBe(HISTORY_PACKET_MAX_BYTES + 100);
  const next = {};
  budget.reserve(next, HISTORY_PACKET_MAX_BYTES, () => {});
  expect(removed).toEqual([0, 1, 2, 3, 4, 5, 6]);
});
it('fails closed on missing or exhausted heap metadata without evicting retained originals', () => {
  let broken = false;
  const owner = {};
  const budget = new HorseHistoryRetentionBudget(HISTORY_PACKET_MAX_BYTES * 2, () => {
    if (broken) throw Error('unreadable');
    return { heap_size_limit: 1024 ** 3, used_heap_size: 0, total_available_size: 1024 ** 3 };
  });
  expect(
    budget.reserve(owner, 100, () => {
      throw Error('must remain');
    })
  ).toBe(true);
  broken = true;
  expect(budget.reserve({}, 100, () => {})).toBe(false);
  expect(budget.reserve(owner, 50, () => {})).toBe(true);
  expect(budget.status()).toMatchObject({ encodedBytes: 50, reservations: 1 });
});

it('uses the exact retained claim and existing reserve at the representation boundary without changing ownership', () => {
  const reserve = (HISTORY_ACTIVE_LOADS + 2) * HISTORY_PACKET_MAX_BYTES * 2;
  let available = 1024 ** 3,
    broken = false;
  const budget = new HorseHistoryRetentionBudget(HISTORY_PACKET_MAX_BYTES, () => {
    if (broken) throw Error('unavailable');
    return { heap_size_limit: 1024 ** 3, used_heap_size: 0, total_available_size: available };
  });
  const owner = {},
    evict = () => {
      throw Error('must not evict');
    };
  expect(budget.reserve(owner, 512, evict)).toBe(true);
  const original = budget.status();
  available = reserve + 512 * 2 - 1;
  expect(budget.canAllocateRepresentation(owner)).toBe(false);
  available++;
  expect(budget.canAllocateRepresentation(owner)).toBe(true);
  expect(budget.canAllocateRepresentation({})).toBe(false);
  available = Number.NaN;
  expect(budget.canAllocateRepresentation(owner)).toBe(false);
  broken = true;
  expect(budget.canAllocateRepresentation(owner)).toBe(false);
  expect(budget.status()).toEqual(original);
  budget.release(owner);
  expect(budget.canAllocateRepresentation(owner)).toBe(false);
});
