/**
 * RFC-4122 v4 UUID with a safe fallback.
 *
 * `crypto.randomUUID` is undefined on non-secure (http) origins and in
 * Safari < 15.4. It is used on the idempotency-key path for every Club Arena
 * purchase and mutation, so it must never throw.
 *
 * Lives in its own module (rather than in the marketplace's shared file) so
 * that importing it from services/clubArenaApi.ts does not drag the whole
 * marketplace catalog into every chunk that talks to the API.
 */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export default uuid;
