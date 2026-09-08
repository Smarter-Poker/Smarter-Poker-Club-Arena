import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/ThrowableService', () => ({
  getThrowableImageUrl: (id: string, px: number) =>
    `/images/throwables/stylized/${id}-${px <= 96 ? 192 : 320}.webp`,
  getThrowableRawUrl: (id: string) => `/images/throwables/stylized/${id}-640.webp`,
}));
import {
  getThrowableCutout,
  peekThrowableCutout,
  releaseThrowableCutouts,
} from '../../src/services/ThrowableCutout';
afterEach(() => {
  releaseThrowableCutouts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('cutout delivery sizing', () => {
  it('times out stalled thumbnail and fallback loads, then allows a fresh retry', async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    vi.stubGlobal(
      'Image',
      class {
        onload = null;
        onerror = null;
        set src(value: string) {
          requests.push(value);
        }
      }
    );
    const first = getThrowableCutout('bomb', 84);
    const rejected = expect(first).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(requests).toHaveLength(2);
    const retry = getThrowableCutout('bomb', 84);
    expect(retry).not.toBe(first);
    const rejectedAgain = expect(retry).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejectedAgain;
    expect(requests).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not recreate released URLs or evict a newer request when old encoding finishes', async () => {
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 3;
        naturalHeight = 3;
        onload: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: () => {
        const data = new Uint8ClampedArray(36);
        for (let i = 0; i < 9; i++) data.set([0, 0, 0, 255], i * 4);
        data.set([200, 100, 50, 255], 16);
        return { data };
      },
      putImageData: vi.fn(),
    } as any);
    const encodings: Array<(blob: Blob | null) => void> = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
      encodings.push(cb);
    });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:current-cutout');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const old = getThrowableCutout('bomb', 84);
    const rejected = expect(old).rejects.toThrow('cache was released');
    await vi.waitFor(() => expect(encodings).toHaveLength(1));
    releaseThrowableCutouts();
    const current = getThrowableCutout('bomb', 84);
    await vi.waitFor(() => expect(encodings).toHaveLength(2));
    encodings[1](new Blob(['current']));
    await current;
    encodings[0](new Blob(['old']));
    await rejected;
    expect(create).toHaveBeenCalledTimes(1);
    expect(peekThrowableCutout('bomb', 84)).toBe('blob:current-cutout');
    expect(getThrowableCutout('bomb', 84)).toBe(current);
  });

  it('decodes the small thumbnail once for shared small display sizes and caches its cutout', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 3;
        naturalHeight = 3;
        onload: (() => void) | null = null;
        set src(value: string) {
          requests.push(value);
          queueMicrotask(() => this.onload?.());
        }
      }
    );
    const pixels = new Uint8ClampedArray(36);
    for (let i = 0; i < 9; i++) pixels.set([0, 0, 0, 255], i * 4);
    pixels.set([200, 100, 50, 255], 16);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: () => ({ data: pixels }),
      putImageData: vi.fn(),
    } as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) =>
      cb(new Blob(['cutout']))
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:small-cutout');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const first = getThrowableCutout('bomb', 56);
    expect(getThrowableCutout('bomb', 84)).toBe(first);
    await expect(first).resolves.toBe('blob:small-cutout');
    expect(requests).toEqual(['/images/throwables/stylized/bomb-192.webp']);
    expect(peekThrowableCutout('bomb', 96)).toBe('blob:small-cutout');
    expect(peekThrowableCutout('bomb', 128)).toBeNull();
  });
  it('uses the larger thumbnail for large displays and retains the raw fallback', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'Image',
      class {
        onerror: (() => void) | null = null;
        set src(value: string) {
          requests.push(value);
          queueMicrotask(() => this.onerror?.());
        }
      }
    );
    await expect(getThrowableCutout('bomb', 128)).rejects.toThrow('failed to load');
    expect(requests).toEqual([
      '/images/throwables/stylized/bomb-320.webp',
      '/images/throwables/stylized/bomb-640.webp',
    ]);
  });
});
