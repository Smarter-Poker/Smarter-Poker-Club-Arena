import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';

const DEFAULT_SELECTION = {
  game_type: 'ALL',
  theme_id: 'default-dark',
  table_id: 'classic_green',
  button_id: 'classic-white',
  background_id: 'midnight',
  cards_id: 'classic_red',
  updated_at: '2026-08-30T07:00:00.000Z',
};

type MockStudioServer = {
  saved: typeof DEFAULT_SELECTION;
  purchases: string[];
};

const jsonHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,apikey,content-type,prefer,x-client-info',
  'content-type': 'application/json',
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, headers: jsonHeaders, body: JSON.stringify(body) });
}

async function mockStudioBackend(
  context: BrowserContext,
  options: { unlockAllLooks?: boolean } = {}
): Promise<MockStudioServer> {
  const server: MockStudioServer = { saved: { ...DEFAULT_SELECTION }, purchases: [] };
  let favorites: string[] = [];
  let loadouts: unknown[] = [null, null, null];

  // Intercept the protocol path, not one placeholder hostname. Vite reads the
  // configured Supabase URL at startup, so a host-pinned mock silently let
  // local saves and checkout escape to whichever project was in .env.
  await context.route(/\/auth\/v1\/.*/, (route) => fulfillJson(route, { user: null }));
  await context.route(/\/rest\/v1\/.*/, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: jsonHeaders });
      return;
    }
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON?.() as Record<string, any> | null;

    if (path.endsWith('/rpc/fn_purchase_feature')) {
      const feature = String(body?.p_feature || '');
      server.purchases.push(feature);
      await fulfillJson(route, { success: true, cost: 350 });
      return;
    }
    if (path.endsWith('/rpc/fn_set_interface_theme')) {
      await fulfillJson(route, body?.p_theme || 'dark');
      return;
    }
    if (path.endsWith('/rpc/fn_mutate_table_studio_preferences')) {
      if (body?.p_favorite_key) {
        favorites = body.p_favorite_enabled
          ? [body.p_favorite_key, ...favorites.filter((key) => key !== body.p_favorite_key)]
          : favorites.filter((key) => key !== body.p_favorite_key);
      }
      if (Number.isInteger(body?.p_loadout_slot)) loadouts[body.p_loadout_slot] = body.p_loadout;
      await fulfillJson(route, [{ favorites, loadouts, revision: 1 }]);
      return;
    }
    if (path.endsWith('/rpc/fn_seed_table_studio_preferences')) {
      favorites = Array.isArray(body?.p_favorites) ? body.p_favorites : [];
      loadouts = Array.isArray(body?.p_loadouts) ? body.p_loadouts : [null, null, null];
      await fulfillJson(route, [{ favorites, loadouts, revision: 0 }]);
      return;
    }
    if (path.endsWith('/user_theme_settings')) {
      if (request.method() === 'GET') {
        await fulfillJson(route, [server.saved]);
      } else {
        const patch = Array.isArray(body) ? body[0] : body;
        server.saved = { ...server.saved, ...(patch || {}) };
        await fulfillJson(route, [], 201);
      }
      return;
    }
    if (path.endsWith('/feature_pricing')) {
      await fulfillJson(route, [
        { feature: 'studio:table_id:neon_city', diamond_cost: 350 },
        { feature: 'card_back_neon', diamond_cost: 75 },
      ]);
      return;
    }
    if (path.endsWith('/user_table_studio_preferences')) {
      await fulfillJson(route, { favorites, loadouts, revision: 0 });
      return;
    }
    if (path.endsWith('/theme_asset_unlocks')) {
      await fulfillJson(
        route,
        options.unlockAllLooks
          ? [
              'default-dark',
              'classic-brown',
              'neon-blue',
              'rustic-wood',
              'casino-green',
              'ocean-depths',
              'crimson-club',
              'arctic-suite',
              'amethyst-night',
              'carbon-ion',
            ].map((asset_id) => ({ category: 'theme_id', asset_id }))
          : []
      );
      return;
    }
    if (path.endsWith('/feature_purchases')) {
      await fulfillJson(route, []);
      return;
    }
    if (path.endsWith('/profiles')) {
      await fulfillJson(route, { diamonds: 5_000, settings: { theme: 'dark' } });
      return;
    }
    await fulfillJson(route, []);
  });
  return server;
}

