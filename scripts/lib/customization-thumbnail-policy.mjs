/**
 * Decide whether a Studio thumbnail should be written during this invocation.
 *
 * The policy deliberately accepts no timestamps. Git does not preserve mtimes,
 * so using them as build inputs makes identical protected checkouts produce
 * different tracked bytes and falsely marks production provenance as dirty.
 */
export function shouldGenerateCustomizationThumbnail({ outputExists, force = false }) {
  return force || !outputExists;
}
