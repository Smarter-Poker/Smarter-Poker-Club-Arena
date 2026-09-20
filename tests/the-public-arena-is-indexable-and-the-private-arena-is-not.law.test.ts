/**
 * The arena root, help centre and legal documents are indexable with their
 * own canonical URL; every signed-in surface is noindex with no canonical.
 * Regressing either direction is what this pins.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applySeo,
  canonicalUrl,
  DEFAULT_OG_IMAGE,
  fullTitle,
  normalisePath,
  PUBLIC_PATHS,
  resolveSeo,
  ROBOTS_INDEX,
  ROBOTS_NOINDEX,
} from '../src/lib/seo';

describe('resolveSeo', () => {
  it('indexes the public surfaces with their own canonical path', () => {
    for (const path of [
      '/',
      '/help',
      '/legal',
      '/legal/tos',
      '/legal/privacy',
      '/legal/fair-gaming',
      '/legal/promotions',
    ]) {
      const entry = resolveSeo(path);
      expect(entry.index, path).toBe(true);
      expect(entry.canonicalPath, path).toBe(path);
      expect(entry.description.length, path).toBeGreaterThan(60);
    }
  });

  it('tolerates a trailing slash', () => {
    expect(resolveSeo('/help/').canonicalPath).toBe('/help');
    expect(normalisePath('/')).toBe('/');
    expect(normalisePath('')).toBe('/');
  });

  it('marks every signed-in surface noindex', () => {
    for (const path of [
      '/cashier',
      '/wallet',
      '/settings',
      '/table/abc',
      '/clubs/123/dashboard',
      '/messages',
      '/profile/9',
      '/share/hand/x',
      '/replay',
    ]) {
      expect(resolveSeo(path).index, path).toBe(false);
    }
  });

  it('exposes the public paths for the sitemap', () => {
    expect(PUBLIC_PATHS).toContain('/');
    expect(PUBLIC_PATHS).toContain('/help');
    expect(PUBLIC_PATHS).not.toContain('/cashier');
  });
});

describe('canonicalUrl', () => {
  it('builds absolute arena URLs with no trailing slash', () => {
    expect(canonicalUrl('/')).toBe('https://smarter.poker/hub/club-arena');
    expect(canonicalUrl('')).toBe('https://smarter.poker/hub/club-arena');
    expect(canonicalUrl('/legal/tos')).toBe('https://smarter.poker/hub/club-arena/legal/tos');
    expect(canonicalUrl('help/')).toBe('https://smarter.poker/hub/club-arena/help');
  });

  it('appends the site name once', () => {
    expect(fullTitle('Help Center')).toBe('Help Center | Smarter.Poker');
    expect(fullTitle('Poker Arena | Smarter.Poker')).toBe('Poker Arena | Smarter.Poker');
  });
});

describe('applySeo', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.title = '';
  });

  it('writes title, description, canonical, robots and JSON-LD for a public route', () => {
    const seo = resolveSeo('/help');
    applySeo(seo);
    // Derived, not pinned: this test is about applySeo writing the head, and
    // it should not fail the day a title is reworded (AEO phase 3,
    // 2026-09-18). That the suffix is appended exactly once has its own
    // test above.
    expect(document.title).toBe(`${seo.title} | Smarter.Poker`);
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      ROBOTS_INDEX
    );
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      'https://smarter.poker/hub/club-arena/help'
    );
    const ld = document.getElementById('route-jsonld');
    expect(ld?.getAttribute('type')).toBe('application/ld+json');
    expect(JSON.parse(ld!.textContent!)['@graph'][0]['@type']).toBe('BreadcrumbList');
  });

  it('flips a private route to noindex, drops the canonical and leaves the title alone', () => {
    applySeo(resolveSeo('/'));
    document.title = 'Cashier | Smarter.Poker';
    applySeo(resolveSeo('/cashier'));
    expect(document.title).toBe('Cashier | Smarter.Poker');
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      ROBOTS_NOINDEX
    );
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.getElementById('route-jsonld')).toBeNull();
  });

  it('reuses the same tags instead of stacking duplicates', () => {
    applySeo(resolveSeo('/'));
    applySeo(resolveSeo('/legal/tos'));
    applySeo(resolveSeo('/'));
    expect(document.head.querySelectorAll('meta[name="robots"]').length).toBe(1);
    expect(document.head.querySelectorAll('link[rel="canonical"]').length).toBe(1);
    expect(document.head.querySelectorAll('meta[name="description"]').length).toBe(1);
  });
});

describe('index.html', () => {
  it('does not tell Google to drop the whole arena', () => {
    const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      ''
    );
    expect(html).not.toMatch(/name="robots"\s+content="noindex/);
    expect(html).toMatch(
      /<link rel="canonical" href="https:\/\/smarter\.poker\/hub\/club-arena" \/>/
    );
    expect(html).toMatch(/application\/ld\+json/);
  });
});

describe('the Help Center FAQPage schema', () => {
  it('is built from the questions the page renders, and only those', async () => {
    const { FAQ_ITEMS } = await import('../src/pages/helpContent');
    const entry = resolveSeo('/help');
    const graph = Array.isArray(entry.jsonLd) ? entry.jsonLd : [entry.jsonLd];
    const faq = graph.find((n) => n && (n as { '@type'?: string })['@type'] === 'FAQPage') as
      | { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> }
      | undefined;
    expect(faq).toBeDefined();
    expect(faq!.mainEntity.map((q) => q.name)).toEqual(FAQ_ITEMS.map((i) => i.question));
    expect(faq!.mainEntity.every((q) => q.acceptedAnswer.text.length > 20)).toBe(true);
  });

  it('gives each public page the title its component sets, so the title never changes after hydration', () => {
    /*
     * This listed the five titles as literals, which pinned the strings
     * rather than the invariant its own name states, and it broke the day
     * the titles were prefixed with the product name (AEO phase 3,
     * 2026-09-18). What matters is that the component sets the SAME title
     * the head already carries, whatever that title is: otherwise the tab
     * changes the instant the page hydrates.
     *
     * So it now checks the relationship. The legal layout and the Help page
     * are the two components that set document.title for a public route,
     * and both must take it from resolveSeo rather than from their own copy.
     */
    const ROOT = join(__dirname, '..');
    const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

    const layout = read('src/components/legal/LegalDocumentLayout.tsx');
    expect(layout, 'the legal layout builds its tab title from resolveSeo').toContain(
      'resolveSeo(location.pathname)'
    );
    expect(
      layout.includes('document.title = `${title} | Smarter.Poker`'),
      'the legal layout must not rebuild the tab title from the visible heading'
    ).toBe(false);

    const help = read('src/pages/HelpPage.tsx');
    const helpTitle = resolveSeo('/help').title;
    expect(help, 'the Help page sets the title its own head declares').toContain(
      `document.title = '${helpTitle} | Smarter.Poker'`
    );

    // And every public route still has a title to set.
    for (const route of [
      '/legal/fair-gaming',
      '/legal/tos',
      '/legal/privacy',
      '/legal/promotions',
      '/help',
    ]) {
      expect(resolveSeo(route).title, `${route} has a title`).toBeTruthy();
    }
  });
});

