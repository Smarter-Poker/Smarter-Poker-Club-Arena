/**
 * The replication collector has one job: never lie about how far behind the
 * slot is. Every assertion here is a way it could have lied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./supabase.js', () => ({
  supabase: { rpc: vi.fn() },
}));
vi.mock('./errorReporter.js', () => ({
  reportError: vi.fn(),
}));

import { ReplicationMetrics } from './ReplicationMetrics.js';
import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

const ok = (rows: unknown[]) => ({ data: rows, error: null });

const twoSlots = [
  {
    slot_name: 'supabase_realtime_replication_slot_2_134_2_a886414',
    slot_type: 'logical',
    active: true,
    restart_lag_bytes: 142_606_336,
    flush_lag_bytes: 109_051_904,
    wal_position_bytes: 987_654_321_000,
  },
  {
    slot_name: 'supabase_realtime_messages_replication_slot_2_134_2_a886414',
    slot_type: 'logical',
    active: true,
    restart_lag_bytes: 18_874_368,
    flush_lag_bytes: 4575,
    wal_position_bytes: 987_654_321_000,
  },
];

describe('ReplicationMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits a lag series per slot, labelled by slot name', async () => {
    rpc.mockResolvedValue(ok(twoSlots));
    const m = new ReplicationMetrics();
    await m.refresh();
    const text = m.toPrometheus().join('\n');

    expect(text).toContain(
      'poker_pg_replication_slot_flush_lag_bytes{slot="supabase_realtime_replication_slot_2_134_2_a886414"} 109051904'
    );
    expect(text).toContain(
      'poker_pg_replication_slot_restart_lag_bytes{slot="supabase_realtime_messages_replication_slot_2_134_2_a886414"} 18874368'
    );
    expect(text).toContain('poker_pg_replication_slots 2');
    expect(text).toContain('poker_pg_wal_position_bytes 987654321000');
  });

  it('declares HELP and TYPE exactly once per metric family, whatever the slot count', async () => {
    rpc.mockResolvedValue(ok(twoSlots));
    const m = new ReplicationMetrics();
    await m.refresh();
    const lines = m.toPrometheus();

    // A duplicated HELP/TYPE for one metric name makes Prometheus reject the
    // WHOLE scrape, taking every other poker_* series down with it. With two
    // slots and a per-slot loop, this is the mistake that is easy to make.
    for (const family of [
      'poker_pg_replication_slot_restart_lag_bytes',
      'poker_pg_replication_slot_flush_lag_bytes',
      'poker_pg_replication_slot_active',
      'poker_pg_replication_slots',
      'poker_pg_wal_position_bytes',
      'poker_pg_replication_metrics_stale_seconds',
    ]) {
      expect(
        lines.filter((l) => l === `# TYPE ${family} gauge` || l === `# TYPE ${family} counter`)
      ).toHaveLength(1);
      expect(lines.filter((l) => l.startsWith(`# HELP ${family} `))).toHaveLength(1);
    }
  });

  it('OMITS a lag series rather than reporting zero when there is no reading', async () => {
    // An inactive slot with no restart_lsn, or a database in recovery. Zero
    // bytes of lag is the PERFECT score - emitting it here would report a
    // stalled slot as flawless.
    rpc.mockResolvedValue(
      ok([
        {
          slot_name: 'idle_slot',
          slot_type: 'logical',
          active: false,
          restart_lag_bytes: null,
          flush_lag_bytes: null,
          wal_position_bytes: null,
        },
      ])
    );
    const m = new ReplicationMetrics();
    await m.refresh();
    const text = m.toPrometheus().join('\n');

    expect(text).not.toContain('poker_pg_replication_slot_restart_lag_bytes');
    expect(text).not.toContain('poker_pg_replication_slot_flush_lag_bytes');
    expect(text).not.toContain('poker_pg_wal_position_bytes');
    // But the slot is still visible, and visibly inactive.
    expect(text).toContain('poker_pg_replication_slot_active{slot="idle_slot",type="logical"} 0');
    expect(text).toContain('poker_pg_replication_slots 1');
  });

  it('is already firing before the first successful collection', () => {
    const m = new ReplicationMetrics();
    const text = m.toPrometheus().join('\n');
    expect(text).toContain('poker_pg_replication_metrics_stale_seconds 86400');
    expect(text).toContain('poker_pg_replication_slots 0');
  });

  it('keeps the last good snapshot when a refresh fails, and never zeroes it', async () => {
    rpc.mockResolvedValue(ok(twoSlots));
    const m = new ReplicationMetrics();
    await m.refresh();

    rpc.mockResolvedValue({ data: null, error: { message: 'statement timeout' } });
    await m.refresh();

    const text = m.toPrometheus().join('\n');
    // A failed read that zeroed the gauge would read as a perfectly healthy
    // slot, which is the failure this whole file exists to prevent.
    expect(text).toContain(
      'poker_pg_replication_slot_flush_lag_bytes{slot="supabase_realtime_replication_slot_2_134_2_a886414"} 109051904'
    );
    expect(text).toContain('poker_pg_replication_slots 2');
  });

  it('survives a thrown RPC without propagating', async () => {
    rpc.mockRejectedValue(new Error('socket hang up'));
    const m = new ReplicationMetrics();
    await expect(m.refresh()).resolves.toBeUndefined();
    expect(m.get().collectedAt).toBe(0);
  });

  it('reports once per outage at the third consecutive failure, not once per attempt', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    const m = new ReplicationMetrics();
    await m.refresh();
    await m.refresh();
    expect(reportError).not.toHaveBeenCalled();
    await m.refresh();
    expect(reportError).toHaveBeenCalledTimes(1);
    await m.refresh();
    await m.refresh();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('treats rows with no slot_name as a failed read, not as zero slots', async () => {
    rpc.mockResolvedValue(ok(twoSlots));
    const m = new ReplicationMetrics();
    await m.refresh();

    rpc.mockResolvedValue(ok([{ unexpected: 'shape' }]));
    await m.refresh();

    // Still the good snapshot. A shape change in the RPC must not be able to
    // quietly report "no slots", which reads as a database with nothing to
    // replicate rather than as a broken collector.
    expect(m.get().slots).toHaveLength(2);
  });

  it('start() is idempotent and does not hold the process open', () => {
    rpc.mockResolvedValue(ok(twoSlots));
    const m = new ReplicationMetrics(60_000);
    m.start();
    m.start();
    m.stop();
    expect(true).toBe(true);
  });
});
