import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import manifest from '../../src/throwables/stills.generated.json';
import inventory from '../../docs/throwables/STYLIZED-SOURCE-INVENTORY.json';
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        getPublicUrl: () => ({ data: { publicUrl: 'https://storage.example/original.jpg' } }),
      }),
    },
  },
}));
import { getThrowableImageUrl, getThrowableRawUrl } from '../../src/services/ThrowableService';
import { knockOutBackground, PREMIUM_THROWABLE_MATTE } from '../../src/services/ThrowableCutout';

describe('premium picker delivery', () => {
  it('covers every approved non-glove still at all three verified delivery sizes', async () => {
    expect(Object.keys(manifest).sort()).toEqual(inventory.map((x) => x.id).sort());
    for (const [id, buckets] of Object.entries(manifest)) {
      for (const [bucket, file] of Object.entries(buckets)) {
        const bytes = readFileSync(join('public', file));
        const metadata = await sharp(bytes).metadata();
        expect(metadata.format, id).toBe('webp');
        expect(metadata.width, id).toBe(Number(bucket));
        expect(metadata.height, id).toBe(Number(bucket));
        expect(file).toContain(createHash('sha256').update(bytes).digest('hex').slice(0, 12));
      }
      expect(getThrowableImageUrl(id, 84)).toBe(`${import.meta.env.BASE_URL}${buckets['192']}`);
      expect(getThrowableImageUrl(id, 128)).toBe(`${import.meta.env.BASE_URL}${buckets['320']}`);
      expect(getThrowableRawUrl(id)).toBe(`${import.meta.env.BASE_URL}${buckets['640']}`);
    }
  });
  it('removes a clean background without erasing a dark prop connected to it', () => {
    const pixels = new Uint8ClampedArray(9 * 4);
    for (let i = 0; i < 9; i++) pixels.set([0, 0, 0, 255], i * 4);
    pixels.set([35, 30, 29, 255], 4 * 4);
    const legacy = pixels.slice();
    knockOutBackground(legacy, 3, 3);
    expect(legacy[4 * 4 + 3]).toBeLessThan(255);
    knockOutBackground(pixels, 3, 3, PREMIUM_THROWABLE_MATTE);
    expect(pixels[3]).toBe(0);
    expect([...pixels.slice(4 * 4, 5 * 4)]).toEqual([35, 30, 29, 255]);
  });
  it('keeps the actual black sphere opaque at every delivery size', async () => {
    for (const file of Object.values(manifest.magic_8_ball)) {
      const { data, info } = await sharp(join('public', file))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const pixels = new Uint8ClampedArray(data);
      knockOutBackground(pixels, info.width, info.height, PREMIUM_THROWABLE_MATTE);
      expect(pixels[3], file).toBe(0);
      for (const [x, y] of [
        [0.5, 0.2],
        [0.5, 0.8],
        [0.2, 0.5],
        [0.8, 0.5],
      ]) {
        const offset = (Math.floor(y * info.height) * info.width + Math.floor(x * info.width)) * 4;
        expect(pixels[offset + 3], `${file} at ${x},${y}`).toBe(255);
      }
    }
  });
});
