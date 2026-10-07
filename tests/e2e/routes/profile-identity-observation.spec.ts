import { test, expect } from '@playwright/test';
import { navigateToRenderedProfile } from '../support/renderedProfileNavigation';
import { rawProfileHeading } from '../support/rawProfileHeading';

// Real browser CSS/text semantics only. No app, auth, network or financial fixture.
test('profile isolation compares one text domain while preserving identity changes', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await page.setContent(
      '<h1 id="profile-heading" style="text-transform:uppercase">Certtheme722616</h1>'
    );
    const heading = page.locator('#profile-heading');
    expect(await heading.innerText()).toBe('CERTTHEME722616');
    const unchanged = await rawProfileHeading(page);
    expect(unchanged).toBe('Certtheme722616');
    await expect(heading).toHaveText(unchanged);
    // The comparison still refuses a different identity; no case-insensitive
    // matcher, ignored assertion or normalization of account names is added.
    await heading.evaluate((node) => {
      node.textContent = 'AnotherPlayer';
    });
    await expect(heading).not.toHaveText(unchanged);
    await heading.evaluate((node) => {
      node.textContent = '';
    });
    await expect(rawProfileHeading(page)).rejects.toThrow('Profile heading has no identity');
  } finally {
    await context.close();
  }
});

// Browser history/actionability semantics only; no app, auth or financial requests.
test('profile gesture closes Table Studio and preserves the document', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  let releaseImage = () => {};
  try {
    const page = await context.newPage();
    const base = 'https://profile-fixture.invalid/hub/club-arena/';
    const heldImage = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    await page.route('**/pending-image.svg', async (route) => {
      await heldImage;
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" />',
      });
    });
    await page.route(base, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `
      <button aria-label="My Profile" onclick="window.profileClicks++; history.pushState({}, '', 'profile'); document.querySelector('main').innerHTML='<h1 id=profile-heading>Own Profile</h1>'">Profile</button>
      <dialog open aria-label="Make The Table Yours"><button aria-label="Close Table Studio" onclick="window.studioCloses++; this.closest('dialog').remove()">Close</button></dialog>
      <main>Table</main><img src="pending-image.svg"><script>window.profileClicks=0;window.studioCloses=0;window.documentIdentity={};window.fixtureLoaded=false;window.addEventListener('load',()=>window.fixtureLoaded=true);</script>`,
      })
    );
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    expect(
      await page.evaluate(() => (window as unknown as { fixtureLoaded: boolean }).fixtureLoaded)
    ).toBe(false);
    const documentIdentity = await page.evaluateHandle(
      () => (window as unknown as { documentIdentity: object }).documentIdentity
    );
    const documents: string[] = [];
    page.on('request', (request) => {
      if (request.isNavigationRequest()) documents.push(request.url());
    });
    await navigateToRenderedProfile(page, base, 60_000);
    expect(page.url()).toBe(`${base}profile`);
    expect(
      await page.evaluate(() => (window as unknown as { fixtureLoaded: boolean }).fixtureLoaded)
    ).toBe(false);
    await expect(page.locator('#profile-heading')).toHaveText('Own Profile');
    expect(documents).toEqual([]);
    expect(
      await page.evaluate(
        (identity) =>
          (window as unknown as { documentIdentity: object }).documentIdentity === identity,
        documentIdentity
      )
    ).toBe(true);
    expect(
      await page.evaluate(() => ({
        clicks: (window as unknown as { profileClicks: number }).profileClicks,
        closes: (window as unknown as { studioCloses: number }).studioCloses,
      }))
    ).toEqual({ clicks: 1, closes: 1 });
    await documentIdentity.dispose();
  } finally {
    releaseImage();
    await context.close();
  }
});
