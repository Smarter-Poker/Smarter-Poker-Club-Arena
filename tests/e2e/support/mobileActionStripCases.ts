import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

export function registerMobileActionStripCases() {
  for (const width of [320, 375, 393, 430, 480, 481, 606, 768, 1280]) {
    for (const height of width <= 375 ? [width === 320 ? 568 : 667, 852] : [852]) {
      const tiny = width <= 340 && height <= 650;
      const topPad = tiny ? 0 : width <= 375 && height <= 700 ? 8 : 16;
      const controlHeight = tiny ? 44 : 52;
      for (const inset of [0, 24, 59]) {
        for (const standalone of [false, true]) {
          test(`mobile action strip stays reachable at ${width}px with ${inset}px inset (${standalone ? 'installed' : 'browser'}, ${height}px tall)`, async ({
            page,
          }) => {
            await page.setViewportSize({ width, height });
            // Apply the installed-app media condition explicitly: browser test runners
            // cannot enter iOS Home Screen mode. All layout rules remain production CSS.
            const sheets = [
              'src/components/table/TableMenu.css',
              'src/components/table/TableTabBar.css',
              'src/pages/MultiTablePage.css',
            ]
              .map((file) => readFileSync(file, 'utf8'))
              .join('\n')
              .replaceAll(
                '(display-mode: standalone)',
                standalone ? '(min-width: 0px)' : '(max-width: 0px)'
              )
              .replace(/env\(safe-area-inset-top(?:,\s*[^)]+)?\)/g, `${inset}px`);
            await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>*{box-sizing:border-box}body{margin:0}${sheets}</style>
          <main class="multi-table-page"><div class="multi-table-page__tab-bar-wrapper">
          <div class="table-tab-bar"><div class="table-tab-bar__menu-container"><button class="table-menu__trigger" aria-label="Menu">Menu</button></div>
          <div class="table-tab-bar__tabs"><button class="table-tab-bar__tab">PLO</button><button class="table-tab-bar__tab">Lobby</button><button class="table-tab-bar__add" aria-label="Add">+</button></div></div>
          <button class="mtp-lobby-btn" aria-label="Game Lobby">Lobby</button></div></main>`);
            // Pin the approved geometry independently of the CSS tokens. A lower
            // bound alone lets an oversized band or a drifting sibling pass.
            const assertGeometry = async (top: number) => {
              const controls = await page
                .locator(
                  '.table-menu__trigger,.table-tab-bar__tab,.table-tab-bar__add,.mtp-lobby-btn,.multi-table-page__pnl-chip'
                )
                .evaluateAll((elements) =>
                  elements.map((el) => {
                    const rect = el.getBoundingClientRect();
                    return {
                      label: el.getAttribute('aria-label') || el.textContent,
                      sibling: el.matches('.mtp-lobby-btn,.multi-table-page__pnl-chip'),
                      y: rect.y,
                      height: rect.height,
                    };
                  })
                );
              for (const control of controls) {
                const expectedTop = top + (control.sibling && width > 480 ? 0.5 : 0);
                expect(control.height, `${control.label}: control height`).toBeCloseTo(
                  controlHeight,
                  1
                );
                expect(control.y, `${control.label}: top placement`).toBeCloseTo(expectedTop, 1);
              }
            };
            const safeTop = standalone && width <= 480 ? Math.max(60, inset) : inset;
            await assertGeometry(safeTop + topPad);
            await page.evaluate(() => {
              (window as any).stripClicks = [];
              document
                .querySelectorAll('button')
                .forEach((button) =>
                  button.addEventListener('click', () =>
                    (window as any).stripClicks.push(
                      button.getAttribute('aria-label') || button.textContent
                    )
                  )
                );
            });
            for (const name of ['Menu', 'PLO', 'Lobby', 'Add', 'Game Lobby']) {
              const button = page.getByRole('button', { name, exact: true });
              const box = await button.boundingBox();
              expect(box!.y).toBeGreaterThanOrEqual(
                (standalone && width <= 480 ? Math.max(60, inset) : inset) + topPad
              );
              expect(box!.height).toBeGreaterThanOrEqual(controlHeight);
              expect(box!.width).toBeGreaterThanOrEqual(44);
              await button.click();
            }
            expect(await page.evaluate(() => (window as any).stripClicks)).toEqual([
              'Menu',
              'PLO',
              'Lobby',
              'Add',
              'Game Lobby',
            ]);
            const reserve = await page.locator('.multi-table-page').evaluate((el) => {
              const ruler = document.createElement('div');
              ruler.style.height = 'var(--sp-tabbar-h)';
              el.append(ruler);
              return {
                declared: ruler.getBoundingClientRect().height,
                actual: el
                  .querySelector('.multi-table-page__tab-bar-wrapper')!
                  .getBoundingClientRect().height,
              };
            });
            expect(reserve.actual).toBeCloseTo(reserve.declared, 1);
            // Four tabs plus the optional tracker fit without shrinking touch targets.
            await page.locator('.table-tab-bar__tabs').evaluate((el) => {
              el.innerHTML = ['PLO', 'NLH', 'PLO5', 'Lobby']
                .map(
                  (label, i) =>
                    `<button class="table-tab-bar__tab${i === 0 ? ' table-tab-bar__tab--active' : ''}">${label}</button>`
                )
                .join('');
              const tracker = document.createElement('button');
              tracker.className = 'multi-table-page__pnl-chip';
              tracker.textContent = '+12';
              el.closest('.multi-table-page__tab-bar-wrapper')!.insertBefore(
                tracker,
                el.closest('.multi-table-page__tab-bar-wrapper')!.lastElementChild
              );
            });
            await assertGeometry(safeTop + topPad);
            if (width >= 375 && width <= 480) {
              const allVisible = await page.locator('.table-tab-bar__tabs').evaluate((el) => {
                const bounds = el.getBoundingClientRect();
                return [...el.children].every((child) => {
                  const rect = child.getBoundingClientRect();
                  return rect.left >= bounds.left && rect.right <= bounds.right;
                });
              });
              expect(allVisible).toBe(true);
              // Native font metrics differ between macOS and Linux WebKit. The
              // larger accessibility glyphs must not strand tab four.
              const wideLabelLayout = await page.locator('.table-tab-bar__tabs').evaluate((el) => {
                for (const child of el.children) {
                  (child as HTMLElement).style.transition = 'none';
                  (child as HTMLElement).style.fontFamily = 'monospace';
                  (child as HTMLElement).style.fontSize = '18px';
                }
                const bounds = el.getBoundingClientRect();
                return [...el.children].map((child) => {
                  const rect = child.getBoundingClientRect();
                  return {
                    left: rect.left,
                    right: rect.right,
                    width: rect.width,
                    visible: rect.left >= bounds.left && rect.right <= bounds.right,
                  };
                });
              });
              expect(
                wideLabelLayout.every((tab) => tab.width >= 44 && tab.visible),
                JSON.stringify(wideLabelLayout)
              ).toBe(true);
            }
            // A pinned bar under a measured global header must not pay the inset again.
            await page.locator('.multi-table-page__tab-bar-wrapper').evaluate((el) => {
              el.classList.add('multi-table-page__tab-bar-wrapper--pinned');
              (el as HTMLElement).style.setProperty('--ca-global-header-height', '100px');
            });
            expect(
              (await page.getByRole('button', { name: 'Menu', exact: true }).boundingBox())!.y
            ).toBe(100 + topPad);
            await assertGeometry(100 + topPad);
            // The ticker owns its inset. Both in-flow and pinned controls must
            // move with it exactly once, including the separate Lobby/tracker.
            await page.locator('.multi-table-page__tab-bar-wrapper').evaluate((el) => {
              (el as HTMLElement).style.setProperty('--mtt-ticker-h', '31px');
            });
            await assertGeometry(131 + topPad);
            await page.locator('.multi-table-page__tab-bar-wrapper').evaluate((el) => {
              el.classList.remove('multi-table-page__tab-bar-wrapper--pinned');
              (el as HTMLElement).style.setProperty('--sp-tabbar-inset', '0px');
            });
            await assertGeometry(31 + topPad);
          });
        }
      }
    }
  }
}
