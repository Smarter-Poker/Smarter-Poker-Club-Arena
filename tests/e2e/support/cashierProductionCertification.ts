import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

// Visible chip totals are whole chips unless compacted with an explicit K/M/B
// suffix. Reject every unsuffixed fractional value, not just the conventional
// two-decimal rendering; otherwise a regression such as `12.5` or `12.345`
// would evade the production certificate.
const RAW_CENTS = /(?:^|[^\d])[-+]?\d{1,3}(?:,\d{3})*\.\d+(?!\d|[KMB%])/;
const COMPACT_FIGURE = /^[-+]?(?:\d{1,3}(?:,\d{3})*|\d+(?:\.\d)?[KMB])$/;

export async function attachCashierScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  await testInfo.attach(`${name}-393px.png`, {
    body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
    contentType: 'image/png',
  });
}

export async function expectCashierAxeClean(
  page: Page,
  testInfo: TestInfo,
  selector: string,
  name: string
): Promise<void> {
  const result = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const violations = result.violations
    .filter((violation) => ['serious', 'critical'].includes(violation.impact || ''))
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.flatMap((node) => node.target.map(String)),
    }));
  await testInfo.attach(`${name}-axe.json`, {
    body: JSON.stringify({ url: page.url(), violations }, null, 2),
    contentType: 'application/json',
  });
  expect(violations, `${name} has serious or critical Axe violations`).toEqual([]);
}

export async function expectNoRawCashierCents(surface: Locator, name: string): Promise<void> {
  const text = (await surface.innerText()).replace(/\s+/g, ' ').trim();
  expect(text, `${name} exposes a raw two-decimal chip figure`).not.toMatch(RAW_CENTS);
}

export function expectCompactCashierFigure(value: string, name: string): void {
  expect(value.trim(), `${name} is not a no-cents compact chip figure`).toMatch(COMPACT_FIGURE);
}
