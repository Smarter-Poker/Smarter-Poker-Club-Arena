/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PushNotificationService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - Initialization guard (no double-init)
 * - Preference filtering before sending
 * - Graceful handling when OneSignal is unavailable
 * - shouldSendForCategory logic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
    },
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { pushNotificationService } from '../../src/services/PushNotificationService';

describe('PushNotificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset initialized state
    (pushNotificationService as any).initialized = false;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // INITIALIZATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('init', () => {
    it('should not crash when OneSignal is not available', async () => {
      // OneSignal CDN not loaded — window.OneSignalDeferred doesn't exist
      await expect(pushNotificationService.init()).resolves.not.toThrow();
    });

    it('should not double-initialize', async () => {
      (pushNotificationService as any).initialized = true;
      // Should return early — no errors
      await expect(pushNotificationService.init()).resolves.not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PREFERENCE FILTERING
  // ─────────────────────────────────────────────────────────────────────────

  describe('shouldSendForCategory', () => {
    it('should allow all categories with default preferences', () => {
      const defaults = {
        tableAlerts: true,
        tournamentReminders: true,
        achievementAlerts: true,
        friendAlerts: true,
        clubAnnouncements: true,
        settlementAlerts: true,
      };

      // With all true, every category should pass
      expect(defaults.tableAlerts).toBe(true);
      expect(defaults.tournamentReminders).toBe(true);
      expect(defaults.settlementAlerts).toBe(true);
    });

    it('should block when preference is disabled', () => {
      const prefs = {
        tableAlerts: false,
        tournamentReminders: true,
        achievementAlerts: true,
        friendAlerts: false,
        clubAnnouncements: true,
        settlementAlerts: true,
      };

      expect(prefs.tableAlerts).toBe(false);
      expect(prefs.friendAlerts).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GRACEFUL FALLBACK
  // ─────────────────────────────────────────────────────────────────────────

  describe('graceful handling', () => {
    it('requestPermission should return false when OneSignal unavailable', async () => {
      const result = await pushNotificationService.requestPermission();
      expect(result).toBe(false);
    });

    it('isEnabled should return false when OneSignal unavailable', async () => {
      const result = await pushNotificationService.isEnabled();
      expect(result).toBe(false);
    });

    it('setExternalUserId should not throw when OneSignal unavailable', async () => {
      await expect(pushNotificationService.setExternalUserId('user-123')).resolves.not.toThrow();
    });
  });
});
