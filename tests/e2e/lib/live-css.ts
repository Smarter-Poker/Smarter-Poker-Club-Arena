/**
 * Read the real bundle manifest and every declared stylesheet, then install
 * them into an isolated document at the same origin. Each stylesheet remains
 * a separate element in manifest order, preserving its imports and cascade.
 * One browser call avoids per-stylesheet protocol overhead on large bundles.
 * Application scripts never start behind a synthetic layout fixture.
 *
 * Unreadable or incomplete styles report an explicit unknown result. Required
 * CI fails on that result; local exploratory callers can report it as skipped.
 */

import { test, type Page, type Route } from '@playwright/test';

export interface LiveCssLoad {
  /** Stylesheets actually installed. Zero means the bundle could not be read. */
  sheets: number;
  /** Total CSS bytes installed - a handful of bytes is as suspect as none. */
  bytes: number;
  /** Present only when something could not be read. */
  reason?: string;
}

/** Enough CSS to be a real bundle rather than a stub or an error page. */
const MIN_BYTES = 2_000;

interface Options {
  /**
   * Value for `--animation-speed` on the root once the CSS is in. Four of the
   * five specs pin it to '1'; multi-table.spec.ts deliberately does not, so
   * this defaults to leaving it alone.
   */
  animationSpeed?: string | null;
  /** Attempts before giving up. Each attempt is a fresh set of reads. */
  attempts?: number;
}

async function readBundle(
  page: Page,
  arena: string
): Promise<{ names: string[]; reason?: string }> {
  const base = arena.endsWith('/') ? arena : `${arena}/`;

  const htmlRes = await page.request.get(`${base}index.html`);
  if (!htmlRes.ok()) {
    return { names: [], reason: `index.html returned HTTP ${htmlRes.status()}` };
  }
  const html = await htmlRes.text();

  const entry = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  let js = '';
  if (entry) {
    const jsRes = await page.request.get(`${base}${entry}`);
    /* A missing entry script is NOT "no stylesheets". It is an unreadable
       bundle, and the lazy chunks are only discoverable through it. */
    if (!jsRes.ok()) {
      return { names: [], reason: `${entry} returned HTTP ${jsRes.status()}` };
    }
    js = await jsRes.text();
  }

  const names = new Set<string>();
  for (const m of js.matchAll(/assets\/[A-Za-z0-9_.-]+\.css/g)) names.add(m[0]);
  for (const m of html.matchAll(/assets\/[A-Za-z0-9_.-]+\.css/g)) names.add(m[0]);
  if (names.size === 0) {
    return {
      names: [],
      reason: entry ? 'the entry script named no stylesheets' : 'no entry script in index.html',
    };
  }
  return { names: [...names] };
}

/**
 * Install the stylesheets the bundle at `arena` is serving into a blank
 * document at that origin. Read the actual manifest and stylesheet bytes,
 * then fulfill only the fixture navigation with an empty document: booting
 * the app and clearing its body does not stop its scripts or background work.
 * Keep each stylesheet separate and in manifest order, while installing them
 * in one browser call so a large bundle does not need hundreds of round trips.
 */
export async function loadLiveCss(
  page: Page,
  arena: string,
  opts: Options = {}
): Promise<LiveCssLoad> {
  const { animationSpeed = null, attempts = 3 } = opts;
  const base = arena.endsWith('/') ? arena : `${arena}/`;
  let lastReason = 'not attempted';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { names, reason } = await readBundle(page, arena);
    if (reason) {
      lastReason = reason;
      continue;
    }

    const sheets = await Promise.all(
      names.map(async (n) => {
        const res = await page.request.get(`${base}${n}`);
        return res.ok()
          ? { content: await res.text() }
          : { content: '', reason: `${n} returned HTTP ${res.status()}` };
      })
    );
    const missing = sheets.flatMap((sheet) => (sheet.reason ? [sheet.reason] : []));
    if (missing.length > 0 || sheets.some((sheet) => sheet.content.length === 0)) {
      lastReason = missing.length > 0 ? missing.join('; ') : 'a declared stylesheet was empty';
      continue;
    }
    const contents = sheets.map((sheet) => sheet.content);
    const bytes = contents.reduce((n, c) => n + c.length, 0);

    if (contents.length === 0 || bytes < MIN_BYTES) {
      lastReason = `read ${contents.length} stylesheet(s), ${bytes} bytes - under the ${MIN_BYTES}-byte floor`;
      continue;
    }

    const fixtureUrl = `${base}index.html`;
    const fixtureDocument = (route: Route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head></head><body></body></html>',
      });
    await page.route(fixtureUrl, fixtureDocument, { times: 1 });
    try {
      await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    } finally {
      await page.unroute(fixtureUrl, fixtureDocument);
    }
    await page.evaluate(
      async ({ contents, animationSpeed }) => {
        const fragment = document.createDocumentFragment();
        const loaded = contents.map((content, index) => {
          const style = document.createElement('style');
          style.type = 'text/css';
          style.appendChild(document.createTextNode(content));
          const ready = new Promise<void>((resolve, reject) => {
            style.onload = () => resolve();
            style.onerror = () => reject(new Error(`Stylesheet ${index + 1} failed to load`));
          });
          fragment.appendChild(style);
          return ready;
        });
        document.head.appendChild(fragment);
        // Separate elements preserve @import validity and cascade order. Waiting
        // for every load event also waits for each sheet's imported styles.
        await Promise.all(loaded);
        if (animationSpeed !== null)
          document.documentElement.style.setProperty('--animation-speed', animationSpeed);
      },
      { contents, animationSpeed }
    );
    return { sheets: contents.length, bytes };
  }

  return { sheets: 0, bytes: 0, reason: lastReason };
}

/**
 * The third outcome, made explicit. Call this immediately after loadLiveCss:
 * a spec that could not read the bundle is SKIPPED with the reason in the
 * local report. Required CI fails instead, because a skip cannot qualify an
 * unreadable bundle. No caller may assert against a partial stylesheet set.
 */
export function skipUnlessLiveCss(load: LiveCssLoad, arena: string): void {
  const reason = `UNKNOWN - could not read the complete CSS bundle at ${arena}: ${load.reason ?? 'no reason recorded'}. Nothing was measured.`;
  // A required CI job cannot become green by skipping unreadable evidence.
  if (load.sheets === 0 && process.env.CI) throw new Error(reason);
  test.skip(load.sheets === 0, reason);
}
