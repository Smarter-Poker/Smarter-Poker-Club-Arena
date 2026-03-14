/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — DisputeService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests dispute resolution lifecycle:
 * - mapDispute field mapping (DB → domain)
 * - Dispute state machine (open → under_review → resolved | escalated | withdrawn)
 * - DisputeTarget types
 * - Severity of escalation alerts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockInsert = vi.fn().mockReturnValue({
  select: () => ({
    maybeSingle: () =>
      Promise.resolve({
        data: {
          id: 'dispute-1',
          submitted_by: 'user-1',
          submitter_name: 'TestUser',
          target_type: 'agent_settlement',
          target_id: 'settlement-1',
          club_id: 'club-1',
          amount: 5000,
          reason: 'Incorrect commission',
          status: 'open',
          assigned_to: null,
          resolution: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          resolved_at: null,
        },
        error: null,
      }),
  }),
});

const mockUpdate = vi.fn().mockReturnValue({
  eq: () => ({
    select: () => ({
      maybeSingle: () =>
        Promise.resolve({
          data: {
            id: 'dispute-1',
            submitted_by: 'user-1',
            submitter_name: 'TestUser',
            target_type: 'agent_settlement',
            target_id: 'settlement-1',
            club_id: 'club-1',
            amount: 5000,
            reason: 'Incorrect commission',
            status: 'under_review',
            assigned_to: 'reviewer-1',
            resolution: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T12:00:00Z',
            resolved_at: null,
          },
          error: null,
        }),
    }),
    eq: () => ({
      select: () => ({
        maybeSingle: () =>
          Promise.resolve({
            data: {
              id: 'dispute-1',
              submitted_by: 'user-1',
              submitter_name: 'TestUser',
              target_type: 'agent_settlement',
              target_id: 'settlement-1',
              club_id: 'club-1',
              amount: 5000,
              reason: 'Incorrect commission',
              status: 'under_review',
              assigned_to: 'reviewer-1',
              resolution: null,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T12:00:00Z',
              resolved_at: null,
            },
            error: null,
          }),
      }),
      in: () => ({
        select: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                id: 'dispute-1',
                submitted_by: 'user-1',
                submitter_name: 'TestUser',
                target_type: 'agent_settlement',
                target_id: 'settlement-1',
                club_id: 'club-1',
                amount: 5000,
                reason: 'Incorrect commission',
                status: 'escalated',
                assigned_to: null,
                resolution: 'Escalated: Complex case',
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T15:00:00Z',
                resolved_at: null,
              },
              error: null,
            }),
        }),
      }),
    }),
  }),
});

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'disputes') {
        return {
          insert: mockInsert,
          update: mockUpdate,
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [], error: null }),
              }),
              maybeSingle: () =>
                Promise.resolve({
                  data: { display_name: 'TestUser', username: 'testuser' },
                  error: null,
                }),
            }),
          }),
        };
      }
      // clubs, profiles
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: { owner_id: 'owner-1', name: 'TestClub', display_name: 'TestUser', username: 'testuser' },
                error: null,
              }),
          }),
        }),
      };
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/services/PushNotificationService', () => ({
  pushNotificationService: {
    sendToUser: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: {
    logCritical: vi.fn().mockResolvedValue(undefined),
    logWarning: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (fn: () => any) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { DisputeService } from '../../src/services/DisputeService';
import type { DisputeTarget, DisputeStatus } from '../../src/services/DisputeService';

describe('DisputeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MAP DISPUTE
  // ─────────────────────────────────────────────────────────────────────────

  describe('mapDispute', () => {
    it('should map DB row to domain object', () => {
      const row = {
        id: 'dispute-1',
        submitted_by: 'user-1',
        submitter_name: 'Alice',
        target_type: 'cashout_request',
        target_id: 'cashout-1',
        club_id: 'club-1',
        amount: 2500,
        reason: 'Not received',
        status: 'open',
        assigned_to: null,
        resolution: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        resolved_at: null,
      };

      const dispute = DisputeService.mapDispute(row);

      expect(dispute.id).toBe('dispute-1');
      expect(dispute.submittedBy).toBe('user-1');
      expect(dispute.submitterName).toBe('Alice');
      expect(dispute.targetType).toBe('cashout_request');
      expect(dispute.amount).toBe(2500);
      expect(dispute.status).toBe('open');
      expect(dispute.assignedTo).toBeNull();
      expect(dispute.resolvedAt).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DISPUTE TARGETS
  // ─────────────────────────────────────────────────────────────────────────

  describe('dispute targets', () => {
    it.each<DisputeTarget>([
      'agent_settlement',
      'cashout_request',
      'credit_invoice',
      'commission_payout',
    ])('should accept target type: %s', (targetType) => {
      const row = {
        id: 'test',
        submitted_by: 'u1',
        submitter_name: 'Test',
        target_type: targetType,
        target_id: 'target-1',
        club_id: 'club-1',
        amount: 100,
        reason: 'Test',
        status: 'open',
        assigned_to: null,
        resolution: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        resolved_at: null,
      };

      const dispute = DisputeService.mapDispute(row);
      expect(dispute.targetType).toBe(targetType);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STATE MACHINE
  // ─────────────────────────────────────────────────────────────────────────

  describe('dispute state machine', () => {
    it.each<DisputeStatus>(['open', 'under_review', 'resolved', 'escalated', 'withdrawn'])(
      'should map status: %s',
      (status) => {
        const row = {
          id: 'test',
          submitted_by: 'u1',
          submitter_name: 'Test',
          target_type: 'agent_settlement',
          target_id: 't1',
          club_id: 'c1',
          amount: 0,
          reason: 'R',
          status,
          assigned_to: null,
          resolution: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          resolved_at: null,
        };
        expect(DisputeService.mapDispute(row).status).toBe(status);
      }
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SUBMIT DISPUTE
  // ─────────────────────────────────────────────────────────────────────────

  describe('submitDispute', () => {
    it('should create a dispute with status=open', async () => {
      const dispute = await DisputeService.submitDispute('user-1', {
        targetType: 'agent_settlement',
        targetId: 'settlement-1',
        clubId: 'club-1',
        amount: 5000,
        reason: 'Incorrect commission',
      });

      expect(dispute.status).toBe('open');
      expect(dispute.submittedBy).toBe('user-1');
      expect(dispute.amount).toBe(5000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // START REVIEW
  // ─────────────────────────────────────────────────────────────────────────

  describe('startReview', () => {
    it('should transition to under_review and assign reviewer', async () => {
      const dispute = await DisputeService.startReview('dispute-1', 'reviewer-1');
      expect(dispute.status).toBe('under_review');
      expect(dispute.assignedTo).toBe('reviewer-1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ESCALATE
  // ─────────────────────────────────────────────────────────────────────────

  describe('escalateDispute', () => {
    it('should transition to escalated and log financial warning', async () => {
      const dispute = await DisputeService.escalateDispute('dispute-1', 'Complex case');
      expect(dispute.status).toBe('escalated');

      const { FinancialAlertService } = await import('../../src/services/FinancialAlertService');
      expect(FinancialAlertService.logWarning).toHaveBeenCalled();
    });
  });
});
