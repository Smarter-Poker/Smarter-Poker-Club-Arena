import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeDocument } from '../scripts/prerender-public-routes.mjs';

const shell = `<!doctype html><html><head><title>Shell</title>
<meta name="description" content="shell" /><meta name="robots" content="index, follow" />
<link rel="canonical" href="https://smarter.poker/hub/club-arena" />
<script type="application/ld+json">{}</script></head><body><div id="root"></div></body></html>`;
const artwork = '/landing-only.png';
const page = {
  path: '/',
  html: `<main><h1>Poker Arena</h1><img src="${artwork}" /></main>`,
  seo: { title: 'Poker Arena', description: 'Arena', index: true, jsonLd: {} },
};
function doc() {
  return composeDocument({ shell, page, css: '' });
}
function activate(path: string, session: string | null = null, storageThrows = false) {
  document.body.innerHTML = doc().split('<body>')[1].split('</body>')[0];
  const script = document.body.querySelector('script')!.textContent!;
  const guard = new Function('document', 'location', 'window', script);
  guard(
    document,
    { pathname: path },
    {
      localStorage: {
        getItem: () => {
          if (storageThrows) throw new Error('Storage unavailable');
          return session;
        },
      },
    }
  );
}
afterEach(() => {
  document.body.innerHTML = '';
});
describe('the origin shared SPA fallback does not activate landing artwork on deep links', () => {
  it('ships artwork inside an inert template and retains the complete no-JavaScript fallback', () => {
    const html = doc();
    document.body.innerHTML = html.split('<body>')[1].split('</body>')[0];
    expect(
      document.querySelector('template')?.content.querySelector('img')?.getAttribute('src')
    ).toBe(artwork);
    expect(html).toContain(
      `<noscript><div id="prerender-landing" data-prerender="landing">${page.html}</div></noscript>`
    );
    expect(html).not.toContain(
      `<div id="prerender-landing" data-prerender="landing">${page.html}</div><script>`
    );
  });
  it.each(['/hub/club-arena/health', '/hub/club-arena/health/', '/hub/club-arena/table/example'])(
    'never activates landing content on %s, including unavailable storage',
    (path) => {
      for (const storageThrows of [false, true]) {
        activate(path, null, storageThrows);
        expect(document.querySelector('template')).toBeNull();
        // The only literal fallback belongs to noscript; active markup is absent.
        expect(
          [...document.querySelectorAll('#prerender-landing')].every((node) =>
            node.closest('noscript')
          )
        ).toBe(true);
        expect(document.querySelector('#root')).not.toBeNull();
      }
    }
  );
  it.each(['/hub/club-arena', '/hub/club-arena/'])(
    'activates the identical signed-out landing before root at %s',
    (path) => {
      activate(path);
      const active = [...document.querySelectorAll('#prerender-landing')].find(
        (node) => !node.closest('noscript')
      )!;
      const expected = document.createElement('template');
      expected.innerHTML = page.html;
      expect(active.innerHTML).toBe(expected.innerHTML);
      expect(
        active.compareDocumentPosition(document.querySelector('#root')!) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
  );
  it('keeps a signed-in root from activating the landing', () => {
    activate('/hub/club-arena/', 'session');
    expect(
      [...document.querySelectorAll('#prerender-landing')].every((node) => node.closest('noscript'))
    ).toBe(true);
  });
  it('retains the origin global fallback and the unchanged route-transfer budget', () => {
    const origin = readFileSync(join(process.cwd(), 'infra/ca-origin/Caddyfile'), 'utf8');
    expect(origin).toContain('rewrite @route /index.html');
    const perf = readFileSync(join(process.cwd(), 'scripts/ci/route-performance.mjs'), 'utf8');
    expect(perf).toContain(
      "if (transfer.initialBytes > 3_000_000) violations.push('transfer > 3MB')"
    );
  });
});
