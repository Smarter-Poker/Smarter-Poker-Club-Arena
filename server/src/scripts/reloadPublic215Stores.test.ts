import { describe, it, expect } from 'vitest';
import { validateReloadReceipt } from './reloadPublic215Stores.js';
const id = {
  requestId: '12345678-1234-4234-8234-123456789abc',
  datasetId: '12345678-1234-4234-8234-123456789abd',
  checksum: 'a'.repeat(64),
};
const good = () => ({
  ...id,
  state: 'complete',
  expectedCells: 107,
  workers: Array.from({ length: 8 }, (_, worker) => ({
    worker,
    type: 'V31_STORE_CONTROL_ACK',
    operation: 'reload',
    requestId: id.requestId,
    ok: true,
    count: 107,
    dataset: { id: id.datasetId, checksum: id.checksum },
    error: null,
  })),
});
describe('explicit store control consumer', () => {
  it('requires eight exact acknowledgments', () =>
    expect(validateReloadReceipt(good(), id, 'reload').workers).toHaveLength(8));
  it('refuses partial, duplicate, stale, mismatched, failed and wrong-operation replies', () => {
    for (const edit of [
      (r: any) => (r.state = 'partial'),
      (r: any) => r.workers.pop(),
      (r: any) => (r.workers[1].worker = 0),
      (r: any) => (r.workers[0].dataset.checksum = 'b'.repeat(64)),
      (r: any) => (r.workers[0].ok = false),
      (r: any) => (r.workers[0].operation = 'status'),
      (r: any) => (r.requestId = id.datasetId),
    ]) {
      const r = good();
      edit(r);
      expect(() => validateReloadReceipt(r, id, 'reload')).toThrow();
    }
  });
});
