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
});

describe('cutout delivery sizing', () => {
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
