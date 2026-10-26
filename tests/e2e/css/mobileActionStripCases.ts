import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

export function registerMobileActionStripCases() {
  for (const width of [320, 375, 393, 430]) {
    for (const inset of [0, 24, 59]) {
      test(`mobile action strip stays reachable at ${width}px with ${inset}px inset`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 852 });
        // Apply the installed-app media condition explicitly: browser test runners
        // cannot enter iOS Home Screen mode. All layout rules remain production CSS.
        const sheets = [
          'src/components/table/TableMenu.css',
          'src/components/table/TableTabBar.css',
          'src/pages/MultiTablePage.css',
        ]
          .map((file) => readFileSync(file, 'utf8'))
          .join('\n')
          .replaceAll('(display-mode: standalone)', '(min-width: 0px)')
          .replace(/env\(safe-area-inset-top(?:,\s*[^)]+)?\)/g, `${inset}px`);
        await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>*{box-sizing:border-box}body{margin:0}${sheets}</style>
          <main class="multi-table-page"><div class="multi-table-page__tab-bar-wrapper">
          <div class="table-tab-bar"><div class="table-tab-bar__menu-container"><button class="table-menu__trigger" aria-label="Menu">Menu</button></div>
          <div class="table-tab-bar__tabs"><button class="table-tab-bar__tab">PLO</button><button class="table-tab-bar__tab">Lobby</button><button class="table-tab-bar__add" aria-label="Add">+</button></div></div>
          <button class="mtp-lobby-btn" aria-label="Game Lobby">Lobby</button></div></main>`);
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
          expect(box!.y).toBeGreaterThanOrEqual(Math.max(60, inset));
          expect(box!.height).toBeGreaterThanOrEqual(44);
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
            actual: el.querySelector('.multi-table-page__tab-bar-wrapper')!.getBoundingClientRect()
              .height,
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
        if (width >= 375) {
          const allVisible = await page.locator('.table-tab-bar__tabs').evaluate((el) => {
            const bounds = el.getBoundingClientRect();
            return [...el.children].every((child) => {
              const rect = child.getBoundingClientRect();
              return rect.left >= bounds.left && rect.right <= bounds.right;
            });
          });
          expect(allVisible).toBe(true);
        }
        // A pinned bar under a measured global header must not pay the inset again.
        await page.locator('.multi-table-page__tab-bar-wrapper').evaluate((el) => {
          el.classList.add('multi-table-page__tab-bar-wrapper--pinned');
          (el as HTMLElement).style.setProperty('--ca-global-header-height', '100px');
        });
        expect(
          (await page.getByRole('button', { name: 'Menu', exact: true }).boundingBox())!.y
        ).toBe(100);
      });
    }
  }
}
