/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PROCESS MEMORY, AS NUMBERS AN ALERT CAN READ (2026-09-14)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The engine exported 1,134 lines of /metrics and not one of them said how
 * much memory the process was using. So this was found by hand, on the box:
 *
 *   - the release train failed eleven of fourteen engine deploys overnight on
 *     `insufficient memory headroom for the bounded engine build`, because the
 *     image is built on the same 3.8 GB host the engine runs on;
 *   - the engine that came up at 08:56 UTC was at 1.64 GB after one hour and
 *     2.1 GB after ninety minutes; the build needs 1.125 GiB free;
 *   - the only series that showed any of it was node_exporter's
 *     `node_memory_MemAvailable_bytes`, which cannot say whether the growth is
 *     the engine, a worker, or the page cache.
 *
 * Read on the box, the growth was NOT the V8 heap: main-isolate heapUsed sat
 * between 400 and 800 MB across GC cycles while RSS climbed, and the delta
 * landed in glibc's main arena (`[heap]`, the brk region: +111 MB in seven
 * minutes during one tournament re-admission storm, flat in quiet minutes).
 * That is the number nothing published. It is published here, beside the V8
 * numbers, so the next reading is a graph rather than an SSH session.
 *
 * Everything below is a read: `process.memoryUsage()` and two small
 * `/proc/self` files (status, maps - never smaps, which walks page tables).
 * No allocation profile, no heap walk - a full-heap traversal on this
 * process pauses it long enough to miss lease renewals (measured 2026-09-14:
 * one `Runtime.queryObjects` fenced ~750 tournament managers).
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
   * glibc's MAIN arena - the `[heap]` (brk) mapping in /proc/self/maps. Native
   * allocations made on the main thread live here: TLS state for every HTTPS
   * connection, serializer buffers, everything malloc'd that is not a V8 page.
   * V8 never uses brk, so this number is exactly "native, main thread". It is
   * the mapping's extent, which for the brk arena is its high-water mark:
   * glibc only ever gives the TOP of this region back, so the extent and the
   * resident size move together (measured 2026-09-14: 378 -> 501 MB in an
   * hour, both readings). -1 when /proc is not readable (macOS, a sandbox).
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
 * The extent of the `[heap]` mapping, from /proc/self/maps.
 *
 * NOT /proc/self/smaps. smaps reports per-mapping RSS by walking the page
 * tables of every mapping, and this process maps ~25 GB of virtual space
 * across a few thousand VMAs (V8 code ranges, worker isolates, arenas): tens
 * of milliseconds, on the main thread, every scrape. maps is the VMA list
 * alone - one line per mapping, no page walk - and for the brk arena its
 * extent is the number that matters (see the field's doc above). Only ever
 * read at scrape time (every 15 s) or on a /health read, never on a hot path.
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
