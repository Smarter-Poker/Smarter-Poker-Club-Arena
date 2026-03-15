/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — GameServerAPI
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests submitAction, getAvailableActions, getServerStatus fallback behavior,
 * getWebSocketStatus, and disconnectTableWebSocket safety.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock fetch ───────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/services/ReconnectingWebSocket', () => ({
  ReconnectingWebSocket: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onMessage: vi.fn(),
    getStatus: vi.fn().mockReturnValue('CLOSED'),
  })),
}));

vi.mock('../../src/services/DeltaSyncService', () => ({
  DeltaSyncService: vi.fn().mockImplementation(() => ({
    onChange: vi.fn(),
    onSnapshotRequest: vi.fn(),
    processMessage: vi.fn(),
    getVersion: vi.fn().mockReturnValue(0),
  })),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import {
  submitAction,
  getAvailableActions,
  getServerStatus,
  getWebSocketStatus,
  disconnectTableWebSocket,
} from '../../src/services/GameServerAPI';

describe('GameServerAPI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('submitAction', () => {
    it('should return success:false when server unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      const result = await submitAction('table-1', 'user-1', 'fold');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Server unreachable');
    });

    it('should return success:false on HTTP error', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });
      const result = await submitAction('table-1', 'user-1', 'fold');
      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });

    it('should return result on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
      const result = await submitAction('table-1', 'user-1', 'fold');
      expect(result.success).toBe(true);
    });

    it('should send amount for raise actions', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
      await submitAction('table-1', 'user-1', 'raise', 100);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/action'),
        expect.objectContaining({
          body: expect.stringContaining('"amount":100'),
        })
      );
    });
  });

  describe('getAvailableActions', () => {
    it('should return canAct:false when server unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      const result = await getAvailableActions('table-1', 'user-1');
      expect(result.canAct).toBe(false);
      expect(result.actions).toEqual([]);
      expect(result.error).toBe('Server unreachable');
    });

    it('should return canAct:false on HTTP error', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 502 });
      const result = await getAvailableActions('table-1', 'user-1');
      expect(result.canAct).toBe(false);
      expect(result.error).toContain('502');
    });
  });

  describe('getServerStatus', () => {
    it('should return null when server unreachable', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));
      const result = await getServerStatus();
      expect(result).toBeNull();
    });

    it('should return null on HTTP error', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      const result = await getServerStatus();
      expect(result).toBeNull();
    });

    it('should return status on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            running: true,
            uptime: 3600,
            activeTables: 5,
            activeTournaments: 2,
            totalHandsDealt: 1000,
          }),
      });
      const result = await getServerStatus();
      expect(result?.running).toBe(true);
      expect(result?.activeTables).toBe(5);
    });
  });

  describe('WebSocket helpers', () => {
    it('getWebSocketStatus should return null when not connected', () => {
      expect(getWebSocketStatus()).toBeNull();
    });

    it('disconnectTableWebSocket should not crash when not connected', () => {
      disconnectTableWebSocket();
      // No throw = pass
    });
  });
});
