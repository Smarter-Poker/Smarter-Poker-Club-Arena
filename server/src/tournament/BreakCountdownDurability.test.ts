import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../services/supabase.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';
import type { GameServer } from '../GameServer.js';

class Countdown extends TournamentManagerBase {
  readonly announcements = vi.fn(async () => true);
  constructor() {
    super('aaaaaaaa-0000-4000-8000-000000000001', {} as GameServer);
  }
  activate() {
    (this as any).lifecycleEpoch.begin();
    this.running = true;
    this.onBreak = true;
  }
  fence() {
    this.fenceForServerShutdown();
  }
  protected override broadcast = this.announcements;
  protected override startEliminationChecker(): void {}
  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const manager = new Countdown();
  manager.activate();
  let row: any = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    on_break: true,
    break_started_at: new Date().toISOString(),
    break_ends_at: null,
  };
  (manager as any).breakCountdownAnchor = { generation: 0, startedAt: row.break_started_at };
  let fail = false,
    lost = false;
  const writes: string[] = [];
  vi.spyOn(supabase, 'from').mockImplementation(() => {
    let patch: any;
    const q: any = {
      update: (value: any) => {
        patch = value;
        return q;
      },
      eq: () => q,
      is: () => q,
      select: () => q,
      maybeSingle: async () => execute(),
      then: (resolve: any, reject: any) => Promise.resolve(execute()).then(resolve, reject),
    };
    function execute() {
      if (patch) {
        writes.push(patch.break_ends_at);
        if (!fail) row = { ...row, ...patch };
        if (fail || lost) return { data: null, error: { message: 'write response unavailable' } };
      }
      return { data: { ...row }, error: null };
    }
    return q;
  });
  return {
    manager,
    writes,
    fail: (v: boolean) => {
      fail = v;
    },
    lost: () => {
      lost = true;
    },
    row: () => row,
    replace: (value: any) => {
      row = { ...row, ...value };
    },
  };
}
describe('the countdown owns one durable deadline', () => {
  it('refuses a returned write failure without announcing success, then retains the original deadline', async () => {
    const f = fixture();
    f.fail(true);
    const deadline = Date.now() + 300000;
    await expect(f.manager.beginBreakCountdown(300000, deadline)).rejects.toThrow();
    expect(f.manager.announcements).not.toHaveBeenCalled();
    f.fail(false);
    await f.manager.beginBreakCountdown(300000, deadline + 60000);
    expect(f.writes).toEqual([new Date(deadline).toISOString(), new Date(deadline).toISOString()]);
    expect(f.row().break_ends_at).toBe(new Date(deadline).toISOString());
  });
  it('accepts an exact committed readback after lost acknowledgment without writing twice', async () => {
    const f = fixture();
    f.lost();
    const deadline = Date.now() + 300000;
    await f.manager.beginBreakCountdown(300000, deadline);
    expect(f.manager.announcements).toHaveBeenCalledOnce();
    expect(f.writes).toHaveLength(1);
    expect(f.row().break_ends_at).toBe(new Date(deadline).toISOString());
    // A cold reader has the actual deadline rather than an invented grace.
    expect(Date.parse(f.row().break_ends_at)).toBe(deadline);
    await f.manager.beginBreakCountdown(300000, deadline + 60000);
    expect(f.writes).toHaveLength(1);
  });
  it('coalesces concurrent callers without changing the first deadline', async () => {
    const f = fixture();
    const deadline = Date.now() + 300000;
    await Promise.all([
      f.manager.beginBreakCountdown(300000, deadline),
      f.manager.beginBreakCountdown(300000, deadline + 60000),
    ]);
    expect(f.writes).toEqual([new Date(deadline).toISOString()]);
    expect(f.manager.announcements).toHaveBeenCalledOnce();
  });
  it('a replacement can prove the same durable deadline without rewriting it', async () => {
    const f = fixture();
    const deadline = Date.now() + 300000;
    await f.manager.beginBreakCountdown(300000, deadline);
    f.manager.fence();
    const replacement = new Countdown();
    replacement.activate();
    (replacement as any).breakCountdownAnchor = {
      generation: 0,
      startedAt: f.row().break_started_at,
    };
    await replacement.beginBreakCountdown(300000, Date.parse(f.row().break_ends_at));
    expect(f.writes).toHaveLength(1);
    expect(replacement.announcements).toHaveBeenCalledWith(
      'tournament_break_started',
      expect.objectContaining({ breakEndsAt: new Date(deadline).toISOString() })
    );
  });
  it('does not overwrite a different durable countdown', async () => {
    const f = fixture();
    const deadline = Date.now() + 300000;
    f.replace({ break_ends_at: new Date(deadline - 1000).toISOString() });
    await expect(f.manager.beginBreakCountdown(300000, deadline)).rejects.toThrow(
      'Deadline Changed'
    );
    expect(f.writes).toHaveLength(0);
    expect(f.manager.announcements).not.toHaveBeenCalled();
  });
  it('does not replay an unresolved proposal against a different break anchor', async () => {
    const f = fixture();
    f.fail(true);
    const deadline = Date.now() + 300000;
    await expect(f.manager.beginBreakCountdown(300000, deadline)).rejects.toThrow();
    f.fail(false);
    f.replace({ break_started_at: new Date(Date.now() + 1000).toISOString() });
    await expect(f.manager.beginBreakCountdown(300000, deadline)).rejects.toThrow('Anchor Changed');
    expect(f.writes).toHaveLength(1);
    expect(f.manager.announcements).not.toHaveBeenCalled();
  });
  it('a refused pause write cannot adopt the previous persisted break', async () => {
    const f = fixture();
    f.replace({ break_started_at: new Date(Date.now() - 3600000).toISOString() });
    (f.manager as any).onBreak = false;
    (f.manager as any).breakApplies = async () => true;
    f.fail(true);
    await f.manager.pauseForBreak(300000);
    f.manager.announcements.mockClear();
    f.fail(false);
    const writesBefore = f.writes.length;
    await expect(f.manager.beginBreakCountdown(300000)).rejects.toThrow('Anchor Changed');
    expect(f.writes).toHaveLength(writesBefore);
    expect(f.manager.announcements).not.toHaveBeenCalled();
  });
  it('refuses an older persisted break on its first countdown attempt', async () => {
    const f = fixture();
    f.replace({ break_started_at: new Date(Date.now() - 3600000).toISOString() });
    await expect(f.manager.beginBreakCountdown(300000)).rejects.toThrow('Anchor Changed');
    expect(f.writes).toHaveLength(0);
    expect(f.manager.announcements).not.toHaveBeenCalled();
  });
  it('accepts the same durable timestamptz returned with a database offset', async () => {
    const f = fixture();
    const deadline = Date.now() + 300000;
    f.replace({ break_ends_at: new Date(deadline).toISOString().replace('Z', '+00:00') });
    await f.manager.beginBreakCountdown(300000, deadline);
    expect(f.writes).toHaveLength(0);
    expect(f.manager.announcements).toHaveBeenCalledOnce();
  });
});
