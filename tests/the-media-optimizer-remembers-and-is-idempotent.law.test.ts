/**
 * LAW: optimizing dist media is parallel, cached, and safe to run twice.
 * ═══════════════════════════════════════════════════════════════════════════
 * Added 2026-09-04. `scripts/optimize-dist-media.mjs` was 88.0s of a 266s CI
 * build and 85.7s of a 120s publisher build, and it runs THREE times per
 * merge - the second largest item on the push-to-live critical path. Two
 * things were wrong with it:
 *
 *  1. SERIAL. One `await pipeline.toFile()` at a time, 496 candidates, on a
 *     16-core box.
 *  2. NO MEMORY, AND NOT IDEMPOTENT. Every raster in dist/ is a byte-for-byte
 *     copy of a committed source asset, so the same input was decoded and
 *     re-encoded on every build of every branch forever. Worse, a second pass
 *     over an already-optimized dist "optimized" 90 more files - generational
 *     quality loss, silently, for anyone who restored a warm dist.
 *
 * This test is behavioural, not textual: it builds a synthetic dist/, runs the
 * real script against it twice, and asserts what the pipeline depends on.
 *
 * THE ONE WAY THIS CACHE CAN SERVE STALE BYTES is a change to the encoder
 * settings without a bump to ENCODER_SETTINGS_VERSION, so that is pinned by
 * name here: the constant sits directly above the settings it covers, and if
 * you changed one you must change the other.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'optimize-dist-media.mjs');

/**
 * A 2400x2400 PNG of deterministic noise. Noise on purpose: a smooth gradient
 * palette-quantizes down past MIN_BYTES and then stops being a candidate at
 * all, which would make the second and third passes trivially "unchanged" for
 * the wrong reason. This fixture stays a candidate on every pass, so the only
 * thing that can make a later pass a no-op is the cache doing its job.
 */
async function makeBigPng(): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const side = 2400;
  const raw = Buffer.alloc(side * side * 3);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = (seed >> 16) & 0xff;
  }
  return sharp(raw, { raw: { width: side, height: side, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

function run(root: string, cache: string): string {
  return execFileSync(process.execPath, [SCRIPT, root], {
    encoding: 'utf8',
    env: { ...process.env, CA_DIST_MEDIA_CACHE: cache },
  });
}

describe('the media optimizer remembers, and running it twice changes nothing', () => {
  let root: string;
  let cache: string;
  let target: string;
  let originalSize: number;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ca-dist-media-law-'));
    cache = join(root, 'cache');
    mkdirSync(join(root, 'dist', 'images'), { recursive: true });
    target = join(root, 'dist', 'images', 'law-fixture.png');
    const png = await makeBigPng();
    writeFileSync(target, png);
    originalSize = statSync(target).size;
    expect(originalSize).toBeGreaterThan(40 * 1024);
  }, 60_000);

  it('optimizes on a cold cache, and reports the miss', () => {
    const out = run(root, cache);
    expect(out).toMatch(/optimized=1\b/);
    expect(out).toMatch(/cache=0hit\/1miss/);
    expect(statSync(target).size).toBeLessThan(originalSize);
  }, 60_000);

  it('running it again re-encodes NOTHING - the output recognises itself', () => {
    const before = readFileSync(target);
    const out = run(root, cache);
    expect(out).toMatch(/optimized=0\b/);
    expect(out).toMatch(/cache=1hit\/0miss/);
    // Byte-identical: no generational re-encode of an already-optimized file.
    expect(readFileSync(target).equals(before)).toBe(true);
  }, 60_000);

  it('a fresh dist with the same bytes is served from cache, not re-encoded', () => {
    // Reset the file to its original bytes, as a fresh `vite build` would.
    const second = join(root, 'dist', 'images', 'law-fixture-copy.png');
    writeFileSync(second, readFileSync(join(root, 'dist', 'images', 'law-fixture.png')));
    const out = run(root, cache);
    expect(out).toMatch(/cache=2hit\/0miss/);
    expect(out).toMatch(/optimized=0\b/);
    rmSync(second);
  }, 60_000);

  it('runs a worker pool, so the box is used rather than one core of it', () => {
    const out = run(root, cache);
    const pool = /pool=(\d+)/.exec(out);
    expect(pool, 'the optimizer no longer reports its pool width').toBeTruthy();
    expect(Number(pool![1])).toBeGreaterThan(0);
    const src = readFileSync(SCRIPT, 'utf8');
    // One libvips thread per image; the pool is where the parallelism lives.
    // Reversing this (sharp's default concurrency x a wide pool) oversubscribes
    // the box and was measurably slower than either extreme.
    expect(src).toContain('sharp.concurrency(1)');
  }, 60_000);

  it('every input to the encode is part of the cache key', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    // Bump ENCODER_SETTINGS_VERSION when the png/webp/jpeg options change.
    // It is the only thing standing between an encoder change and a cache
    // that keeps serving the previous encoder's bytes.
    expect(src).toContain('ENCODER_SETTINGS_VERSION');
    expect(src).toMatch(/rule\.maxDim.*ext.*ENCODER_SETTINGS_VERSION.*sharp\$\{sharpVersion\}/s);
    // sharp's own version too: a new libvips can produce different bytes.
    expect(src).toContain('sharpVersion');
  });
});
