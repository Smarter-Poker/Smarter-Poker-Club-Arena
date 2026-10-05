let fallbackSequence = 0;

/**
 * Create the UUID carried by every retry of one logical settings mutation.
 * Browsers supported by Club Arena expose Web Crypto; the fallback keeps
 * local test harnesses and older embedded webviews functional without reusing
 * a process-local value.
 */
export function createMutationId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    const seed = `${Date.now()}-${globalThis.performance?.now() ?? 0}-${fallbackSequence++}`;
    for (let index = 0; index < bytes.length; index += 1) {
      const code = seed.charCodeAt(index % seed.length);
      bytes[index] = (code + index * 37 + fallbackSequence * 17) & 0xff;
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
