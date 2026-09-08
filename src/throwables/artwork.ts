import manifest from './artwork.generated.json';
import { throwableAtlasUrl } from './atlasUrl';
import stillManifest from './stills.generated.json';
const stills: Record<string, Record<string, string>> = stillManifest;

const rigs: Record<string, readonly string[]> = manifest.rigs;
const sizes: Record<string, readonly number[]> = manifest.sizes;
const pending = new Map<string, Promise<void>>();
const ready = new Set<string>();
const MAX_READY_SHEETS = 12;
const LOAD_TIMEOUT_MS = 10_000;

export function hasThrowableArtwork(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(rigs, id);
}

/** Share concurrent decodes without preloading the entire catalogue. Failed
 * requests are evicted so a later user retry actually retries the network. */
function prepareSheet(
  name: string,
  delivery?: { url: string; size: readonly number[] }
): Promise<void> {
  if (ready.has(name)) {
    ready.delete(name);
    ready.add(name);
    return Promise.resolve();
  }
  const existing = pending.get(name);
  if (existing) return existing;
  const task = new Promise<void>((resolve, reject) => {
    const img = new Image();
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      img.onerror = null;
      if (error) reject(error);
      else resolve();
    };
    // This is a network deadline, independent of the animation speed.
    const timeout = setTimeout(() => finish(new Error('Artwork load timed out')), LOAD_TIMEOUT_MS);
    img.decoding = 'async';
    img.onerror = () => finish(new Error('Artwork could not load'));
    img.src = delivery?.url ?? throwableAtlasUrl(name);
    img.decode().then(
      () => {
        const size = delivery?.size ?? sizes[name];
        if (!size || img.naturalWidth !== size[0] || img.naturalHeight !== size[1]) {
          finish(new Error('Artwork dimensions do not match the rig'));
        } else finish();
      },
      () => finish(new Error('Artwork could not decode'))
    );
  })
    .then(() => {
      ready.add(name);
      if (ready.size > MAX_READY_SHEETS) ready.delete(ready.values().next().value!);
    })
    .finally(() => pending.delete(name));
  pending.set(name, task);
  return task;
}

/** Require every atlas for a rig, or the approved static image for an item
 * awaiting its bespoke rig. A failed legacy image must not be charged either. */
export async function prepareThrowableArtwork(id: string): Promise<void> {
  if (hasThrowableArtwork(id)) {
    await Promise.all(rigs[id].map((name) => prepareSheet(name)));
    return;
  }
  const still = stills[id]?.['320'];
  if (still)
    await prepareSheet(`still:${id}`, {
      url: `${import.meta.env.BASE_URL}${still}`,
      size: [320, 320],
    });
}
