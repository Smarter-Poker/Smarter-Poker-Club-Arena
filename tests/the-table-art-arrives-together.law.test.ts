/**
 * LAW: THE TABLE ART ARRIVES TOGETHER, OR THE TABLE WAITS FOR IT
 * (Dan 2026-10-15, binding)
 * ===========================================================================
 * Dan, with a screenshot of seats on a bare navy gradient: "IT MUST ALWAYS
 * LOAD THE ACTUAL TABLE AND BACKGROUND IMAGES AND EVERYTHING AT ONCE."
 *
 * Root causes: nothing preloaded or retried the felt and room rasters, and
 * the service worker answered a failed image fetch with a 0-byte 200 that
 * paints nothing and never errors. Pinned here:
 *   1. the worker returns a real network error, never an empty image;
 *   2. the loader retries a failed or 0x0 image with a fresh URL;
 *   3. TablePage paints only URLs the loader has decoded and covers the
 *      table until both have.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('the service worker never answers an image with nothing', () => {
  it('returns Response.error() rather than an empty 200 PNG', () => {
    const sw = read('public/sw-bus.js');
    expect(sw).not.toMatch(/new Response\(new Uint8Array\(0\)/);
    expect(sw).toContain('return Response.error();');
  });
});

describe('TablePage paints the art the loader decoded, and waits for it', () => {
  const page = read('src/pages/TablePage.tsx');
  it('feeds both rasters through useTableArt', () => {
    expect(page).toContain(
      'const tableArt = useTableArt(tableSkinUrl, tableBackgroundUrl, themeReady, themeScope);'
    );
    expect(page).toContain('src={tableArt.skinSrc || undefined}');
    expect(page).toContain('resolveBackgroundLayersForUrl(tableArt.backgroundSrc)');
  });
  it('covers the table until the art can be revealed', () => {
    expect(page).toContain('{!tableArt.reveal && !tableLoadFailure && (');
    expect(page).toContain('className="table-art-cover"');
    expect(read('src/pages/TablePage.css')).toMatch(/\.table-art-cover\s*\{[^}]*z-index:\s*5000/);
  });
});

describe('the loader retries a failed or empty image', () => {
  type Behaviour = 'error' | 'empty' | 'ok';
  let plan: Behaviour[] = [];
  const srcs: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    plan = [];
    srcs.length = 0;
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 0;
      naturalHeight = 0;
      decoding = 'auto';
      decode() {
        return Promise.resolve();
      }
      set src(v: string) {
        srcs.push(v);
        const b = plan.shift() ?? 'ok';
        setTimeout(() => {
          if (b === 'error') this.onerror?.();
          else {
            if (b === 'ok') {
              this.naturalWidth = 10;
              this.naturalHeight = 10;
            }
            this.onload?.();
          }
        }, 0);
      }
    }
    vi.stubGlobal('Image', FakeImage);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('retries with a fresh URL until the image decodes', async () => {
    const { loadTableImage, isTableImageDecoded } = await import('../src/hooks/useTableArt');
    plan = ['error', 'empty', 'ok'];
    const done = loadTableImage('/assets/felt.png');
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe('/assets/felt.png?r=2');
    expect(srcs).toEqual(['/assets/felt.png', '/assets/felt.png?r=1', '/assets/felt.png?r=2']);
    expect(isTableImageDecoded('/assets/felt.png')).toBe(true);
  });

  it('a decoded image is instant the second time', async () => {
    const { loadTableImage } = await import('../src/hooks/useTableArt');
    const first = loadTableImage('/assets/room.jpg');
    await vi.runAllTimersAsync();
    await first;
    srcs.length = 0;
    await expect(loadTableImage('/assets/room.jpg')).resolves.toBe('/assets/room.jpg');
    expect(srcs).toEqual([]);
  });
});
