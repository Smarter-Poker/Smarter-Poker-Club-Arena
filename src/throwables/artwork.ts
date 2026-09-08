import manifest from './artwork.generated.json';

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
function prepareSheet(name: string): Promise<void> {
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
    img.src = `${import.meta.env.BASE_URL}images/throwables/animated/${name}.webp`;
    img.decode().then(
      () => {
        const size = sizes[name];
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

/** Legacy items have no atlas to decode. Premium items require every sheet,
 * including shared effects, before a charge or a playback clock can start. */
export async function prepareThrowableArtwork(id: string): Promise<void> {
  const names = Object.prototype.hasOwnProperty.call(rigs, id) ? rigs[id] : [];
  await Promise.all(names.map(prepareSheet));
}
