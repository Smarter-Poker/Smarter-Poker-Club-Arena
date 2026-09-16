/**
 * WHAT WOULD AN ENFORCED CSP ACTUALLY BLOCK?
 *
 * The World Hub has shipped `Content-Security-Policy-Report-Only` since Phase
 * 6.1.14, with a comment in next.config.js saying to switch it to enforcing
 * "once violations have been monitored and confirmed zero". That monitoring
 * has never happened, because the policy carries no `report-uri` and no
 * `report-to`: the only record a violation leaves is a line in whichever
 * browser happened to hit it. next.config.js says so itself, about the Sentry
 * allowance that was missing until 2026-08-29 — "the only symptom was a line
 * in the console that nobody reads".
 *
 * That is the gap this spec closes. A browser fires `securitypolicyviolation`
 * for a report-only policy too (with disposition "report"), so driving
 * production as it actually is, touching no header, records exactly what the
 * enforced policy would have blocked.
 *
 * It is read-only: it signs in through the suite's own globalSetup, navigates,
 * scrolls, and reads. It submits nothing and changes nothing.
 *
 * Two jobs, and the second is the one that keeps paying:
 *   1. It answers whether the switch to enforcing is safe TODAY.
 *   2. It fails the moment somebody adds an external resource the policy does
 *      not allow — which is precisely how Sentry got in and stayed broken for
 *      ten days under a header that was supposed to be watching.
 */
import { expect, test } from '@playwright/test';

type Violation = {
  directive: string;
  blockedURI: string;
  disposition: string;
  sourceFile?: string;
  lineNumber?: number;
};

/** Relative, because Club Arena is served under a base path. See playwright.config.ts. */
const ARENA_ROUTES = ['', 'clubs', 'wallet', 'profile', 'promotions'];

/**
 * The policy is set by the World Hub for the whole origin, so a Club-Arena-only
 * sweep would certify a header that mostly governs somebody else's pages.
 */
const HUB_ROUTES = ['/', '/diamonds', '/games'];

const COLLECT = () => {
  (window as unknown as { __cspViolations?: Violation[] }).__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    const w = window as unknown as { __cspViolations: Violation[] };
    w.__cspViolations.push({
      directive: e.effectiveDirective || e.violatedDirective,
      blockedURI: e.blockedURI,
      disposition: e.disposition,
      sourceFile: e.sourceFile,
      lineNumber: e.lineNumber,
    });
  });
};

test.describe('the content security policy', () => {
  test('blocks nothing the app actually needs', async ({ page, baseURL }) => {
    test.setTimeout(240_000);

    await page.addInitScript(COLLECT);

    const found: Array<Violation & { route: string }> = [];
    const origin = new URL(baseURL ?? 'https://smarter.poker/hub/club-arena/').origin;

    const visit = async (url: string, label: string) => {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
      } catch {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      }
      await page.waitForTimeout(3500);
      // Lazily mounted panels fetch their own things; a viewport-height visit
      // certifies the header against about a third of the page.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(2000);
      const batch = await page
        .evaluate(
          () => (window as unknown as { __cspViolations?: Violation[] }).__cspViolations ?? []
        )
        .catch(() => [] as Violation[]);
      for (const v of batch) found.push({ ...v, route: label });
    };

    for (const route of ARENA_ROUTES)
      await visit(new URL(route, baseURL).toString(), `arena:/${route}`);
    for (const route of HUB_ROUTES) await visit(`${origin}${route}`, `hub:${route}`);

    // ── Report before asserting, so a red run names the resource ───────────
    const grouped = new Map<string, { v: Violation; routes: Set<string> }>();
    for (const v of found) {
      const key = `${v.directive} <- ${v.blockedURI}`;
      if (!grouped.has(key)) grouped.set(key, { v, routes: new Set() });
      grouped.get(key)!.routes.add(v.route);
    }
    for (const [key, { v, routes }] of grouped) {
      console.log(
        `CSP ${v.disposition}: ${key}\n    routes: ${[...routes].join(', ')}` +
          (v.sourceFile ? `\n    from ${v.sourceFile}:${v.lineNumber}` : '')
      );
    }

    const summary = [...grouped.keys()].sort();
    expect(
      summary,
      'An enforced Content-Security-Policy would block these. Either the ' +
        'resource belongs in next.config.js (World Hub), or the code should ' +
        'stop loading it. Do not enforce the policy while this list is not empty.'
    ).toEqual([]);
  });

  test('is still being served, and still says what it is meant to say', async ({
    page,
    baseURL,
  }) => {
    // A policy that silently stopped shipping would make the test above pass
    // for the worst possible reason.
    const res = await page.goto(baseURL!, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const headers = res?.headers() ?? {};
    const reportOnly = headers['content-security-policy-report-only'] ?? '';
    const enforced = headers['content-security-policy'] ?? '';
    const policy = reportOnly || enforced;

    expect(policy, 'no Content-Security-Policy header of either kind').toBeTruthy();
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ]) {
      expect(policy, `the policy dropped: ${directive}`).toContain(directive);
    }
    // A retired telemetry provider must not remain an allowed network destination.
    expect(policy, 'Retired telemetry must not remain in connect-src').not.toMatch(/sentry\.io/i);
    // upgrade-insecure-requests is ignored inside a report-only policy, so it
    // lives in the enforced header and must stay there.
    expect(enforced, 'upgrade-insecure-requests left the enforced header').toContain(
      'upgrade-insecure-requests'
    );
  });
});
