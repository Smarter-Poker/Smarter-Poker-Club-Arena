import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameServer as GameServerType } from './GameServer.js';

let GameServer: typeof GameServerType;
let supabase: typeof import('./services/supabase.js').supabase;

beforeAll(async () => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-placeholder-key');
  ({ GameServer } = await import('./GameServer.js'));
  ({ supabase } = await import('./services/supabase.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the existing lease cleanup calls its custody-preserving database owner', () => {
  it('uses the maintained RPC with the existing one-hour age boundary', async () => {
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: [{ table_leases_deleted: 0, tournament_leases_deleted: 0 }],
      error: null,
    } as never);
    await (
      GameServer.prototype as unknown as { reapDeadLeases(): Promise<void> }
    ).reapDeadLeases.call({});
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('reap_dead_engine_leases', { p_stale_seconds: 3600 });
  });

  /* A LEASE KEPT ON PURPOSE IS NOT AN EMPTY SWEEP (2026-09-23).
     The reaper preserves a dead holder's lease while its event still holds
     unresolved F06 custody, and that is correct. What it could not do was say
     so: two deletion counts of zero meant both "nothing to reap" and "kept 48
     dead leases, the oldest unrenewed for 47.6 hours", and this method logs
     only a non-zero deletion. That is the conflation CLAUDE.md 10.86 rule 1
     forbids, and it is why nobody noticed for two days. */
  const reap = async (row: Record<string, unknown> | null) => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: row === null ? [] : [row],
      error: null,
    } as never);
    const owner: Record<string, unknown> = {};
    await (
      GameServer.prototype as unknown as { reapDeadLeases(): Promise<void> }
    ).reapDeadLeases.call(owner);
    return owner;
  };

  it('publishes what the reaper deliberately kept, and how old the oldest is', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const owner = await reap({
      table_leases_deleted: 0,
      tournament_leases_deleted: 0,
      table_leases_retained: 0,
      tournament_leases_retained: 48,
      oldest_retained_seconds: 171_360,
    });
    expect(owner.leaseCustodyRetention).toMatchObject({
      tables: 0,
      tournaments: 48,
      oldestSeconds: 171_360,
    });
    // A deletion count of zero used to be the only thing this pass could say.
    expect(log.mock.calls.flat().join(' ')).toContain('48 tournament');
  });

  it('a reaper that does not publish the counts is UNKNOWN, never zero', async () => {
    // The predecessor's return shape. Reporting its silence as "nothing was
    // retained" is the exact failure this field exists to end.
    const owner = await reap({ table_leases_deleted: 0, tournament_leases_deleted: 0 });
    expect(owner.leaseCustodyRetention).toBeNull();
  });

  it('says nothing when there is genuinely nothing kept', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const owner = await reap({
      table_leases_deleted: 0,
      tournament_leases_deleted: 0,
      table_leases_retained: 0,
      tournament_leases_retained: 0,
      oldest_retained_seconds: 0,
    });
    expect(owner.leaseCustodyRetention).toMatchObject({ tables: 0, tournaments: 0 });
    expect(log).not.toHaveBeenCalled();
  });

  it('routes the existing hourly callback through owned server lifecycle work', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const work = Promise.resolve();
    const owner = {
      leaseReapTimer: null,
      reapDeadLeases: vi.fn(() => work),
      launchServerLifecycleJob: vi.fn(),
    };
    (GameServer.prototype as unknown as { startLeaseReaper(): void }).startLeaseReaper.call(owner);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(owner.reapDeadLeases).toHaveBeenCalledTimes(1);
    expect(owner.launchServerLifecycleJob).toHaveBeenCalledTimes(1);
    expect(owner.launchServerLifecycleJob).toHaveBeenCalledWith(
      work,
      'GameServer.lease_reap_failed'
    );
    vi.clearAllTimers();
  });
});

describe('counting a retention never changes what the reaper deletes', () => {
  const MIGRATION = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'supabase',
      'migrations',
      '20260923213812_a_retained_lease_is_not_an_empty_sweep.sql'
    ),
    'utf8'
  );

  it('refuses to install over a body it has not been reasoned about', () => {
    // A rewrite that does not pin its predecessor is a rewrite of something
    // else. The 20260919024039 retention migration set this precedent.
    expect(MIGRATION).toContain(
      "md5(pg_get_functiondef(oid)) = '7501ae6661f48127f91d85d1fb0c9c9f'"
    );
    expect(MIGRATION).toContain("RAISE EXCEPTION 'LEASE_REAPER_RETENTION_COUNT_PREIMAGE_CHANGED'");
  });

  it('keeps both custody guards and both delete predicates exactly as they were', () => {
    // The 2026-09-19 rule is unchanged: an unresolved original's evidence is
    // never erased. Counting it must not become an excuse to collect it.
    expect(MIGRATION).toContain(
      'IF NOT smarter_private.f06_lease_has_pending_custody(candidate.tournament_id,NULL) THEN'
    );
    expect(MIGRATION).toContain(
      'IF NOT smarter_private.f06_lease_has_pending_custody(event_id,candidate.table_id) THEN'
    );
    expect(MIGRATION).toContain(
      'DELETE FROM public.engine_tournament_leases WHERE tournament_id=candidate.tournament_id AND heartbeat_at<cutoff;'
    );
    expect(MIGRATION).toContain(
      'DELETE FROM public.engine_table_leases WHERE table_id=candidate.table_id AND heartbeat_at<cutoff;'
    );
    // The age floor and the concurrency fences survive the rewrite.
    expect(MIGRATION).toContain('IF coalesce(p_stale_seconds,0)<600 THEN');
    expect(MIGRATION).toContain('FOR UPDATE OF l SKIP LOCKED');
    expect(MIGRATION).toContain('FOR UPDATE NOWAIT');
    expect(MIGRATION).toContain('EXCEPTION WHEN lock_not_available THEN NULL;');
  });

  it('counts a retention only on the branch that kept the row', () => {
    // Every increment is inside an ELSE of a custody guard. A counter that can
    // move on the delete path would report a collection as a retention.
    const increments = MIGRATION.match(/_retained:=\w+_retained\+1;/g) ?? [];
    expect(increments).toHaveLength(2);
    for (const marker of [
      'tournaments_retained:=tournaments_retained+1;',
      'tables_retained:=tables_retained+1;',
    ]) {
      const at = MIGRATION.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      const branch = MIGRATION.slice(MIGRATION.lastIndexOf(' ELSE', at), at);
      expect(branch.trim()).toBe('ELSE');
    }
  });

  it('a row it could not lock is not counted as kept', () => {
    // SKIP LOCKED and NOWAIT both mean "this call did not read that row".
    // Folding that into "kept for custody" is the same conflation this
    // migration exists to remove (CLAUDE.md 10.86 rule 1).
    expect(MIGRATION).toContain('A row this loop cannot lock is NOT counted as retained');
    const nowaitBranch = MIGRATION.slice(MIGRATION.indexOf('EXCEPTION WHEN lock_not_available'));
    expect(nowaitBranch).not.toContain('_retained:=');
  });

  it('reports the age of the oldest thing it kept', () => {
    expect(MIGRATION).toContain('oldest_retained_seconds integer');
    expect((MIGRATION.match(/oldest:=greatest\(oldest,/g) ?? []).length).toBe(2);
  });
});
