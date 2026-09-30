/**
 * A DIAMOND PLAYER WHOSE CLIENT HAS GONE STALE (Diamond Phase 11, line 7).
 *
 * The build under test (build B; see playwright.stale-client.config.ts), a
 * signed-in fixture player and nothing real behind them (mock-backend.ts):
 *
 *   ROTATION   the Diamond lobby, the Diamond wallet with a transfer half
 *              typed, and a Diamond table, turned portrait -> landscape ->
 *              portrait: same page, same state, nothing sideways, and the
 *              table covered (never rebuilt) while it is sideways.
 *   SESSIONS   an expired token that refreshes, one whose refresh is refused,
 *              a sign-out in another app on this origin, and a session revoked
 *              under an open table, in the cashier and on the Staff Desk: the
 *              client recovers or asks to sign in, keeps the one saved request,
 *              and never sends a money call twice.
 *   STORAGE    a Diamond figure an older build left behind is never painted.
 */
import { expect, test, type Page } from '@playwright/test';
import { DIAMOND_TABLE, PLAYER, newBackend, signIn, type Backend } from './mock-backend';

const ORIGIN = `http://127.0.0.1:${process.env.STALE_CLIENT_PORT || 4610}`;
const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const LOBBY = 'clubs/diamond-arena';
const CLOSED_NOTICE = 'Diamond Games Are Not Open For Play Yet.';

test.skip(
  !process.env.STALE_CLIENT_DIST_B,
  'needs the build under test: see playwright.stale-client.config.ts'
);
test.use({ viewport: PORTRAIT, hasTouch: true, isMobile: true });

test.beforeEach(async ({ request }) => {
  expect((await request.get(`${ORIGIN}/__deploy?to=b&pool=prune`)).ok()).toBe(true);
});

async function sideways(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth
    )
  );
}

/** Turn the phone: the viewport, the media queries, and the event pages listen for. */
async function turn(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  await page.waitForTimeout(700);
}

function calls(backend: Backend, name: string): number {
  return backend.calls.filter((c) => c === name).length;
}

/** The sign-in door, with the route it must bring the player back to. */
async function expectSignInDoor(page: Page, route: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe('/auth/login');
  const back = new URL(page.url()).searchParams.get('redirect') ?? '';
  expect(decodeURIComponent(back)).toBe(`/hub/club-arena/${route}`);
}

async function noDiamondFigureLeft(page: Page): Promise<void> {
  const left = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('wallet-store') || '{"state":{}}');
    const walletCaches = Object.keys(localStorage).filter((k) => k.startsWith('wallet_cache_'));
    return { diamonds: saved.state?.diamonds ?? 0, walletCaches };
  });
  expect(left).toEqual({ diamonds: 0, walletCaches: [] });
}

