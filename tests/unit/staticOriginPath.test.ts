/**
 * A production browser run reads the arena's static files from the arena
 * origin, and nothing else (2026-10-04).
 *
 * tests/e2e/support/staticOriginDirect.ts has the incident: Post-Deploy E2E
 * cold-loaded the arena about a thousand times an hour through the World
 * Hub's Vercel project, which bills every image, font and chunk.
 *
 * What is pinned here is the decision, because both of its edges matter:
 *   - a static file that stays on the public path is money spent for nothing;
 *   - a document, the service worker script, build-info.json or an API call
 *     that leaves the public path is a production check that stopped checking
 *     production.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { staticOriginUrl, targetsProduction, STATIC_ORIGIN } from '../e2e/support/staticOriginPath';

const PUBLIC = 'https://smarter.poker/hub/club-arena';

describe('which requests are read from the origin', () => {
  it.each([
    ['assets/index-Bx91kQ2a-v6.js', 'assets/index-Bx91kQ2a-v6.js'],
    ['assets/TablePage-9a8b7c6d-v6.css', 'assets/TablePage-9a8b7c6d-v6.css'],
    ['assets/club-buttons/primary.webp', 'assets/club-buttons/primary.webp'],
    ['images/global-header/menu.png', 'images/global-header/menu.png'],
    ['cards/as.webp', 'cards/as.webp'],
    ['club-logos/preset-01.webp', 'club-logos/preset-01.webp'],
    ['game-card-icons/nlh.png', 'game-card-icons/nlh.png'],
    ['fonts/fonts-0a1b2c3d.css', 'fonts/fonts-0a1b2c3d.css'],
    ['fonts/inter-latin.woff2', 'fonts/inter-latin.woff2'],
    ['sounds/chip.mp3', 'sounds/chip.mp3'],
    ['default-avatar.png', 'default-avatar.png'],
  ])('%s is read from the origin at the same path', (requested, expected) => {
    expect(staticOriginUrl(`${PUBLIC}/${requested}`)).toBe(`${STATIC_ORIGIN}/${expected}`);
  });

  it('keeps the query string, so a cache-busted request stays cache-busted', () => {
    expect(staticOriginUrl(`${PUBLIC}/images/a.png?v=3`)).toBe(`${STATIC_ORIGIN}/images/a.png?v=3`);
  });

  it.each([
    ['the bare route', PUBLIC],
    ['the route with a slash', `${PUBLIC}/`],
    ['a client route', `${PUBLIC}/cashier`],
    ['a client route with a dot in a segment', `${PUBLIC}/clubs/shark.club/tables`],
    ['index.html', `${PUBLIC}/index.html`],
    ['offline.html', `${PUBLIC}/offline.html`],
    ['the service worker script', `${PUBLIC}/sw-bus.js`],
    ['the release proof', `${PUBLIC}/build-info.json`],
    ['the manifest', `${PUBLIC}/manifest.json`],
    ['video', `${PUBLIC}/videos/intro.mp4`],
    ['a Hub API route', 'https://smarter.poker/api/club-arena/tables'],
    ['a World Hub page', 'https://smarter.poker/hub/training'],
    ['a World Hub asset', 'https://smarter.poker/_next/static/chunks/main.js'],
    ['a look-alike prefix', 'https://smarter.poker/hub/club-arena-archive/logo.png'],
    ['the origin itself', `${STATIC_ORIGIN}/assets/index-Bx91kQ2a-v6.js`],
    ['Supabase', 'https://kuklfnapbkmacvwxktbh.supabase.co/rest/v1/tables'],
    ['another host with the same path', 'https://example.com/hub/club-arena/assets/a.js'],
    ['plain http', 'http://smarter.poker/hub/club-arena/assets/a.js'],
    ['a path that climbs', `${PUBLIC}/assets/../index.html`],
    ['not a URL', 'not a url'],
  ])('%s stays on the public path', (_name, url) => {
    expect(staticOriginUrl(url)).toBeNull();
  });
});

describe('which runs are production runs', () => {
  it.each(['https://smarter.poker/hub/club-arena/', 'https://SMARTER.POKER/hub/club-arena/'])(
    '%s is production',
    (baseURL) => {
      expect(targetsProduction(baseURL)).toBe(true);
    }
  );

  it.each([
    'http://localhost:5173/hub/club-arena/',
    'http://127.0.0.1:4173/hub/club-arena/',
    'https://club-arena-preview.example/hub/club-arena/',
    'https://ca-static.smarter.poker/',
    'https://smarter.poker/',
    '',
  ])('%s is not, and is left exactly as it was', (baseURL) => {
    expect(targetsProduction(baseURL)).toBe(false);
  });
});

describe('the detour is wired where every runner process loads it, and can only fall back', () => {
  const config = readFileSync('playwright.config.ts', 'utf8');
  const installer = readFileSync('tests/e2e/support/staticOriginDirect.ts', 'utf8');

  it('playwright.config.ts installs it with the normalised base URL', () => {
    expect(config).toContain(
      "import { installStaticOriginDirect } from './tests/e2e/support/staticOriginDirect';"
    );
    expect(config).toMatch(/^installStaticOriginDirect\(baseURL\);$/m);
  });

  it('is Chromium only: WebKit keeps reading static files through the public path', () => {
    expect(installer).toMatch(/import \{ chromium,/);
    expect(installer).not.toMatch(/\bwebkit\b\s*[.,}]/);
    expect(installer).not.toMatch(/\bfirefox\b\s*[.,}]/);
  });

  it('never aborts a request: every exit is the origin answer or the public path', () => {
    expect(installer).not.toMatch(/route\.abort\(/);
    expect(installer.match(/route\.fallback\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(installer).toMatch(/response\.status\(\) >= 500/);
  });

  it('can be switched off for one run without a code change', () => {
    expect(installer).toContain("process.env.CA_E2E_STATIC_VIA_PUBLIC_PATH === '1'");
  });
});
