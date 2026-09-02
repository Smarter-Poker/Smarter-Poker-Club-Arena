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
  cleanupStaleTemporaryCustomizationAccounts,
  createTemporaryCustomizationAccount,
  expectedUnlockForFeature,
  listTableStudioStorefrontSkus,
  readServiceRows,
  requireCustomizationCertificationEnvironment,
  type StorefrontSku,
  type TemporaryCustomizationAccount,
} from './support/temporaryCustomizationAccount';

const CERTIFICATION_ENABLED = process.env.CUSTOMIZATION_COMMERCE_CERTIFICATION === '1';
const RESPONSE_TIMEOUT = 60_000;

type Appearance = {
  table: string;
  background: string;
  button: string;
  cards: string;
};

const FINAL_APPEARANCE: Appearance = {
  table: 'neon_city',
  background: 'place_las_vegas',
  button: 'amethyst-chip',
  cards: 'gold',
};

function preview(studio: Locator) {
  return studio.locator('.studio-game-preview');
}

async function expectAppearance(studio: Locator, appearance: Appearance) {
  await expect(preview(studio)).toHaveAttribute('data-table-theme', appearance.table, {
    timeout: RESPONSE_TIMEOUT,
  });
  await expect(preview(studio)).toHaveAttribute('data-background-theme', appearance.background, {
    timeout: RESPONSE_TIMEOUT,
  });
  await expect(preview(studio)).toHaveAttribute('data-button-theme', appearance.button, {
    timeout: RESPONSE_TIMEOUT,
  });
  await expect(preview(studio)).toHaveAttribute('data-card-back', appearance.cards, {
    timeout: RESPONSE_TIMEOUT,
  });
}

async function signInTemporaryAccount(
  context: BrowserContext,
  baseURL: string,
  account: TemporaryCustomizationAccount
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT });
  await page
    .waitForURL((url) => url.pathname.includes('/auth'), { timeout: 20_000 })
    .catch(() => undefined);

  if (page.url().includes('/auth')) {
    const email = page.locator('input[type="email"]').first();
    const password = page.locator('input[type="password"]').first();
    await expect(email).toBeVisible({ timeout: 30_000 });
    await email.fill(account.email);
    await password.fill(account.password);
    const titled = page.locator('button[type="submit"][title="Sign In"]').first();
    const submit = (await titled.count())
      ? titled
      : page.locator('form button[type="submit"], button[type="submit"]').first();
    await submit.click();
    await page.waitForURL((url) => !url.pathname.includes('/auth'), { timeout: 45_000 });
  }

  await page.evaluate(() => localStorage.setItem('club_arena_welcome_accepted', 'true'));
  // The canonical lobby is intentionally a standalone full-bleed route. It
  // does not mount AppLayout, which owns the server-backed profile decision
  // used by ensurePlayableProfile. Probe a known protected layout route just
  // like global setup and the realtime certification do; otherwise the test
  // waits for a gate that cannot exist on `/` and can never reach checkout.
  await page.goto(new URL('notifications', baseURL).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: RESPONSE_TIMEOUT,
  });
  if (page.url().includes('/auth')) {
    throw new Error(`Temporary customization account ${account.id} did not remain signed in.`);
  }
  await ensurePlayableProfile(page);
  await expect(page.getByRole('button', { name: 'Open Menu' }).first()).toBeVisible({
    timeout: 30_000,
  });
  return page;
}

async function openStudio(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open Menu' }).first().click();
  await page.getByRole('button', { name: 'Open Table Studio' }).click();
  const studio = page.getByRole('dialog', { name: 'Make The Table Yours' });
  await expect(studio).toBeVisible({ timeout: 30_000 });
  await expect(studio.locator('.theme-modal__grid')).toHaveAttribute('aria-busy', 'false', {
    timeout: RESPONSE_TIMEOUT,
  });
  await expect(studio.getByText('Table Art Live')).toBeVisible({ timeout: RESPONSE_TIMEOUT });
  return studio;
}

