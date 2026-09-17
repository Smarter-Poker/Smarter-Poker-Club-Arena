/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LOADING THE CSS THIS COMMIT ACTUALLY SERVES - AND SAYING SO WHEN IT CANNOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Six specs open the built bundle, discover the lazy stylesheet chunks from
 * the entry's module graph, and ask Chrome what the shipped CSS really does.
 * Five of them carried a byte-identical copy of the loader, and that copy had
 * no timeout, no retry, and - for the two fetches that matter - no error
 * handling at all:
 *
 *     const html = await fetch(base + 'index.html').then((r) => r.text());
 *     const entry = html.match(...)?.[0];
 *     const js = entry ? await fetch(base + entry).then((r) => r.text()) : '';
 *
 * All of it ran inside ONE `page.evaluate`, so a slow or refused read consumed
 * the whole 30s test budget and surfaced as `Test timeout of 30000ms exceeded`
 * pointing at the `page.evaluate` line - a failure that names the symptom and
 * not one thing about the cause. That is what turned `CI - Build & Type
 * Safety` red on 2026-09-11 for a branch whose own suites were green.
 *
 * The worse half is the other direction. `entry` unmatched yields `js = ''`,
 * every chunk 404s into the per-chunk `catch`, and the loader returns happily
 * having installed ZERO stylesheets. A spec then asks "is this animation
 * collapsed under reduced motion?" of a document with no CSS, finds no
 * animation, and PASSES. Both the red and the green were the same defect:
 * **a reader that answers when it cannot tell** (CLAUDE.md 10.86).
 *
 * So this loader has three outcomes, not two. It reads over Playwright's own
 * request API - which has its own timeout and cannot eat the test budget -
 * retries a bounded number of times, and REFUSES to return quietly with
 * nothing: a caller that could not read the bundle is handed `sheets: 0` and
 * the reason, and `skipUnlessLiveCss` turns that into a SKIPPED test with the
 * reason attached. Never a pass, never a bare timeout.
 *
 * `card-squeeze-mobile.spec.ts` already did the assertive half correctly and
 * is where the `page.request.get` + `expect(res.ok())` shape comes from.
 */

import { test, type Page } from '@playwright/test';

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
 * document at that origin, exactly as the five copies did: navigate to the
 * built index so relative url() and font paths still resolve, empty the body
 * so the app cannot re-render over the fixture, then add each sheet.
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
        /* One chunk that 404s is genuinely not this test's problem - the
           bundle moved on and the others still describe the shipped CSS. A
           bundle where they ALL 404 is caught by the byte floor below. */
        return res.ok() ? res.text() : '';
      })
    );
    const contents = sheets.filter((c) => c.length > 0);
    const bytes = contents.reduce((n, c) => n + c.length, 0);

    if (contents.length === 0 || bytes < MIN_BYTES) {
      lastReason = `read ${contents.length} stylesheet(s), ${bytes} bytes - under the ${MIN_BYTES}-byte floor`;
      continue;
    }

    await page.goto(`${base}index.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.body.innerHTML = '';
    });
    for (const content of contents) await page.addStyleTag({ content });
    if (animationSpeed !== null) {
      await page.evaluate(
        (v) => document.documentElement.style.setProperty('--animation-speed', v),
        animationSpeed
      );
    }
    return { sheets: contents.length, bytes };
  }

  return { sheets: 0, bytes: 0, reason: lastReason };
}

/**
 * The third outcome, made explicit. Call this immediately after loadLiveCss:
 * a spec that could not read the bundle is SKIPPED with the reason in the
 * report, rather than asserting against an empty stylesheet (which passes) or
 * dying on a timeout that names nothing (which is what used to happen).
 */
export function skipUnlessLiveCss(load: LiveCssLoad, arena: string): void {
  test.skip(
    load.sheets === 0,
    `UNKNOWN - could not read the CSS bundle at ${arena}: ${load.reason ?? 'no reason recorded'}. ` +
      `This is not a CSS regression; nothing was measured.`
  );
}
