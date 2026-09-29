/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HUB PICTURES — a picture the World Hub serves reaches the app (native only)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Player pictures are stored as ROOT-RELATIVE paths on the World Hub's origin:
 * profiles.arena_avatar_url holds '/avatars/table/...' for 1,243 players and
 * avatar_url for 283, the Hub's /api/avatars catalog answers
 * '/avatars/free/rockstar.webp', and club logos can be '/hub/...'. On the web
 * the Hub IS the origin, so they load. Inside the app the origin is
 * https://localhost (capacitor://localhost on iOS) and none of those files are
 * in the bundle. Found on the Android emulator 2026-09-29: the Avatar Gallery -
 * the first thing a new player opens - showed twenty-five question marks, and
 * the Complete Your Profile card a broken image. Table seats were spared only
 * because getAvatarWithFallback already builds absolute addresses.
 *
 * Rewriting every <img> that might show one is dozens of sites today and a
 * trap for every site written tomorrow - the fetch shim's reasoning. So the
 * app installs ONE shim at boot: an <img> or <source> address that is
 * root-relative, and whose first path segment is NOT part of this bundle, is
 * loaded from https://smarter.poker. The build lists the bundle's own
 * top-level entries (__NATIVE_BUNDLE_ROOTS__, scripts/native/bundle-roots.mjs),
 * so '/images/...' and '/default-avatar.png' stay local. Without that list the
 * shim does nothing rather than guess.
 *
 * It covers what React renders (setAttribute) and what code assigns
 * (img.src = ...). Installed from main.tsx's native boot path; never loaded on
 * the web.
 */

import { WEB_ORIGIN } from '../appBase';

declare const __NATIVE_BUNDLE_ROOTS__: readonly string[] | undefined;

const BUNDLE_ROOTS: ReadonlySet<string> = new Set(
  typeof __NATIVE_BUNDLE_ROOTS__ !== 'undefined' ? __NATIVE_BUNDLE_ROOTS__ : []
);

function localOrigin(): string {
  try {
    return typeof location !== 'undefined' ? location.origin : '';
  } catch {
    return '';
  }
}

/** Where a picture must be loaded from inside the app. */
export function hubPictureUrl(
  value: string,
  bundleRoots: ReadonlySet<string> = BUNDLE_ROOTS,
  origin: string = localOrigin()
): string {
  if (typeof value !== 'string' || value === '' || bundleRoots.size === 0) return value;
  let path = value;
  // An address already resolved against the app's own origin (code that
  // copies one image's .src into another) is the same miss.
  if (origin && origin !== 'null' && value.startsWith(`${origin}/`))
    path = value.slice(origin.length);
  // Root-relative only: 'https:', 'data:', 'blob:' and protocol-relative '//' pass.
  if (path.charCodeAt(0) !== 47 || path.charCodeAt(1) === 47) return value;
  const first = path.slice(1).split(/[/?#]/, 1)[0];
  if (!first || bundleRoots.has(first)) return value;
  return `${WEB_ORIGIN}${path}`;
}

/** The same, for each candidate of a srcset. A data: URI's commas are left alone. */
export function hubPictureSrcset(
  value: string,
  bundleRoots: ReadonlySet<string> = BUNDLE_ROOTS,
  origin: string = localOrigin()
): string {
  if (typeof value !== 'string' || value === '' || value.includes('data:')) return value;
  return value
    .split(',')
    .map((candidate) => {
      const [url, ...descriptor] = candidate.trim().split(/\s+/);
      if (!url) return candidate;
      return [hubPictureUrl(url, bundleRoots, origin), ...descriptor].join(' ');
    })
    .join(', ');
}

function wrapUrlProperty(proto: object, prop: 'src' | 'srcset', map: (v: string) => string): void {
  const own = Object.getOwnPropertyDescriptor(proto, prop);
  if (!own?.get || !own.set) return;
  const { get, set } = own;
  Object.defineProperty(proto, prop, {
    configurable: true,
    enumerable: own.enumerable,
    get(this: Element) {
      return get.call(this);
    },
    set(this: Element, v: unknown) {
      set.call(this, typeof v === 'string' ? map(v) : v);
    },
  });
}

let installed = false;

export function installHubPictureShim(): void {
  if (installed || typeof window === 'undefined' || BUNDLE_ROOTS.size === 0) return;
  installed = true;
  const setAttribute = Element.prototype.setAttribute;
  for (const proto of [HTMLImageElement.prototype, HTMLSourceElement.prototype]) {
    wrapUrlProperty(proto, 'src', (v) => hubPictureUrl(v));
    wrapUrlProperty(proto, 'srcset', (v) => hubPictureSrcset(v));
    Object.defineProperty(proto, 'setAttribute', {
      configurable: true,
      writable: true,
      value: function setAttributeForHubPictures(this: Element, name: string, value: string) {
        const n = String(name).toLowerCase();
        const v =
          n === 'src'
            ? hubPictureUrl(String(value))
            : n === 'srcset'
              ? hubPictureSrcset(String(value))
              : value;
        return setAttribute.call(this, name, v);
      },
    });
  }
}
