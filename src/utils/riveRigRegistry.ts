/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RIVE RIG REGISTRY — which avatars have a rigged .riv, if any
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY A MANIFEST AND NOT A PROBE
 * The obvious implementation is "request <slug>.riv and see if it 404s". That
 * is nine speculative requests per table, every table, forever — and today all
 * nine would fail, because no avatar is rigged yet. One manifest is one request
 * whose failure is cached for the session.
 *
 * THE ZERO-RIG CASE IS THE IMPORTANT ONE
 * Right now `/avatars/rive/manifest.json` does not exist. That is not an error
 * state, it is the normal state, and it must be completely silent: one 404, no
 * console noise, no Sentry report, no retry, and every seat falls straight
 * through to the CSS choreography that is already live. If this file ever makes
 * a player's table slower or noisier while there are no rigs, it is wrong.
 *
 * THE ART IS THE BLOCKER, NOT THIS
 * A .riv is authored in the Rive editor. Measured 2026-08-21: the table avatars
 * are 125x170 portrait crops, mostly head-and-shoulders, so a rig can drive a
 * blink, a head turn, a shrug or a cape sway — but NOT an arm reaching for the
 * pot, because no arm was drawn. See docs/RIVE-AVATAR-CONTRACT.md.
 */

/** Shape of /avatars/rive/manifest.json. */
export interface RiveManifest {
  /**
   * Map of avatar slug -> .riv filename, relative to /avatars/rive/.
   * The slug is the `{tier}_{name}` stem already used by the table artwork,
   * so `vip_alien` maps to whatever file rigs vip_alien.
   */
  rigs: Record<string, string>;
  /** Bumped by the asset pipeline; lets a future cache key on it. */
  version?: number;
}

const MANIFEST_URL = 'https://smarter.poker/avatars/rive/manifest.json';
const RIG_BASE = 'https://smarter.poker/avatars/rive/';

/**
 * Single in-flight promise for the whole session. Resolves to null when there
 * is no manifest, which is the current and expected state — cached so nine
 * seats do not each discover that independently.
 */
let manifestPromise: Promise<RiveManifest | null> | null = null;

export function loadRiveManifest(): Promise<RiveManifest | null> {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'force-cache' });
      if (!res.ok) return null; // 404 is the normal case today. Silent.
      const json = (await res.json()) as RiveManifest;
      if (!json || typeof json !== 'object' || !json.rigs) return null;
      return json;
    } catch {
      // Offline, blocked, or malformed. A missing rig must never surface to a
      // player as anything other than the static avatar they already had.
      return null;
    }
  })();
  return manifestPromise;
}

/**
 * The `{tier}_{name}` stem for a table avatar URL, or null if this is not
 * library bust art (uploaded photos and generated SVG monograms are never
 * rigged — there is nothing to rig).
 */
export function rigSlugForAvatarUrl(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null;
  const m = avatarUrl.match(/\/avatars\/table\/((?:vip|free)_[^/.@]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Absolute URL of the .riv for this avatar, or null when it has no rig. */
export async function riveUrlForAvatar(
  avatarUrl: string | null | undefined
): Promise<string | null> {
  const slug = rigSlugForAvatarUrl(avatarUrl);
  if (!slug) return null;
  const manifest = await loadRiveManifest();
  if (!manifest) return null;
  const file = manifest.rigs[slug];
  return file ? RIG_BASE + file : null;
}

/** Test seam — resets the session cache so each test starts clean. */
export function __resetRiveManifestCache(): void {
  manifestPromise = null;
}
