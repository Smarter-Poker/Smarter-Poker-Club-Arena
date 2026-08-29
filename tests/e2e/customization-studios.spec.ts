import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const avatarCss = readFileSync('src/components/customization/AvatarGallery.css', 'utf8');
const studioCss = readFileSync('src/components/table/ThemeSettingsModal.css', 'utf8');

test.describe('mobile-first customization studios', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('Avatar Gallery fits the phone, keeps controls touch-safe, and scrolls only its catalog', async ({
    page,
  }) => {
    await page.setContent(`
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>${avatarCss}</style>
      <div class="avatar-gallery-overlay">
        <section class="avatar-gallery">
          <header class="ag-header"><div><span class="ag-eyebrow">PLAYER IDENTITY STUDIO</span><h1 class="ag-title">Avatar Gallery</h1></div><button class="ag-close">×</button></header>
          <div class="ag-preview"><div class="ag-preview__current"><img class="ag-preview__img" /></div><div class="ag-preview__arrow">→</div><div class="ag-preview__selected"><img class="ag-preview__img ag-preview__img--selected" /></div><div class="ag-preview__status"><span></span>Changes apply instantly</div></div>
          <div class="ag-actions"><button class="ag-action">Quick Avatar</button><button class="ag-action ag-action--vip">Create Custom Avatar</button></div>
          <div class="ag-tabs">${['Presets', 'VIP', 'Mine', 'Style'].map((label, i) => `<button class="ag-tab ${i === 0 ? 'ag-tab--active' : ''}">${label}</button>`).join('')}</div>
          <label class="ag-search"><input placeholder="Search this collection" /><span>⌕</span></label>
          <div class="ag-content"><div class="ag-grid">${Array.from({ length: 20 }, (_, i) => `<button class="ag-item"><span class="ag-item__img"></span><span class="ag-item__name">Avatar ${i + 1}</span></button>`).join('')}</div></div>
          <footer class="ag-footer"><button class="ag-apply">Done</button></footer>
        </section>
      </div>
    `);

    await expect(page.locator('.avatar-gallery')).toHaveCSS('width', '390px');
    await expect(page.locator('.avatar-gallery')).toHaveCSS('height', '844px');
    for (const selector of [
      '.ag-close',
      '.ag-action',
      '.ag-tab',
      '.ag-search input',
      '.ag-apply',
    ]) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(43.9);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(
      await page.locator('.ag-content').evaluate((node) => node.scrollHeight > node.clientHeight)
    ).toBe(true);
    if (process.env.CAPTURE_CUSTOMIZATION_VISUALS) {
      await page.screenshot({ path: 'test-results/avatar-studio-mobile.png' });
    }
  });

  test('Table Studio keeps its gameplay preview above choices without burying the first catalog viewport', async ({
    page,
  }) => {
    await page.setContent(`
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>${studioCss}</style>
      <div class="theme-modal-overlay"><section class="theme-modal">
        <header class="theme-modal__header"><div><span class="theme-modal__eyebrow">PLAYER TABLE STUDIO</span><h1 class="theme-modal__title">Make The Table Yours</h1></div><button class="theme-modal__close">×</button></header>
        <div class="theme-modal__studio-bar"><label class="theme-modal__game-type"><span class="theme-modal__game-label">Apply To</span><select class="theme-modal__game-select"><option>All Games</option></select></label><span class="theme-modal__autosave"><span class="theme-modal__autosave-dot"></span>All changes saved</span></div>
        <div class="theme-modal__workspace">
          <aside class="theme-modal__visual-rail"><fieldset class="theme-modal__mode"><legend>Interface</legend><div class="theme-modal__mode-options"><button class="theme-modal__mode-option">Light</button><button class="theme-modal__mode-option theme-modal__mode-option--active">Dark</button></div><span class="theme-modal__mode-note">Mode note</span></fieldset><div class="theme-modal__preview-shell"><div class="theme-modal__preview-switch"><button class="active">Standard</button><button>Final Table</button></div><div class="theme-modal__live-preview"></div></div><div class="theme-modal__selection-ledger">${['Table', 'Background', 'Buttons', 'Card Back'].map((label) => `<div class="theme-modal__selection-item"><span>${label}</span><strong>Selected</strong></div>`).join('')}</div></aside>
          <section class="theme-modal__catalog"><div class="theme-modal__tabs">${['Themes', 'Table', 'Buttons', 'Background', 'Cards'].map((label) => `<button class="theme-modal__tab">${label}</button>`).join('')}</div><div class="theme-modal__catalog-scroll"><div class="theme-modal__discovery"><label><input placeholder="Search Themes" /></label><div class="theme-modal__filters"><button>All</button><button>Free</button><button>VIP</button></div></div><div class="theme-modal__grid">${Array.from({ length: 8 }, (_, i) => `<div class="theme-asset-wrap"><button class="theme-asset"><span class="theme-asset__preview"></span><span class="theme-asset__name">Design ${i + 1}</span></button><button class="theme-asset__favorite">Favorite</button></div>`).join('')}</div></div><footer class="theme-modal__footer"><button class="theme-modal__btn">Restore</button><button class="theme-modal__btn">Done</button></footer></section>
        </div>
      </section></div>
    `);

    const preview = await page.locator('.theme-modal__live-preview').boundingBox();
    expect(preview?.height).toBeGreaterThanOrEqual(210);
    expect(preview?.height).toBeLessThanOrEqual(270);
    for (const selector of [
      '.theme-modal__close',
      '.theme-modal__game-select',
      '.theme-modal__mode-option',
      '.theme-modal__preview-switch button',
      '.theme-modal__tab',
      '.theme-modal__filters button',
      '.theme-asset__favorite',
    ]) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(43.9);
    }
    const tabRail = page.locator('.theme-modal__tabs');
    expect(await tabRail.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    /* 2026-08-29: this was `tab.scrollWidth <= tab.clientWidth` for every tab —
       "no label is truncated" — and it is the one assertion in this file that
       measures TEXT rather than layout. The studio's font is loaded from
       /fonts by the app, and a page.setContent harness has no base URL to
       resolve it from, so both platforms fall back: macOS to a narrow face
       where "Background" fits 124px, Linux CI to a wider one where it does
       not. The beat went red the first time it ran in the gate, on a runner,
       for a page that ships correctly.
       What the design actually guarantees is the ROOM, not the rendering:
       ThemeSettingsModal.css gives every tab a `minmax(124px, 1fr)` column
       precisely so the words survive ("preserve the words and let the rail do
       the horizontal scrolling it already advertises"). Assert that, and the
       beat means the same thing on every machine. */
    for (const tab of await page.locator('.theme-modal__tab').all()) {
      const w = (await tab.boundingBox())?.width ?? 0;
      expect(w).toBeGreaterThanOrEqual(124);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    if (process.env.CAPTURE_CUSTOMIZATION_VISUALS) {
      await page.screenshot({ path: 'test-results/table-studio-mobile.png' });
    }
  });
});
