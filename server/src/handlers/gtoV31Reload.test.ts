import { describe, it, expect, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    rpc: vi.fn(() => {
      throw Error('REAL_DB_FORBIDDEN');
    }),
  },
}));
vi.mock('../engine/horseDecision/lane.js', () => ({
  getLiveHorseDecisionWorker: vi.fn(() => {
    throw Error('REAL_LANE_FORBIDDEN');
  }),
}));
import { V31ReloadRequests, handleGtoV31Reload } from './gtoV31Reload.js';
const id = {
  requestId: '12345678-1234-4234-8234-123456789abc',
  datasetId: '12345678-1234-4234-8234-123456789abd',
  checksum: 'a'.repeat(64),
};
const eight = (r: any) =>
  Array.from({ length: 8 }, (_, worker) => ({
    type: 'V31_STORE_CONTROL_ACK' as const,
    operation: r.operation,
    requestId: r.requestId,
    ok: true,
    count: 107,
    dataset: { id: id.datasetId, checksum: id.checksum },
    error: null,
    worker,
  }));
describe('single explicit active-corpus reload owner', () => {
  it('reserves identity before authority await so concurrent duplicates dispatch only once', async () => {
    let ready!: (n: number) => void;
    let initial = true;
    const authority = vi.fn(() =>
        initial
          ? ((initial = false),
            new Promise<number>((r) => {
              ready = r;
            }))
          : Promise.resolve(107)
      ),
      dispatch = vi.fn(async (r) => eight(r)),
      owner = new V31ReloadRequests(authority, dispatch);
    const first = owner.run(id, 'reload'),
      second = owner.run(id, 'reload');
    expect(authority).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    ready(107);
    expect((await first).state).toBe('complete');
    expect(await second).toEqual(await first);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(owner.run({ ...id, checksum: 'b'.repeat(64) }, 'reload')).rejects.toThrow(
      'identity_conflict'
    );
  });
  it('refuses non-active authority before any worker load', async () => {
    const dispatch = vi.fn(),
      owner = new V31ReloadRequests(async () => {
        throw Error('requested_dataset_not_active');
      }, dispatch);
    await expect(owner.run(id, 'reload')).rejects.toThrow('not_active');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('requires all eight distinct exact acknowledgments and reports partial outcomes', async () => {
    for (const transform of [
      (w: any[]) => w.slice(1),
      (w: any[]) => w.map((a, i) => ({ ...a, worker: 0 })),
      (w: any[]) =>
        w.map((a, i) =>
          i ? a : { ...a, dataset: { id: id.datasetId, checksum: 'b'.repeat(64) } }
        ),
    ]) {
      const owner = new V31ReloadRequests(
        async () => 107,
        async (r) => transform(eight(r))
      );
      expect((await owner.run(id, 'reload')).state).toBe('partial');
    }
  });
  it('status performs a fresh explicit read without replaying a reload', async () => {
    const dispatch = vi.fn(async (r) => eight(r)),
      owner = new V31ReloadRequests(async () => 107, dispatch);
    await owner.run(id, 'reload');
    await owner.run(id, 'status');
    await owner.run(id, 'status');
    expect(dispatch.mock.calls.map((c) => c[0].operation)).toEqual(['reload', 'status', 'status']);
  });
  it('rejects unauthorized HTTP before reading the body or contacting authority', async () => {
    const run = vi.fn(),
      response = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
    await handleGtoV31Reload({} as any, response as any, false, { run } as any);
    expect(run).not.toHaveBeenCalled();
    expect(response.writeHead.mock.calls[0][0]).toBe(401);
  });
  it('rechecks authoritative active identity after worker acknowledgments', async () => {
    let reads = 0;
    const owner = new V31ReloadRequests(
      async () => {
        if (++reads > 1) throw Error('requested_dataset_not_active');
        return 107;
      },
      async (r) => eight(r)
    );
    await expect(owner.run(id, 'reload')).rejects.toThrow('not_active');
  });

  it('rejects coercible non-string UUID values before authority reads', async () => {
    const authority = vi.fn(),
      owner = new V31ReloadRequests(authority, vi.fn());
    await expect(owner.run({ ...id, requestId: [id.requestId] }, 'reload')).rejects.toThrow(
      'invalid_request'
    );
    expect(authority).not.toHaveBeenCalled();
  });
});