async function activateCategory(studio: Locator, name: string) {
  const tab = studio.getByRole('tab', { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function openPurchase(studio: Locator, category: string, assetName: string) {
  await activateCategory(studio, category);
  const asset = studio.getByRole('button', {
    name: `${assetName}, Purchase Or VIP Required`,
    exact: true,
  });
  await expect(asset).toBeEnabled({ timeout: 30_000 });
  await asset.click();
  const dialog = studio.page().getByRole('dialog', { name: `Unlock ${assetName}` });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  return dialog;
}

async function applyAsset(studio: Locator, category: string, assetName: string) {
  await activateCategory(studio, category);
  if (category === 'Scenes') {
    await studio.getByRole('button', { name: /^Places & Rooms/ }).click();
  }
  const asset = studio.getByRole('button', { name: assetName, exact: true });
  await expect(asset).toBeEnabled({ timeout: RESPONSE_TIMEOUT });
  if ((await asset.getAttribute('aria-pressed')) === 'true') return;

  const saved = studio
    .page()
    .waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/rest/v1/user_theme_settings'),
      { timeout: RESPONSE_TIMEOUT }
    );
  await asset.click();
  await expect(asset).toHaveAttribute('aria-pressed', 'true', { timeout: RESPONSE_TIMEOUT });
  const response = await saved;
  if (!response.ok()) {
    throw new Error(`Production appearance save failed with HTTP ${response.status()}.`);
  }
}

async function expectNoLockedAssets(studio: Locator) {
  for (const category of ['Looks', 'Tables', 'Buttons', 'Cards']) {
    await activateCategory(studio, category);
    await expect
      .poll(
        () =>
          studio
            .locator('.theme-modal__grid .theme-asset[aria-label*="Purchase Or VIP Required"]')
            .count(),
        {
          timeout: RESPONSE_TIMEOUT,
          message: `${category} still contained a locked purchased item.`,
        }
      )
      .toBe(0);
  }

  await activateCategory(studio, 'Scenes');
  for (const group of ['Places & Rooms', 'Skins']) {
    await studio.getByRole('button', { name: new RegExp(`^${group}`) }).click();
    await expect
      .poll(
        () =>
          studio
            .locator('.theme-modal__grid .theme-asset[aria-label*="Purchase Or VIP Required"]')
            .count(),
        { timeout: RESPONSE_TIMEOUT, message: `${group} still contained a locked purchased item.` }
      )
      .toBe(0);
  }
}

function exactQuery(select: string, column: string, value: string): URLSearchParams {
  return new URLSearchParams({ select, [column]: `eq.${value}` });
}

function purchaseOrder(skus: StorefrontSku[], firstFeature: string): StorefrontSku[] {
  return skus
    .filter((sku) => sku.feature !== firstFeature)
    .sort((left, right) => {
      const leftTheme = left.feature.startsWith('studio:theme_id:') ? 1 : 0;
      const rightTheme = right.feature.startsWith('studio:theme_id:') ? 1 : 0;
      return leftTheme - rightTheme || left.feature.localeCompare(right.feature);
    });
}

test.describe('production Table Studio commerce certification', () => {
  test.skip(
    !CERTIFICATION_ENABLED,
    'Set CUSTOMIZATION_COMMERCE_CERTIFICATION=1 to create isolated production fixtures.'
  );
  test.describe.configure({ mode: 'serial', timeout: 720_000 });

  test('every sellable design charges once, unlocks live, persists, and remains account-scoped', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(720_000);
    if (!baseURL) throw new Error('A deployed BASE_URL is required.');

    const environment = requireCustomizationCertificationEnvironment();
    const staleAccountsRemoved = await cleanupStaleTemporaryCustomizationAccounts(environment);
    console.log(
      `[customization-certification] removed ${staleAccountsRemoved} stale reserved account(s)`
    );
    const skus = await listTableStudioStorefrontSkus(environment);
    expect(skus.length).toBeGreaterThanOrEqual(60);
    const totalCost = skus.reduce((sum, sku) => sum + sku.diamond_cost, 0);
    const firstFeature = 'studio:table_id:neon_city';
    expect(skus.some((sku) => sku.feature === firstFeature)).toBe(true);

    const accounts: TemporaryCustomizationAccount[] = [];
    const contexts: BrowserContext[] = [];
    try {
      const buyer = await createTemporaryCustomizationAccount(
        environment,
        'buyer',
        totalCost + 1_000
      );
      accounts.push(buyer);
      const entitlementProbe = await createTemporaryCustomizationAccount(
        environment,
        'bundle',
        1_500
      );
      accounts.push(entitlementProbe);
      const observer = await createTemporaryCustomizationAccount(environment, 'observer', 0);
      accounts.push(observer);

      const firstDevice = await browser.newContext({
        ...devices['iPhone 13'],
        baseURL,
        storageState: { cookies: [], origins: [] },
      });
      const secondDevice = await browser.newContext({
        ...devices['Pixel 7'],
        baseURL,
        storageState: { cookies: [], origins: [] },
      });
      contexts.push(firstDevice, secondDevice);

      const firstPage = await signInTemporaryAccount(firstDevice, baseURL, buyer);
      const firstStudio = await openStudio(firstPage);
      const secondPage = await signInTemporaryAccount(secondDevice, baseURL, buyer);
      const secondStudio = await openStudio(secondPage);

      // Two independent devices press Buy against the same permanent SKU.
      // Both requests must reach the RPC; one buys and one reconciles ownership.
      const firstDialog = await openPurchase(firstStudio, 'Tables', 'Neon City');
      const secondDialog = await openPurchase(secondStudio, 'Tables', 'Neon City');
      const firstResponse = firstPage.waitForResponse(
        (response) => response.url().includes('/rest/v1/rpc/fn_purchase_feature'),
        { timeout: RESPONSE_TIMEOUT }
      );
      const secondResponse = secondPage.waitForResponse(
        (response) => response.url().includes('/rest/v1/rpc/fn_purchase_feature'),
        { timeout: RESPONSE_TIMEOUT }
      );
      await Promise.all([
        firstDialog.getByRole('button', { name: /Buy For/ }).click(),
        secondDialog.getByRole('button', { name: /Buy For/ }).click(),
      ]);
      const [firstRpcResponse, secondRpcResponse] = await Promise.all([
        firstResponse,
        secondResponse,
      ]);
      expect(firstRpcResponse.ok()).toBe(true);
      expect(secondRpcResponse.ok()).toBe(true);
      const purchaseBodies = await Promise.all([
        firstRpcResponse.json() as Promise<Record<string, unknown>>,
        secondRpcResponse.json() as Promise<Record<string, unknown>>,
      ]);
      expect(purchaseBodies.filter((body) => body.success === true)).toHaveLength(1);
      expect(
        purchaseBodies.filter(
          (body) => body.already_owned === true || body.error === 'already_owned'
        )
      ).toHaveLength(1);
      const firstPurchaseAppearance = {
        ...FINAL_APPEARANCE,
        background: 'midnight',
        button: 'classic-white',
        cards: 'classic_red',
      };
      await expectAppearance(firstStudio, firstPurchaseAppearance);
      await expectAppearance(secondStudio, firstPurchaseAppearance);

      const firstReceipts = await readServiceRows<{ feature: string }>(
        environment,
        'feature_purchases',
        new URLSearchParams({
          select: 'feature',
          user_id: `eq.${buyer.id}`,
          feature: `eq.${firstFeature}`,
        })
      );
      expect(firstReceipts).toHaveLength(1);

      // Exercise every other production SKU through the real authenticated RPC.
      // Individual assets go first; complete themes go last so every SKU sells
      // new permission and the test does not intentionally request an overlap.
      for (const sku of purchaseOrder(skus, firstFeature)) {
        const { data, error } = await buyer.client.rpc('fn_purchase_feature', {
          p_user_id: buyer.id,
          p_feature: sku.feature,
        });
        expect(error, `RPC transport failed for ${sku.feature}`).toBeNull();
        expect(data?.success, `Purchase failed for ${sku.feature}: ${data?.error || ''}`).toBe(
          true
        );
        expect(Number(data?.cost)).toBe(sku.diamond_cost);
      }

      const receipts = await readServiceRows<{ feature: string; cost: number }>(
        environment,
        'feature_purchases',
        exactQuery('feature,cost', 'user_id', buyer.id)
      );
      expect(new Set(receipts.map((row) => row.feature))).toEqual(
        new Set(skus.map((sku) => sku.feature))
      );
      expect(receipts).toHaveLength(skus.length);

      const debits = await readServiceRows<{
        amount: number;
        transaction_type: string;
        metadata: { feature?: string } | null;
      }>(
        environment,
        'diamond_transactions',
        new URLSearchParams({
          select: 'amount,transaction_type,metadata',
          user_id: `eq.${buyer.id}`,
          transaction_type: 'eq.feature_purchase',
        })
      );
      expect(debits).toHaveLength(skus.length);
      expect(debits.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(-totalCost);
      expect(new Set(debits.map((row) => String(row.metadata?.feature || '')))).toEqual(
        new Set(skus.map((sku) => sku.feature))
      );

      const balanceRows = await readServiceRows<{ diamonds: number }>(
        environment,
        'profiles',
        exactQuery('diamonds', 'id', buyer.id)
      );
      expect(Number(balanceRows[0]?.diamonds)).toBe(1_000);

      const unlocks = await readServiceRows<{ category: string; asset_id: string }>(
        environment,
        'theme_asset_unlocks',
        exactQuery('category,asset_id', 'user_id', buyer.id)
      );
      const unlockSet = new Set(unlocks.map((row) => `${row.category}:${row.asset_id}`));
      for (const sku of skus) {
        const expected = expectedUnlockForFeature(sku.feature);
        expect(expected, `No entitlement mapping exists for ${sku.feature}`).not.toBeNull();
        expect(unlockSet.has(expected as string), `${sku.feature} delivered no ${expected}`).toBe(
          true
        );
      }

      // The second device stayed open while 59 more purchases committed. Its
      // owner-filtered Realtime subscription must remove every lock without a reload.
      await expectNoLockedAssets(secondStudio);

      await applyAsset(firstStudio, 'Looks', 'Neon Ice');
      await expectAppearance(secondStudio, {
        table: 'ice_cavern',
        background: 'galaxy',
        button: 'blue-crystal',
        cards: 'classic_blue',
      });
      await applyAsset(firstStudio, 'Tables', 'Neon City');
      await applyAsset(firstStudio, 'Scenes', 'Las Vegas');
      await applyAsset(firstStudio, 'Buttons', 'Amethyst Chip');
      await applyAsset(firstStudio, 'Cards', 'Premium Gold');
      await expectAppearance(firstStudio, FINAL_APPEARANCE);
      await expectAppearance(secondStudio, FINAL_APPEARANCE);

      await secondPage.reload({ waitUntil: 'domcontentloaded', timeout: RESPONSE_TIMEOUT });
      const reloadedStudio = await openStudio(secondPage);
      await expectAppearance(reloadedStudio, FINAL_APPEARANCE);

      // A preset grants its linked assets. The linked a-la-carte RPC must now
      // reconcile that entitlement without charging, even though this account
      // has enough diamonds for the old broken path to debit it.
      const themeFeature = 'studio:theme_id:neon-blue';
      const linkedFeature = 'studio:table_id:ice_cavern';
      const { data: presetPurchase, error: presetError } = await entitlementProbe.client.rpc(
        'fn_purchase_feature',
        { p_user_id: entitlementProbe.id, p_feature: themeFeature }
      );
      expect(presetError).toBeNull();
      expect(presetPurchase?.success).toBe(true);
      const probeBefore = await readServiceRows<{ diamonds: number }>(
        environment,
        'profiles',
        exactQuery('diamonds', 'id', entitlementProbe.id)
      );
      const { data: linkedPurchase, error: linkedError } = await entitlementProbe.client.rpc(
        'fn_purchase_feature',
        { p_user_id: entitlementProbe.id, p_feature: linkedFeature }
      );
      expect(linkedError).toBeNull();
      expect(linkedPurchase?.already_owned).toBe(true);
      expect(linkedPurchase?.ownership_source).toBe('entitlement');
      const probeAfter = await readServiceRows<{ diamonds: number }>(
        environment,
        'profiles',
        exactQuery('diamonds', 'id', entitlementProbe.id)
      );
      expect(probeAfter[0]?.diamonds).toBe(probeBefore[0]?.diamonds);
      const linkedReceipts = await readServiceRows<{ feature: string }>(
        environment,
        'feature_purchases',
        new URLSearchParams({
          select: 'feature',
          user_id: `eq.${entitlementProbe.id}`,
          feature: `eq.${linkedFeature}`,
        })
      );
      expect(linkedReceipts).toHaveLength(0);

      // An empty account is refused by server truth, cannot buy for another
      // user id, and RLS cannot read the buyer's entitlement rows.
      const cheapest = [...skus].sort((a, b) => a.diamond_cost - b.diamond_cost)[0];
      const { data: insufficient, error: insufficientError } = await observer.client.rpc(
        'fn_purchase_feature',
        { p_user_id: observer.id, p_feature: cheapest.feature }
      );
      expect(insufficientError).toBeNull();
      expect(insufficient?.success).toBe(false);
      expect(String(insufficient?.error || '')).toMatch(/insufficient/i);

      const { data: crossAccount, error: crossAccountError } = await observer.client.rpc(
        'fn_purchase_feature',
        { p_user_id: buyer.id, p_feature: cheapest.feature }
      );
      expect(crossAccountError).toBeNull();
      expect(crossAccount?.success).toBe(false);
      expect(String(crossAccount?.error || '')).toMatch(/own account/i);

      const { data: leakedUnlocks, error: leakedUnlockError } = await observer.client
        .from('theme_asset_unlocks')
        .select('category,asset_id')
        .eq('user_id', buyer.id);
      expect(leakedUnlockError).toBeNull();
      expect(leakedUnlocks).toEqual([]);
    } finally {
      await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
      for (const account of accounts.reverse()) {
        await cleanupTemporaryCustomizationAccount(environment, account);
      }
    }
  });
});
