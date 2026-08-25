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
//
// UPDATED (Round 56, 2026-05-01): the ReconnectingWebSocket / DeltaSyncService
// mocks that used to live here were deleted along with their modules — see the
// "WEBSOCKET CONNECTIVITY" note in src/services/GameServerAPI.ts. Nothing in
// GameServerAPI imports them any more, so mocking non-existent module paths
// was dead weight.

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import * as GameServerAPI from '../../src/services/GameServerAPI';
import {
  submitAction,
  getAvailableActions,
  getServerStatus,
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
    // UPDATED (Round 56, 2026-05-01): GameServerAPI no longer owns a WebSocket.
    // The legacy connectTableWebSocket / getWebSocketStatus /
    // disconnectTableWebSocket trio was deleted because it duplicated the
    // engine WS wiring without bearer auth or PING replies; the production
    // reconnect path is services/EngineStateClient.ts. These tests used to
    // call the removed helpers — they now pin the removal so the footgun
    // cannot be reintroduced through this module.
    it('no longer exports the legacy table WebSocket helpers', () => {
      const surface = GameServerAPI as unknown as Record<string, unknown>;
      expect(surface.connectTableWebSocket).toBeUndefined();
      expect(surface.getWebSocketStatus).toBeUndefined();
      expect(surface.disconnectTableWebSocket).toBeUndefined();
    });

    it('exposes only HTTP action endpoints on its default export', () => {
      const keys = Object.keys(GameServerAPI.default).sort();
      expect(keys).toEqual(
        [
          'activateTimeBank',
          'addChips',
          'getAvailableActions',
          'getServerStatus',
          'getTableState',
          'notifyServerRejectRebuy',
          // Added 2026-08-25. Both are HTTP action endpoints that were defined
          // and exported by name but never listed here, so
          // GameServerAPI.requestRabbitHunt and .postBBToEnter resolved to
          // undefined while their siblings worked. The rule this test enforces
          // is "no WebSocket helpers", asserted on the last line — not "no new
          // endpoints".
          'postBBToEnter',
          'previewInsurance',
          'removeChips',
          'requestRabbitHunt',
          'respondToInsurance',
          'respondToRIT',
          'sendHeartbeat',
          'setPreAction',
          'setSitOut',
          'showHand',
          'submitAction',
          'submitDiscard',
          'toggleStraddle',
        ].sort()
      );
      expect(keys.some((k) => /websocket/i.test(k))).toBe(false);
    });
  });
});