describe('the public arena is measured and light (discoverability phase 5, 2026-09-17)', () => {
  const ROOT = join(__dirname, '..');

  it('the route performance gate measures every prerendered public route, taken from the manifest', () => {
    const gate = readFileSync(join(ROOT, 'scripts/ci/route-performance.mjs'), 'utf8');
    expect(gate).toContain("'prerender-manifest.json'");
    expect(gate).toContain('export function prerenderedRoutes(');
    expect(gate).toContain(
      "entry.route === '/' ? '/hub/club-arena/' : `/hub/club-arena${entry.route}/`"
    );
    expect(gate).toContain(
      "const routes = [...publicRoutes, '/hub/club-arena/legal', '/hub/club-arena/health']"
    );
    // An empty manifest fails the gate rather than silently measuring nothing.
    expect(gate).toContain('has no routes; the public arena was not prerendered');
    expect(gate).toContain("violations.push('transfer > 3MB')");
  });

  it('the landing page records a view and each way in, through the consent-gated analytics path', () => {
    const page = readFileSync(join(ROOT, 'src/pages/PokerArenaLandingPage.tsx'), 'utf8');
    expect(page).toContain("import { capture } from '../lib/analytics'");
    expect(page).toContain("capture(LANDING_VIEWED, { product: 'poker_arena'");
    for (const call of [
      "trackCta('sign_up', 'hero')",
      "trackCta('sign_in', 'hero')",
      "trackCta('sign_up', 'closing')",
      "trackCta('sign_in', 'closing')",
    ]) {
      expect(page).toContain(call);
    }
    // The page still fetches nothing of its own: a crawler and a person get the same markup.
    expect(page).not.toMatch(/\bfetch\(/);
  });
});

describe('the public arena is accessible (discoverability phase 6, 2026-09-17)', () => {
  const ROOT = join(__dirname, '..');
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

  it('every prerendered route is audited with axe-core on every build, and a serious violation fails it', () => {
    const gate = read('scripts/ci/public-a11y.mjs');
    expect(gate).toContain("import AxeBuilder from '@axe-core/playwright'");
    expect(gate).toContain("'prerender-manifest.json'");
    expect(gate).toContain("export const FAILING_IMPACTS = new Set(['serious', 'critical'])");
    expect(gate).toContain("'wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'");
    expect(gate).toContain('has no routes; the public arena was not prerendered');
    expect(read('package.json')).toContain('"test:a11y": "node scripts/ci/public-a11y.mjs"');
    expect(read('.github/workflows/ci.yml')).toContain('run: npm run test:a11y');
  });

  it('there is one main landmark per page, and the skip link has a target on the landing page', () => {
    // AppLayout owns <main id="main-content"> for every route it wraps, so a
    // page inside it must not render a second <main>.
    for (const file of [
      'src/pages/HelpPage.tsx',
      'src/prerender/HelpPrerender.tsx',
      'src/components/legal/LegalDocumentLayout.tsx',
    ]) {
      expect(read(file), file).not.toMatch(/<main[\s>]/);
    }
    // The landing renders outside AppLayout (AuthGuard's publicFallback), so
    // it is the main landmark and the skip link's target.
    expect(read('src/pages/PokerArenaLandingPage.tsx')).toContain(
      '<main className={styles.page} id="main-content" tabIndex={-1}>'
    );
    expect(read('src/App.tsx')).toContain('href="#main-content" className="skip-link"');
    // The static prerender, which has no AppLayout, supplies the landmark itself.
    expect(read('src/prerender/entry-server.tsx')).toContain(
      '<main id="main-content" tabIndex={-1}>'
    );
  });
});

describe('Poker Arena has its own share card (discoverability phase 6, 2026-09-17)', () => {
  const ROOT = join(__dirname, '..');
  it('seo.ts and the static index.html name the same 1200x630 Poker Arena card', () => {
    expect(DEFAULT_OG_IMAGE).toBe('https://smarter.poker/images/og-poker-arena.jpg');
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(html).toContain(
      '<meta property="og:image" content="https://smarter.poker/images/og-poker-arena.jpg" />'
    );
    expect(html).toContain(
      '<meta name="twitter:image" content="https://smarter.poker/images/og-poker-arena.jpg" />'
    );
    expect(html).not.toContain('og-card.jpg');
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
  });
});
