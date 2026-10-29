import { expect, devices, type Browser, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { TemporaryCustomizationAccount } from './temporaryCustomizationAccount';

async function passwordPreferenceSession(account: TemporaryCustomizationAccount) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || !account.password || !account.email)
    throw new Error('Owned disposable account and public SDK configuration are required');
  if (account.email === process.env.SP_EMAIL)
    throw new Error('Refusing global pipeline account logout');
  expect(account.email).toMatch(/^ca-customization-cert-.*@example\.invalid$/);
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (error || !data.session || data.user.id !== account.id)
    throw new Error('Owned disposable account password reauthentication failed');
  return { client, session: data.session, ownerId: data.user.id };
}

/** Auth is the only state installed in this independently empty browser context. */
export async function openFreshPreferenceDevice(
  browser: Browser,
  configuredBaseURL: string,
  account: TemporaryCustomizationAccount
) {
  if (!configuredBaseURL) throw new Error('Configured application BASE_URL is required');
  const baseURL = configuredBaseURL.endsWith('/') ? configuredBaseURL : `${configuredBaseURL}/`;
  const { client, session, ownerId } = await passwordPreferenceSession(account);
  const origin = new URL(baseURL).origin;
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    baseURL,
    storageState: {
      cookies: [],
      origins: [
        { origin, localStorage: [{ name: 'smarter-poker-auth', value: JSON.stringify(session) }] },
      ],
    },
  });
  const state = await context.storageState();
  expect(state.cookies).toEqual([]);
  expect(state.origins.flatMap((entry) => entry.localStorage.map((item) => item.name))).toEqual([
    'smarter-poker-auth',
  ]);
  return { context, page: await context.newPage(), client, ownerId };
}

/** Global signout is safe only for this case's distinct, owned disposable account. */
export async function logoutAndOpenFreshPreferenceDevice(
  page: Page,
  configuredBaseURL: string,
  account: TemporaryCustomizationAccount
) {
  if (account.email === process.env.SP_EMAIL)
    throw new Error('Refusing global pipeline account logout');
  const currentOwner = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('smarter-poker-auth') || 'null')?.user?.id ?? null;
    } catch {
      return null;
    }
  });
  expect(currentOwner, 'UI logout may only target this case-owned disposable identity').toBe(
    account.id
  );
  const logout = page.getByRole('button', { name: 'Log Out', exact: true });
  if (!(await logout.isVisible()))
    await page.getByRole('button', { name: 'Open Menu', exact: true }).click();
  await logout.click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('smarter-poker-auth')))
    .toBeNull();
  const browser = page.context().browser();
  if (!browser) throw new Error('Separate browser context required');
  return openFreshPreferenceDevice(browser, configuredBaseURL, account);
}
