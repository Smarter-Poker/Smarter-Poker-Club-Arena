/**
 * PUSH OPT-IN, IN A REAL BROWSER (2026-09-27).
 *
 * Chromium with notification permission granted, the REAL prompt host, push
 * client and nudge policy, a real service-worker registration at the shared
 * /push/ scope, and a local stand-in for the hub API that records what the
 * page sent. The one boundary that may be substituted is the push service
 * itself: when this Chromium build cannot reach one, pushManager.subscribe()
 * is answered by a recorded stand-in and the spec says so in its annotations.
 *
 * Run: npm run test:e2e:push-enrollment
 */
import { test, expect, type Page } from '@playwright/test';

const OWNER = '47965354-0e56-43ef-931c-ddaab82af765';

test.beforeEach(async ({ context, baseURL }) => {
  await context.grantPermissions(['notifications'], { origin: new URL(baseURL!).origin });
  await context.addInitScript(() => {
    const w = window as unknown as { __pushSubscribeMode?: string };
    const proto = PushManager.prototype;
    const realSubscribe = proto.subscribe;
    const realGet = proto.getSubscription;
    const fakes = new WeakMap<object, PushSubscription>();
    proto.subscribe = async function (this: PushManager, options?: PushSubscriptionOptionsInit) {
      try {
        const sub = await realSubscribe.call(this, options);
        w.__pushSubscribeMode = 'real-push-service';
        return sub;
      } catch {
        w.__pushSubscribeMode = 'push-service-stand-in';
        const endpoint = `https://fcm.googleapis.com/fcm/send/harness-${Math.random().toString(36).slice(2)}`;
        const fake = {
          endpoint,
          expirationTime: null,
          options: {
            applicationServerKey: options?.applicationServerKey ?? null,
            userVisibleOnly: true,
          },
          toJSON: () => ({
            endpoint,
            keys: { p256dh: 'BHarnessP256dhKeyMaterial', auth: 'harnessAuthSecret' },
          }),
          unsubscribe: async () => {
            fakes.delete(this);
            return true;
          },
          getKey: () => null,
        } as unknown as PushSubscription;
        fakes.set(this, fake);
        return fake;
      }
    };
    proto.getSubscription = async function (this: PushManager) {
      const real = await realGet.call(this).catch(() => null);
      return real ?? fakes.get(this) ?? null;
    };
    // The hub API reads a Bearer JWT from the shared session key.
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    const token = `h.${b64({ sub: 'harness', exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;
    localStorage.setItem('smarter-poker-auth', JSON.stringify({ access_token: token }));
  });
});

async function open(page: Page, uid: string) {
  await page.goto(`./?uid=${uid}`);
  expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
  await expect(page.getByRole('button', { name: 'Harness Join Club' })).toBeVisible();
}

const card = (page: Page) => page.getByRole('dialog', { name: 'Enable notifications' });

async function requests(page: Page) {
  return (await (await page.request.get('/__harness/requests')).json()) as Array<{
    method: string;
    auth: string | null;
    body: Record<string, unknown>;
  }>;
}

test('a player opts in at a meaningful moment and this device shows as on', async ({
  page,
}, info) => {
  const uid = `player-${Date.now()}`;
  await open(page, uid);
  const before = (await requests(page)).length;

  await page.getByRole('button', { name: 'Harness Join Club' }).click();
  await expect(card(page)).toBeVisible({ timeout: 6_000 });
  await expect(card(page)).toHaveAttribute('data-push-nudge', 'club_joined');
  await expect(card(page)).toHaveAttribute('aria-modal', 'false');
  await expect(page.getByText('Stay In Touch With Your Club')).toBeVisible();

  // The card does not block the page the player is using.
  await page.getByRole('button', { name: 'Harness Page Control' }).click();
  await expect(page.getByTestId('taps')).toHaveText('1');

  // Nothing was enrolled before the player's own tap.
  expect((await requests(page)).length).toBe(before);
  await card(page).getByRole('button', { name: 'Enable' }).click();
  await expect(page.getByText('Notifications Are On For This Device.')).toBeVisible({
    timeout: 20_000,
  });

  const sent = (await requests(page)).slice(before);
  expect(sent).toHaveLength(1);
  expect(sent[0].method).toBe('POST');
  expect(sent[0].auth).toMatch(/^Bearer /);
  expect(sent[0].body.endpoint).toMatch(/^https:\/\//);
  expect(sent[0].body.keys).toBeTruthy();
  expect(String(sent[0].body.deviceId)).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  expect(sent[0].body.repairOnly).toBeUndefined();

  // One registration, at the scope the World Hub uses.
  const scopes = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname)
  );
  expect(scopes).toEqual(['/push/']);
  await page.getByRole('button', { name: 'Harness Read Status' }).click();
  await expect(page.getByTestId('status')).toHaveText('on');

  info.annotations.push({
    type: 'push-service',
    description: String(
      await page.evaluate(() => (window as { __pushSubscribeMode?: string }).__pushSubscribeMode)
    ),
  });
});

test('Not Now is respected: the next moment does not ask again', async ({ page }) => {
  const uid = `player-${Date.now()}-b`;
  await open(page, uid);
  const before = (await requests(page)).length;

  await page.getByRole('button', { name: 'Harness Join Club' }).click();
  await expect(card(page)).toBeVisible({ timeout: 6_000 });
  await card(page).getByRole('button', { name: 'Not Now' }).click();
  await expect(card(page)).toHaveCount(0);

  const ledger = await page.evaluate((u) => localStorage.getItem(`sp_push_nudge_v1_${u}`), uid);
  expect(JSON.parse(ledger || '{}').dismissals).toBe(1);

  await page.getByRole('button', { name: 'Harness Rakeback Receipt' }).click();
  await page.waitForTimeout(4_000);
  await expect(card(page)).toHaveCount(0);
  expect((await requests(page)).length).toBe(before);
  expect(await page.evaluate(() => Notification.permission)).toBe('granted');
});

test('the owner is never nudged for receipts, but is asked when joining a club', async ({
  page,
}) => {
  await open(page, OWNER);
  await page.getByRole('button', { name: 'Harness Rakeback Receipt' }).click();
  await page.waitForTimeout(4_000);
  await expect(card(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Harness Join Club' }).click();
  await expect(card(page)).toHaveAttribute('data-push-nudge', 'club_joined', { timeout: 6_000 });
});
