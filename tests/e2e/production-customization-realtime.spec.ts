import {
  devices,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

import { ensurePlayableProfile } from './support/ensurePlayableProfile';
import {
  cleanupTemporaryCustomizationAccount,
  createTemporaryCustomizationAccount,
  readServiceRows,
  requireCustomizationCertificationEnvironment,
  type CustomizationCertificationEnvironment,
  type TemporaryCustomizationAccount,
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
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page
    .waitForURL((url) => url.pathname.includes('/auth'), { timeout: 20_000 })
    .catch(() => undefined);
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
  await page.evaluate(() => localStorage.setItem('club_arena_welcome_accepted', 'true'));
  await page.goto(new URL('notifications', baseURL).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
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

    try {
      // Each run owns both players. Post-deploy workflows intentionally do not
      // cancel one another, so standing SP_EMAIL accounts let a newer canary
      // overwrite an older run between its successful POST and reload. That
      // produced a false durability failure while also making cleanup capable
      // of changing a real player's appearance. Reserved identities preserve
      // the exact same two-device/isolation proof without shared mutable state.
      primaryAccount = await createTemporaryCustomizationAccount(environment, 'theme-primary', 0);
      otherAccount = await createTemporaryCustomizationAccount(environment, 'theme-other', 0);
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
    } catch (error) {
      journeyFailure = error;
    } finally {
      // Close all realtime sockets before hard-deleting the reserved Auth and
      // database rows. Cleanup must still run when the journey itself fails.
      const closed = await Promise.allSettled([
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
      const failureSummary = [journeyFailure, ...teardownFailures]
        .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
        .join(' | ');
      throw new AggregateError(
        [journeyFailure, ...teardownFailures],
        `Customization certification journey and cleanup both failed: ${failureSummary}`
      );
    }
    if (journeyFailure) throw journeyFailure;
    if (teardownFailures.length) {
      throw new AggregateError(teardownFailures, 'Customization certification cleanup failed.');
    }
  });
});
