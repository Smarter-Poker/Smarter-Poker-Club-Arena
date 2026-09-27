import {
  devices,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { rawProfileHeading } from './support/rawProfileHeading';

import { ensureAcceptedTerms } from './support/ensureAcceptedTerms';
import { ensurePlayableProfile } from './support/ensurePlayableProfile';
import { observeAccountRealtime } from './support/accountRealtimeObservation';
import { createReservedPresenceTransport } from './support/reservedPresenceTransport';
import {
  cleanupTemporaryCustomizationAccount,
  createTemporaryCustomizationAccount,
  readServiceRows,
  requireCustomizationCertificationEnvironment,
  type CustomizationCertificationEnvironment,
  type TemporaryCustomizationAccount,
  withCauses,
} from './support/temporaryCustomizationAccount';

type Appearance = {
  table: string;
  background: string;
  button: string;
  cards: string;
};

type SavedStudioState = {
  appearance: Appearance;
  mode: 'Light' | 'Dark';
  selections: Record<'Looks' | 'Tables' | 'Scenes' | 'Buttons' | 'Cards', string>;
  sceneGroup: 'Places & Rooms' | 'Skins';
};

const PRESETS: Record<string, Appearance> = {
  'House Classic': {
    table: 'classic_green',
    background: 'midnight',
    button: 'classic-white',
    cards: 'classic_red',
  },
  'Carbon Club': {
    table: 'carbon_red',
    background: 'midnight',
    button: 'gray-d-gear',
    cards: 'classic_red',
  },
  'Ocean Suite': {
    table: 'ocean_blue',
    background: 'royal_indigo',
    button: 'classic-white',
    cards: 'classic_blue',
  },
};

const CATEGORY_ALTERNATIVES = {
  Tables: ['Classic Green', 'Carbon Red', 'Ocean Blue'],
  Scenes: ['Midnight', 'Royal Indigo', 'Emerald Room'],
  Buttons: ['White D', 'Red D', 'Gray D'],
  Cards: ['Classic Blue', 'Classic Red', 'Royal'],
} as const;

const CATEGORY_APPEARANCE_FIELD = {
  Tables: 'table',
  Scenes: 'background',
  Buttons: 'button',
  Cards: 'cards',
} as const satisfies Record<keyof typeof CATEGORY_ALTERNATIVES, keyof Appearance>;

const FREE_ASSET_ID_BY_NAME: Record<string, string> = {
  'Classic Green': 'classic_green',
  'Carbon Red': 'carbon_red',
  'Ocean Blue': 'ocean_blue',
  Midnight: 'midnight',
  'Royal Indigo': 'royal_indigo',
  'Emerald Room': 'emerald_room',
  'White D': 'classic-white',
  'Red D': 'red-d-gear',
  'Gray D': 'gray-d-gear',
  'Classic Blue': 'classic_blue',
  'Classic Red': 'classic_red',
  Royal: 'royal',
};

const PRODUCTION_RESPONSE_TIMEOUT = 60_000;
const PRESENCE_TOPIC_PREFIX = 'cert-presence:';
const accountObservations = new WeakMap<Page, ReturnType<typeof observeAccountRealtime>>();
// Record only the expected cosmetic signal, never session/auth websocket frames.
const appearanceSignalReceived = new WeakMap<Page, boolean>();
const accountSignalReceived = new WeakMap<Page, boolean>();
function observeAppearanceSignal(page: Page, userId: string) {
  appearanceSignalReceived.set(page, false);
  accountSignalReceived.set(page, false);
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        const event = Array.isArray(frame) ? frame[3] : frame.event;
        const body = Array.isArray(frame) ? frame[4] : frame.payload;
        if (
          event === 'broadcast' &&
          body?.event === 'appearance_changed' &&
          body?.payload?.user_id === userId
        )
          appearanceSignalReceived.set(page, true);
        if (
          event === 'broadcast' &&
          body?.event === 'account_changed' &&
          body?.payload?.user_id === userId
        )
          accountSignalReceived.set(page, true);
      } catch {
        /* Non-JSON websocket frames are unrelated to appearance. */
      }
    })
  );
}
async function expectHeaderPortrait(page: Page, url: string) {
  const portrait = page.locator('button[aria-label="My Profile"] span img').first();
  await expect(portrait).toHaveAttribute('src', url, { timeout: PRODUCTION_RESPONSE_TIMEOUT });
  await expect
    .poll(
      () =>
        portrait.evaluate(
          (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
        ),
      { timeout: PRODUCTION_RESPONSE_TIMEOUT }
    )
    .toBe(true);
}

function preview(studio: Locator) {
  return studio.locator('.studio-game-preview');
}

async function readAppearance(studio: Locator): Promise<Appearance> {
  return preview(studio).evaluate((target) => ({
    table: target.getAttribute('data-table-theme') || '',
    background: target.getAttribute('data-background-theme') || '',
    button: target.getAttribute('data-button-theme') || '',
    cards: target.getAttribute('data-card-back') || '',
  }));
}

async function expectAppearance(studio: Locator, appearance: Appearance) {
  await expect.poll(() => readAppearance(studio), { timeout: 20_000 }).toEqual(appearance);
}

async function expectPreviewAvatarsLoaded(studio: Locator) {
  const avatars = preview(studio).locator('.studio-game-preview__seat > img');
  await expect(avatars).toHaveCount(6, { timeout: PRODUCTION_RESPONSE_TIMEOUT });
  await expect
    .poll(
      () =>
        avatars.evaluateAll((images) =>
          images.every(
            (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
          )
        ),
      {
        timeout: PRODUCTION_RESPONSE_TIMEOUT,
        message: 'Table Studio preview avatars did not resolve to real image assets.',
      }
    )
    .toBe(true);
}

async function expectPersistedAppearance(
  environment: CustomizationCertificationEnvironment,
  userId: string,
  appearance: Appearance
) {
  await expect
    .poll(
      async () => {
        const rows = await readServiceRows<{
          game_type: string;
          table_id: string;
          background_id: string;
          button_id: string;
          cards_id: string;
        }>(
          environment,
          'user_theme_settings',
          new URLSearchParams({
            select: 'game_type,table_id,background_id,button_id,cards_id',
            user_id: `eq.${userId}`,
            game_type: 'eq.ALL',
          })
        );
        const row = rows[0];
        return row
          ? {
              table: row.table_id,
              background: row.background_id,
              button: row.button_id,
              cards: row.cards_id,
            }
          : null;
      },
      {
        timeout: PRODUCTION_RESPONSE_TIMEOUT,
        message: 'The selected Table Studio appearance never became durable.',
      }
    )
    .toEqual(appearance);
}

async function installOverlaySafety(page: Page) {
  await page.addLocatorHandler(
    page.getByRole('dialog', { name: /enable notifications/i }),
    async (dialog) => {
      const dismiss = dialog.getByRole('button', { name: /not now|got it/i }).first();
      if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
    }
  );
}

async function openStudio(page: Page) {
  await installOverlaySafety(page);
  await page.goto('./', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (page.url().includes('/auth')) {
    throw new Error('Production customization smoke requires an authenticated session.');
  }

  const menu = page.getByRole('button', { name: 'Open Menu' }).first();
  await expect(menu).toBeVisible({ timeout: 30_000 });
  await menu.click();
  const open = page.getByRole('button', { name: 'Open Table Studio' });
  await expect(open).toBeVisible({ timeout: 20_000 });
  // Attach before opening the modal. A cached first paint is useful, but the
  // certification must not call it hydrated until this device has completed
  // an authoritative account-scoped settings read. This also prevents a slow
  // auth/store handoff from making the cold-reload assertion race a default or
  // stale local snapshot while the real row is still in flight.
  const hydrated = page.waitForResponse(
    (response) =>
      response.ok() &&
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname.endsWith('/rest/v1/user_theme_settings'),
    { timeout: PRODUCTION_RESPONSE_TIMEOUT }
  );
  await Promise.all([hydrated, open.click()]);

  const studio = page.getByRole('dialog', { name: 'Make The Table Yours' });
  await expect(studio).toBeVisible({ timeout: 20_000 });
  // The successful settings response above proves the authoritative read; the
  // settled grid and live marker below prove that receipt was rendered rather
  // than merely downloaded behind a cached snapshot.
  const grid = studio.locator('.theme-modal__grid');
  await expect(grid).toHaveAttribute('aria-busy', 'false', {
    timeout: PRODUCTION_RESPONSE_TIMEOUT,
  });
  await expect(studio.getByText('Table Art Live')).toBeVisible({
    timeout: PRODUCTION_RESPONSE_TIMEOUT,
  });
  await expectPreviewAvatarsLoaded(studio);
  await expect(grid.locator('.theme-asset[aria-pressed="true"]')).toHaveCount(1, {
    timeout: PRODUCTION_RESPONSE_TIMEOUT,
  });
  return studio;
}

async function signIn(
  context: BrowserContext,
  baseURL: string,
  account: TemporaryCustomizationAccount
) {
  const page = await context.newPage();
  accountObservations.set(page, observeAccountRealtime(page, account.id, ''));
  observeAppearanceSignal(page, account.id);
  // The public landing page deliberately does not redirect signed-out visitors.
  // These contexts are empty: enter a protected route and require real sign-in.
  const protectedURL = new URL('notifications', baseURL).toString();
  await page.goto(protectedURL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForURL((url) => url.pathname.includes('/auth'), { timeout: 20_000 });
  if (page.url().includes('/auth')) {
    const emailInput = page.locator('input[type="email"]').first();
    const passwordInput = page.locator('input[type="password"]').first();
    await expect(emailInput).toBeVisible({ timeout: 30_000 });
    await emailInput.fill(account.email);
    await passwordInput.fill(account.password);
    const titled = page.locator('button[type="submit"][title="Sign In"]').first();
    const submit = (await titled.count())
      ? titled
      : page.locator('form button[type="submit"], button[type="submit"]').first();
    await submit.click();
    await page.waitForURL((url) => !url.pathname.includes('/auth'), { timeout: 45_000 });
  }
  // Wait for persistence, then reject any other identity before account writes.
  const signedInUser = await page.waitForFunction(
    () => {
      try {
        const session = JSON.parse(localStorage.getItem('smarter-poker-auth') || 'null');
        return session?.user?.id || session?.currentSession?.user?.id || null;
      } catch {
        return null;
      }
    },
    undefined,
    { timeout: 30_000 }
  );
  expect(await signedInUser.jsonValue()).toBe(account.id);
  await signedInUser.dispose();

  await page.evaluate(() => localStorage.setItem('club_arena_welcome_accepted', 'true'));
  await page.goto(protectedURL, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await ensureAcceptedTerms(page);
  await ensurePlayableProfile(page);
  await expect(page.getByRole('button', { name: 'Open Menu' }).first()).toBeVisible({
    timeout: 30_000,
  });
  expect(await sessionUserId(page)).toBe(account.id);
  return page;
}

async function sessionUserId(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    try {
      const session = JSON.parse(localStorage.getItem('smarter-poker-auth') || 'null');
      return session?.user?.id || session?.currentSession?.user?.id || '';
    } catch {
      return '';
    }
  });
  if (!id) throw new Error('The authenticated production session had no user id.');
  return id;
}

async function selectedAssetName(studio: Locator) {
  const selected = studio.locator('.theme-modal__grid .theme-asset[aria-pressed="true"]');
  await expect(selected).toHaveCount(1);
  return (await selected.getAttribute('aria-label')) || '';
}

async function activateCategory(studio: Locator, category: keyof SavedStudioState['selections']) {
  const tab = studio.getByRole('tab', { name: category });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function captureState(studio: Locator): Promise<SavedStudioState> {
  const selections = {} as SavedStudioState['selections'];
  await activateCategory(studio, 'Looks');
  selections.Looks = await selectedAssetName(studio);
  await activateCategory(studio, 'Tables');
  selections.Tables = await selectedAssetName(studio);

  await activateCategory(studio, 'Scenes');
  let sceneGroup: SavedStudioState['sceneGroup'] = 'Places & Rooms';
  for (const group of ['Places & Rooms', 'Skins'] as const) {
    await studio.getByRole('button', { name: new RegExp(`^${group}`) }).click();
    const selected = studio.locator('.theme-modal__grid .theme-asset[aria-pressed="true"]');
    if ((await selected.count()) === 1) {
      selections.Scenes = (await selected.getAttribute('aria-label')) || '';
      sceneGroup = group;
      break;
    }
  }
  if (!selections.Scenes) throw new Error('The selected production background was not listed.');

  await activateCategory(studio, 'Buttons');
  selections.Buttons = await selectedAssetName(studio);
  await activateCategory(studio, 'Cards');
  selections.Cards = await selectedAssetName(studio);

  const mode = (
    await studio.getByRole('button', { pressed: true, name: /^(Light|Dark)$/ }).textContent()
  )?.trim() as SavedStudioState['mode'];
  if (mode !== 'Light' && mode !== 'Dark') throw new Error('Interface mode was not selectable.');

  return { appearance: await readAppearance(studio), mode, selections, sceneGroup };
}

async function selectAsset(
  studio: Locator,
  category: keyof SavedStudioState['selections'],
  name: string
) {
  await activateCategory(studio, category);
  if (category === 'Scenes') {
    await studio.getByRole('button', { name: /^Places & Rooms/ }).click();
  }
  const asset = studio.getByRole('button', { name, exact: true });
  await expect(asset).toBeEnabled({ timeout: 20_000 });
  // Cleanup can overlap a newer production run using the same dedicated
  // accounts. If that run has already restored this exact value, there is no
  // write to wait for and the account is already in the requested state.
  if ((await asset.getAttribute('aria-pressed')) === 'true') return;
  const persisted = studio
    .page()
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/rest/v1/user_theme_settings'),
      { timeout: PRODUCTION_RESPONSE_TIMEOUT }
    );
  await asset.click();
  await expect(asset).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
  const response = await persisted;
  if (!response.ok()) {
    throw new Error(`Table Studio persistence failed with HTTP ${response.status()}.`);
  }
  await expect(studio.getByText('Table Art Live')).toBeVisible({ timeout: 20_000 });
}

function different(current: string, options: readonly string[]) {
  const result = options.find((name) => name !== current);
  if (!result) throw new Error(`No alternate free design for ${current}.`);
  return result;
}

function differentFrom(disallowed: readonly string[], options: readonly string[]) {
  const result = options.find((name) => !disallowed.includes(name));
  if (!result) {
    throw new Error(`No free design remains after excluding ${disallowed.join(', ')}.`);
  }
  return result;
}

test.describe('production Table Studio realtime contract', () => {
  // This test performs and verifies durable production writes on two reserved
  // identities, then hard-deletes both. Restoring disposable cosmetics before
  // deletion adds no evidence and can hide the original journey failure.
  test.describe.configure({ mode: 'serial', timeout: 600_000 });

  test('every free cosmetic applies, persists, syncs to another device, and stays isolated from another player', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(600_000);
    if (!baseURL) throw new Error('A deployed BASE_URL is required.');

    const environment = requireCustomizationCertificationEnvironment();
    let primaryAccount: TemporaryCustomizationAccount | undefined;
    let otherAccount: TemporaryCustomizationAccount | undefined;
    let primaryDesktop: BrowserContext | undefined;
    let primaryMobile: BrowserContext | undefined;
    let otherPlayer: BrowserContext | undefined;
    let primaryPage: Page | undefined;
    let primaryStudio: Locator | undefined;
    let mobileStudio: Locator | undefined;
    let otherStudio: Locator | undefined;
    let primaryOriginal: SavedStudioState | undefined;
    let otherOriginal: SavedStudioState | undefined;
    let journeyFailure: unknown;
    const teardownFailures: unknown[] = [];
    const presenceTransports: Array<Awaited<ReturnType<typeof createReservedPresenceTransport>>> =
      [];

    try {
      // Each run owns both players. Post-deploy workflows intentionally do not
      // cancel one another, so standing SP_EMAIL accounts let a newer canary
      // overwrite an older run between its successful POST and reload. That
      // produced a false durability failure while also making cleanup capable
      // of changing a real player's appearance. Reserved identities preserve
      // the exact same two-device/isolation proof without shared mutable state.
      primaryAccount = await createTemporaryCustomizationAccount(environment, 'theme-primary', 0);
      otherAccount = await createTemporaryCustomizationAccount(environment, 'theme-other', 0);
      // The shared fixture sets an Arena avatar, but intentionally does not opt
      // it into the global header. Establish this test's explicit baseline
      // through each reserved player's own authenticated session before opening
      // the receiving browsers; never depend on a production column default.
      for (const account of [primaryAccount, otherAccount]) {
        const baseline = await account.client
          .from('profiles')
          .update({ use_avatar_as_profile_pic: true })
          .eq('id', account.id)
          .select('arena_avatar_url,use_avatar_as_profile_pic');
        if (baseline.error) throw baseline.error;
        expect(baseline.data).toEqual([
          {
            arena_avatar_url: '/avatars/table/free_samurai@2x.webp',
            use_avatar_as_profile_pic: true,
          },
        ]);
      }
      primaryDesktop = await browser.newContext({
        ...devices['Desktop Chrome'],
        baseURL,
        storageState: { cookies: [], origins: [] },
      });
      primaryMobile = await browser.newContext({
        ...devices['iPhone 13'],
        baseURL,
        storageState: { cookies: [], origins: [] },
      });
      otherPlayer = await browser.newContext({
        ...devices['iPhone 13'],
        baseURL,
        storageState: { cookies: [], origins: [] },
      });

      primaryPage = await signIn(primaryDesktop, baseURL, primaryAccount);
      primaryStudio = await openStudio(primaryPage);
      const mobilePage = await signIn(primaryMobile, baseURL, primaryAccount);
      mobileStudio = await openStudio(mobilePage);
      const otherPage = await signIn(otherPlayer, baseURL, otherAccount);
      otherStudio = await openStudio(otherPage);
      console.log('[customization-realtime] three isolated sessions ready');
      const primaryUserId = await sessionUserId(primaryPage);
      expect(await sessionUserId(mobilePage)).toBe(primaryUserId);
      expect(await sessionUserId(otherPage)).not.toBe(primaryUserId);

      primaryOriginal = await captureState(primaryStudio);
      otherOriginal = await captureState(otherStudio);
      const otherBefore = otherOriginal.appearance;
      console.log('[customization-realtime] account baselines captured');

      // A third authenticated session makes the edit. Neither receiving browser
      // is reloaded, focused, or sent an artificial bus event. Both must receive
      // the real private database signal and render its authorized profile read.
      const originalPortrait = '/avatars/table/free_samurai@2x.webp';
      const changedPortrait = '/avatars/table/free_shark@2x.webp';
      await expectHeaderPortrait(primaryPage, originalPortrait);
      await expectHeaderPortrait(mobilePage, originalPortrait);
      await expectHeaderPortrait(otherPage, originalPortrait);
      appearanceSignalReceived.set(primaryPage, false);
      appearanceSignalReceived.set(mobilePage, false);
      const edited = await primaryAccount.client
        .from('profiles')
        .update({ arena_avatar_url: changedPortrait, use_avatar_as_profile_pic: true })
        .eq('id', primaryUserId);
      if (edited.error) throw edited.error;
      await expect
        .poll(() => appearanceSignalReceived.get(primaryPage!), {
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        })
        .toBe(true);
      await expect
        .poll(() => appearanceSignalReceived.get(mobilePage), {
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        })
        .toBe(true);
      await expectHeaderPortrait(primaryPage, changedPortrait);
      await expectHeaderPortrait(mobilePage, changedPortrait);
      await expectHeaderPortrait(otherPage, originalPortrait);
      const appearanceRows = await readServiceRows<{
        arena_avatar_url: string;
        use_avatar_as_profile_pic: boolean;
      }>(
        environment,
        'profiles',
        new URLSearchParams({
          select: 'arena_avatar_url,use_avatar_as_profile_pic',
          id: `eq.${primaryUserId}`,
        })
      );
      expect(appearanceRows).toEqual([
        { arena_avatar_url: changedPortrait, use_avatar_as_profile_pic: true },
      ]);
      console.log(
        '[customization-realtime] profile signal reached both devices and preserved player isolation'
      );

      const primaryPreset = different(primaryOriginal.selections.Looks, Object.keys(PRESETS));
      await selectAsset(primaryStudio, 'Looks', primaryPreset);
      let expectedPrimary = { ...PRESETS[primaryPreset] };
      await expectPersistedAppearance(environment, primaryUserId, expectedPrimary);
      await expectAppearance(primaryStudio, expectedPrimary);
      await expectAppearance(mobileStudio, expectedPrimary);
      await expectAppearance(otherStudio, otherBefore);
      console.log('[customization-realtime] preset synced and remained account-scoped');

      for (const category of ['Tables', 'Scenes', 'Buttons', 'Cards'] as const) {
        await activateCategory(primaryStudio, category);
        if (category === 'Scenes') {
          await primaryStudio.getByRole('button', { name: /^Places & Rooms/ }).click();
        }
        const selected = primaryStudio.locator(
          '.theme-modal__grid .theme-asset[aria-pressed="true"]'
        );
        const current =
          (await selected.count()) === 1 ? (await selected.getAttribute('aria-label')) || '' : '';
        // A preset may already have applied one of these assets. Re-selecting
        // it can produce a green POST while proving nothing about a changed
        // value surviving reload. The final choice must differ from both the
        // artwork currently on screen and the account's original value.
        const target = differentFrom(
          [current, primaryOriginal.selections[category]],
          CATEGORY_ALTERNATIVES[category]
        );
        await selectAsset(primaryStudio, category, target);
        const targetId = FREE_ASSET_ID_BY_NAME[target];
        if (!targetId) throw new Error(`The free design ${target} has no expected asset id.`);
        expectedPrimary = {
          ...expectedPrimary,
          [CATEGORY_APPEARANCE_FIELD[category]]: targetId,
        };
        await expectPersistedAppearance(environment, primaryUserId, expectedPrimary);
        await expectAppearance(primaryStudio, expectedPrimary);
        await expectAppearance(mobileStudio, expectedPrimary);
        await expectAppearance(otherStudio, otherBefore);
        console.log(`[customization-realtime] ${category} synced and remained account-scoped`);
      }

      const finalPrimary = expectedPrimary;
      // openStudio performs a fresh, bounded navigation before reopening the
      // modal. A separate reload here duplicated that navigation and could
      // leave Playwright waiting forever for a lifecycle event even though the
      // production page had already rendered. The navigation below remains a
      // genuine cold rehydrate from the persisted account settings.
      mobileStudio = await openStudio(mobilePage);
      await expectAppearance(mobileStudio, finalPrimary);
      console.log('[customization-realtime] persisted appearance survived a device reload');

      const otherPreset = different(primaryPreset, Object.keys(PRESETS));
      await selectAsset(otherStudio, 'Looks', otherPreset);
      await expectAppearance(otherStudio, PRESETS[otherPreset]);
      await expectAppearance(primaryStudio, finalPrimary);
      console.log('[customization-realtime] second player remained isolated');

      // Same real third session, now exercising the separate metadata/settings
      // carrier on mounted profiles. No synthetic bus emission or read polling.
      for (const page of [primaryPage, mobilePage, otherPage]) {
        await page.goto(new URL('profile', baseURL.endsWith('/') ? baseURL : `${baseURL}/`).href, {
          waitUntil: 'domcontentloaded',
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        });
        await expect(page.locator('#profile-heading')).toBeVisible({
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        });
      }
      const otherName = await rawProfileHeading(otherPage);
      const otherMode = await otherPage.locator('html').getAttribute('data-theme');
      await primaryPage.emulateMedia({ colorScheme: 'light' });
      await mobilePage.emulateMedia({ colorScheme: 'dark' });
      accountSignalReceived.set(primaryPage, false);
      accountSignalReceived.set(mobilePage, false);
      const alias = `Signal${primaryUserId.slice(0, 8)}`;
      const accountEdit = await primaryAccount.client
        .from('profiles')
        .update({
          alias,
          settings: { theme: 'auto', achievementNotifications: false, settlementAlerts: false },
        })
        .eq('id', primaryUserId);
      if (accountEdit.error) throw accountEdit.error;
      for (const page of [primaryPage, mobilePage]) {
        await expect
          .poll(() => accountSignalReceived.get(page), { timeout: PRODUCTION_RESPONSE_TIMEOUT })
          .toBe(true);
        await expect(page.locator('#profile-heading')).toHaveText(alias, {
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        });
        await expect
          .poll(
            () =>
              page.evaluate(() =>
                JSON.parse(localStorage.getItem('club-arena-user-settings') || '{}')
              ),
            { timeout: PRODUCTION_RESPONSE_TIMEOUT }
          )
          .toMatchObject({
            theme: 'auto',
            achievementNotifications: false,
            settlementAlerts: false,
          });
      }
      await expect(primaryPage.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect(mobilePage.locator('html')).toHaveAttribute('data-theme', 'dark');
      await primaryPage.emulateMedia({ colorScheme: 'dark' });
      await expect(primaryPage.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(otherPage.locator('#profile-heading')).toHaveText(otherName);
      await expect(otherPage.locator('html')).toHaveAttribute('data-theme', otherMode!);
      const accountReadback = await primaryAccount.client
        .from('profiles')
        .select('alias,settings')
        .eq('id', primaryUserId)
        .maybeSingle();
      if (accountReadback.error) throw accountReadback.error;
      expect(accountReadback.data).toMatchObject({
        alias,
        settings: { theme: 'auto', achievementNotifications: false, settlementAlerts: false },
      });
      console.log(
        '[account-realtime] private metadata and preferences reached both devices, Auto followed each device, and the other player stayed isolated'
      );

      // UnionDetailPage is owner-only even for a public union. Reserved players
      // must not bypass that route or create/fund a union for certification.
      // This is real SDK transport proof on a disposable topic, separate from
      // the PresenceService unit contracts and the unavailable owner-page UI.
      const presenceTopic = `${PRESENCE_TOPIC_PREFIX}${primaryUserId}`;
      const primaryPresence = await createReservedPresenceTransport(
        environment,
        primaryAccount,
        presenceTopic
      );
      presenceTransports.push(primaryPresence);
      const otherPresence = await createReservedPresenceTransport(
        environment,
        otherAccount,
        presenceTopic
      );
      presenceTransports.push(otherPresence);
      await expect
        .poll(() => primaryPresence.state.peers, {
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        })
        .toEqual([otherAccount.id, primaryUserId].sort());
      await expect
        .poll(() => otherPresence.state.peers, {
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        })
        .toEqual([otherAccount.id, primaryUserId].sort());
      const quietTracks = primaryPresence.state.tracks;
      const quietJoins = primaryPresence.state.joins;
      const quietHeartbeats = primaryPresence.state.heartbeatReplies;
      expect(quietTracks).toBeGreaterThan(0);
      // The old application producer fired every60s. Actual service regression
      // protection remains in PresenceService.test.ts; this interval separately
      // proves the SDK transport stays live without republishing Presence.
      await primaryPage.waitForTimeout(65_000);
      expect(primaryPresence.state.tracks).toBe(quietTracks);
      expect(primaryPresence.state.joins).toBe(quietJoins);
      expect(primaryPresence.state.heartbeatReplies).toBeGreaterThan(quietHeartbeats);
      expect(primaryPresence.state.errors).toEqual([]);
      await otherPresence.leave();
      await expect
        .poll(() => primaryPresence.state.peers, {
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        })
        .toEqual([primaryUserId]);
      expect(primaryPresence.state.leaves).toBeGreaterThan(0);
      await otherPresence.reconnect();
      await expect
        .poll(() => primaryPresence.state.peers, {
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        })
        .toEqual([otherAccount.id, primaryUserId].sort());
      expect(otherPresence.state.tracks).toBeGreaterThan(1);
      expect(otherPresence.state.errors).toEqual([]);
      console.log(
        '[presence-transport] real authenticated SDK join, leave and fresh connection rejoin passed on a reserved topic; unchanged Presence stayed quiet for65s while heartbeat replies continued; owner-only union UI was not exercised'
      );
      const primaryObserved = accountObservations.get(primaryPage)!;

      // Read-only balance acceptance. No financial update is induced to make
      // a cross-device event appear. Prove the real own-row subscription and
      // authorized reads, retention while offline, then reads after rejoin.
      await expect
        .poll(() => primaryObserved.membershipSubscriptions, {
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        })
        .toBeGreaterThan(0);
      await expect
        .poll(() => primaryObserved.membershipReads, { timeout: PRODUCTION_RESPONSE_TIMEOUT })
        .toBeGreaterThan(0);
      await expect
        .poll(() => primaryObserved.balanceReads, { timeout: PRODUCTION_RESPONSE_TIMEOUT })
        .toBeGreaterThan(0);
      const persistedWallet = () =>
        primaryPage!.evaluate(() => JSON.parse(localStorage.getItem('wallet-store') || '{}').state);
      await expect
        .poll(async () => (await persistedWallet())?._balancesUserId, {
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        })
        .toBe(primaryUserId);
      const walletBefore = await persistedWallet();
      const beforeReconnect = { ...primaryObserved };
      await primaryDesktop.setOffline(true);
      await expect
        .poll(() => primaryObserved.socketCloses, { timeout: PRODUCTION_RESPONSE_TIMEOUT })
        .toBeGreaterThan(beforeReconnect.socketCloses);
      expect((await persistedWallet()).balances).toEqual(walletBefore.balances);
      await primaryDesktop.setOffline(false);
      await expect
        .poll(() => primaryObserved.membershipSubscriptions, {
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        })
        .toBeGreaterThan(beforeReconnect.membershipSubscriptions);
      await expect
        .poll(() => primaryObserved.membershipReads, { timeout: PRODUCTION_RESPONSE_TIMEOUT })
        .toBeGreaterThan(beforeReconnect.membershipReads);
      await expect
        .poll(() => primaryObserved.balanceReads, { timeout: PRODUCTION_RESPONSE_TIMEOUT })
        .toBeGreaterThan(beforeReconnect.balanceReads);
      await expect
        .poll(async () => (await persistedWallet())._balancesAt, {
          timeout: PRODUCTION_RESPONSE_TIMEOUT,
        })
        .toBeGreaterThan(walletBefore._balancesAt);
      const authorizedMembers = await primaryAccount.client
        .from('club_members')
        .select('chip_balance,promo_balance,locked_chips')
        .eq('user_id', primaryUserId);
      const authorizedAgents = await primaryAccount.client
        .from('agents')
        .select('agent_wallet_balance')
        .eq('user_id', primaryUserId);
      if (authorizedMembers.error) throw authorizedMembers.error;
      if (authorizedAgents.error) throw authorizedAgents.error;
      const total = (authorizedMembers.data || []).reduce(
        (sum, row) => sum + Number(row.chip_balance || 0),
        0
      );
      const locked = (authorizedMembers.data || []).reduce(
        (sum, row) => sum + Number(row.locked_chips || 0),
        0
      );
      const promo = (authorizedMembers.data || []).reduce(
        (sum, row) => sum + Number(row.promo_balance || 0),
        0
      );
      const business = (authorizedAgents.data || []).reduce(
        (sum, row) => sum + Number(row.agent_wallet_balance || 0),
        0
      );
      const walletAfter = await persistedWallet();
      expect(walletAfter.balances.PLAYER).toMatchObject({
        total,
        locked,
        available: Math.max(0, total - locked),
      });
      expect(walletAfter.balances.PROMO).toMatchObject({ total: promo, available: promo });
      expect(walletAfter.balances.BUSINESS).toMatchObject({ total: business, available: business });
      await primaryPage.goto(
        new URL('wallet', baseURL.endsWith('/') ? baseURL : `${baseURL}/`).href,
        { waitUntil: 'domcontentloaded' }
      );
      await expect(
        primaryPage.getByText('Playable Now', { exact: true }).locator('..').locator('dd')
      ).toHaveText(Math.max(0, total - locked).toLocaleString(), {
        timeout: PRODUCTION_RESPONSE_TIMEOUT,
      });
      console.log(
        '[member-balance] authenticated own-row subscription and initial/reconnect reads reached the persistent wallet and rendered amount; no financial mutation induced'
      );
    } catch (error) {
      journeyFailure = error;
    } finally {
      // Close all realtime sockets before hard-deleting the reserved Auth and
      // database rows. Cleanup must still run when the journey itself fails.
      const closed = await Promise.allSettled([
        ...presenceTransports.map((transport) => transport.close()),
        primaryDesktop?.close(),
        primaryMobile?.close(),
        otherPlayer?.close(),
      ]);
      closed.forEach((result) => {
        if (result.status === 'rejected') teardownFailures.push(result.reason);
      });
      const cleaned = await Promise.allSettled([
        primaryAccount
          ? cleanupTemporaryCustomizationAccount(environment, primaryAccount)
          : Promise.resolve(),
        otherAccount
          ? cleanupTemporaryCustomizationAccount(environment, otherAccount)
          : Promise.resolve(),
      ]);
      cleaned.forEach((result) => {
        if (result.status === 'rejected') teardownFailures.push(result.reason);
      });
    }

    if (journeyFailure && teardownFailures.length) {
      throw new AggregateError(
        [journeyFailure, ...teardownFailures],
        withCauses('Customization certification journey and cleanup both failed:', [
          journeyFailure,
          ...teardownFailures,
        ])
      );
    }
    if (journeyFailure) throw journeyFailure;
    if (teardownFailures.length) {
      /* The combined branch above already folded its causes into the title.
         This one did not, so a teardown that failed ALONE still printed a bare
         name - the same trap one level up (10.86 rule 4). Both branches now
         go through the one helper. */
      throw new AggregateError(
        teardownFailures,
        withCauses('Customization certification cleanup failed.', teardownFailures)
      );
    }
  });
});