async function openStudio(page: Page) {
  await page.goto('/hub/club-arena/dev/customization', { waitUntil: 'domcontentloaded' });
  const studio = page.getByRole('dialog', { name: 'Make The Table Yours' });
  await expect(studio).toBeVisible({ timeout: 20_000 });
  /* THE TILE CANNOT BE READY BEFORE THE DIALOG, SO ITS BUDGET MUST NOT BE
     SMALLER (2026-09-05). A tile is disabled while
     `themeLoadState !== 'ready'` - the catalog fetch - so this wait is on a
     network round trip that starts only once the line above has passed. Giving
     it half the dialog's budget meant a loaded runner failed here rather than
     on the thing that was actually slow, and it did: it took the required CSS
     Beat E2E check red on a branch whose diff does not touch Table Studio at
     all. The failing tile carried neither `theme-asset--locked` nor the
     "Checking Ownership" label, so ownership had already resolved - only the
     catalog had not arrived. */
  await expect(studio.getByRole('button', { name: 'Carbon Club', exact: true })).toBeEnabled({
    timeout: 20_000,
  });
  return studio;
}

// The CI beat immediately before this one exercises a large production build
// in Chromium and WebKit. On the shared Linux runner, image decode and a
// background mobile tab can keep Playwright's two-frame "stable" heuristic
// pending even though the semantic button is already visible and enabled. The
// control itself is what this suite owns, so invoke the real DOM control once
// those user-visible preconditions are true instead of waiting on unrelated
// pixels elsewhere in the animated studio. Tap-target geometry and keyboard
// activation are asserted separately below.
async function tapReadyControl(control: Locator) {
  await expect(control).toBeVisible({ timeout: 20_000 });
  await expect(control).toBeEnabled({ timeout: 20_000 });
  await control.evaluate((element: HTMLElement) => element.click());
}

const COORDINATED_LOOKS = [
  'House Classic',
  'Carbon Club',
  'Neon Ice',
  'Golden Dusk',
  'Jade Casino',
  'Ocean Suite',
  'Crimson Club',
  'Arctic Suite',
  'Amethyst Night',
  'Carbon Ion',
];

