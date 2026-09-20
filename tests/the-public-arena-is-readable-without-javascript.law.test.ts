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
 *      the prerender renders the same questions from the same source;
 *   5. the web fonts are declared once: the self-hosted stylesheet is inlined
 *      in place of its async link, and no stylesheet under src re-imports the
 *      same faces from Google Fonts (a later declaration wins the cascade and
 *      every word swaps to a fallback and back while it loads).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_PATHS } from '../src/lib/seo';
import { FAQ_ITEMS } from '../src/pages/helpContent';
// @ts-expect-error - a plain .mjs script with named exports
import {
  composeDocument,
  fontHeadMarkup,
  latinFontUrls,
  replaceFontStylesheet,
  verifyDocument,
} from '../scripts/prerender-public-routes.mjs';

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
    // The landing is a sibling BEFORE #root, with #root hidden while it exists.
    expect(landing).toContain('<div id="prerender-landing" data-prerender="landing">');
    expect(landing).toMatch(/body:has\(#prerender-landing\) #root\{display:none\}/);
    expect(landing.indexOf('id="prerender-landing"')).toBeLessThan(
      landing.indexOf('<div id="root"></div>')
    );
    expect(readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')).toMatch(
      /releasePrerenderedLanding\(\)/
    );
    expect(landing).toContain('localStorage.getItem("smarter-poker-auth")');
    expect(landing).toContain(
      '<link rel="canonical" href="https://smarter.poker/hub/club-arena" />'
    );
  });

  it('a heading inside a script does not satisfy the h1 guard', () => {
    // index.html's last-resort screen is a JS string containing `<h1 ...>`.
    const words = Array.from({ length: 130 }, (_, i) => `w${i}`).join(' ');
    const shellScript = `<script>root.innerHTML = '<div><h1>Loading Failed</h1></div>'</script>`;
    const doc = `<html><head>${shellScript}<meta name="robots" content="index, follow" /><link rel="canonical" href="https://smarter.poker/hub/club-arena/help" /></head><body>${shellScript}<div id="root"><p>${words}</p></div></body></html>`;
    expect(() => verifyDocument('/help', doc)).toThrow(/no <h1>/);
    const withHeading = doc.replace(`<p>${words}</p>`, `<h1>Help Center</h1><p>${words}</p>`);
    expect(verifyDocument('/help', withHeading)).toBeGreaterThanOrEqual(130);
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

  it('the fonts are declared once: the stylesheet is inlined in place of its async link', () => {
    const fontsCss = [
      '/* latin-ext */',
      "@font-face { font-family: 'Cinzel'; font-style: normal; font-weight: 400; font-display: swap; src: url(/hub/club-arena/fonts/cinzel-ext.woff2) format('woff2'); unicode-range: U+0100-02BA; }",
      '/* latin */',
      "@font-face { font-family: 'Cinzel'; font-style: normal; font-weight: 400; font-display: swap; src: url(/hub/club-arena/fonts/cinzel.woff2) format('woff2'); unicode-range: U+0000-00FF, U+0131; }",
      "@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; font-display: swap; src: url(/hub/club-arena/fonts/inter.woff2) format('woff2'); unicode-range: U+0000-00FF, U+0131; }",
      "@font-face { font-family: 'Inter'; font-style: normal; font-weight: 700; font-display: swap; src: url(/hub/club-arena/fonts/inter.woff2) format('woff2'); unicode-range: U+0000-00FF, U+0131; }",
      "@font-face { font-family: 'Rajdhani'; font-style: normal; font-weight: 400; font-display: swap; src: url(/hub/club-arena/fonts/rajdhani.woff2) format('woff2'); unicode-range: U+0000-00FF; }",
    ].join('\n');
    expect(latinFontUrls(fontsCss)).toEqual([
      '/hub/club-arena/fonts/cinzel.woff2',
      '/hub/club-arena/fonts/inter.woff2',
    ]);
    const fonts = {
      file: 'fonts-abc123.css',
      css: fontsCss
        .replace(/\/\*[^*]*\*\//g, '')
        .replace(/\s+/g, ' ')
        .trim(),
      urls: latinFontUrls(fontsCss),
    };
    const markup = fontHeadMarkup(fonts);
    expect(markup).toContain(
      '<link rel="preload" href="/hub/club-arena/fonts/cinzel.woff2" as="font" type="font/woff2" crossorigin />'
    );
    expect(markup).toContain('<style data-prerender="fonts">@font-face');
    expect(markup).not.toContain('/* latin */');
    expect((markup.match(/@font-face/g) || []).length).toBe(5);

    const shell = [
      '<head>',
      '    <link',
      '      href="/hub/club-arena/fonts/fonts-abc123.css"',
      '      rel="stylesheet"',
      '      media="print"',
      '      onload="this.media = \'all\'"',
      '    />',
      '    <noscript>',
      '      <link',
      '        href="/hub/club-arena/fonts/fonts-abc123.css"',
      '        rel="stylesheet"',
      '      />',
      '    </noscript>',
      '    <link rel="stylesheet" crossorigin href="/hub/club-arena/assets/index-x.css">',
      '</head>',
    ].join('\n');
    const out = replaceFontStylesheet(shell, 'fonts-abc123.css', markup);
    expect(out).not.toContain('fonts-abc123.css');
    expect(out).not.toContain('<noscript>');
    expect(out.indexOf('data-prerender="fonts"')).toBeLessThan(out.indexOf('index-x.css'));
    expect(() => replaceFontStylesheet(out, 'fonts-abc123.css', markup)).toThrow(/no async link/);
    expect(fontHeadMarkup(null)).toBe('');
  });

  it('no stylesheet under src imports Google Fonts: the faces are declared once, in index.html', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          /\.css$/.test(entry.name) &&
          /@import\s+url\(['"]?https:\/\/fonts\.googleapis\.com/.test(readFileSync(full, 'utf8'))
        )
          offenders.push(full.slice(ROOT.length + 1));
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders).toEqual([]);
    const shell = read('index.html');
    expect(shell).toMatch(/family=Cinzel:wght@400;500;600;700&/);
  });
});
