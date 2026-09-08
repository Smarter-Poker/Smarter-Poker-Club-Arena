/**
 * Store readiness, phase 3b: what a reviewer reads and what the app collects.
 * Behavioural where the module is pure (consent, the age arithmetic); text
 * where the pin is copy or wiring.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getAnalyticsConsent,
  setAnalyticsConsent,
  analyticsAllowed,
  ANALYTICS_CONSENT_KEY,
} from '../../src/lib/consent';
import { ageOn, latestAdultBirthday, MINIMUM_AGE } from '../../src/components/legal/AgeGate';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

// Prettier wraps JSX text; every whitespace run is one \s+.
const DAN_SENTENCE =
  /Smarter\.Poker\s+Does\s+Not\s+Sell,\s+Redeem\s+Or\s+Pay\s+Out\s+Chips\s+And\s+Assigns\s+Them\s+No\s+Monetary\s+Value/;

describe('chips are described the one way Dan settled (2026-09-07), everywhere a reader sees it', () => {
  for (const f of [
    'src/components/modals/ClubArenaWelcomeModal.tsx',
    'src/pages/legal/TermsOfServicePage.tsx',
    'src/components/legal/TOSAcceptanceModal.tsx',
  ]) {
    it(f, () => {
      const src = read(f);
      expect(src).toContain('Club Play Credits');
      expect(src).toMatch(DAN_SENTENCE);
      expect(src).not.toContain('Cannot Be Exchanged For Real Money');
      expect(src).not.toContain('No Real-World Monetary');
    });
  }
});

describe('the age gate', () => {
  it('counts whole years, birthday inclusive', () => {
    const today = new Date(Date.UTC(2026, 8, 8)); // 2026-09-08
    expect(ageOn('2008-09-08', today)).toBe(18);
    expect(ageOn('2008-09-09', today)).toBe(17);
    expect(ageOn('1990-05-04', today)).toBe(36);
    expect(ageOn('2008-02-30', today)).toBeNull();
    expect(ageOn('nope', today)).toBeNull();
    expect(latestAdultBirthday(today)).toBe('2008-09-08');
    expect(MINIMUM_AGE).toBe(18);
  });
  it('is native-only until Dan flips it, wraps the app inside TOSGuard, and writes through the one RPC', () => {
    const gate = read('src/components/legal/AgeGate.tsx');
    expect(gate).toContain('export const AGE_GATE_ON_WEB = false;');
    expect(gate).toContain("supabase.rpc('fn_set_my_birthday', { p_birthday: birthday })");
    expect(gate).toContain("await supabase.auth.signOut({ scope: 'local' });");
    // under 18 never reaches the server
    expect(gate).toMatch(/age < MINIMUM_AGE\s*\?\s*\{ ok: false, reason: 'under_18' \}/);
    const app = read('src/App.tsx');
    expect(app.indexOf('<AgeGate>')).toBeGreaterThan(app.indexOf('<TOSGuard>'));
    expect(app.indexOf('</AgeGate>')).toBeLessThan(app.indexOf('</TOSGuard>'));
  });
  it('the RPC refuses under 18 with nothing written, is once-only, and asks auth.uid()', () => {
    const sql = read(
      'supabase/migrations/20260908004420_a_player_states_a_date_of_birth_once_and_the_platform_refuse.sql'
    );
    expect(sql).toContain('v_uid uuid := auth.uid();');
    expect(sql).toContain("RETURN jsonb_build_object('ok', false, 'reason', 'under_18');");
    expect(sql.indexOf("'under_18'")).toBeLessThan(sql.indexOf('UPDATE public.profiles'));
    expect(sql).toContain("RETURN jsonb_build_object('ok', false, 'reason', 'already_set');");
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_set_my_birthday(date) FROM PUBLIC, anon;'
    );
  });
});

describe('consent', () => {
  beforeEach(() => localStorage.clear());
  it('remembers an answer and reports it', () => {
    expect(getAnalyticsConsent()).toBe('unset');
    setAnalyticsConsent('denied');
    expect(getAnalyticsConsent()).toBe('denied');
    expect(localStorage.getItem(ANALYTICS_CONSENT_KEY)).toBe('denied');
    setAnalyticsConsent('granted');
    expect(getAnalyticsConsent()).toBe('granted');
  });
  it('on the web (this test build) analytics is allowed regardless: nothing changes there', () => {
    expect(analyticsAllowed()).toBe(true);
    setAnalyticsConsent('denied');
    expect(analyticsAllowed()).toBe(true);
  });
  it('the app asks once, PostHog asks consent, Sentry never carries the email and records no replay in the app', () => {
    expect(read('src/lib/analytics.ts')).toContain(
      'return isBrowser() && !!getKey() && analyticsAllowed();'
    );
    const sentry = read('src/core/SentryInit.ts');
    const setUser = sentry.slice(
      sentry.indexOf('export function setSentryUser'),
      sentry.indexOf('export function clearSentryUser')
    );
    expect(setUser).not.toMatch(/email:\s*user\.email/);
    expect(sentry).toContain('replaysSessionSampleRate: IS_NATIVE_BUILD ? 0 : 0.1,');
    expect(sentry).toContain('replaysOnErrorSampleRate: IS_NATIVE_BUILD ? 0 : 1.0,');
    expect(read('src/App.tsx')).toContain('{IS_NATIVE_BUILD && (');
    expect(read('src/App.tsx')).toContain(
      "lazyWithRetry(() => import('./components/legal/AgeGate'))"
    );
    expect(read('src/pages/SettingsPage.tsx')).toContain('Share Usage Analytics');
  });
  it('the privacy policy names every service by name and purpose', () => {
    const p = read('src/pages/legal/PrivacyPolicyPage.tsx');
    for (const name of [
      'Supabase',
      'Sentry',
      'PostHog',
      'Apple App Store And Google Play',
      'Firebase Cloud Messaging',
    ]) {
      expect(p, name).toContain(`<strong>${name}:</strong>`);
    }
    expect(p).toMatch(/It\s+Does\s+Not\s+Carry\s+Your\s+Email\s+Address/);
  });
});

describe('no credit without a payment', () => {
  it('the client has no path that credits a diamond package without a store receipt or a Checkout session', () => {
    const src = read('src/services/DiamondService.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    expect(src).not.toMatch(/rpc\(\s*['"]fn_add_diamonds['"]/);
  });
});
