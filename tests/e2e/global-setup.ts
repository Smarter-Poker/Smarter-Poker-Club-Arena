/**
 * Optional authenticated session for the Playwright suite.
 *
 * WHY THIS EXISTS
 * 47 of the route specs call test.skip() the moment they land on /auth, and the
 * suite runs signed out, so a third of it has never asserted anything. Those
 * specs are not wrong to skip — an unauthenticated run genuinely cannot check
 * "Player Stats navigates to /stats". They just need a session.
 *
 * HOW IT BEHAVES
 * If SP_EMAIL and SP_PASS are set, this logs in once before the run and writes
 * a storageState the specs reuse. If they are NOT set, it writes an EMPTY
 * storageState and the suite behaves exactly as it does today — signed out,
 * with those specs skipping. So this is safe to merge before any credential
 * exists anywhere, and turns itself on the moment two secrets are added.
 *
 * A login failure is deliberately NOT fatal. Falling back to a signed-out run
 * costs 47 skips; failing the whole pipeline over a login blip costs everyone
 * their build. Every fallback prints its reason, so a signed-out run is never
 * silently mistaken for a signed-in one.
 *
 * USE DEDICATED TEST ACCOUNTS. Most specs are read-only smoke checks, while the
 * customization contract performs reversible writes and this setup may finish
 * the account's one-time profile onboarding. Never point it at an owner/admin
 * login or a real player's identity.
 */
import { chromium, type FullConfig } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensurePlayableProfile } from './support/ensurePlayableProfile';

export const STORAGE_STATE = 'tests/e2e/.auth/state.json';

const EMPTY_STATE = { cookies: [], origins: [] };

/**
 * First-run gate. AppLayout renders ClubArenaWelcomeModal over the whole app
 * until this key is 'true' — a full-viewport z-index:1000 overlay with
 * pointer-events:auto. Signed OUT nobody ever saw it, because the app bounced
 * to /auth first; signed IN it sits in front of every route, and Playwright
 * reports `<div class="_overlay_…"> intercepts pointer events` on any click.
 * That single overlay is the difference between 43 specs asserting on the app
 * and 43 specs asserting on a modal.
 *
 * We seed the flag rather than tick the agreement checkbox: the flag is
 * per-browser-profile localStorage, thrown away with the test run, and no
 * consent is recorded anywhere server-side by either route.
 */
const WELCOME_ACCEPTED_KEY = 'club_arena_welcome_accepted';

/**
 * The key above is duplicated from src/lib/storage.ts because global-setup runs
 * outside the app bundle. A silent rename there would put the overlay back in
 * front of every spec and cost hours to re-diagnose, so verify it rather than
 * trust it. This is a warning, not a throw: a moved constant must not take the
 * whole pipeline down.
 */
function assertWelcomeKeyStillCurrent() {
  try {
    const src = readFileSync('src/lib/storage.ts', 'utf8');
    if (!src.includes(`'${WELCOME_ACCEPTED_KEY}'`)) {
      console.warn(
        `[global-setup] WARNING: '${WELCOME_ACCEPTED_KEY}' is no longer in src/lib/storage.ts. ` +
          'The welcome overlay will block every authenticated spec until this key is updated.'
      );
    }
  } catch {
    /* Running outside the repo root — nothing to check against. */
  }
}

function signedOut(reason: string) {
  console.log(`[global-setup] ${reason} — running signed out (auth specs will skip).`);
  writeFileSync(STORAGE_STATE, JSON.stringify(EMPTY_STATE));
}

