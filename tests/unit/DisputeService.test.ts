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

const buildChain = (row: unknown = null): any => {
  const handler: ProxyHandler<any> = {
    get: (_target, prop) => {
      if (prop === 'maybeSingle' || prop === 'single')
        return () => Promise.resolve({ data: row, error: null });
      if (prop === 'then')
        return (resolve: (v: any) => void) => resolve({ data: row, error: null });
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

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { DisputeService } from '../../src/services/DisputeService';
import { supabase } from '../../src/lib/supabase';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const from = supabase.from as unknown as ReturnType<typeof vi.fn>;

describe('DisputeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockResolvedValue({ data: null, error: null });
    from.mockImplementation(() => buildChain());
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
  });

  describe('getMyDisputes', () => {
    it('should return empty array for user with no disputes', async () => {
      const result = await DisputeService.getMyDisputes('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('getOpenCount', () => {
    it('should return 0 when no open disputes', async () => {
      const count = await DisputeService.getOpenCount('club-1');
      expect(count).toBe(0);
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
      rpc.mockResolvedValueOnce({ data: { ok: true, dispute_id: 'd-1' }, error: null });
      from.mockImplementationOnce(() => buildChain({ id: 'd-1', status: 'open', amount: 250.5 }));

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
      rpc.mockResolvedValueOnce({ data: { ok: true, dispute_id: 'd-2' }, error: null });
      from.mockImplementationOnce(() => buildChain({ id: 'd-2' }));

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
  });

  describe('withdrawDispute', () => {
    it('withdraws through the definer entry point', async () => {
      rpc.mockResolvedValueOnce({ data: { ok: true, status: 'withdrawn' }, error: null });
      await DisputeService.withdrawDispute('d-1', 'ignored-caller-id');
      expect(rpc).toHaveBeenCalledWith('fn_dispute_withdraw', { p_dispute_id: 'd-1' });
      expect(from).not.toHaveBeenCalled();
    });

    it('says why a dispute cannot be withdrawn instead of silently succeeding', async () => {
      rpc.mockResolvedValueOnce({
        data: { ok: false, reason: 'not_withdrawable', status: 'resolved' },
        error: null,
      });
      await expect(DisputeService.withdrawDispute('d-1', 'u')).rejects.toThrow('already resolved');
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
