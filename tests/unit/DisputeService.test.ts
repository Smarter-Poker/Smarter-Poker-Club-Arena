/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — DisputeService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-20. This file used to assert `typeof DisputeService.submitDispute`
 * was 'function' and nothing else about it. It passed for the entire life of
 * the platform while filing a dispute was impossible: `disputes` grants
 * authenticated only SELECT, its one policy is SELECT only, and the client
 * INSERT behind that button was refused every single time. The table has held
 * ZERO rows since it was created.
 *
 * A test that checks a method exists cannot tell you the method does nothing.
 * These check what the method actually sends.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const buildChain = (
  row: unknown = null,
  error: unknown = null,
  count: number | null = null
): any => {
  const handler: ProxyHandler<any> = {
    get: (_target, prop) => {
      if (prop === 'maybeSingle' || prop === 'single')
        return () => Promise.resolve({ data: row, error });
      if (prop === 'then')
        return (resolve: (v: any) => void) => resolve({ data: row, error, count });
      return vi.fn().mockReturnValue(new Proxy({}, handler));
    },
  };
  return new Proxy({}, handler);
};

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => buildChain()),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/services/FinancialAlertService', () => ({
  FinancialAlertService: { logWarning: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import {
  DisputeService,
  parseDispute,
  parseDisputeAdjustmentAmount,
} from '../../src/services/DisputeService';
import { supabase } from '../../src/lib/supabase';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const from = supabase.from as unknown as ReturnType<typeof vi.fn>;

const disputeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'd-1',
  submitted_by: 'user-1',
  submitter_name: 'Player One',
  target_type: 'agent_settlement',
  target_id: 'settlement-9',
  club_id: 'club-uuid-1',
  amount: '250.50',
  reason: 'the settlement is short',
  status: 'open',
  assigned_to: null,
  resolution: null,
  created_at: '2026-10-03T12:00:00Z',
  updated_at: '2026-10-03T12:00:00Z',
  resolved_at: null,
  ...overrides,
});

