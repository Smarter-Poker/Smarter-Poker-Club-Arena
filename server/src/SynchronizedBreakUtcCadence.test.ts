import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let GameServer: (typeof import('./GameServer.js'))['GameServer'];
type BreakScheduler = {
  running: boolean;
  scheduleSynchronizedBreaks(): void;
  triggerSynchronizedBreak: ReturnType<typeof vi.fn>;
  launchServerLifecycleJob: ReturnType<typeof vi.fn>;
};

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder-key';
  ({ GameServer } = await import('./GameServer.js'));
}, 60_000); // importing GameServer alone can pass 10s on a loaded CI runner
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function scheduler(): BreakScheduler {
  return Object.assign(Object.create(GameServer.prototype), {
    running: true,
    triggerSynchronizedBreak: vi.fn().mockResolvedValue(undefined),
    launchServerLifecycleJob: vi.fn(),
  }) as BreakScheduler;
}

describe('Synchronized Break UTC Cadence', () => {
  it.each([
    ['UTC', '2026-09-10T00:54:59.750Z', '2026-09-10T00:55:00.000Z'],
    ['UTC', '2026-09-10T00:55:00.000Z', '2026-09-10T01:55:00.000Z'],
    ['America/Chicago', '2026-11-01T06:56:00.000Z', '2026-11-01T07:55:00.000Z'],
    ['America/Chicago', '2026-11-01T07:54:00.000Z', '2026-11-01T07:55:00.000Z'],
    ['Europe/Berlin', '2026-10-25T01:54:00.000Z', '2026-10-25T01:55:00.000Z'],
    ['Asia/Kathmandu', '2026-09-10T00:54:00.000Z', '2026-09-10T00:55:00.000Z'],
    ['America/Chicago', '2026-03-08T07:56:00.000Z', '2026-03-08T08:55:00.000Z'],
    ['UTC', '2026-12-31T23:56:00.000Z', '2027-01-01T00:55:00.000Z'],
  ])('arms the next UTC :55 in %s at %s', (zone, now, expected) => {
    vi.stubEnv('TZ', zone);
    vi.setSystemTime(new Date(now));
    const timers = vi.spyOn(globalThis, 'setTimeout');
    scheduler().scheduleSynchronizedBreaks();
    expect(timers).toHaveBeenCalledTimes(1);
    expect(timers.mock.calls[0][1]).toBe(Date.parse(expected) - Date.parse(now));
  });

  it('re-arms from the current wall clock after a delayed firing', () => {
    vi.stubEnv('TZ', 'UTC');
    vi.setSystemTime(new Date('2026-09-10T00:54:00.000Z'));
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const server = scheduler();
    server.scheduleSynchronizedBreaks();
    const fire = timers.mock.calls[0][0] as () => void;
    vi.setSystemTime(new Date('2026-09-10T00:57:00.000Z'));
    fire();
    expect(server.triggerSynchronizedBreak).toHaveBeenCalledOnce();
    expect(server.launchServerLifecycleJob).toHaveBeenCalledOnce();
    expect(timers.mock.calls[1][1]).toBe(58 * 60 * 1000);
  });
});
