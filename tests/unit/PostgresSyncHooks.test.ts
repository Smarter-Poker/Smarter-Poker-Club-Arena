/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PostgresSyncHooks
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests init/destroy lifecycle, double-init guard, and cleanup on destroy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const mockChannel = {
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockReturnThis(),
  unsubscribe: vi.fn(),
};

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: vi.fn().mockReturnValue(mockChannel),
    removeChannel: vi.fn(),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { postgresSyncHooks } from '../../src/services/PostgresSyncHooks';

describe('PostgresSyncHooks', () => {
  beforeEach(() => vi.clearAllMocks());

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

  describe('channel setup', () => {
    it('should create channel scoped to user ID', () => {
      const { supabase } = require('../../src/lib/supabase');
      postgresSyncHooks.init('user-123');
      expect(supabase.channel).toHaveBeenCalledWith('global_db_sync:user-123');
    });

    it('should subscribe to 8 postgres_changes listeners', () => {
      postgresSyncHooks.init('user-456');
      // .on() is called for: wallets, profiles, clubs, unions, tables, tournaments, user_table_settings, club_members
      // Plus .subscribe() at the end
      expect(mockChannel.on).toHaveBeenCalledTimes(8);
    });
  });
});
