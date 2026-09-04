/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — SentryInit
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

// Mock Sentry
vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  showReportDialog: vi.fn(),
  withScope: vi.fn(),
  globalHandlersIntegration: vi.fn(),
}));

import {
  initSentry,
  setSentryUser,
  clearSentryUser,
  captureException,
  captureMessage,
  addBreadcrumb,
} from '../../src/core/SentryInit';

describe('SentryInit', () => {
  it('should export initSentry function', () => {
    expect(typeof initSentry).toBe('function');
  });

  it('should export setSentryUser function', () => {
    expect(typeof setSentryUser).toBe('function');
  });

  it('should export clearSentryUser function', () => {
    expect(typeof clearSentryUser).toBe('function');
  });

  it('should not throw when setting user', () => {
    setSentryUser({ id: 'u1', email: 'test@test.com', username: 'test' });
  });

  it('should not throw when clearing user', () => {
    clearSentryUser();
  });

  it('should not throw when capturing exception', () => {
    captureException(new Error('test error'));
  });

  it('should not throw when capturing message', () => {
    captureMessage('test message', 'info');
  });

  it('should not throw when adding breadcrumb', () => {
    addBreadcrumb({ category: 'test', message: 'test breadcrumb' });
  });
});
