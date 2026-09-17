/**
 * The process publishes its own weight (2026-09-14). Before this the engine
 * exported 1,134 metric lines and none of them said how much memory it used;
 * the release train was refused 11 of 14 times overnight on host memory and
 * the only witness was an SSH session. These tests pin the sampler, its
 * cache, the /health block, and - the part that matters for an alert - that
 * the always-on registry carries every memory gauge from the first scrape.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  sampleProcessMemory,
  processMemoryHealth,
  resetProcessMemorySampleForTests,
  type ProcessMemorySample,
} from './processMemory.js';
import { alwaysOnPrometheusLines, alwaysOnRegistry } from './engineInstruments.js';

const MEMORY_GAUGES = [
  'poker_engine_process_rss_bytes',
  'poker_engine_heap_used_bytes',
  'poker_engine_heap_total_bytes',
  'poker_engine_external_bytes',
  'poker_engine_array_buffers_bytes',
  'poker_engine_native_main_arena_bytes',
  'poker_engine_rss_anon_bytes',
  'poker_engine_threads',
] as const;

describe('sampleProcessMemory', () => {
  beforeEach(() => resetProcessMemorySampleForTests());

  it('reads the V8 numbers from the live process', () => {
    const s = sampleProcessMemory();
    expect(s.rssBytes).toBeGreaterThan(0);
    expect(s.heapTotalBytes).toBeGreaterThan(0);
    expect(s.heapUsedBytes).toBeGreaterThan(0);
    expect(s.heapUsedBytes).toBeLessThanOrEqual(s.heapTotalBytes);
    expect(s.rssBytes).toBeGreaterThan(s.heapUsedBytes);
    expect(s.externalBytes).toBeGreaterThanOrEqual(0);
    expect(s.arrayBuffersBytes).toBeGreaterThanOrEqual(0);
  });

  it('the /proc numbers are either real or -1, never absent and never NaN', () => {
    const s = sampleProcessMemory();
    for (const k of ['nativeMainArenaBytes', 'rssAnonBytes', 'threads'] as const) {
      expect(Number.isFinite(s[k]), k).toBe(true);
      expect(s[k] === -1 || s[k] > 0, `${k}=${s[k]}`).toBe(true);
    }
    if (process.platform === 'linux') {
      // On Linux /proc/self/status is always readable by the process itself.
      expect(s.rssAnonBytes).toBeGreaterThan(0);
      expect(s.threads).toBeGreaterThan(0);
      expect(s.nativeMainArenaBytes).toBeGreaterThan(0);
    }
  });

  it('caches for five seconds so a burst of readers shares one /proc read', () => {
    let t = 1_000_000;
    const first = sampleProcessMemory(() => t);
    t += 4_999;
    expect(sampleProcessMemory(() => t)).toBe(first);
    t += 1;
    const second = sampleProcessMemory(() => t);
    expect(second).not.toBe(first);
    expect(second.sampledAt).toBe(t);
  });

  it('the test seam forgets the cached sample', () => {
    const first = sampleProcessMemory(() => 5);
    resetProcessMemorySampleForTests();
    expect(sampleProcessMemory(() => 5)).not.toBe(first);
  });
});

describe('processMemoryHealth', () => {
  it('rounds to megabytes and turns -1 into null', () => {
    const sample: ProcessMemorySample = {
      rssBytes: 2_147_000_000,
      heapTotalBytes: 900_400_000,
      heapUsedBytes: 650_600_000,
      externalBytes: 40_000_000,
      arrayBuffersBytes: 1_000,
      nativeMainArenaBytes: -1,
      rssAnonBytes: -1,
      threads: -1,
      sampledAt: 0,
    };
    expect(processMemoryHealth(sample)).toEqual({
      rssMb: 2147,
      heapUsedMb: 651,
      heapTotalMb: 900,
      externalMb: 40,
      nativeMainArenaMb: null,
      rssAnonMb: null,
      threads: null,
    });
  });

  it('keeps the /proc numbers when they are real', () => {
    const sample: ProcessMemorySample = {
      rssBytes: 1_000_000,
      heapTotalBytes: 1_000_000,
      heapUsedBytes: 1_000_000,
      externalBytes: 0,
      arrayBuffersBytes: 0,
      nativeMainArenaBytes: 501_000_000,
      rssAnonBytes: 1_900_000_000,
      threads: 41,
      sampledAt: 0,
    };
    const h = processMemoryHealth(sample);
    expect(h.nativeMainArenaMb).toBe(501);
    expect(h.rssAnonMb).toBe(1900);
    expect(h.threads).toBe(41);
  });

  it('defaults to a live sample', () => {
    const h = processMemoryHealth();
    expect(h.rssMb).toBeGreaterThan(0);
    expect(h.heapUsedMb).toBeGreaterThan(0);
  });
});

describe('the always-on registry carries the memory gauges', () => {
  it('every memory gauge has a series from import, before any scrape', () => {
    const rendered = alwaysOnRegistry.renderPrometheus();
    for (const name of MEMORY_GAUGES) {
      expect(rendered, name).toMatch(new RegExp(`^# TYPE ${name} gauge$`, 'm'));
      expect(rendered, name).toMatch(new RegExp(`^${name} -?\\d+$`, 'm'));
    }
  });

  it('a scrape refreshes them and the V8 numbers are the live ones', () => {
    resetProcessMemorySampleForTests();
    const lines = alwaysOnPrometheusLines();
    const value = (name: string): number => {
      const line = lines.find((l) => l.startsWith(`${name} `));
      expect(line, name).toBeDefined();
      return Number(line!.split(' ')[1]);
    };
    const rss = value('poker_engine_process_rss_bytes');
    const heapUsed = value('poker_engine_heap_used_bytes');
    const heapTotal = value('poker_engine_heap_total_bytes');
    expect(rss).toBeGreaterThan(0);
    expect(heapUsed).toBeGreaterThan(0);
    expect(heapUsed).toBeLessThanOrEqual(heapTotal);
    // The sampler and the gauges agree: the scrape published the cached sample.
    const s = sampleProcessMemory();
    expect(rss).toBe(s.rssBytes);
    expect(heapUsed).toBe(s.heapUsedBytes);
    expect(value('poker_engine_threads')).toBe(s.threads);
    expect(value('poker_engine_native_main_arena_bytes')).toBe(s.nativeMainArenaBytes);
  });
});
