import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import manifest from '../../src/throwables/artwork.generated.json';

const images: Array<{
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  resolve: () => void;
  reject: (e: Error) => void;
}> = [];
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  images.length = 0;
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      naturalWidth = 1254;
      naturalHeight = 1254;
      decoding = '';
      onerror = null;
      resolve!: () => void;
      reject!: (e: Error) => void;
      constructor() {
        images.push(this);
      }
      decode() {
        return new Promise<void>((resolve, reject) => {
          this.resolve = resolve;
          this.reject = reject;
        });
      }
    }
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('throwable artwork readiness', () => {
  it('declares every runtime sheet used by every rig, including shared effects', () => {
    for (const [id, names] of Object.entries(manifest.rigs)) {
      const src = fs.readFileSync(`src/throwables/rigs/${id}.tsx`, 'utf8');
      expect(
        [...new Set([...src.matchAll(/src="([a-z0-9_-]+)"/g)].map((m) => m[1]))].sort()
      ).toEqual(names);
    }
    const ids = fs
      .readdirSync('src/throwables/rigs')
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => f.slice(0, -4))
      .sort();
    expect(Object.keys(manifest.rigs).sort()).toEqual(ids);
  });

  it('deduplicates concurrent loads and waits for all shared sheets', async () => {
    const { prepareThrowableArtwork } = await import('../../src/throwables/artwork');
    const a = prepareThrowableArtwork('cool_sunglasses_emoji');
    const b = prepareThrowableArtwork('cool_sunglasses_emoji');
    expect(images).toHaveLength(2);
    const done = vi.fn();
    a.then(done);
    images[0].resolve();
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    images[1].resolve();
    await Promise.all([a, b]);
    expect(done).toHaveBeenCalledOnce();
  });

  it('rejects broken artwork and really retries after a failure', async () => {
    const { prepareThrowableArtwork } = await import('../../src/throwables/artwork');
    const a = prepareThrowableArtwork('heart');
    const rejected = expect(a).rejects.toThrow('could not decode');
    images[0].reject(new Error('offline'));
    await rejected;
    const b = prepareThrowableArtwork('heart');
    expect(images).toHaveLength(2);
    images[1].resolve();
    await b;
  });

  it('rejects the wrong asset dimensions instead of charging for bad crops', async () => {
    const { prepareThrowableArtwork } = await import('../../src/throwables/artwork');
    const a = prepareThrowableArtwork('tennis_ball');
    const rejected = expect(a).rejects.toThrow('dimensions');
    images[0].resolve();
    await rejected;
    const b = prepareThrowableArtwork('tennis_ball');
    images[1].naturalWidth = 1264;
    images[1].naturalHeight = 1244;
    images[1].resolve();
    await b;
  });

  it('settles a stalled decode at the network deadline and allows retry', async () => {
    const { prepareThrowableArtwork } = await import('../../src/throwables/artwork');
    const a = prepareThrowableArtwork('heart');
    const rejected = expect(a).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    const b = prepareThrowableArtwork('heart');
    images[1].resolve();
    await b;
    images[0].resolve();
    await Promise.resolve();
  });
});
