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

// Mock OneSignal
vi.stubGlobal('OneSignal', undefined);

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

  it('should have init method', () => {
    expect(typeof pushNotificationService.init).toBe('function');
  });

  it('should have setExternalUserId method', () => {
    expect(typeof pushNotificationService.setExternalUserId).toBe('function');
  });

  it('should have requestPermission method', () => {
    expect(typeof pushNotificationService.requestPermission).toBe('function');
  });

  it('should have isEnabled method', () => {
    expect(typeof pushNotificationService.isEnabled).toBe('function');
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
