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
  requireCustomizationCertificationEnvironment,
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

const PRODUCTION_RESPONSE_TIMEOUT = 60_000;

function preview(studio: Locator) {
  return studio.locator('.studio-game-preview');
}

async function readAppearance(studio: Locator): Promise<Appearance> {
  const target = preview(studio);
  return {
    table: (await target.getAttribute('data-table-theme')) || '',
    background: (await target.getAttribute('data-background-theme')) || '',
    button: (await target.getAttribute('data-button-theme')) || '',
    cards: (await target.getAttribute('data-card-back')) || '',
  };
}

async function expectAppearance(studio: Locator, appearance: Appearance) {
  const target = preview(studio);
  await expect(target).toHaveAttribute('data-table-theme', appearance.table, { timeout: 20_000 });
  await expect(target).toHaveAttribute('data-background-theme', appearance.background, {
    timeout: 20_000,
  });
  await expect(target).toHaveAttribute('data-button-theme', appearance.button, {
    timeout: 20_000,
  });
  await expect(target).toHaveAttribute('data-card-back', appearance.cards, { timeout: 20_000 });
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
  await open.click();

  const studio = page.getByRole('dialog', { name: 'Make The Table Yours' });
  await expect(studio).toBeVisible({ timeout: 20_000 });
  // The settings request may be satisfied before the listener is attached or
  // from a warm in-memory snapshot. Network timing is not the contract; a
  // settled grid with the live-status marker and exactly one selected design
  // is. These assertions still fail on an empty/error response without making
  // a cached success look like a timeout.
  const grid = studio.locator('.theme-modal__grid');
  await expect(grid).toHaveAttribute('aria-busy', 'false', {
    timeout: PRODUCTION_RESPONSE_TIMEOUT,
  });
  await expect(studio.getByText('Table Art Live')).toBeVisible({
    timeout: PRODUCTION_RESPONSE_TIMEOUT,
  });
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

async function restoreState(studio: Locator, state: SavedStudioState) {
  await selectAsset(studio, 'Looks', state.selections.Looks);
  await selectAsset(studio, 'Tables', state.selections.Tables);
  await activateCategory(studio, 'Scenes');
  await studio.getByRole('button', { name: new RegExp(`^${state.sceneGroup}`) }).click();
  const scene = studio.getByRole('button', { name: state.selections.Scenes, exact: true });
  await expect(scene).toBeEnabled({ timeout: 20_000 });
  if ((await scene.getAttribute('aria-pressed')) !== 'true') {
    const scenePersisted = studio
      .page()
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes('/rest/v1/user_theme_settings'),
        { timeout: PRODUCTION_RESPONSE_TIMEOUT }
      );
    await scene.click();
    await expect(scene).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
    const sceneResponse = await scenePersisted;
    if (!sceneResponse.ok()) {
      throw new Error(`Table Studio restoration failed with HTTP ${sceneResponse.status()}.`);
    }
  }
  await selectAsset(studio, 'Buttons', state.selections.Buttons);
  await selectAsset(studio, 'Cards', state.selections.Cards);
  await studio.getByRole('button', { name: state.mode, exact: true }).click();
  await expectAppearance(studio, state.appearance);
}

test.describe('production Table Studio realtime contract', () => {
  // This test deliberately performs and verifies a dozen durable production
  // writes, then restores two accounts. Publish bursts can make the cleanup
  // slower without making it less necessary, so give the live contract its
  // own budget instead of letting Playwright close the browser mid-restore.
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
      const primaryUserId = await sessionUserId(primaryPage);
      expect(await sessionUserId(mobilePage)).toBe(primaryUserId);
      expect(await sessionUserId(otherPage)).not.toBe(primaryUserId);

      primaryOriginal = await captureState(primaryStudio);
      otherOriginal = await captureState(otherStudio);
      const otherBefore = otherOriginal.appearance;

      const primaryPreset = different(primaryOriginal.selections.Looks, Object.keys(PRESETS));
      await selectAsset(primaryStudio, 'Looks', primaryPreset);
      await expectAppearance(primaryStudio, PRESETS[primaryPreset]);
      await expectAppearance(mobileStudio, PRESETS[primaryPreset]);
      await expectAppearance(otherStudio, otherBefore);

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
        const updated = await readAppearance(primaryStudio);
        await expectAppearance(mobileStudio, updated);
        await expectAppearance(otherStudio, otherBefore);
      }

      const finalPrimary = await readAppearance(primaryStudio);
      await mobilePage.reload({ waitUntil: 'domcontentloaded' });
      mobileStudio = await openStudio(mobilePage);
      await expectAppearance(mobileStudio, finalPrimary);

      const otherPreset = different(primaryPreset, Object.keys(PRESETS));
      await selectAsset(otherStudio, 'Looks', otherPreset);
      await expectAppearance(otherStudio, PRESETS[otherPreset]);
      await expectAppearance(primaryStudio, finalPrimary);
    } catch (error) {
      journeyFailure = error;
    } finally {
      // Restoration is useful evidence when the test reaches it, but reserved
      // fixtures must be closed and hard-deleted even if restoration itself
      // exposes a regression. Collect every teardown failure and report them
      // together after all recoverable cleanup has run.
      const restored = await Promise.allSettled([
        primaryStudio && primaryOriginal
          ? restoreState(primaryStudio, primaryOriginal)
          : Promise.resolve(),
        otherStudio && otherOriginal ? restoreState(otherStudio, otherOriginal) : Promise.resolve(),
      ]);
      restored.forEach((result) => {
        if (result.status === 'rejected') teardownFailures.push(result.reason);
      });
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
      throw new AggregateError(
        [journeyFailure, ...teardownFailures],
        'Customization certification journey and cleanup both failed.'
      );
    }
    if (journeyFailure) throw journeyFailure;
    if (teardownFailures.length) {
      throw new AggregateError(teardownFailures, 'Customization certification cleanup failed.');
    }
  });
});
