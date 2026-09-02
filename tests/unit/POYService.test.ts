/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — POYService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the Player of the Year batching logic:
 * - trackHandResult: session creation, accumulation, batched flushing
 * - submitTournamentResult: honest handling of a rejected endpoint
 * - submitCashSession: honest handling of a rejected endpoint
 * - flushAllSessions: clears all tracked sessions
 *
 * Strategy: spy on submitCashSession to verify trackHandResult actually
 * creates and accumulates session data correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POYService } from '../../src/services/POYService';

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

describe('POYService', () => {
  let submitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // POY is same-origin now. Never let a unit test POST to whatever unrelated
    // application happens to be listening on localhost:3000.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        text: async () => 'endpoint unavailable',
      })
    );
    // Flush any leaked state first
    await POYService.flushAllSessions();
    // Spy on submitCashSession so we can verify flush calls without network
    submitSpy = vi.spyOn(POYService, 'submitCashSession').mockResolvedValue({ success: false });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REJECTED ENDPOINT
  // ─────────────────────────────────────────────────────────────────────────

  describe('submitTournamentResult', () => {
    it('should return { success: false } when the endpoint rejects the result', async () => {
      const result = await POYService.submitTournamentResult({
        player_id: 'p1',
        club_id: 'c1',
        game_type: 'tournament',
        placement: 1,
        total_players: 100,
        buy_in: 500,
        winnings: 10000,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('submitCashSession', () => {
    it('should return { success: false } when the endpoint rejects the session', async () => {
      // Restore real implementation for this one test
      submitSpy.mockRestore();
      const result = await POYService.submitCashSession({
        player_id: 'p1',
        club_id: 'c1',
        game_type: 'cash',
        hands_played: 50,
        winnings: 500,
        duration_minutes: 60,
        buy_in: 1000,
      });
      expect(result.success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // HAND TRACKING & BATCHING — verified via flushSession spy
  // ─────────────────────────────────────────────────────────────────────────

  describe('trackHandResult', () => {
    it('should create a session that calls submitCashSession on flush', async () => {
      POYService.trackHandResult({
        userId: 'p1',
        clubId: 'c1',
        clubName: 'Test Club',
        profit: 100,
      });

      // Flush the session — should call submitCashSession with tracked data
      await POYService.flushSession('p1:c1');
      expect(submitSpy).toHaveBeenCalledOnce();
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          player_id: 'p1',
          club_id: 'c1',
          club_name: 'Test Club',
          game_type: 'cash',
          hands_played: 1,
          winnings: 100,
        })
      );
    });

    it('should accumulate hands and profit for same user+club', async () => {
      POYService.trackHandResult({ userId: 'p1', clubId: 'c1', profit: 100 });
      POYService.trackHandResult({ userId: 'p1', clubId: 'c1', profit: -50 });
      POYService.trackHandResult({ userId: 'p1', clubId: 'c1', profit: 200 });

      await POYService.flushSession('p1:c1');
      expect(submitSpy).toHaveBeenCalledOnce();
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          hands_played: 3,
          winnings: 250, // 100 + (-50) + 200
        })
      );
    });

    it('should track separate sessions for different users', async () => {
      POYService.trackHandResult({ userId: 'p1', clubId: 'c1', profit: 100 });
      POYService.trackHandResult({ userId: 'p2', clubId: 'c1', profit: -100 });

      await POYService.flushSession('p1:c1');
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({ player_id: 'p1', winnings: 100 })
      );

      submitSpy.mockClear();
      await POYService.flushSession('p2:c1');
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({ player_id: 'p2', winnings: -100 })
      );
    });

    it('should track separate sessions for same user, different clubs', async () => {
      POYService.trackHandResult({ userId: 'p1', clubId: 'c1', profit: 100 });
      POYService.trackHandResult({ userId: 'p1', clubId: 'c2', profit: -100 });

      await POYService.flushSession('p1:c1');
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({ club_id: 'c1', winnings: 100 })
      );

      submitSpy.mockClear();
      await POYService.flushSession('p1:c2');
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({ club_id: 'c2', winnings: -100 })
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FLUSH
  // ─────────────────────────────────────────────────────────────────────────

  describe('flushAllSessions', () => {
    it('should not call submitCashSession when no active sessions', async () => {
      await POYService.flushAllSessions();
      expect(submitSpy).not.toHaveBeenCalled();
    });

    it('should flush all tracked sessions at once', async () => {
      POYService.trackHandResult({ userId: 'p1', clubId: 'c1', profit: 100 });
      POYService.trackHandResult({ userId: 'p2', clubId: 'c2', profit: -50 });

      await POYService.flushAllSessions();
      expect(submitSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('flushSession', () => {
    it('should not call submitCashSession for nonexistent key', async () => {
      await POYService.flushSession('nonexistent:key');
      expect(submitSpy).not.toHaveBeenCalled();
    });
  });
});
