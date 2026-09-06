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
import { createClient, type Session } from '@supabase/supabase-js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ensureClubMembership,
  retireCurrentClubEntryMessage,
} from './support/ensureClubMembership';
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
const AUTH_STORAGE_KEY = 'smarter-poker-auth';
const DEFAULT_E2E_CLUB_ID = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

async function createDirectSession(email: string, password: string): Promise<Session | null> {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const publishableKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) return null;

  const client = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`direct Supabase login failed (${error?.message || 'no session returned'})`);
  }
  return data.session;
}

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

/**
 * The signed-out fallback, and the one place it is not allowed.
 *
 * Falling back is right for a local run or a merge gate: costing everyone their
 * build over a login blip is worse than costing 47 skips. It is WRONG for the
 * post-deploy job, which exists for no other purpose than to look at production
 * with a real session. There, a silent fallback produces a green run in which
 * almost nothing executed — the exact failure Phase 6 was opened to close.
 *
 * E2E_REQUIRE_AUTH=1 says "this run has credentials and its verdict depends on
 * them". Then a failed login is a failed run, with its real reason, instead of
 * a success that verified nothing.
 */
function signedOut(reason: string) {
  /**
   * A CREDENTIAL THAT WAS SUPPLIED AND DID NOT WORK IS NOT THE SAME AS NO
   * CREDENTIAL, AND UNTIL NOW BOTH LOOKED IDENTICAL.
   *
   * ci.yml's scheduled `Live Production E2E` deliberately tolerates missing
   * secrets so a repo that never set them does not go red. Correct. But it
   * treated a BROKEN login the same way: 47 route specs would quietly skip and
   * the job would report success, which is the Phase 6 failure wearing a
   * different hat. That job does not want a hard failure, so it gets the next
   * best thing - an annotation on the run itself, where somebody sees it,
   * rather than one line buried in a log nobody opens.
   */
  if (process.env.SP_EMAIL && process.env.SP_PASS) {
    console.log(
      `::error title=E2E ran signed out despite having credentials::${reason}. ` +
        'The auth-gated specs skipped, so this run verified far less than it appears to.'
    );
  }
  if (process.env.E2E_REQUIRE_AUTH === '1') {
    throw new Error(
      `[global-setup] ${reason} — and E2E_REQUIRE_AUTH=1, so this run cannot ` +
        'fall back to a signed-out session. A signed-out post-deploy run skips ' +
        'the specs it exists to run and would report success having verified ' +
        'almost nothing. Fix the credential, or unset E2E_REQUIRE_AUTH.'
    );
  }
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

    /* Authenticate against the API before touching the Hub login form when the
       Supabase public configuration is available. Production login chrome is
       a separate deploy and has changed button semantics more than once; the
       contract this suite needs is a valid Club Arena session, not a replay of
       another application's form. The app and Hub deliberately share this
       exact storage key, so seeding the SDK-issued session exercises the same
       boot path a returning player uses. Local runs without API configuration
       keep the UI-login fallback below. */
    const directSession = await createDirectSession(email, password);

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

    if (directSession) {
      assertWelcomeKeyStillCurrent();
      await page.evaluate(
        ({ authKey, session, welcomeKey }) => {
          localStorage.setItem(authKey, JSON.stringify(session));
          localStorage.setItem(welcomeKey, 'true');
        },
        {
          authKey: AUTH_STORAGE_KEY,
          session: directSession,
          welcomeKey: WELCOME_ACCEPTED_KEY,
        }
      );
      await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(8_000);
      if (page.url().includes('/auth')) {
        signedOut('direct Supabase session did not survive application boot');
        return;
      }
      authenticated = true;
      console.log('[global-setup] direct Supabase session accepted by production.');
    }

    if (!authenticated && !page.url().includes('/auth')) {
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
    if (!authenticated) {
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
      await page
        .waitForURL((u) => !u.pathname.includes('/auth'), { timeout: 45000 })
        .catch(() => {});
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
    }

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
    // receives the same mandatory alias/avatar gate. The base route can be a
    // redirect/loading surface that has not mounted AppLayout's gate yet, so
    // probe on a known protected layout route before deciding the account is
    // complete. Leaving the gate open caused 15 apparently unrelated lobby
    // and tournament tests to time out behind one correct modal.
    await page.goto(new URL('notifications', baseURL).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await ensurePlayableProfile(page);

    // The lobby suite exercises a real club route. A valid authenticated
    // session is still shown InvitePage until this dedicated account joins the
    // fixture club, which made all eight lobby assertions time out without
    // ever reaching the UI they claim to test. Use the public Join Club flow
    // once and prove the lobby is reachable before sharing this storageState.
    await ensureClubMembership(page, baseURL, process.env.E2E_CLUB_ID || DEFAULT_E2E_CLUB_ID);
    await retireCurrentClubEntryMessage(page);

    await ctx.storageState({ path: STORAGE_STATE });
    console.log('[global-setup] authenticated session saved — auth-gated specs will run.');
  } catch (err) {
    /* A throw raised BY signedOut() (E2E_REQUIRE_AUTH=1) must escape with its
       own message. Passing it through the fallback below would call signedOut()
       a second time and nest the explanation inside "auth setup failed (...)",
       which is how a clear cause becomes an unreadable one. */
    if (process.env.E2E_REQUIRE_AUTH === '1') {
      throw err;
    }
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
