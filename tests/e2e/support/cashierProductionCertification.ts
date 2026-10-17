import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

// Non-wallet transaction/statistic figures retain the compact console reading.
// Wallets have a separate exact-cents contract below. Reject every unsuffixed
// fractional non-wallet value, including 12.5 and 12.345.
const RAW_CENTS = /(?:^|[^\d])[-+]?\d{1,3}(?:,\d{3})*\.\d+(?!\d|[KMB%])/;
// Wallets retain US grouping and exactly two decimals below one million;
// Diamonds retain whole counts. Only million/billion wallets are abbreviated.
const EXACT_WALLET = /^-?(?:0|[1-9]\d{0,2}(?:,\d{3})*)\.\d{2}$/;
const DIAMOND_WALLET = /^-?(?:0|[1-9]\d{0,2}(?:,\d{3})*)$/;
const LARGE_WALLET = /^-?([1-9]\d*(?:\.[1-9])?)([MB])$/;

function isCashierWalletFigure(
  value: string,
  kind: 'chips' | 'diamonds',
  options: { allowAbsentAgentFloat?: boolean } = {}
): boolean {
  // A successful read with no agents row is a documented empty wallet,
  // never an unavailable read. Only the Agent Wallet dialog uses this state.
  if (kind === 'chips' && options.allowAbsentAgentFloat && value === 'No Agent Float Yet')
    return true;
  const large = LARGE_WALLET.exec(value);
  if (large) {
    const magnitude = Number(large[1]);
    return Number.isFinite(magnitude) && (large[2] === 'B' || magnitude < 1_000);
  }
  const pattern = kind === 'diamonds' ? DIAMOND_WALLET : EXACT_WALLET;
  if (!pattern.test(value)) return false;
  const magnitude = Math.abs(Number(value.replace(/,/g, '')));
  // A sub-million chip amount can round to exactly 1,000,000.00.
  return kind === 'chips' ? magnitude <= 1_000_000 : magnitude < 1_000_000;
}

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

export function expectCashierWalletFigure(
  value: string,
  name: string,
  kind: 'chips' | 'diamonds' = 'chips',
  options: { allowAbsentAgentFloat?: boolean } = {}
): void {
  expect(
    isCashierWalletFigure(value.trim(), kind, options),
    `${name} is not a verified ${kind} wallet figure: ${JSON.stringify(value)}`
  ).toBe(true);
}

export async function expectCashierWalletBalance(
  value: Locator,
  name: string,
  kind: 'chips' | 'diamonds' = 'chips',
  options: { allowAbsentAgentFloat?: boolean } = {}
): Promise<void> {
  await expect(value, `${name} must identify one balance`).toHaveCount(1);
  await expect
    .poll(
      async () => {
        const figure = (await value.innerText()).trim();
        return { figure, valid: isCashierWalletFigure(figure, kind, options) };
      },
      { message: `${name} must print its verified ${kind} wallet balance` }
    )
    .toMatchObject({ valid: true });
}

export function expectCompactCashierFigure(value: string, name: string): void {
  expect(value.trim(), `${name} is not a no-cents compact chip figure`).toMatch(
    /^[-+]?(?:\d{1,3}(?:,\d{3})*|\d+(?:\.\d)?[KMB])$/
  );
}

export function cashierRosterWalletValue(label: Locator): Locator {
  return label.locator('..').locator('strong');
}

export function expectCashierAmountPresets(values: string[]): void {
  const labels = values.map((value) => value.trim());
  const isMax = (label: string) => /^max$/i.test(label);
  expect(labels.filter(isMax), 'Amount presets must include one MAX action').toHaveLength(1);
  const amounts = labels.filter((label) => !isMax(label));
  expect(amounts.length, 'Amount presets must include numeric choices').toBeGreaterThan(0);
  for (const amount of amounts) expectCompactCashierFigure(amount, 'Amount Preset');
}
