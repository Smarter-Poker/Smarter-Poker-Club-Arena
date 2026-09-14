/**
 * PROCESS MEMORY OBSERVATIONS (2026-09-14)
 *
 * The incident recorded engine RSS growth and refused on-host image builds.
 * Main-isolate V8 usage, whole-process RSS and the [heap] virtual mapping are
 * separate measurements. Their correlation can guide investigation but cannot
 * identify a specific native allocator, thread or allocation owner.
 *
 * The sampler reads process.memoryUsage(), /proc/self/status and /proc/self/maps.
 * It never invokes inspector APIs, queryObjects, heap snapshots or smaps.
 * These synchronous reads are cached for five seconds; that limits frequency,
 * not worst-case duration. Node documents that memoryUsage() can iterate pages.
 * Measure sampler and event-loop latency on a representative replica before
 * claiming a cost bound; never use a live heap traversal to investigate it.
 */

import { readFileSync } from 'node:fs';

export interface ProcessMemorySample {
  /** Resident set size of the whole process, every isolate and every arena. */
  rssBytes: number;
  /** V8 main-isolate heap, committed and used. */
  heapTotalBytes: number;
  heapUsedBytes: number;
  /** Memory V8 knows about outside its heap (Buffers, bound C++ objects). */
  externalBytes: number;
  arrayBuffersBytes: number;
  /**
   * Virtual extent of the Linux [heap] mapping, commonly the brk heap.
   * This is not per-mapping RSS, allocated bytes, a historical maximum, or
   * proof of main-thread/TLS ownership. It can shrink and resident pages
   * can change without a matching extent change. -1 when unavailable.
   * The public metric name is retained for compatibility.
   */
  nativeMainArenaBytes: number;
  /** Anonymous RSS (everything that is not file-backed). -1 when unreadable. */
  rssAnonBytes: number;
  /** OS threads in the process (worker isolates, libuv, V8 helpers). -1 when unreadable. */
  threads: number;
  sampledAt: number;
}

function readProcStatus(): { rssAnon: number; threads: number } {
  try {
    const text = readFileSync('/proc/self/status', 'utf8');
    const anon = /^RssAnon:\s+(\d+)\s+kB/m.exec(text);
    const threads = /^Threads:\s+(\d+)/m.exec(text);
    return {
      rssAnon: anon ? Number(anon[1]) * 1024 : -1,
      threads: threads ? Number(threads[1]) : -1,
    };
  } catch {
    return { rssAnon: -1, threads: -1 };
  }
}

/**
 * Current [heap] virtual mapping extent from the VMA list in /proc/self/maps.
 * Avoid smaps and its per-mapping page accounting. The whole-process RSS
 * series must be read separately; this extent cannot stand in for RSS.
 */
function readMainArenaBytes(): number {
  try {
    const text = readFileSync('/proc/self/maps', 'utf8');
    const line = /^([0-9a-f]+)-([0-9a-f]+) .*\[heap\]\s*$/m.exec(text);
    if (!line) return -1;
    const bytes = Number.parseInt(line[2], 16) - Number.parseInt(line[1], 16);
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : -1;
  } catch {
    return -1;
  }
}

let last: ProcessMemorySample | null = null;
const CACHE_MS = 5_000;

/**
 * One sample, cached for five seconds so a burst of /health and /metrics
 * readers shares a single /proc read.
 */
export function sampleProcessMemory(now: () => number = Date.now): ProcessMemorySample {
  const at = now();
  if (last && at - last.sampledAt < CACHE_MS) return last;
  const mu = process.memoryUsage();
  const status = readProcStatus();
  last = {
    rssBytes: mu.rss,
    heapTotalBytes: mu.heapTotal,
    heapUsedBytes: mu.heapUsed,
    externalBytes: mu.external,
    arrayBuffersBytes: mu.arrayBuffers,
    nativeMainArenaBytes: readMainArenaBytes(),
    rssAnonBytes: status.rssAnon,
    threads: status.threads,
    sampledAt: at,
  };
  return last;
}

/** Test seam: forget the cached sample. */
export function resetProcessMemorySampleForTests(): void {
  last = null;
}

/** The /health block: megabytes, rounded, because a human reads this one. */
export function processMemoryHealth(sample: ProcessMemorySample = sampleProcessMemory()): {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  nativeMainArenaMb: number | null;
  rssAnonMb: number | null;
  threads: number | null;
} {
  const mb = (b: number) => Math.round(b / 1e6);
  return {
    rssMb: mb(sample.rssBytes),
    heapUsedMb: mb(sample.heapUsedBytes),
    heapTotalMb: mb(sample.heapTotalBytes),
    externalMb: mb(sample.externalBytes),
    nativeMainArenaMb: sample.nativeMainArenaBytes >= 0 ? mb(sample.nativeMainArenaBytes) : null,
    rssAnonMb: sample.rssAnonBytes >= 0 ? mb(sample.rssAnonBytes) : null,
    threads: sample.threads >= 0 ? sample.threads : null,
  };
}
