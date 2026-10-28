import { getHeapStatistics } from 'node:v8';
import { isMainThread, threadId } from 'node:worker_threads';

/** Diagnostic scalars for one V8 isolate; never whole-process RSS. */
export interface IsolateMemorySample {
  source: 'node_v8_heap_statistics';
  threadId: number;
  shardIndex: number;
  sampledAtMs: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapLimitBytes: number;
}

export function isolateMemoryIsValid(
  value: unknown,
  expectedShard?: number
): value is IsolateMemorySample {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const numbers = [
    'threadId',
    'shardIndex',
    'sampledAtMs',
    'heapUsedBytes',
    'heapTotalBytes',
    'heapLimitBytes',
  ];
  return (
    Object.keys(v).length === 7 &&
    ['source', ...numbers].every((k) => Object.hasOwn(v, k)) &&
    v.source === 'node_v8_heap_statistics' &&
    numbers.every((k) => Number.isSafeInteger(v[k]) && (v[k] as number) >= 0) &&
    (v.threadId as number) > 0 &&
    (v.sampledAtMs as number) > 0 &&
    (v.heapLimitBytes as number) > 0 &&
    (v.heapUsedBytes as number) <= (v.heapTotalBytes as number) &&
    (expectedShard === undefined || v.shardIndex === expectedShard)
  );
}

/** Called only by the existing worker STATUS request. No traversal or GC. */
export function sampleIsolateMemory(shardIndex: number): IsolateMemorySample | null {
  if (isMainThread) return null;
  try {
    const heap = getHeapStatistics();
    const value: IsolateMemorySample = {
      source: 'node_v8_heap_statistics',
      threadId,
      shardIndex,
      sampledAtMs: Date.now(),
      heapUsedBytes: heap.used_heap_size,
      heapTotalBytes: heap.total_heap_size,
      heapLimitBytes: heap.heap_size_limit,
    };
    return isolateMemoryIsValid(value, shardIndex) ? value : null;
  } catch {
    return null;
  }
}
