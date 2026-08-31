/**
 * tableLease — the guard that stops two engine containers dealing one table.
 *
 * The behaviour these tests pin down is mostly about what must NOT happen: a
 * database problem must never be able to stop a table dealing. That inversion —
 * a fail-safe that becomes an outage — is the failure mode of every liveness
 * mechanism we shipped on 2026-08-15, none of which fired on 2026-08-16.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rpc = vi.fn();
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

/**
 * The module reads ENGINE_LEASE_ENFORCE at import time (a constant, so the hot
 * path is a boolean test rather than an env lookup per table per tick), so each
 * enforcement mode needs a fresh module instance.
 */
async function loadLease(enforce: boolean) {
  vi.resetModules();
  // 2026-08-20: enforcement is ON BY DEFAULT (the 23:48Z split-brain on a
  // table with a seated human ended the evidence phase). Off is now the
  // explicit opt-out, so the "unenforced" cases here load with 'off'.
  if (enforce) process.env.ENGINE_LEASE_ENFORCE = 'on';
  else process.env.ENGINE_LEASE_ENFORCE = 'off';
  return import('./tableLease.js');
}

const TABLE = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  rpc.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENGINE_LEASE_ENFORCE;
});

describe('INSTANCE_ID', () => {
  it('is unique per module load, so a restarted engine cannot inherit its own dead lease', async () => {
    const a = await loadLease(false);
    const b = await loadLease(false);
    expect(a.INSTANCE_ID).not.toBe(b.INSTANCE_ID);
    expect(a.INSTANCE_ID).toContain(String(process.pid));
  });
});

describe('claimTable', () => {
  it('grants when the database grants', async () => {
    const { claimTable } = await loadLease(true);
    rpc.mockResolvedValue({
      data: [{ granted: true, holder: 'me', holder_age_seconds: 0 }],
      error: null,
    });
    await expect(claimTable(TABLE)).resolves.toBe(true);
  });

  it('refuses a table another live instance holds - but only with enforcement on', async () => {
    const denied = {
      data: [{ granted: false, holder: 'other-1', holder_age_seconds: 2.5 }],
      error: null,
    };

    const enforced = await loadLease(true);
    rpc.mockResolvedValue(denied);
    await expect(enforced.claimTable(TABLE)).resolves.toBe(false);

    const observing = await loadLease(false);
    rpc.mockResolvedValue(denied);
    await expect(observing.claimTable(TABLE)).resolves.toBe(true);
  });

  it('records the conflict for /health in BOTH modes - observation is the point of the off mode', async () => {
    const { claimTable, recentLeaseConflicts } = await loadLease(false);
    rpc.mockResolvedValue({
      data: [{ granted: false, holder: 'other-1', holder_age_seconds: 2.5 }],
      error: null,
    });
    await claimTable(TABLE);
    expect(recentLeaseConflicts()).toEqual([
      expect.objectContaining({ tableId: TABLE, holder: 'other-1', holderAgeSeconds: 2.5 }),
    ]);
  });

  it('FAILS OPEN on an RPC error - a database blip must not stop a table starting', async () => {
    const { claimTable, leaseDiagnostics } = await loadLease(true);
    rpc.mockResolvedValue({ data: null, error: { message: 'function does not exist' } });
    await expect(claimTable(TABLE)).resolves.toBe(true);
    expect(leaseDiagnostics().claimErrors).toBe(1);
  });

  it('FAILS OPEN when the RPC throws outright', async () => {
    const { claimTable } = await loadLease(true);
    rpc.mockRejectedValue(new Error('ECONNRESET'));
    await expect(claimTable(TABLE)).resolves.toBe(true);
  });

  it('FAILS OPEN on an unrecognised payload rather than guessing', async () => {
    const { claimTable } = await loadLease(true);
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(claimTable(TABLE)).resolves.toBe(true);
  });
});

