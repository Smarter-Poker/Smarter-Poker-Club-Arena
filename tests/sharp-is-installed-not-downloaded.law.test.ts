/**
 * LAW: sharp is a declared dependency, and the network install stays a net.
 * ═══════════════════════════════════════════════════════════════════════════
 * Added 2026-09-04. sharp was deliberately absent from package.json and
 * `scripts/lib/sharp-loader.mjs` shelled out to `npm install --no-save sharp`
 * into os.tmpdir() on every build that needed it. Measured on the estate's CI
 * logs that was 97.2s cold and still 76.6s warm - npm re-resolves over the
 * network either way - and it happened THREE times per merge. It was the
 * single largest item on the push-to-live critical path and the largest
 * source of its run-to-run variance.
 *
 * The original reason it was kept out is real and is recorded in the loader:
 * `npm install` under NODE_ENV=production prunes devDependencies. That is not
 * how this repo installs. Every workflow runs `npm ci` FIRST and sets
 * NODE_ENV=production only on the build step's own env, so the devDependency
 * is present by the time anything imports it. `npm ci --ignore-scripts` (the
 * typecheck and CSS Beat jobs) is fine too: sharp 0.34 ships prebuilt
 * `@img/sharp-*` binaries and needs no install script.
 *
 * THE FALLBACK STAYS. If the direct import ever fails on a runner, the loader
 * installs into a temp prefix exactly as before - that is a no-regression net,
 * not dead code, and deleting it turns a slow build into a broken one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('sharp is installed, not downloaded mid-build', () => {
  it('is declared, so no build has to fetch it', () => {
    const declared = pkg.devDependencies?.sharp ?? pkg.dependencies?.sharp;
    expect(declared, 'sharp must be a declared dependency').toBeTruthy();
  });

  it('the lockfile carries the binaries the Linux runners need', () => {
    const lock = read('package-lock.json');
    // The estate's runners are linux-x64. Without these entries in the
    // lockfile, `npm ci` on a runner installs sharp with no native binary and
    // the import fails - which would look like "the change did nothing"
    // because the loader would silently fall back to the network install.
    for (const p of [
      '"node_modules/@img/sharp-linux-x64"',
      '"node_modules/@img/sharp-libvips-linux-x64"',
      '"node_modules/@img/sharp-linux-arm64"',
    ]) {
      expect(lock, `${p} missing from package-lock.json`).toContain(p);
    }
  });

  it('the temp-prefix fallback is still there as a net', () => {
    const loader = read('scripts/lib/sharp-loader.mjs');
    expect(loader).toContain("await import('sharp')");
    expect(loader).toMatch(/npm install .*sharp/);
    // Returns null rather than throwing: callers treat sharp as optional and a
    // missed optimization must never block a deploy.
    expect(loader).toMatch(/return null/);
  });
});
