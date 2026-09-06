/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE CUES — the client's view of the sound library (phase 1)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `cueManifest.generated.ts` is written by `scripts/audio/build-throwable-cues.mjs`
 * from `scripts/audio/throwable-cues.manifest.json`, the one place that says
 * where every shipped cue came from and under what licence. Never edit the
 * generated file by hand; edit the manifest and rebuild.
 *
 * A cue is either a FILE (`public/sounds/throwables/<name>.webm` + `.m4a`) or
 * a PLACEHOLDER: no file yet, and a legacy procedural recipe key to play in
 * its place until the library (plan 3.3.1, phase 6) supplies one. A spec may
 * name a placeholder; it may never name a cue that is in neither list, and
 * `tests/unit/throwableCuesAreLicensed.test.ts` holds that line.
 */

import { mediaUrl } from '../utils/mediaBase';
import { throwableSoundService } from '../services/ThrowableSoundService';
import { THROWABLE_CUE_MANIFEST, type CueManifestEntry } from './cueManifest.generated';

export type { CueManifestEntry };

export function cueEntry(name: string): CueManifestEntry | undefined {
  return THROWABLE_CUE_MANIFEST[name];
}

export function isPlaceholderCue(name: string): boolean {
  const e = THROWABLE_CUE_MANIFEST[name];
  return !e || e.placeholder === true;
}

/** Same rule as the knockout gloves: media, so it can move to the CDN. */
export function cueUrl(name: string, ext: 'webm' | 'm4a'): string {
  return mediaUrl(`sounds/throwables/${name}.${ext}`);
}

/** Legacy recipe to play for a placeholder cue (see ThrowableSoundService.playImpact). */
export function placeholderRecipe(name: string): string | undefined {
  return THROWABLE_CUE_MANIFEST[name]?.fallback;
}

/** Rig modules call this at import time so the first throw is warm. */
export function preloadThrowableCues(names: readonly string[]): void {
  const files = names.filter((n) => !isPlaceholderCue(n));
  if (files.length) throwableSoundService.preloadCues(files, cueUrl);
}