describe('heartbeatTables', () => {
  it('reports the tables that were genuinely taken by another LIVE instance', async () => {
    const { heartbeatTables } = await loadLease(true);
    rpc.mockResolvedValue({
      data: [
        { table_id: 'keep-1', state: 'kept' },
        { table_id: 'lost-1', state: 'taken' },
        { table_id: 'lost-2', state: 'taken' },
      ],
      error: null,
    });
    await expect(heartbeatTables(['keep-1', 'lost-1', 'lost-2'])).resolves.toEqual([
      'lost-1',
      'lost-2',
    ]);
  });

  /**
   * THE 2026-08-29 BUG, PINNED. The old shape could only say "kept", so the
   * caller subtracted and called the whole remainder a takeover. Production
   * logged 204 teardowns in one hour — "another engine instance has taken it
   * over. Stopping it here." — while eight of those table ids were held in the
   * database by THAT VERY INSTANCE with a 2.8-second-old heartbeat.
   *
   * A missing row means claimTable's fail-open path started the table without
   * writing one (596 supabase_timeouts in that same hour). A stale row means
   * the holder went quiet. Neither is a takeover, and tearing a live table
   * down for one is the false alarm, not the safety measure.
   */
  it('does NOT stop a table whose lease is merely missing or stale - nobody took it', async () => {
    const { heartbeatTables, recentLeaseConflicts, reclaimableLeaseCount } = await loadLease(true);
    rpc.mockResolvedValue({
      data: [
        { table_id: 'no-row', state: 'missing' },
        { table_id: 'quiet-holder', state: 'stale' },
        { table_id: 'really-taken', state: 'taken' },
      ],
      error: null,
    });
    await expect(heartbeatTables(['no-row', 'quiet-holder', 'really-taken'])).resolves.toEqual([
      'really-taken',
    ]);
    // Only the genuine takeover is a conflict worth showing on /health.
    expect(recentLeaseConflicts().map((c) => c.tableId)).toEqual(['really-taken']);
    expect(reclaimableLeaseCount()).toBe(2);
  });

  it('treats an id the function did not answer for as reclaimable, never as taken', async () => {
    const { heartbeatTables } = await loadLease(true);
    rpc.mockResolvedValue({ data: [{ table_id: 'answered', state: 'kept' }], error: null });
    // 'silent' is absent from the result entirely. Silence is not evidence.
    await expect(heartbeatTables(['answered', 'silent'])).resolves.toEqual([]);
  });

  it('reports nothing lost while enforcement is off, even when a lease is genuinely taken', async () => {
    const { heartbeatTables, recentLeaseConflicts } = await loadLease(false);
    rpc.mockResolvedValue({
      data: [
        { table_id: 'a', state: 'taken' },
        { table_id: 'b', state: 'taken' },
      ],
      error: null,
    });
    await expect(heartbeatTables(['a', 'b'])).resolves.toEqual([]);
    // Still recorded, so /health shows the split-brain before we act on it.
    expect(
      recentLeaseConflicts()
        .map((c) => c.tableId)
        .sort()
    ).toEqual(['a', 'b']);
  });

  it('treats "could not ask" as "lost nothing" - the inversion that would freeze the platform', async () => {
    const { heartbeatTables } = await loadLease(true);
    rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    await expect(heartbeatTables(['a', 'b', 'c'])).resolves.toEqual([]);

    rpc.mockRejectedValue(new Error('socket hang up'));
    await expect(heartbeatTables(['a', 'b', 'c'])).resolves.toEqual([]);
  });

  it('does not call the database at all with no tables', async () => {
    const { heartbeatTables } = await loadLease(true);
    await expect(heartbeatTables([])).resolves.toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('releaseTables', () => {
  it('releases everything for this instance by default', async () => {
    const { releaseTables, INSTANCE_ID } = await loadLease(true);
    rpc.mockResolvedValue({ data: 3, error: null });
    await releaseTables();
    expect(rpc).toHaveBeenCalledWith('release_table_leases', {
      p_instance_id: INSTANCE_ID,
      p_table_ids: null,
    });
  });

  it('never throws - it runs on the shutdown path', async () => {
    const { releaseTables } = await loadLease(true);
    rpc.mockRejectedValue(new Error('gone'));
    await expect(releaseTables()).resolves.toBeUndefined();
  });
});
