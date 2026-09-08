/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CONSENT — whether product analytics may run, on each target
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Store readiness, phase 3 (audit tier 0): "Gate analytics behind consent,
 * and stop shipping email to Sentry ... Apple's Privacy Nutrition Labels
 * cannot be answered truthfully as things stand."
 *
 * Two kinds of telemetry, treated differently:
 *
 *   - Crash and error reporting (Sentry) runs without a prompt, on every
 *     target, because a table that stops dealing has to be seen. It carries
 *     the user id and username and NEVER the email (SentryInit.ts), and in
 *     the app it records no session replay. It is named in the privacy
 *     policy.
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