test.describe('rotation keeps the page, its state and its layout', () => {
  test('the Diamond lobby, portrait -> landscape -> portrait', async ({ page }) => {
    await signIn(page, newBackend());
    await page.goto(LOBBY);
    const notice = page.getByText(CLOSED_NOTICE);
    await expect(notice).toBeVisible({ timeout: 30_000 });
    const node = await notice.elementHandle();
    for (const size of [LANDSCAPE, PORTRAIT]) {
      await turn(page, size);
      expect(await node!.evaluate((n) => n.isConnected), 'a rotation rebuilt the lobby').toBe(true);
      await expect(notice).toBeVisible();
      expect(await sideways(page), `sideways at ${size.width}x${size.height}`).toBeLessThanOrEqual(
        1
      );
      expect(
        await page.evaluate(() => document.documentElement.getAttribute('data-arena-scheme'))
      ).toBe('light');
      expect(new URL(page.url()).pathname).toBe(`/hub/club-arena/${LOBBY}`);
    }
  });

  test('the Diamond wallet keeps a half-typed transfer through two turns', async ({ page }) => {
    await signIn(page, newBackend());
    await page.goto(LOBBY);
    await expect(page.getByText(CLOSED_NOTICE)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Send Diamonds' }).click();
    const friend = page.getByLabel('Friend Player ID');
    const amount = page.getByLabel('Diamond Amount');
    await friend.fill('10000000-0000-4000-8000-000000000002');
    await amount.fill('25');
    const node = await amount.elementHandle();
    for (const size of [LANDSCAPE, PORTRAIT]) {
      await turn(page, size);
      expect(await node!.evaluate((n) => n.isConnected), 'a rotation rebuilt the form').toBe(true);
      await expect(friend).toHaveValue('10000000-0000-4000-8000-000000000002');
      await expect(amount).toHaveValue('25');
      expect(await sideways(page), `sideways at ${size.width}x${size.height}`).toBeLessThanOrEqual(
        1
      );
    }
    await expect(page.getByRole('button', { name: 'Review Transfer' })).toBeEnabled();
  });

  test('a Diamond table is covered while sideways and never rebuilt', async ({ page }) => {
    await signIn(page, newBackend());
    await page.goto(`table/${DIAMOND_TABLE}`);
    const table = page.locator('.table-page').first();
    await expect(table).toBeVisible({ timeout: 30_000 });
    const node = await table.elementHandle();
    const lock = page.locator('.portrait-lock');
    await expect(lock).toBeHidden();
    await turn(page, LANDSCAPE);
    await expect(lock).toBeVisible();
    expect(await node!.evaluate((n) => n.isConnected), 'a rotation rebuilt the table').toBe(true);
    await turn(page, PORTRAIT);
    await expect(lock).toBeHidden();
    expect(await node!.evaluate((n) => n.isConnected)).toBe(true);
    expect(new URL(page.url()).pathname).toBe(`/hub/club-arena/table/${DIAMOND_TABLE}`);
  });
});

test.describe('an expired, refused, signed-out-elsewhere or revoked session', () => {
  test('an expired token that refreshes: the lobby recovers in place', async ({ page }) => {
    const backend = newBackend();
    await signIn(page, backend, { expired: true });
    await page.goto(LOBBY);
    await expect(page.getByText(CLOSED_NOTICE)).toBeVisible({ timeout: 30_000 });
    expect(calls(backend, 'POST /auth/v1/token')).toBeGreaterThanOrEqual(1);
    expect(new URL(page.url()).pathname).toBe(`/hub/club-arena/${LOBBY}`);
  });

  test('an expired token whose refresh is refused: the sign-in door, and no figure left behind', async ({
    page,
  }) => {
    const backend = newBackend({ refresh: 'revoked' });
    await signIn(page, backend, { expired: true });
    await page.goto(LOBBY);
    await expectSignInDoor(page, LOBBY);
    await noDiamondFigureLeft(page);
  });

  test('an expired token with the network down: at worst the door, and the session is kept', async ({
    page,
  }) => {
    const backend = newBackend({ refresh: 'offline' });
    await signIn(page, backend, { expired: true });
    await page.goto(LOBBY);
    await page.waitForTimeout(15_000);
    /* Either outcome the line allows: still on the arena, or asked to sign in
       with the route carried. Measured 2026-09-30: the guard asks to sign in. */
    const where = new URL(page.url());
    if (where.pathname === '/auth/login')
      expect(decodeURIComponent(where.searchParams.get('redirect') ?? '')).toBe(
        `/hub/club-arena/${LOBBY}`
      );
    else expect(where.pathname).toBe(`/hub/club-arena/${LOBBY}`);
    /* "We do not know" is never a reason to throw a session away: the refresh
       token is still there for when the network comes back. */
    const kept = await page.evaluate(() => localStorage.getItem('smarter-poker-auth'));
    expect(JSON.parse(kept ?? 'null')?.refresh_token).toBe('stale-client-fixture-refresh');
    /* The SDK did try (a bounded few times) and every attempt died on the wire. */
    expect(calls(backend, 'POST /auth/v1/token')).toBeGreaterThanOrEqual(1);
  });

  test('signed out in another app on this origin: the open lobby follows, and clears its money caches', async ({
    page,
    context,
  }) => {
    await signIn(page, newBackend());
    await page.goto(LOBBY);
    await expect(page.getByText(CLOSED_NOTICE)).toBeVisible({ timeout: 30_000 });
    /* Exactly what the World Hub's signOut does to a shared-key client. */
    const hub = await context.newPage();
    await hub.goto(`${ORIGIN}/auth/login`);
    await hub.evaluate(() => {
      localStorage.removeItem('smarter-poker-auth');
      new BroadcastChannel('smarter-poker-auth').postMessage({
        event: 'SIGNED_OUT',
        session: null,
      });
    });
    await expectSignInDoor(page, LOBBY);
    await noDiamondFigureLeft(page);
  });

  test('revoked at boot: the lobby asks to sign in, and keeps the arena in the door', async ({
    page,
  }) => {
    const backend = newBackend({ session: 'revoked', refresh: 'revoked' });
    await signIn(page, backend);
    await page.goto(LOBBY);
    await expectSignInDoor(page, LOBBY);
    /* GoTrue was asked before anything was thrown away. */
    expect(calls(backend, 'GET /auth/v1/user')).toBeGreaterThanOrEqual(1);
    await noDiamondFigureLeft(page);
  });

  test('revoked while at an open Diamond table: the next heartbeat takes the player to the door, back to the table', async ({
    page,
  }) => {
    const backend = newBackend({ engineHttp: 'answered' });
    await signIn(page, backend);
    await page.goto(`table/${DIAMOND_TABLE}`);
    await expect(page.locator('.table-page').first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => calls(backend, 'engine POST /heartbeat'), { timeout: 30_000 })
      .toBeGreaterThan(0);
    /* Signed out on another device: GoTrue now refuses the session and its
       refresh token, and the engine refuses the next heartbeat before it runs. */
    backend.session = 'revoked';
    backend.refresh = 'revoked';
    backend.engineSocket = 'auth-refused';
    let prompted = false;
    const watch = page
      .getByRole('alertdialog')
      .getByText('Your Session Has Ended')
      .waitFor({ state: 'visible', timeout: 45_000 })
      .then(() => (prompted = true))
      .catch(() => {});
    await expectSignInDoor(page, `table/${DIAMOND_TABLE}`);
    await watch;
    /* GoTrue said so before anything was thrown away: either the probe's
       /user or the engine client's one refresh, whichever ran first. */
    expect(
      calls(backend, 'GET /auth/v1/user') + calls(backend, 'POST /auth/v1/token')
    ).toBeGreaterThanOrEqual(1);
    console.log(
      `[table revoked] door reached; the "Your Session Has Ended" prompt was ${prompted ? 'shown first' : 'not needed (the SDK signed out first)'}`
    );
  });

  test('revoked in the cashier: "sign in again", one send, and the request kept for the retry', async ({
    page,
  }) => {
    const backend = newBackend();
    backend.tables.friendships = [{ id: 'friendship' }];
    backend.rpc.send_wallet_diamond_transfer = () => ({
      status: 403,
      body: { code: '42501', message: 'authentication_required', details: null, hint: null },
    });
    await signIn(page, backend);
    await page.goto(LOBBY);
    await expect(page.getByText(CLOSED_NOTICE)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Send Diamonds' }).click();
    await page.getByLabel('Friend Player ID').fill('10000000-0000-4000-8000-000000000002');
    await page.getByLabel('Diamond Amount').fill('25');
    await page.getByRole('button', { name: 'Review Transfer' }).click();
    /* Signed out on another device between reviewing and confirming. */
    backend.session = 'revoked';
    backend.refresh = 'revoked';
    await page.getByRole('button', { name: 'Confirm Transfer' }).click();
    await expect(
      page.getByText(
        'Your Session Has Ended. Sign In Again, Then Retry This Transfer To Retrieve Its Receipt.'
      )
    ).toBeVisible({ timeout: 15_000 });
    await expectSignInDoor(page, LOBBY);
    expect(calls(backend, 'rpc send_wallet_diamond_transfer')).toBe(1);
    const kept = await page.evaluate(
      (id) => sessionStorage.getItem('diamond-transfer:' + id),
      PLAYER
    );
    expect(JSON.parse(kept ?? 'null')).toMatchObject({
      recipient: '10000000-0000-4000-8000-000000000002',
      amount: 25,
    });
  });

  test('revoked on the Staff Desk: the door refuses by name and the desk says "sign in again"', async ({
    page,
  }) => {
    const backend = newBackend();
    (backend.tables.profiles[0] as { role: string }).role = 'admin';
    backend.rpc.fn_poker_diamond_open_cash_table = () => ({
      status: 403,
      body: { code: '28000', message: 'diamond_staff_session_required', details: null, hint: null },
    });
    await signIn(page, backend);
    await page.goto('diamond-staff-desk');
    await expect(page.getByRole('heading', { name: 'Open A Table' })).toBeVisible({
      timeout: 30_000,
    });
    const form = page.locator('form', { has: page.getByRole('heading', { name: 'Open A Table' }) });
    await form.getByLabel('Name').fill('P11');
    await form.getByLabel('Small Blind').fill('1');
    await form.getByLabel('Big Blind').fill('2');
    await form.getByLabel('Minimum Buy-In').fill('40');
    await form.getByLabel('Maximum Buy-In').fill('200');
    await form.getByRole('button', { name: 'Open Table' }).click();
    await expect(page.getByText('Your Session Has Ended. Sign In Again.')).toBeVisible({
      timeout: 15_000,
    });
    expect(calls(backend, 'rpc fn_poker_diamond_open_cash_table')).toBe(1);
  });
});

test.describe('storage an older build left behind', () => {
  test('an ownerless Diamond figure is never painted, even when the real one cannot be read', async ({
    page,
  }) => {
    const backend = newBackend();
    backend.tables.profiles = []; // the balance read finds nothing it can vouch for
    await page.addInitScript(() => {
      if (sessionStorage.getItem('stale-client-wallet-seeded')) return;
      sessionStorage.setItem('stale-client-wallet-seeded', '1');
      localStorage.setItem(
        'wallet-store',
        JSON.stringify({
          state: { diamonds: 494465, _balancesUserId: null, _balancesAt: 0 },
          version: 0,
        })
      );
    });
    await signIn(page, backend);
    await page.goto('wallet');
    await expect(page.getByText(/Diamonds/i).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(3_000);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain('494,465');
    expect(text).not.toContain('494465');
  });
});
