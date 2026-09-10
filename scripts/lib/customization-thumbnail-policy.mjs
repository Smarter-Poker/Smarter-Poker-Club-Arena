/**
 * Decide whether a Studio thumbnail should be written during this invocation,
 * and whether a committed one still matches the art it was made from.
 *
 * The policy deliberately accepts no timestamps. Git does not preserve mtimes,
 * so using them as build inputs makes identical protected checkouts produce
 * different tracked bytes and falsely marks production provenance as dirty.
 *
 * ── WHY A SOURCE HASH WAS ADDED (2026-09-09) ─────────────────────────────────
 * Generation is append-only: an existing derivative is rewritten only for an
 * explicit `--force` authoring run. That is the right call and it stays. Its
 * cost is that repairing a table skin and forgetting the authoring run ships a
 * thumbnail of the OLD art, and until now nothing could tell.
 *
 * That is the same failure this whole strand of work is made of - the art was
 * fixed at the source and the copy the player actually sees was not.
 *
 * IT CANNOT BE CAUGHT BY LOOKING AT THE PIXELS, and that was measured rather
 * than assumed. Comparing each committed thumbnail against a fresh regeneration
 * on 2026-09-09:
 *
 *   worst 16x16 block, same content, different sharp build : up to 37.7
 *   worst 16x16 block, genuinely stale (pre-repair art)    : as low as 17.7
 *
 * The bands overlap and they overlap the wrong way round, because a repaired
 * gold line is a small local change while an encoder version bump is a broad
 * faint one. `classic_green` stale scored 0.54 mean absolute difference against
 * `golden_sand` scoring 1.82 while being perfectly correct. No threshold on a
 * rendered comparison separates them.
 *
 * So do not measure the output. Record the INPUT. Every derivative carries the
 * sha256 of the file it was generated from, which is exact, costs nothing, and
 * does not care which libvips produced the bytes.
 */

/**
 * Ordinary builds stay hermetic: a committed derivative is never rewritten
 * except by an explicit authoring run. A stale derivative is stopped by
 * `tests/a-thumbnail-is-not-allowed-to-outlive-its-art.test.ts` at review time,
 * which is before the bytes reach a build, rather than by silently rewriting
 * tracked art inside the publisher.
 */
export function shouldGenerateCustomizationThumbnail({ outputExists, force = false }) {
  return force || !outputExists;
}

/**
 * Does this derivative still correspond to the art on disk?
 *
 * `unknown` is deliberately NOT stale. An asset with no recorded hash predates
 * the manifest, and reporting every one of those as broken on the day this
 * lands would bury the one that actually is.
 */
export function thumbnailSourceState({ recordedHash, currentHash }) {
  if (!recordedHash) return 'unknown';
  return recordedHash === currentHash ? 'current' : 'stale';
}

export function isThumbnailStale(args) {
  return thumbnailSourceState(args) === 'stale';
}

/** Where the manifest lives, relative to the repo root. */
export const THUMBNAIL_SOURCE_MANIFEST = 'src/assets/customization-thumbs/sources.json';
