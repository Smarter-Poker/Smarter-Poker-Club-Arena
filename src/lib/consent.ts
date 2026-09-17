/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CONSENT — whether product analytics may run, on each target
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Local error diagnostics use the existing console and require no external
 * reporting provider.
 *
 *   - Product analytics (PostHog: autocapture, funnels) is opt-in INSIDE THE
 *     APP: nothing is loaded and nothing is captured until the player says
 *     yes (ConsentPrompt, or the Settings toggle). On the web nothing
 *     changes - the site's existing behaviour stays exactly as it is - so
 *     `analyticsAllowed()` is true there.
 *
 * The answer lives in localStorage on the device (mirrored to native storage
 * by the session mirror's sibling is unnecessary: "unset" simply asks again).
 */

import { IS_NATIVE_BUILD } from './appBase';

export type AnalyticsConsent = 'granted' | 'denied' | 'unset';

export const ANALYTICS_CONSENT_KEY = 'ca.consent.analytics.v1';

export function getAnalyticsConsent(): AnalyticsConsent {
  try {
    const v = localStorage.getItem(ANALYTICS_CONSENT_KEY);
    return v === 'granted' || v === 'denied' ? v : 'unset';
  } catch {
    return 'unset';
  }
}

export function setAnalyticsConsent(value: 'granted' | 'denied'): void {
  try {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, value);
  } catch {
    /* private mode: the prompt will ask again next launch */
  }
  try {
    window.dispatchEvent(new CustomEvent('ca:analytics-consent', { detail: value }));
  } catch {
    /* no window */
  }
}

/** True when product analytics may load and capture on this target, now. */
export function analyticsAllowed(): boolean {
  if (!IS_NATIVE_BUILD) return true;
  return getAnalyticsConsent() === 'granted';
}

/** True when the app should ask (native, and never answered). */
export function analyticsConsentNeeded(): boolean {
  return IS_NATIVE_BUILD && getAnalyticsConsent() === 'unset';
}
