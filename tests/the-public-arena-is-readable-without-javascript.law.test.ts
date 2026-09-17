/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: THE PUBLIC ARENA IS READABLE WITHOUT JAVASCRIPT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AEO phase 1, 2026-09-17. The origin serves one index.html whose body is an
 * empty #root; the crawlers that decide what ChatGPT, Claude, Perplexity and
 * Meta AI can cite never run the bundle, so to them the arena was nothing.
 * scripts/prerender-public-routes.mjs renders the indexable routes to static
 * HTML at the end of build:ci. This pins the parts that would rot silently:
 *
 *   1. build:ci runs the prerender after the shell is final (fonts self-hosted,
 *      service-worker precache injected) and before provenance is stamped;
 *   2. the prerender entry covers exactly the routes seo.ts marks indexable,
 *      with every deliberate exception written down;
 *   3. composeDocument swaps the route's title, description, canonical, robots
 *      and JSON-LD into the shell, puts the markup in #root, and wraps the
 *      landing in the block the session script removes for a signed-in player;
 *   4. the Help Center keeps every answer in the DOM (hidden, not absent) and
 *      the prerender renders the same questions from the same source.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_PATHS } from '../src/lib/seo';
import { FAQ_ITEMS } from '../src/pages/helpContent';
// @ts-expect-error - a plain .mjs script with named exports
import { composeDocument, verifyDocument } from '../scripts/prerender-public-routes.mjs';

const ROOT = join(__dirname, '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

describe('the public arena is readable without JavaScript', () => {
  it('build:ci prerenders after the shell is final and before provenance is stamped', () => {
    const { scripts } = JSON.parse(read('package.json'));
    const steps: string[] = scripts['build:ci'].split('&&').map((s: string) => s.trim());
    const at = (needle: string) => steps.findIndex((s) => s.includes(needle));
    expect(at('scripts/prerender-public-routes.mjs')).toBeGreaterThan(
      at('scripts/optimize-dist-media.mjs')
    );
    expect(at('scripts/prerender-public-routes.mjs')).toBeGreaterThan(
      at('scripts/self-host-fonts.mjs')
    );
    expect(at('scripts/prerender-public-routes.mjs')).toBeLessThan(
      at('scripts/stamp-build-provenance.mjs')
    );
  });

  it('the prerender entry covers exactly the indexable routes, exceptions written down', () => {
    const entry = read('src/prerender/entry-server.tsx');
    const pages = [...entry.matchAll(/^\s{2}'(\/[^']*)': \(\) => </gm)].map((m) => m[1]);
    const exceptions = [...entry.matchAll(/^\s{2}'(\/[^']*)':\n\s+'[^']{40,}'/gm)].map((m) => m[1]);
    expect(pages.length).toBeGreaterThanOrEqual(5);
    expect([...pages, ...exceptions].sort()).toEqual([...PUBLIC_PATHS].sort());
    expect(pages).toContain('/');
    expect(pages).toContain('/help');
    expect(pages).toContain('/legal/tos');
  });

  it('the prerender config is not a merge of the client config', () => {
    const config = read('vite.prerender.config.ts');
    expect(config).not.toMatch(/mergeConfig|from '\.\/vite\.config'/);
    expect(config).toMatch(/ssrEmitAssets: true/);
    expect(config).toMatch(/base: WEB_BASE/);
  });

  it('composeDocument writes the route head and the markup into #root', () => {
    const shell = [
      '<!doctype html><html><head>',
      '<title>Poker Arena | Private Online Poker Clubs | Smarter.Poker</title>',
      '<meta name="description" content="shell" />',
      '<!-- this said `noindex, nofollow` once; a comment is not a directive -->',
      '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />',
      '<link rel="canonical" href="https://smarter.poker/hub/club-arena" />',
      '<meta property="og:title" content="shell" />',
      '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[]}</script>',
      '</head><body><div id="root"></div></body></html>',
    ].join('\n');
    const words = Array.from({ length: 130 }, (_, i) => `Word${i}`).join(' ');
    const page = {
      path: '/legal/tos',
      html: `<main><h1>Terms Of Service</h1><p>${words}</p></main>`,
      seo: {
        title: 'Terms Of Service',
        description: 'The Terms.',
        canonicalPath: '/legal/tos',
        index: true,
        jsonLd: { '@type': 'WebPage', name: 'Terms Of Service' },
      },
    };
    const doc = composeDocument({ shell, page, css: '.x{color:red}' });
    expect(doc).toContain('<title>Terms Of Service | Smarter.Poker</title>');
    expect(doc).toContain('<meta name="description" content="The Terms." />');
    expect(doc).toContain(
      '<link rel="canonical" href="https://smarter.poker/hub/club-arena/legal/tos" />'
    );
    expect(doc).toContain(
      '<meta property="og:title" content="Terms Of Service | Smarter.Poker" />'
    );
    expect(doc).toContain(
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Terms Of Service"}</script>'
    );
    expect(doc).toContain('<style data-prerender="css">.x{color:red}</style>');
    expect(doc).toContain(
      '<div id="root"><div data-prerender="/legal/tos"><main><h1>Terms Of Service</h1>'
    );
    expect(doc).not.toContain('prerender-landing');
    expect(verifyDocument('/legal/tos', doc)).toBeGreaterThanOrEqual(130);

    const landing = composeDocument({
      shell,
      page: { ...page, path: '/', seo: { ...page.seo, canonicalPath: '/' } },
      css: '',
    });
    expect(landing).toContain(
      '<div id="root"><div id="prerender-landing" data-prerender="landing">'
    );
    expect(landing).toContain('localStorage.getItem("smarter-poker-auth")');
    expect(landing).toContain(
      '<link rel="canonical" href="https://smarter.poker/hub/club-arena" />'
    );
  });

  it('verifyDocument refuses an empty, noindex or uncanonical page', () => {
    const base =
      '<html><head><meta name="robots" content="index, follow" /><link rel="canonical" href="https://smarter.poker/hub/club-arena/help" /></head><body><div id="root"><h1>Help</h1></div></body></html>';
    expect(() => verifyDocument('/help', base)).toThrow(/words of readable text/);
    const words = Array.from({ length: 130 }, (_, i) => `w${i}`).join(' ');
    const full = base.replace('<h1>Help</h1>', `<h1>Help</h1><p>${words}</p>`);
    expect(verifyDocument('/help', full)).toBeGreaterThanOrEqual(130);
    expect(() =>
      verifyDocument('/help', full.replace('index, follow', 'noindex, nofollow'))
    ).toThrow(/not indexable/);
    expect(() => verifyDocument('/help', full.replace('<h1>Help</h1>', '<p>Help</p>'))).toThrow(
      /no <h1>/
    );
  });

  it('the Help Center keeps every answer in the DOM and the prerender renders the same questions', () => {
    const helpPage = read('src/pages/HelpPage.tsx');
    expect(helpPage).toMatch(/hidden=\{!isExpanded\}/);
    expect(helpPage).not.toMatch(/\{isExpanded && \(\s*<div className=\{styles\.answer\}/);
    expect(helpPage).toMatch(/from '\.\/helpContent'/);
    const prerender = read('src/prerender/HelpPrerender.tsx');
    expect(prerender).toMatch(/from '\.\.\/pages\/helpContent'/);
    expect(prerender).toMatch(/FAQ_ITEMS\.map/);
    expect(FAQ_ITEMS.length).toBeGreaterThanOrEqual(10);
    expect(read('src/pages/HelpPage.module.css')).toMatch(
      /\.answer\[hidden\]\s*\{\s*display: none;/
    );
  });
});
