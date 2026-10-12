/**
 * A PRODUCTION BROWSER RUN READS THE ARENA'S STATIC FILES FROM THE ORIGIN
 * (2026-10-04).
 *
 * WHAT WAS HAPPENING. Every Playwright test opens a fresh browser context, so
 * every test is a cold load: 80-125 images, fonts, scripts and stylesheets.
 * Against production each of those travelled smarter.poker -> Vercel ->
 * ca-static.smarter.poker, and Vercel bills each one. Post-Deploy E2E runs
 * after every publish and takes 20-24 minutes, publishes land every few
 * minutes while agents are merging, so one run was effectively always in
 * flight. Measured 2026-10-03/04: about 1,000 cold arena loads an hour from
 * GitHub runner addresses, about 2.0M requests a day on the World Hub's Vercel
 * project (97% under /hub/club-arena), and its on-demand budget exhausted four
 * days into the cycle. The same hours with no runs showed none of it.
 *
 * WHAT THIS DOES. When the run targets production, every Chromium context the
 * runner creates answers a Club Arena static-file request by fetching the same
 * file from the arena origin and handing it to the page. The page still sees
 * the smarter.poker URL, same-origin, with the origin's bytes - which are the
 * bytes Vercel would have proxied. Nothing the app does can tell.
 *
 * WHAT STILL GOES THROUGH THE PUBLIC PATH: the document and every client
 * route, sw-bus.js, build-info.json and every other .json, every API call, and
 * video. See staticOriginPath.ts. The rewrite for static files is still proved
 * on every run by the WebKit projects (not patched here) and hourly by
 * .github/scripts/origin-contract.sh, which reads a hashed asset through
 * smarter.poker.
 *
 * IT CANNOT MAKE A TEST FAIL. If the origin cannot be read, answers 5xx, or
 * the page went away mid-request, the request continues on the public path
 * exactly as it did before this file existed.
 *
 * WHY IT IS INSTALLED ON THE BROWSER TYPE and not as a fixture. Ninety-six
 * specs import `test` straight from @playwright/test and a dozen build their
 * own contexts with browser.newContext(). A fixture would cover only the specs
 * rewritten to import it, and the next spec written the ordinary way would
 * quietly go back to the billed path. Wrapping launch() and newContext() here
 * covers every context there is. If a Playwright upgrade ever changes how the
 * runner launches, this stops applying and the suite behaves exactly as
 * before - the failure direction is cost, never correctness.
 *
 * Chromium only. Its service-worker requests are visible to context routing,
 * so the worker's precache is served from the origin too. WebKit does not
 * expose those, so WebKit projects are left alone.
 *
 * Opt out for one run: CA_E2E_STATIC_VIA_PUBLIC_PATH=1.
 */
import { chromium, type Browser, type BrowserContext, type Route } from '@playwright/test';
import { staticOriginUrl, targetsProduction } from './staticOriginPath';

const ORIGIN_READ_TIMEOUT_MS = 15_000;
const ORIGIN_ACCEPT_ENCODING = 'gzip, deflate, br';
const INSTALLED = Symbol.for('club-arena.e2e.static-origin-direct');

async function answerFromOrigin(route: Route): Promise<void> {
  const originUrl = staticOriginUrl(route.request().url());
  if (!originUrl || route.request().method() !== 'GET') {
    await route.fallback();
    return;
  }
  try {
    const response = await route.fetch({
      url: originUrl,
      // The origin's Caddy prefers zstd, which a current Chromium asks for and
      // the runner's request layer cannot decode. Ask only for what it can.
      headers: { ...route.request().headers(), 'accept-encoding': ORIGIN_ACCEPT_ENCODING },
      timeout: ORIGIN_READ_TIMEOUT_MS,
      maxRedirects: 0,
    });
    if (response.status() >= 500 || (response.status() >= 300 && response.status() < 400)) {
      await route.fallback();
      return;
    }
    await route.fulfill({ response });
  } catch {
    // Origin unreachable, or the page closed while the read was in flight.
    // Either way the public path is the answer it would have had anyway.
    await route.fallback().catch(() => undefined);
  }
}

async function routeContext(context: BrowserContext): Promise<void> {
  await context.route((url) => staticOriginUrl(url.href) !== null, answerFromOrigin);
}

function wrapBrowser(browser: Browser): Browser {
  const marked = browser as Browser & { [INSTALLED]?: true };
  if (marked[INSTALLED]) return browser;
  marked[INSTALLED] = true;
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args: Parameters<Browser['newContext']>) => {
    const context = await newContext(...args);
    await routeContext(context);
    return context;
  };
  return browser;
}

/**
 * Called once from playwright.config.ts, which every runner process loads.
 * Returns whether the detour is active, so the config can say so in the log.
 */
export function installStaticOriginDirect(baseURL: string): boolean {
  if (process.env.CA_E2E_STATIC_VIA_PUBLIC_PATH === '1') return false;
  if (!targetsProduction(baseURL)) return false;
  const browserType = chromium as typeof chromium & { [INSTALLED]?: true };
  if (browserType[INSTALLED]) return true;
  browserType[INSTALLED] = true;
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (...args: Parameters<typeof chromium.launch>) =>
    wrapBrowser(await launch(...args));
  return true;
}
