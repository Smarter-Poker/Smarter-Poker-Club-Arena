import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  createIntake,
  acceptedReceipt,
  TARGET,
} from '../tools/production-alerts-native-wakeup/core.mjs';
const A = '00000000-0000-0000-0000-000000000001';
const B = '00000000-0000-0000-0000-000000000002';
function fixture(seed = null) {
  let state = seed;
  let ids = [A];
  let acknowledged = false;
  let calls = 0;
  let failure = false;
  const writes: any[] = [];
  const intake = createIntake({
    load: async () => state,
    save: async (value) => {
      state = value;
      writes.push(value);
    },
    pending: async () => ({ version: 1, active_acknowledged: acknowledged, pending: ids }),
    id: () => B,
    queue: async (args) => {
      calls++;
      expect(state.phase).toBe('submitting');
      expect(args[2]).toBe(TARGET);
      if (failure) throw Error('timeout');
      return `Queued message ${A} for thread ${TARGET}.`;
    },
  });
  return {
    intake,
    writes,
    get state() {
      return state;
    },
    get calls() {
      return calls;
    },
    set ids(value) {
      ids = value;
    },
    set acknowledged(value) {
      acknowledged = value;
    },
    set failure(value) {
      failure = value;
    },
  };
}
describe('committed operational alert wakes native intake', () => {
  it('queues once across concurrent event bursts until actual database acknowledgement', async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 25 }, () => f.intake.event()));
    expect(f.calls).toBe(1);
    expect(f.state.phase).toBe('queued');
    f.ids = [B];
    f.acknowledged = true;
    await f.intake.event();
    expect(f.calls).toBe(2);
    expect(f.writes[2]).toBeNull();
  });
  it('retains an uncertain native side effect without automatic retry, including restart', async () => {
    const f = fixture();
    f.failure = true;
    await expect(f.intake.event()).rejects.toThrow('uncertain');
    await f.intake.event();
    expect(f.calls).toBe(1);
    expect(f.state.phase).toBe('uncertain');
    const restored = fixture(f.state);
    await restored.intake.event();
    expect(restored.calls).toBe(0);
  });
  it('does not requeue a crash after persisted submission', async () => {
    const f = fixture({ operationId: B, ids: [A], phase: 'submitting' });
    await f.intake.event();
    expect(f.calls).toBe(0);
  });
  it('keeps empty, invalid and unavailable source results distinct', async () => {
    const f = fixture();
    f.ids = [];
    await f.intake.event();
    expect(f.calls).toBe(0);
    f.ids = ['malformed'];
    await expect(f.intake.event()).rejects.toThrow('invalid');
    expect(f.calls).toBe(0);
    const broken = createIntake({
      load: async () => null,
      save: async () => {},
      pending: async () => {
        throw Error('offline');
      },
      queue: async () => {
        throw Error('must not queue');
      },
    });
    await expect(broken.event()).rejects.toThrow('offline');
  });
  it('requires the actual receipt and canonical target', () => {
    expect(acceptedReceipt(`Queued message ${A} for thread ${TARGET}.`)).toBe(A);
    for (const text of ['accepted', '', `Queued message ${A} for thread ${B}.`])
      expect(() => acceptedReceipt(text)).toThrow();
  });
  it('parses the actual shipped gateway entry and requires credential authentication', () => {
    expect(() =>
      execFileSync(process.execPath, ['--check', 'tools/production-alerts-native-wakeup/index.mjs'])
    ).not.toThrow();
    const migration = readFileSync(
      'supabase/migrations/20261027175950_native_alert_event_delivery.sql',
      'utf8'
    );
    expect(migration).toContain("WHERE name='ca_native_alert_receive_capability_v1'");
    expect(migration).toContain(
      'IF NOT public.fn_ca_native_alert_capability(p_channel) THEN RAISE EXCEPTION'
    );
    expect(migration).toContain('USING (public.fn_ca_native_alert_capability(realtime.topic()))');
  });
  it('keeps native database qualification on the existing alert qualification path', () => {
    expect(readFileSync('scripts/ci/test-alert-ledger-roots.py', 'utf8')).toContain(
      "ROOT/'scripts/ci/test-native-alert-event.py'"
    );
    expect(readFileSync('.github/workflows/informational-alert-state.yml', 'utf8')).toContain(
      'run: python3 scripts/ci/test-alert-ledger-roots.py'
    );
    const entry = readFileSync('tools/production-alerts-native-wakeup/index.mjs', 'utf8');
    expect(/private:\s*true/.test(entry)).toBe(true);
    expect(/shell:\s*false/.test(entry)).toBe(true);
    expect(entry).not.toMatch(/setInterval|setTimeout|schedule|restart|deploy/);
  });
});
