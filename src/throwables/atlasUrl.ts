import manifest from './artwork.generated.json';
const hashes: Record<string, string> = manifest.hashes;
/** Renderer and readiness use identical content-addressed cache identities. */
export function throwableAtlasUrl(name: string): string {
  const hash = hashes[name];
  if (!hash) throw new Error(`Unknown throwable atlas: ${name}`);
  return `${import.meta.env.BASE_URL}images/throwables/animated/${name}.webp?v=${hash}`;
}
