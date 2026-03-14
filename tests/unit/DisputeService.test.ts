/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — DisputeService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests dispute resolution lifecycle:
 * - mapDispute field mapping (DB → domain)
 * - Dispute state machine (open → under_review → resolved | escalated | withdrawn)
 * - DisputeTarget types
 * - Submit and review transitions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const disputeRow = (overrides: Record<string, any> = {}) => ({
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
  ...overrides,
});

// Proxy that returns itself for any chained call, with terminal methods
const buildChain = (terminalData: any = null): any => {
  const handler: ProxyHandler<any> = {
    get: (_target, prop) => {
      if (prop === 'maybeSingle' || prop === 'single')
        return () => Promise.resolve({ data: terminalData, error: null });
      if (prop === 'then')
        return (resolve: (v: any) => void) =>
          resolve({ data: terminalData, error: null, count: 0 });
      return vi.fn().mockReturnValue(new Proxy({}, handler));
    },
  };
  return new Proxy({}, handler);
};

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'disputes') {
        return {
          insert: () => buildChain(disputeRow()),
          update: () =>
            buildChain(disputeRow({ status: 'under_review', assigned_to: 'reviewer-1' })),
          select: () => buildChain(),
        };
      }
      // profiles, clubs
      return {
        select: () =>
          buildChain({
            owner_id: 'owner-1',
            name: 'TestClub',
            display_name: 'TestUser',
            username: 'testuser',
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
      const row = disputeRow({
        submitted_by: 'user-1',
        submitter_name: 'Alice',
        target_type: 'cashout_request',
        target_id: 'cashout-1',
        amount: 2500,
        reason: 'Not received',
      });

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

    it('should map resolved dispute with all fields', () => {
      const row = disputeRow({
        status: 'resolved',
        assigned_to: 'reviewer-1',
        resolution: 'Credited 5000 chips',
        resolved_at: '2026-01-02T00:00:00Z',
      });

      const dispute = DisputeService.mapDispute(row);
      expect(dispute.status).toBe('resolved');
      expect(dispute.assignedTo).toBe('reviewer-1');
      expect(dispute.resolution).toBe('Credited 5000 chips');
      expect(dispute.resolvedAt).toBe('2026-01-02T00:00:00Z');
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
      const dispute = DisputeService.mapDispute(disputeRow({ target_type: targetType }));
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
        expect(DisputeService.mapDispute(disputeRow({ status })).status).toBe(status);
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
});
