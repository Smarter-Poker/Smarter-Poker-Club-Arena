/**
 * The native bundle's top-level entries, for src/lib/native/hubPictureShim.ts.
 *
 * public/ is copied to the root of dist-native/ and the build writes
 * index.html and assets/ beside it, so these are the only first path segments
 * a root-relative address can name and still find a file INSIDE the app. Any
 * other root-relative picture lives on the World Hub, and the shim loads it
 * from there. vite.config.ts hands this list to native builds only, as
 * __NATIVE_BUNDLE_ROOTS__.
 */
import { readdirSync } from 'node:fs';

/** @param {string} publicDir */
export function nativeBundleRoots(publicDir) {
  const names = readdirSync(publicDir).filter((n) => !n.startsWith('.'));
  return [...new Set([...names, 'index.html', 'assets'])].sort();
}