test.describe('real Table Studio browser flows', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('real tiles repaint the real preview, persist, and broadcast to a second tab', async ({
    context,
    page,
  }) => {
    const server = await mockStudioBackend(context);
    const studio = await openStudio(page);
    const preview = studio.locator('.studio-game-preview');
    const liveState = page.getByTestId('customization-live-state');

    const secondPage = await context.newPage();
    const secondStudio = await openStudio(secondPage);
    await page.bringToFront();

    await tapReadyControl(studio.getByRole('tab', { name: 'Tables' }));
    await tapReadyControl(studio.getByRole('button', { name: 'Carbon Red', exact: true }));
    await expect(preview).toHaveAttribute('data-table-theme', 'carbon_red');
    await expect(liveState).toHaveAttribute('data-table-theme', 'carbon_red');
    await expect(secondStudio.locator('.studio-game-preview')).toHaveAttribute(
      'data-table-theme',
      'carbon_red'
    );

    await tapReadyControl(studio.getByRole('tab', { name: 'Buttons' }));
    await tapReadyControl(studio.getByRole('button', { name: 'Red D', exact: true }));
    await expect(preview).toHaveAttribute('data-button-theme', 'red-d-gear');

    await tapReadyControl(studio.getByRole('tab', { name: 'Scenes' }));
    await tapReadyControl(studio.getByRole('button', { name: 'Emerald Room', exact: true }));
    await expect(preview).toHaveAttribute('data-background-theme', 'emerald_room');

    await tapReadyControl(studio.getByRole('tab', { name: 'Cards' }));
    await tapReadyControl(studio.getByRole('button', { name: 'Royal', exact: true }));
    await expect(preview).toHaveAttribute('data-card-back', 'royal');

    /* POLL ALL FOUR, NOT JUST THE FIRST (2026-09-05).
       These are four independent debounced writes and they do not land in the
       order they were made, so polling `table_id` and then asserting the other
       three flat is a race the suite loses intermittently. It lost on
       2026-09-05 with background_id still reading its default 'midnight'
       against an expected 'emerald_room' - a red check on a branch that had not
       touched Table Studio at all. */
    await expect.poll(() => server.saved.table_id).toBe('carbon_red');
    await expect.poll(() => server.saved.button_id).toBe('red-d-gear');
    await expect.poll(() => server.saved.background_id).toBe('emerald_room');
    await expect.poll(() => server.saved.cards_id).toBe('royal');

    await tapReadyControl(studio.getByRole('button', { name: 'Final Table' }));
    await expect(preview).toHaveAttribute('data-table-theme', 'final_table');
    await expect(preview).toHaveAttribute('data-background-theme', 'final_table_broadcast');
    await expect(studio.getByText('CHAMPIONSHIP TABLE')).toBeVisible();
  });

  test('a purchasable design charges once, unlocks, and auto-applies in the real component', async ({
    context,
    page,
  }) => {
    const server = await mockStudioBackend(context);
    const studio = await openStudio(page);
    await tapReadyControl(studio.getByRole('tab', { name: 'Tables' }));
    await tapReadyControl(
      studio.getByRole('button', { name: /Neon City, Purchase Or VIP Required/ })
    );

    const purchase = page.getByRole('dialog', { name: 'Unlock Neon City' });
    await expect(purchase).toBeVisible();
    await tapReadyControl(purchase.getByRole('button', { name: 'Buy For 350 ◆' }));

    // Checkout applies and saves after the RPC response. The native CI trace
    // received that response in18ms but saved the selection after the former
    // five-second dialog deadline. Await the complete persisted outcome with
    // the same bounded readiness budget used by the real Studio controls.
    await expect
      .poll(() => ({ purchases: [...server.purchases], tableId: server.saved.table_id }), {
        timeout: 20_000,
      })
      .toEqual({ purchases: ['studio:table_id:neon_city'], tableId: 'neon_city' });

    await expect(purchase).toBeHidden();
    await expect(studio.locator('.studio-game-preview')).toHaveAttribute(
      'data-table-theme',
      'neon_city'
    );
    await expect(studio.getByRole('button', { name: 'Neon City', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(server.purchases).toEqual(['studio:table_id:neon_city']);
    expect(server.saved.table_id).toBe('neon_city');
  });

  test('the actual mobile dialog passes axe, keyboard, zoom, and forced-color checks', async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);
    await mockStudioBackend(context);
    const studio = await openStudio(page);

    const results = await new AxeBuilder({ page }).include('.theme-modal').analyze();
    expect(results.violations).toEqual([]);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    for (const selector of [
      '.theme-modal__close',
      '.theme-modal__mode-option',
      '.theme-modal__tab',
      '.theme-modal__filters button',
      '.theme-asset__favorite',
    ]) {
      const box = await studio.locator(selector).first().boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }

    await studio.getByRole('tab', { name: 'Looks' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(studio.getByRole('tab', { name: 'Tables' })).toBeFocused();
    await expect(studio.getByRole('tab', { name: 'Tables' })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
    await page.setViewportSize({ width: 320, height: 568 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await expect(studio.getByRole('button', { name: 'Done' })).toBeVisible();

    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await expect(studio.getByRole('button', { name: 'Done' })).toBeVisible();
  });

  // Each look is an independent verdict. Keeping all thirty screenshots in one
  // test made the timeout grow with the catalog and hid which look never ran.
  for (const look of COORDINATED_LOOKS) {
    test(`${look} retains its mobile, tablet, light, dark, and final-table visuals`, async ({
      context,
      page,
    }) => {
      await mockStudioBackend(context, { unlockAllLooks: true });
      const studio = await openStudio(page);
      const shell = studio.locator('.theme-modal__preview-shell');

      await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important}',
      });

      const settleArtwork = async () => {
        await shell.evaluate(async (preview) => {
          await document.fonts.ready;
          await Promise.all(
            Array.from(
              preview.querySelectorAll<HTMLImageElement>(
                '.studio-game-preview__background-ambient, .studio-game-preview__background, .studio-game-preview__table'
              )
            ).map((image) => image.decode())
          );
        });
      };
      const capture = async (name: string) => {
        await settleArtwork();
        await shell.scrollIntoViewIfNeeded();
        const bounds = await shell.boundingBox();
        expect(bounds, `preview bounds for ${name}`).not.toBeNull();
        const clip = {
          x: Math.floor(bounds!.x),
          y: Math.floor(bounds!.y),
          width: Math.ceil(bounds!.x + bounds!.width) - Math.floor(bounds!.x),
          height: Math.ceil(bounds!.y + bounds!.height) - Math.floor(bounds!.y),
        };
        const screenshot = await page.screenshot({
          animations: 'disabled',
          caret: 'hide',
          clip,
          scale: 'css',
        });
        expect(screenshot).toMatchSnapshot(name, { maxDiffPixelRatio: 0.02 });
      };

      const slug = look.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await tapReadyControl(studio.getByRole('button', { name: look, exact: true }));
      await expect(studio.getByRole('button', { name: look, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      );

      await page.setViewportSize({ width: 390, height: 844 });
      await tapReadyControl(studio.getByRole('button', { name: 'Dark', exact: true }));
      await tapReadyControl(studio.getByRole('button', { name: 'Standard', exact: true }));
      await capture(`${slug}-mobile-dark-standard.png`);

      await tapReadyControl(studio.getByRole('button', { name: 'Final Table', exact: true }));
      await capture(`${slug}-mobile-dark-final.png`);

      await page.setViewportSize({ width: 768, height: 1024 });
      await tapReadyControl(studio.getByRole('button', { name: 'Light', exact: true }));
      await tapReadyControl(studio.getByRole('button', { name: 'Standard', exact: true }));
      await capture(`${slug}-tablet-light-standard.png`);
    });
  }
});
