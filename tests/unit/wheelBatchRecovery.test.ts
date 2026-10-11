import { beforeEach, describe, expect, it } from 'vitest';
import fixtures from '../fixtures/diamond-spins/wheel-v4-postgres-receipts.json';
import {
  clearWheelBatch,
  parsePaidWheelBatch,
  readWheelBatch,
  saveWheelBatch,
  type PendingWheelBatch,
} from '../../src/services/WheelBatchService';
const club = 'd1000000-0000-4000-8000-000000000003';
const run = 'd1000000-0000-4000-8000-000000000099';
const request = 'd1000000-0000-4000-8000-000000000098';
const pending: PendingWheelBatch = {
  userId: 'fixture-player',
  clubId: club,
  requestId: request,
  spins: 5,
  entryDiamonds: 25,
  seed: 'batch-fixture',
  presented: 0,
};
function batch(): Record<string, any> {
  const source = fixtures.records.find((r) => r.value.outcome.kind === 'chips')!.value;
  const receipts = Array.from({ length: 5 }, (_, index) => ({
    ...structuredClone(source),
    spin_id: `d1000000-0000-4000-8000-00000000010${index}`,
    club_id: club,
    contract_version: 4,
    entry_value_diamonds: 25,
    player_cost_diamonds: 25,
    auto_run: { run_id: run, spins: 5, spins_done: index + 1 },
    fairness: {
      ...structuredClone(source.fairness),
      commit_id: `d1000000-0000-4000-8000-00000000020${index}`,
      client_seed: `batch-fixture:${index + 1}`,
    },
  }));
  return {
    ok: true,
    request_id: request,
    run_id: run,
    spins: 5,
    spins_done: 5,
    entry_diamonds: 25,
    total_cost_diamonds: 125,
    client_seed: 'batch-fixture',
    receipts,
    tickets: receipts.map((r) => ({
      commit_id: r.fairness.commit_id,
      server_seed_hash: r.fairness.server_seed_hash,
    })),
  };
}
beforeEach(() => localStorage.clear());
describe('paid run recovery', () => {
  it('retains identity, presentation position and explicit return intent', () => {
    saveWheelBatch({ ...pending, presented: 3, resumeAfterGame: true });
    expect(readWheelBatch(pending.userId, club)).toEqual({
      ...pending,
      presented: 3,
      resumeAfterGame: true,
    });
  });
  it('refuses replacing a saved operation and clears only the matching operation', () => {
    saveWheelBatch(pending);
    expect(() => saveWheelBatch({ ...pending, requestId: run })).toThrow('Another Saved Run');
    clearWheelBatch(pending.userId, club, run);
    expect(readWheelBatch(pending.userId, club)).toEqual(pending);
    clearWheelBatch(pending.userId, club, request);
    expect(readWheelBatch(pending.userId, club)).toBeNull();
  });
  it('refuses a changed saved wager and presentation rewinds from another page', () => {
    saveWheelBatch({ ...pending, presented: 3 });
    expect(() => saveWheelBatch({ ...pending, presented: 2 })).toThrow('Already Presented');
    expect(() => saveWheelBatch({ ...pending, presented: 3, seed: 'changed' })).toThrow(
      'Another Saved Run'
    );
    expect(readWheelBatch(pending.userId, club)?.presented).toBe(3);
  });
  it('accepts all complete independently sealed receipt positions', () => {
    expect(parsePaidWheelBatch(batch(), pending.userId, club).receipts).toHaveLength(5);
  });
  it.each(['missing', 'cost', 'order', 'seal', 'club', 'duplicate', 'duplicateReceipt', 'count'])(
    'refuses a %s batch instead of starting another wager',
    (defect) => {
      const value = batch();
      if (defect === 'duplicateReceipt') value.receipts[2].spin_id = value.receipts[1].spin_id;
      if (defect === 'count') value.receipts[2].auto_run.spins = 25;
      if (defect === 'missing') value.receipts.pop();
      if (defect === 'cost') value.total_cost_diamonds = 25;
      if (defect === 'order') value.receipts[2].auto_run.spins_done = 1;
      if (defect === 'seal') value.tickets[2].server_seed_hash = '0'.repeat(64);
      if (defect === 'club') value.receipts[2].club_id = run;
      if (defect === 'duplicate') value.tickets[2] = value.tickets[1];
      expect(() => parsePaidWheelBatch(value, pending.userId, club)).toThrow();
    }
  );
});
