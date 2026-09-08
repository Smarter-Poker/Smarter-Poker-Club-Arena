/**
 * The rake spec guard (Chip Accounting Standard R7, 2026-09-02) under Dan's
 * risk ruling: a mismatch ALERTS ONCE PER BOOT and never blocks dealing.
 *
 * Pins:
 *   - match: no alert, state says the two agree;
 *   - mismatch: one CRITICAL `RakeSpec.drift` with both checksums and both
 *     canonical texts; a second tick of the SAME mismatch files nothing; a
 *     tick that finds a DIFFERENT database checksum still files nothing
 *     (once per boot, not once per checksum); the drift state is published;
 *   - resolved: an info `RakeSpec.drift_resolved` when the two agree again;
 *   - unavailable: a warning, and the previous verdict is kept;
 *   - nothing here exposes a "blocked" flag and nothing in the engine reads
 *     one - the only import of the drift state is /health in GameServer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockRaiseAlert = vi.fn(async () => undefined);
vi.mock('./financialAlerts.js', () => ({
  raiseFinancialAlert: (...args: unknown[]) => mockRaiseAlert(...(args as [])),
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: vi.fn() } }));

const guard = await import('./rakeSpecGuard.js');
const spec = await import('../config/rakeSpec.js');

type Rpc = (fn: string) => Promise<{ data: unknown; error: unknown }>;
const clientReturning = (checksum: unknown, canonical = 'db-canonical'): { rpc: Rpc } => ({
  rpc: async (fn: string) => {
    if (fn === 'fn_rake_spec_checksum') return { data: checksum, error: null };
    if (fn === 'fn_rake_spec_canonical') return { data: canonical, error: null };
    return { data: null, error: new Error(`unexpected rpc ${fn}`) };
  },
});
const failingClient: { rpc: Rpc } = {
  rpc: async () => ({ data: null, error: new Error('PGRST002 schema cache reload') }),
};

const OTHER = 'ffffffffffffffffffffffffffffffff';
const THIRD = '00000000000000000000000000000000';

beforeEach(() => {
  mockRaiseAlert.mockClear();
  guard.resetRakeSpecGuardForTests();
});

afterEach(async () => {
  await guard.stopRakeSpecGuard();
  vi.useRealTimers();
});

describe('rakeSpecGuard: match', () => {
  it('files no alert and publishes agreement', async () => {
    const v = await guard.verifyRakeSpecAgainstDatabase(clientReturning(spec.rakeSpecChecksum()));
    expect(v).toBe('match');
    expect(mockRaiseAlert).not.toHaveBeenCalled();
    const s = spec.rakeSpecDriftState();
    expect(s.drifted).toBe(false);
    expect(s.databaseChecksum).toBe(spec.rakeSpecChecksum());
    expect(s.compiledChecksum).toBe(spec.rakeSpecChecksum());
  });
});

describe('rakeSpecGuard: mismatch', () => {
  it('files ONE critical RakeSpec.drift with both checksums and both canonical texts', async () => {
    const v = await guard.verifyRakeSpecAgainstDatabase(clientReturning(OTHER, 'the-db-text'));
    expect(v).toBe('mismatch');
    expect(mockRaiseAlert).toHaveBeenCalledTimes(1);
    const [severity, kind, , ctx] = mockRaiseAlert.mock.calls[0] as unknown as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(severity).toBe('critical');
    expect(kind).toBe('RakeSpec.drift');
    expect(ctx.compiledChecksum).toBe(spec.rakeSpecChecksum());
    expect(ctx.databaseChecksum).toBe(OTHER);
    expect(ctx.compiledCanonical).toBe(spec.rakeSpecCanonical());
    expect(ctx.databaseCanonical).toBe('the-db-text');
    expect(spec.rakeSpecDriftState().drifted).toBe(true);
    expect(spec.rakeSpecDriftState().detail).toContain('dealing continues');
  });

  it('is deduped once per boot: the same drift and a different drift both file nothing more', async () => {
    await guard.verifyRakeSpecAgainstDatabase(clientReturning(OTHER));
    await guard.verifyRakeSpecAgainstDatabase(clientReturning(OTHER));
    await guard.verifyRakeSpecAgainstDatabase(clientReturning(THIRD));
    expect(mockRaiseAlert).toHaveBeenCalledTimes(1);
    expect(spec.rakeSpecDriftState().databaseChecksum).toBe(THIRD);
  });

  it('files an info RakeSpec.drift_resolved when the two agree again', async () => {
    await guard.verifyRakeSpecAgainstDatabase(clientReturning(OTHER));
    const v = await guard.verifyRakeSpecAgainstDatabase(clientReturning(spec.rakeSpecChecksum()));
    expect(v).toBe('match');
    const kinds = mockRaiseAlert.mock.calls.map((c) => (c as unknown as [string, string])[1]);
    expect(kinds).toEqual(['RakeSpec.drift', 'RakeSpec.drift_resolved']);
    expect(spec.rakeSpecDriftState().drifted).toBe(false);
  });
});

describe('rakeSpecGuard: unavailable', () => {
  it('warns and keeps the previous verdict', async () => {
    await guard.verifyRakeSpecAgainstDatabase(clientReturning(OTHER));
    const v = await guard.verifyRakeSpecAgainstDatabase(failingClient);
    expect(v).toBe('unavailable');
    const last = mockRaiseAlert.mock.calls.at(-1) as unknown as [string, string];
    expect(last[0]).toBe('warning');
    expect(last[1]).toBe('RakeSpec.checksum_unavailable');
    expect(spec.rakeSpecDriftState().drifted).toBe(true);
    expect(spec.rakeSpecDriftState().databaseChecksum).toBe(OTHER);
  });

  it('a malformed checksum counts as unavailable, not as drift', async () => {
    const v = await guard.verifyRakeSpecAgainstDatabase(clientReturning('not-a-checksum'));
    expect(v).toBe('unavailable');
    expect(spec.rakeSpecDriftState().drifted).toBe(false);
  });
});

describe('rakeSpecGuard: it never holds a table (Dan 2026-09-02 risk ruling)', () => {
  const SRC = join(__dirname, '..');
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

  it('exposes no blocked flag and the drift state has none', () => {
    expect('isCashDealingBlockedByRakeSpec' in spec).toBe(false);
    expect('blocked' in spec.rakeSpecDriftState()).toBe(false);
  });

  it('the deal loop and the watchdog do not import the drift state', () => {
    for (const file of [
      'engine/ServerTableEngineDealing.ts',
      'engine/ServerTableEngineTurns.ts',
      'engine/ServerTableEngineBase.ts',
      'engine/HandController.ts',
    ]) {
      const text = read(file);
      expect(text, `${file} must not gate dealing on the rake spec`).not.toMatch(
        /rakeSpecDriftState|isCashDealingBlockedByRakeSpec|rake_spec_drift_hold/
      );
    }
    // The only reader is /health.
    expect(read('GameServer.ts')).toContain('rakeSpec: rakeSpecDriftState()');
  });

  it('startRakeSpecGuard resolves on a mismatch instead of throwing', async () => {
    const v = await guard.startRakeSpecGuard(clientReturning(OTHER), 60_000);
    expect(v).toBe('mismatch');
    await guard.stopRakeSpecGuard();
  });

  it('stop joins an interval check before shutdown may release ownership', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let finishCheck!: () => void;
    const delayedClient: { rpc: Rpc } = {
      rpc: async () => {
        calls++;
        if (calls === 1) return { data: spec.rakeSpecChecksum(), error: null };
        await new Promise<void>((resolve) => {
          finishCheck = resolve;
        });
        return { data: spec.rakeSpecChecksum(), error: null };
      },
    };

    await guard.startRakeSpecGuard(delayedClient, 10);
    await vi.advanceTimersByTimeAsync(10);
    let stopped = false;
    const stopping = guard.stopRakeSpecGuard().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishCheck();
    await stopping;
    expect(stopped).toBe(true);
  });
});
