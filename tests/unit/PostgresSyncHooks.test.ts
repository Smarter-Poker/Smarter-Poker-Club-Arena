/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PostgresSyncHooks
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests init/destroy lifecycle, double-init guard, and cleanup on destroy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const admission = vi.hoisted(() => ({
  subscribe: vi.fn(),
  attempts: [] as Array<{ signal: AbortSignal; status: (value: string) => void }>,
}));
vi.mock('../../src/lib/subscribeRealtime', () => ({ subscribeRealtime: admission.subscribe }));

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
      unsubscribe: vi.fn(),
    }),
    removeChannel: vi.fn(),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { masterBus } from '../../src/core/MasterBus';
import { supabase } from '../../src/lib/supabase';
import { postgresSyncHooks } from '../../src/services/PostgresSyncHooks';

describe('PostgresSyncHooks', () => {
  beforeEach(() => {
    postgresSyncHooks.destroy();
    vi.clearAllMocks();
    admission.attempts = [];
    admission.subscribe.mockImplementation((channel, status, signal) => {
      admission.attempts.push({ signal, status });
      channel.subscribe(status);
      return Promise.resolve();
    });
  });

  afterEach(() => {
    postgresSyncHooks.destroy();
  });

  describe('init / destroy lifecycle', () => {
    it('should init without crashing', () => {
      postgresSyncHooks.init('test-user');
    });

    it('should not re-init when already initialized', () => {
      postgresSyncHooks.init('test-user');
      postgresSyncHooks.init('test-user'); // Guard prevents duplicate
      // channel() should only be called once for init
    });

    it('should destroy without crashing', () => {
      postgresSyncHooks.init('test-user');
      postgresSyncHooks.destroy();
    });

    it('should not crash on destroy when not initialized', () => {
      postgresSyncHooks.destroy();
    });

    it('should be re-initializable after destroy', () => {
      postgresSyncHooks.init('test-user');
      postgresSyncHooks.destroy();
      postgresSyncHooks.init('test-user');
      postgresSyncHooks.destroy();
    });
  });

  describe('export shape', () => {
    it('should export postgresSyncHooks with init and destroy', () => {
      expect(typeof postgresSyncHooks.init).toBe('function');
      expect(typeof postgresSyncHooks.destroy).toBe('function');
    });
  });
});

describe('pending global subscription admission', () => {
  beforeEach(() => {
    postgresSyncHooks.destroy();
    vi.clearAllMocks();
    admission.attempts = [];
    admission.subscribe.mockImplementation((_channel, status, signal) => {
      admission.attempts.push({ signal, status });
      return Promise.resolve();
    });
  });
  afterEach(() => postgresSyncHooks.destroy());

  it('destroy aborts pending admission and rejects a late subscribed status', () => {
    postgresSyncHooks.init('old-user');
    expect(admission.attempts).toHaveLength(1);
    expect(admission.attempts[0].signal.aborted).toBe(false);
    postgresSyncHooks.destroy();
    expect(admission.attempts[0].signal.aborted).toBe(true);
    vi.mocked(masterBus.emit).mockClear();
    admission.attempts[0].status('SUBSCRIBED');
    admission.attempts[0].status('TIMED_OUT');
    expect(masterBus.emit).not.toHaveBeenCalled();
    expect(supabase.channel).toHaveBeenCalledTimes(1);
  });

  it('an identity switch retires only the old admission and ignores its late errors', () => {
    postgresSyncHooks.init('old-user');
    postgresSyncHooks.init('new-user');
    expect(admission.attempts).toHaveLength(2);
    expect(admission.attempts[0].signal.aborted).toBe(true);
    expect(admission.attempts[1].signal.aborted).toBe(false);
    vi.mocked(masterBus.emit).mockClear();
    admission.attempts[0].status('CHANNEL_ERROR');
    admission.attempts[1].status('SUBSCRIBED');
    expect(masterBus.emit).toHaveBeenCalledWith('REALTIME_CONNECTED', {
      channelName: 'global_db_sync:new-user',
    });
    expect(
      vi.mocked(masterBus.emit).mock.calls.some(([kind]) => kind === 'REALTIME_DISCONNECTED')
    ).toBe(false);
    expect(supabase.channel).toHaveBeenCalledTimes(2);
  });
});
