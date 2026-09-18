/** Exact receipts emitted by the real isolated PostgreSQL probe, followed by
 * complete public/auth-row rollback. No production wager or player data. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import receipts from '../fixtures/diamond-wheel-v2-receipts.json';
import stateReceipt from '../fixtures/diamond-wheel-v2-state.json';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import service from '../../src/services/DiamondWheelService';
import { verifyWheelReceiptFairness } from '../../src/utils/wheelFairness';
import { assertWheelReceipt } from '../../src/utils/wheelPendingSpin';
import { assertWheelAward } from '../../src/utils/wheelAward';
beforeEach(() => rpc.mockReset());

describe('the browser consumes real committed wheel receipts', () => {
  it('keeps the actual server welcome eligibility, funded range and pending awards', async () => {
    const award = receipts.find((r) => r.value.outcome.kind === 'bonus')!.value.bonus!;
    // A pending entry uses the same actual award from the spin receipt.
    rpc.mockResolvedValue({ data: { ...stateReceipt, awards: [award] }, error: null });
    const state = await service.getStateV2(stateReceipt.club_id, 2500);
    expect(state.pending_awards).toEqual([
      expect.objectContaining({ id: award.id, game: award.game }),
    ]);
    expect(state.welcome).toEqual({
      available: stateReceipt.welcome.available,
      entry_diamonds: 100,
    });
    expect(state.max_funded_entry).toBe(stateReceipt.max_funded_entry);
  });
  it.each(receipts.map((r, i) => ({ ...r, name: `${i + 1}: ${r.value.outcome.label}` })))(
    '$name',
    async ({ value: raw, stake }) => {
      rpc.mockResolvedValue({ data: raw, error: null });
      const input = {
        clubId: raw.club_id,
        commitId: raw.fairness.commit_id,
        clientSeed: raw.fairness.client_seed,
        entryDiamonds: stake,
        mode: raw.welcome
          ? ('welcome' as const)
          : raw.daily_bonus
            ? ('daily_bonus' as const)
            : ('paid' as const),
        ticketId: raw.bonus_ticket_id,
      };
      const result = await service.spinV2(input);
      assertWheelReceipt(result, {
        ...input,
        userId: 'd1000000-0000-4000-8000-000000000004',
        commitHash: raw.fairness.server_seed_hash,
        contractVersion: 2,
      });
      expect(result.outcome).toMatchObject({
        kind: raw.outcome.kind,
        ord: raw.outcome.ord,
        amount: raw.outcome.amount,
      });
      expect((await verifyWheelReceiptFairness(result)).fair).toBe(true);
      expect(result.segments).toHaveLength(12);
      if ('grants' in raw.outcome) expect(result.outcome.grants).toEqual(raw.outcome.grants);
    }
  );
  it('does not certify an Upgrade when only the first draw verifies', async () => {
    const raw = receipts.find((r) => r.value.outcome.kind === 'upgrade')!.value;
    rpc.mockResolvedValue({ data: raw, error: null });
    const result = await service.spinV2({
      clubId: raw.club_id,
      commitId: raw.fairness.commit_id,
      clientSeed: raw.fairness.client_seed,
      entryDiamonds: raw.entry_value_diamonds,
      mode: 'paid',
      ticketId: raw.bonus_ticket_id,
    });
    result.secondary!.fairness.roll += 1;
    expect((await verifyWheelReceiptFairness(result)).fair).toBe(false);
    result.secondary!.fairness.eligible_ords = [result.secondary!.outcome.ord];
    expect(() => assertWheelAward(result)).toThrow();
  });
});
