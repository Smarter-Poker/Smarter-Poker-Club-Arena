import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('tests/e2e/routes/hamburger-menu.spec.ts', 'utf8');
const settingsOwner = readFileSync('src/hooks/useUserTableSettings.ts', 'utf8');

describe('production hamburger certification contract', () => {
  it('allows the canonical settings read to settle before measuring persistence', () => {
    const readDeadline = settingsOwner.match(/SETTINGS_READ_TIMEOUT_MS\s*=\s*([\d_]+)/);
    const readinessBudget = source.match(
      /toHaveAttribute\(\s*'aria-busy',\s*'false',\s*\{\s*timeout:\s*([\d_]+)/
    );
    expect(readDeadline, 'the settings owner must retain an explicit read deadline').not.toBeNull();
    expect(
      readinessBudget,
      'the readiness assertion needs the canonical read deadline plus DOM commit headroom'
    ).not.toBeNull();
    const milliseconds = (value: string) => Number(value.replaceAll('_', ''));
    expect(milliseconds(readinessBudget![1])).toBeGreaterThanOrEqual(
      milliseconds(readDeadline![1]) + 5_000
    );
  });

  it('proves the drawer opened and retries only a replaced hydration header', () => {
    expect(source).toContain("getByRole('dialog', { name: 'Poker Arena' })");
    expect(source).toContain('for (let attempt = 0; attempt < 2; attempt += 1)');
    expect(source).toContain("waitFor({ state: 'visible', timeout: 5000 })");
    expect(source).not.toContain('waitForTimeout(400)');
  });

  it('certifies the private Union door with the reserved non-allowlisted account', () => {
    expect(source).toContain('hides Unions and closes its direct route');
    expect(source).toContain("getByRole('button', { name: /^Unions");
    expect(source).toContain("page.goto('unions')");
    expect(source).toContain('toHaveURL(/\\/community');
  });
});

it('waits for its complete authenticated settings row before inspecting panel readiness', () => {
  const journey = source.slice(
    source.indexOf("test('Auto Time Bank defaults"),
    source.indexOf("test('should toggle Sounds")
  );
  expect(journey).toContain(
    'const initialSettingsRead = page.waitForResponse(isCompleteSettingsRead)'
  );
  expect(journey.indexOf('const initialSettingsRead')).toBeLessThan(
    journey.indexOf('await navigateAndWait')
  );
  expect(
    journey.indexOf('await requireOwnSettingsRow(await initialSettingsRead, certificateOwner)')
  ).toBeLessThan(journey.indexOf('await expandSettings();'));
  expect(journey).toContain("toHaveAttribute('aria-busy', 'false')");
  expect(journey).toContain('expect(ownerId).toBe(certificateOwner)');
  expect(journey).not.toContain('setTimeout');
  expect(journey).not.toContain('waitForTimeout');
});