export default async function globalSetup(config: FullConfig) {
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });

  const email = process.env.SP_EMAIL;
  const password = process.env.SP_PASS;
  const baseURL = config.projects[0]?.use?.baseURL as string | undefined;

  if (!email || !password || !baseURL) {
    signedOut('SP_EMAIL/SP_PASS not set');
    return;
  }

  const browser = await chromium.launch();
  let authenticated = false;
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    /* Do NOT hardcode a login path. On production the arena is a base-path app
       inside the World Hub, and the sign-in page belongs to the HUB:
       /hub/club-arena/ bounces to /auth/login?redirect=... at the origin. The
       arena also has its own /auth route (App.tsx) which is what a standalone
       dev server serves. Guessing either one gets the other environment wrong
       and lands on a 404, where the form never appears and the run falls back
       to signed-out for a reason that reads like a bad password.

       Loading baseURL and following wherever the app sends us is correct in
       both, and stays correct if auth moves again. */
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);

    if (!page.url().includes('/auth')) {
      // Nothing to do — the app let us in without a session.
      await ctx.storageState({ path: STORAGE_STATE });
      console.log('[global-setup] app did not require sign-in; state saved as-is.');
      return;
    }

    /* Both login screens expose exactly one email + one password input. The Hub
       form is image-backed: every button has empty text and is identified only
       by `title`, so a `:has-text("Sign In")` locator matches nothing there.
       Prefer the titled submit, fall back to the form's first submit, which is
       what the arena's own AuthPage renders. */
    const emailInput = page.locator('input[type="email"]').first();
    const passwordInput = page.locator('input[type="password"]').first();
    try {
      await emailInput.waitFor({ state: 'visible', timeout: 30000 });
    } catch {
      signedOut(`no sign-in form at ${page.url()}`);
      return;
    }

    await emailInput.fill(email, { timeout: 15000 });
    await passwordInput.fill(password, { timeout: 15000 });

    const titled = page.locator('button[type="submit"][title="Sign In"]').first();
    const submit = (await titled.count())
      ? titled
      : page.locator('form button[type="submit"], button[type="submit"]').first();
    await submit.click({ timeout: 15000 });

    // Leaving /auth is the signal the credential was accepted.
    await page.waitForURL((u) => !u.pathname.includes('/auth'), { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(5000);

    // Clear the first-run gate on this origin before the state is captured.
    assertWelcomeKeyStillCurrent();
    await page.evaluate((k) => {
      try {
        localStorage.setItem(k, 'true');
      } catch {
        /* storage disabled — the overlay stays, specs will report it. */
      }
    }, WELCOME_ACCEPTED_KEY);

    /* Prove the session actually works rather than trusting the click: load the
       app fresh and confirm we are not bounced back to /auth. A storageState
       captured from a failed login is worse than none — the specs would run,
       land on /auth, skip anyway, and the log would claim they were
       authenticated. */
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    if (page.url().includes('/auth')) {
      signedOut('login did not take');
      return;
    }
    authenticated = true;

    /* Confirm the gate is actually down. Seeding a key that the app no longer
       reads would look identical in the log while every spec kept failing on an
       intercepted click. */
    const overlayUp = await page
      .locator('[class*="overlay" i]:visible')
      .filter({ hasText: 'Important Notice' })
      .count()
      .catch(() => 0);
    if (overlayUp) {
      console.warn(
        '[global-setup] WARNING: the welcome overlay is still up after seeding ' +
          `'${WELCOME_ACCEPTED_KEY}'. Authenticated specs will fail on intercepted clicks.`
      );
    }

    // A freshly provisioned test account is a real new player and therefore
    // receives the same mandatory alias/avatar gate. Leaving it open caused 14
    // apparently unrelated lobby and tournament tests to time out behind one
    // correct modal. Finish it once and prove the durable profile state before
    // sharing this browser state with the suite.
    await ensurePlayableProfile(page);

    await ctx.storageState({ path: STORAGE_STATE });
    console.log('[global-setup] authenticated session saved — auth-gated specs will run.');
  } catch (err) {
    if (authenticated) {
      // Do not convert a broken authenticated preflight into 47 signed-out
      // skips. This is a production fixture failure and must stop the run with
      // its real cause.
      throw err;
    }
    signedOut(`auth setup failed (${(err as Error).message.slice(0, 120)})`);
  } finally {
    await browser.close();
  }
}
