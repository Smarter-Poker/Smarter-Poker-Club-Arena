/**
 * installId - one id per browser install, shared by every feature that needs
 * to say "this device".
 *
 * The push subscription minted one under `smarter-poker-push-device-id`
 * (src/lib/pushClient.ts) so a phone gets each banner once. The Daily Club
 * Arena Bonus sends the same id with every claim so that five accounts on one
 * phone are visible as five accounts on one phone
 * (fn_ca_daily_bonus_velocity_check). One key, one id, so the two never
 * disagree about what a device is.
 *
 * Returns null rather than throwing: private windows and locked-down
 * browsers throw on localStorage access, and a missing id costs one
 * measurement, never the feature.
 */
export const INSTALL_ID_KEY = 'smarter-poker-push-device-id';

export function installId(): string | null {
  try {
    const existing = window.localStorage.getItem(INSTALL_ID_KEY);
    if (existing && /^[a-z0-9-]{8,64}$/i.test(existing)) return existing;
    const fresh =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    window.localStorage.setItem(INSTALL_ID_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}
