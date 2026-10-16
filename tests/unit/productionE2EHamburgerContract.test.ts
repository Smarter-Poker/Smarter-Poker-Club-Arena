import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectsUserTableSettingsColumn } from '../e2e/support/userTableSettingsRead';

const source = readFileSync('tests/e2e/routes/hamburger-menu.spec.ts', 'utf8');

describe('production hamburger certification contract', () => {
  it('waits for the Auto Time Bank read even when the other settings owner responds first', () => {
    const endpoint = 'https://example.supabase.co/rest/v1/user_table_settings';
    const tableChromeRead = `${endpoint}?select=sound_enabled%2Cshow_ticker%2Csettings_touched&user_id=eq.player`;
    const allPlayerSettings = `${endpoint}?select=*&user_id=eq.player`;
    const timeBankRead = `${endpoint}?select=user_id%2Cauto_time_bank&user_id=eq.player`;
    expect(selectsUserTableSettingsColumn(tableChromeRead, 'auto_time_bank')).toBe(false);
    expect(selectsUserTableSettingsColumn(allPlayerSettings, 'auto_time_bank')).toBe(true);
    expect(selectsUserTableSettingsColumn(timeBankRead, 'auto_time_bank')).toBe(true);
    expect(selectsUserTableSettingsColumn(`${endpoint}_history?select=*`, 'auto_time_bank')).toBe(
      false
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
