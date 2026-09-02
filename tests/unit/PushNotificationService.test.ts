/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PushNotificationService
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

// No OneSignal stub any more. The SDK is not loaded, and nothing in the
// service reaches for it — see the removal note below.

import {
  pushNotificationService,
  PushNotificationService,
} from '../../src/services/PushNotificationService';

describe('PushNotificationService', () => {
  it('should export a singleton instance', () => {
    expect(pushNotificationService).toBeDefined();
  });

  it('should export PushNotificationService alias', () => {
    expect(PushNotificationService).toBe(pushNotificationService);
  });

  /**
   * These four methods existed only to drive the OneSignal SDK, and asserting
   * they exist is what kept them looking load-bearing.
   *
   * OneSignal was retired on 2026-08-19 and replaced with self-hosted VAPID web
   * push. The loader survived until 2026-08-29, when it was found still
   * injecting the v16 SDK on every Club Arena session and calling
   * api.onesignal.com/sync/<app-id>/web — a third-party request per session, for
   * a vendor the platform does not use. `init`, `setExternalUserId`,
   * `requestPermission` and `isEnabled` went with it. Between the four of them
   * they had one caller in the entire app.
   *
   * The assertion is inverted rather than deleted so that re-adding any of them
   * fails here, with this explanation attached, instead of quietly bringing the
   * SDK back with it.
   */
  it('no longer exposes the OneSignal SDK surface', () => {
    for (const removed of ['init', 'setExternalUserId', 'requestPermission', 'isEnabled']) {
      expect(
        (pushNotificationService as unknown as Record<string, unknown>)[removed],
        `${removed}() existed only to drive the OneSignal SDK, which was removed on 2026-08-29`
      ).toBeUndefined();
    }
  });

  it('should have sendToUser method', () => {
    expect(typeof pushNotificationService.sendToUser).toBe('function');
  });

  it('should have sendToUsers method', () => {
    expect(typeof pushNotificationService.sendToUsers).toBe('function');
  });

  it('should have notifyTableAvailable method', () => {
    expect(typeof pushNotificationService.notifyTableAvailable).toBe('function');
  });

  it('should have notifyTournamentStarting method', () => {
    expect(typeof pushNotificationService.notifyTournamentStarting).toBe('function');
  });

  it('should have notifyAchievement method', () => {
    expect(typeof pushNotificationService.notifyAchievement).toBe('function');
  });

  it('should have notifySettlement method', () => {
    expect(typeof pushNotificationService.notifySettlement).toBe('function');
  });
});