describe('DisputeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({ data: null, error: null });
    from.mockImplementation(() => buildChain([]));
  });

  describe('getClubDisputes', () => {
    it('should return empty array when no disputes', async () => {
      const result = await DisputeService.getClubDisputes('club-1');
      expect(result).toEqual([]);
    });

    it('should accept optional status filter', async () => {
      const result = await DisputeService.getClubDisputes('club-1', 'pending');
      expect(Array.isArray(result)).toBe(true);
    });

    it('refuses a row from outside the requested club', async () => {
      const requestedClub = '11111111-1111-4111-8111-111111111111';
      from.mockImplementationOnce(() =>
        buildChain([disputeRow({ club_id: '22222222-2222-4222-8222-222222222222' })])
      );

      await expect(DisputeService.getClubDisputes(requestedClub)).rejects.toThrow(
        'scope could not be verified'
      );
    });
  });

  describe('getMyDisputes', () => {
    it('should return empty array for user with no disputes', async () => {
      const result = await DisputeService.getMyDisputes('user-1');
      expect(result).toEqual([]);
    });

    it('refuses a row from outside the signed-in account', async () => {
      from.mockImplementationOnce(() => buildChain([disputeRow({ submitted_by: 'someone-else' })]));

      await expect(DisputeService.getMyDisputes('user-1')).rejects.toThrow(
        'scope could not be verified'
      );
    });
  });

  describe('getOpenCount', () => {
    it('should return 0 when no open disputes', async () => {
      from.mockImplementationOnce(() => buildChain(null, null, 0));
      const count = await DisputeService.getOpenCount('club-1');
      expect(count).toBe(0);
    });

    it('does not turn a failed count read into a false zero', async () => {
      from.mockImplementationOnce(() => buildChain(null, new Error('count refused'), null));
      await expect(DisputeService.getOpenCount('club-1')).rejects.toThrow('count refused');
    });

    it('refuses a successful response without an exact count', async () => {
      from.mockImplementationOnce(() => buildChain(null, null, null));
      await expect(DisputeService.getOpenCount('club-1')).rejects.toThrow(
        'count could not be verified'
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FILING, which had never once happened
  // ───────────────────────────────────────────────────────────────────────────

  const aDispute = {
    targetType: 'agent_settlement' as const,
    targetId: 'settlement-9',
    clubId: 'club-uuid-1',
    amount: 250.5,
    reason: 'the settlement is short',
  };

  describe('submitDispute', () => {
    it('files through the definer entry point, not through a table write', async () => {
      rpc.mockResolvedValueOnce({
        data: { ok: true, dispute_id: 'd-1', status: 'open' },
        error: null,
      });
      from.mockImplementationOnce(() => buildChain(disputeRow()));

      const filed = await DisputeService.submitDispute('ignored-caller-id', aDispute);

      expect(rpc).toHaveBeenCalledWith('fn_dispute_submit', {
        p_target_type: 'agent_settlement',
        p_target_id: 'settlement-9',
        p_club_id: 'club-uuid-1',
        p_amount: 250.5,
        p_reason: 'the settlement is short',
      });
      expect(filed.id).toBe('d-1');

      // The only table touch is the read-back. Nothing writes to disputes from
      // the browser, because nothing can.
      expect(from.mock.calls.every(([table]) => table === 'disputes')).toBe(true);
    });

    it('never sends a caller-supplied user id, because the server takes the session', async () => {
      rpc.mockResolvedValueOnce({
        data: { ok: true, dispute_id: 'd-2', status: 'open' },
        error: null,
      });
      from.mockImplementationOnce(() => buildChain(disputeRow({ id: 'd-2' })));

      await DisputeService.submitDispute('someone-elses-id', aDispute);

      const [, params] = rpc.mock.calls[0];
      expect(JSON.stringify(params)).not.toContain('someone-elses-id');
    });

    it('turns a refusal into something a person can read', async () => {
      rpc.mockResolvedValueOnce({
        data: { ok: false, reason: 'already_open', dispute_id: 'd-1' },
        error: null,
      });
      await expect(DisputeService.submitDispute('u', aDispute)).rejects.toThrow(
        'You already have an open dispute about this'
      );
    });

    it('names an unrecognised refusal rather than swallowing it', async () => {
      rpc.mockResolvedValueOnce({ data: { ok: false, reason: 'something_new' }, error: null });
      await expect(DisputeService.submitDispute('u', aDispute)).rejects.toThrow('something_new');
    });

    it('does not report success when the entry point errors', async () => {
      rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
      await expect(DisputeService.submitDispute('u', aDispute)).rejects.toThrow(
        'Could not file the dispute'
      );
    });

    it.each([
      {},
      { ok: 'true', dispute_id: 'd-1', status: 'open' },
      { ok: true, dispute_id: 'd-1' },
      { ok: true, dispute_id: 'd-1', status: 'resolved' },
    ])('refuses the malformed filing receipt %#', async (receipt) => {
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      await expect(DisputeService.submitDispute('u', aDispute)).rejects.toThrow(/receipt/i);
      expect(from).not.toHaveBeenCalled();
    });

    it('refuses a filing read-back for another dispute', async () => {
      rpc.mockResolvedValueOnce({
        data: { ok: true, dispute_id: 'd-1', status: 'open' },
        error: null,
      });
      from.mockImplementationOnce(() => buildChain(disputeRow({ id: 'd-other' })));

      await expect(DisputeService.submitDispute('u', aDispute)).rejects.toThrow(
        'read-back did not match'
      );
    });
  });

  describe('verified review transition', () => {
    it('requires a request-bound receipt and matching under-review read-back', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          ok: true,
          dispute_id: 'd-1',
          status: 'under_review',
          assigned_to: 'reviewer-1',
        },
        error: null,
      });
      from.mockImplementationOnce(() =>
        buildChain(disputeRow({ status: 'under_review', assigned_to: 'reviewer-1' }))
      );

      const reviewed = await DisputeService.startReview('d-1', 'reviewer-1');
      expect(reviewed.status).toBe('under_review');
      expect(reviewed.assignedTo).toBe('reviewer-1');
    });

    it.each([
      { ok: 'false', dispute_id: 'd-1', status: 'under_review', assigned_to: 'reviewer-1' },
      { ok: true, dispute_id: 'd-other', status: 'under_review', assigned_to: 'reviewer-1' },
      { ok: true, dispute_id: 'd-1', status: 'open', assigned_to: 'reviewer-1' },
      { ok: true, dispute_id: 'd-1', status: 'under_review', assigned_to: 'someone-else' },
    ])('refuses the malformed review receipt %#', async (receipt) => {
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      await expect(DisputeService.startReview('d-1', 'reviewer-1')).rejects.toThrow();
      expect(from).not.toHaveBeenCalled();
    });

    it('refuses a successful receipt whose read-back stayed open', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          ok: true,
          dispute_id: 'd-1',
          status: 'under_review',
          assigned_to: 'reviewer-1',
        },
        error: null,
      });
      from.mockImplementationOnce(() => buildChain(disputeRow({ status: 'open' })));

      await expect(DisputeService.startReview('d-1', 'reviewer-1')).rejects.toThrow(
        'read-back did not match'
      );
    });
  });

  describe('verified resolution transition', () => {
    const request = {
      resolution: 'Reviewed And Corrected',
      adjustmentType: 'credit' as const,
      adjustmentAmount: 12.5,
    };

    it('requires an exact adjustment receipt and matching resolved read-back', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          ok: true,
          dispute_id: 'd-1',
          status: 'resolved',
          adjustment_type: 'credit',
          amount: 12.5,
        },
        error: null,
      });
      from.mockImplementationOnce(() =>
        buildChain(
          disputeRow({
            status: 'resolved',
            resolution: request.resolution,
            resolved_at: '2026-10-03T12:01:00Z',
            updated_at: '2026-10-03T12:01:00Z',
          })
        )
      );

      const resolved = await DisputeService.resolveDispute('d-1', 'reviewer-1', request);
      expect(resolved.status).toBe('resolved');
      expect(resolved.resolution).toBe(request.resolution);
    });

    it.each([
      {
        ok: 'false',
        dispute_id: 'd-1',
        status: 'resolved',
        adjustment_type: 'credit',
        amount: 12.5,
      },
      {
        ok: true,
        dispute_id: 'd-other',
        status: 'resolved',
        adjustment_type: 'credit',
        amount: 12.5,
      },
      { ok: true, dispute_id: 'd-1', status: 'open', adjustment_type: 'credit', amount: 12.5 },
      { ok: true, dispute_id: 'd-1', status: 'resolved', adjustment_type: 'debit', amount: 12.5 },
      { ok: true, dispute_id: 'd-1', status: 'resolved', adjustment_type: 'credit', amount: 10 },
    ])('refuses the malformed resolution receipt %#', async (receipt) => {
      rpc.mockResolvedValueOnce({ data: receipt, error: null });
      await expect(DisputeService.resolveDispute('d-1', 'reviewer-1', request)).rejects.toThrow();
      expect(from).not.toHaveBeenCalled();
    });

    it('does not discard a resolved-row read-back error', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          ok: true,
          dispute_id: 'd-1',
          status: 'resolved',
          adjustment_type: 'credit',
          amount: 12.5,
        },
        error: null,
      });
      from.mockImplementationOnce(() => buildChain(null, new Error('read refused')));

      await expect(DisputeService.resolveDispute('d-1', 'reviewer-1', request)).rejects.toThrow(
        'read refused'
      );
    });
  });

  describe('verified escalation transition', () => {
    it('requires a request-bound receipt and matching escalated read-back', async () => {
      rpc.mockResolvedValueOnce({
        data: { ok: true, dispute_id: 'd-1', status: 'escalated' },
        error: null,
      });
      from.mockImplementationOnce(() =>
        buildChain(
          disputeRow({
            status: 'escalated',
            resolution: 'Escalated: Complex Review',
            updated_at: '2026-10-03T12:01:00Z',
          })
        )
      );

      const escalated = await DisputeService.escalateDispute('d-1', 'Complex Review');
      expect(escalated.status).toBe('escalated');
    });

    it('refuses a string success flag without reading or alerting', async () => {
      rpc.mockResolvedValueOnce({
        data: { ok: 'true', dispute_id: 'd-1', status: 'escalated' },
        error: null,
      });

      await expect(DisputeService.escalateDispute('d-1', 'Complex Review')).rejects.toThrow(
        'receipt'
      );
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('withdrawDispute', () => {
    it('withdraws through the definer entry point', async () => {
      rpc.mockResolvedValueOnce({
        data: { ok: true, dispute_id: 'd-1', status: 'withdrawn' },
        error: null,
      });
      from.mockImplementationOnce(() => buildChain(disputeRow({ status: 'withdrawn' })));
      await DisputeService.withdrawDispute('d-1', 'ignored-caller-id');
      expect(rpc).toHaveBeenCalledWith('fn_dispute_withdraw', { p_dispute_id: 'd-1' });
      expect(from).toHaveBeenCalledWith('disputes');
    });

    it('says why a dispute cannot be withdrawn instead of silently succeeding', async () => {
      rpc.mockResolvedValueOnce({
        data: { ok: false, reason: 'not_withdrawable', status: 'resolved' },
        error: null,
      });
      await expect(DisputeService.withdrawDispute('d-1', 'u')).rejects.toThrow('already resolved');
    });

    it('refuses a truthy string success flag', async () => {
      rpc.mockResolvedValueOnce({
        data: { ok: 'false', dispute_id: 'd-1', status: 'withdrawn' },
        error: null,
      });
      await expect(DisputeService.withdrawDispute('d-1', 'u')).rejects.toThrow('receipt');
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('verified dispute money', () => {
    it.each([
      ['1', 1],
      ['1.2', 1.2],
      ['1.23', 1.23],
      ['0.01', 0.01],
      ['.5', 0.5],
      ['01.20', 1.2],
      ['1.230', 1.23],
    ])('accepts positive exact-cent adjustment %s', (input, expected) => {
      expect(parseDisputeAdjustmentAmount(input)).toBe(expected);
    });

    it.each(['', '0', '0.00', '-1', '1.001', 'NaN', 'Infinity', '1e3'])(
      'refuses invalid adjustment %s',
      (input) => {
        expect(parseDisputeAdjustmentAmount(input)).toBeNull();
      }
    );

    it('refuses a malformed or sub-cent dispute amount', () => {
      expect(() => parseDispute(disputeRow({ amount: '250.501' }))).toThrow(
        'financial state could not be verified'
      );
    });

    it('refuses an impossible dispute timeline', () => {
      expect(() => parseDispute(disputeRow({ updated_at: '2026-10-03T11:59:59Z' }))).toThrow(
        'timeline could not be verified'
      );
    });

    it('does not call the resolver with an empty or sub-cent adjustment', async () => {
      await expect(
        DisputeService.resolveDispute('d-1', 'reviewer', {
          resolution: 'Reviewed',
          adjustmentType: 'credit',
          adjustmentAmount: 0,
        })
      ).rejects.toThrow('positive whole-cent');
      await expect(
        DisputeService.resolveDispute('d-1', 'reviewer', {
          resolution: 'Reviewed',
          adjustmentType: 'credit',
          adjustmentAmount: 1.001,
        })
      ).rejects.toThrow('positive whole-cent');
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The rule, asserted against the source with its comments removed (CLAUDE.md
  // 7.3). The comments above describe the very writes being forbidden, so an
  // assertion made against the raw text would read its own explanation and
  // pass, or fail, for the wrong reason.
  // ───────────────────────────────────────────────────────────────────────────

  describe('no browser write reaches the disputes table', () => {
    const SOURCE_PATH = join(__dirname, '..', '..', 'src', 'services', 'DisputeService.ts');

    function withoutComments(source: string): string {
      return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    }

    it('contains no insert or update against disputes', () => {
      const raw = readFileSync(SOURCE_PATH, 'utf8');
      const code = withoutComments(raw);
      expect(
        code.length,
        'the comment stripper removed nothing, so it proves nothing'
      ).toBeLessThan(raw.length);

      expect(code).toContain("from('disputes')");
      expect(code).not.toMatch(/\.insert\s*\(/);
      expect(code).not.toMatch(/\.update\s*\(/);
      expect(code).not.toMatch(/\.upsert\s*\(/);
      expect(code).not.toMatch(/\.delete\s*\(/);
    });

    it('routes every write through a named definer entry point', () => {
      const code = withoutComments(readFileSync(SOURCE_PATH, 'utf8'));
      for (const entry of [
        'fn_dispute_submit',
        'fn_dispute_withdraw',
        'fn_dispute_start_review',
        'fn_resolve_dispute',
        'fn_dispute_escalate',
      ]) {
        expect(code, `${entry} is the only way that write can happen`).toContain(entry);
      }
    });
  });

  describe('export shape', () => {
    it('should export DisputeService with all methods', () => {
      expect(typeof DisputeService.submitDispute).toBe('function');
      expect(typeof DisputeService.withdrawDispute).toBe('function');
      expect(typeof DisputeService.getClubDisputes).toBe('function');
      expect(typeof DisputeService.getMyDisputes).toBe('function');
      expect(typeof DisputeService.getOpenCount).toBe('function');
      expect(typeof DisputeService.startReview).toBe('function');
      expect(typeof DisputeService.resolveDispute).toBe('function');
      expect(typeof DisputeService.escalateDispute).toBe('function');
    });
  });
});
