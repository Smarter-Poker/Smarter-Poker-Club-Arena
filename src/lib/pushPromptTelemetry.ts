/**
 * pushPromptTelemetry.ts - the push enrolment funnel, one row per outcome.
 *
 * Writes public.push_prompt_events (migration 20260927221335): the database
 * stamps user_id from auth.uid() and created_at from now(), caps a player at
 * 200 rows a day, and grants the browser INSERT on surface, event, platform
 * and detail only. Nobody reads it from the client; admins read
 * fn_push_prompt_funnel.
 *
 * Fire-and-forget by contract. Telemetry can explain why enrolment is low; it
 * can never be the reason a prompt fails, so nothing here throws, nothing is
 * awaited by a caller, and the Supabase client is imported lazily so the
 * push path never waits on it (iOS only honours the permission prompt while
 * the tap gesture is alive).
 */
import { isNativePlatform, nativePlatform } from './appBase';
import type { PushPromptEvent, PushPromptSurface } from './pushPromptPolicy';

export type PushPromptPlatform =
  | 'ios_browser'
  | 'ios_pwa'
  | 'android_web'
  | 'desktop_web'
  | 'native_ios'
  | 'native_android'
  | 'unknown';

/** Where this device sits in the push landscape, as the funnel groups it. */
export function pushPromptPlatform(): PushPromptPlatform {
  try {
    if (isNativePlatform()) {
      const p = nativePlatform();
      return p === 'ios' ? 'native_ios' : p === 'android' ? 'native_android' : 'unknown';
    }
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unknown';
    const ua = navigator.userAgent || '';
    const ios =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) {
      const nav = navigator as Navigator & { standalone?: boolean };
      const standalone =
        nav.standalone === true ||
        window.matchMedia?.('(display-mode: standalone)')?.matches === true;
      return standalone ? 'ios_pwa' : 'ios_browser';
    }
    if (/Android/i.test(ua)) return 'android_web';
    return 'desktop_web';
  } catch {
    return 'unknown';
  }
}

export function recordPushPromptEvent(
  surface: PushPromptSurface,
  event: PushPromptEvent,
  detail: string | null = null
): void {
  try {
    const row = {
      surface,
      event,
      platform: pushPromptPlatform(),
      detail: detail && /^[a-z0-9:_-]{1,64}$/.test(detail) ? detail : null,
    };
    void import('./supabase')
      .then(({ supabase }) => supabase.from('push_prompt_events').insert(row))
      .then(({ error }) => {
        if (error) console.debug('[push-prompt-telemetry] refused', error.message);
      })
      .catch(() => undefined);
  } catch {
    /* Telemetry must never surface to a player. */
  }
}
