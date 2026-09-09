/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — TournamentService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests BLIND_STRUCTURES, PAYOUT_STRUCTURES, SPIN_MULTIPLIERS, BOUNTY_PRESETS,
 * getTournament null return, and getTournaments empty return.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRpc, mockEmit, mockUuid } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockEmit: vi.fn(),
  mockUuid: vi.fn(() => '00000000-0000-4000-8000-000000000001'),
}));

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: mockRpc,
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: mockEmit, subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
}));

vi.mock('../../src/utils/uuid', () => ({ uuid: mockUuid }));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: { logTransaction: vi.fn().mockResolvedValue(undefined) },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import {
  BLIND_STRUCTURES,
  PAYOUT_STRUCTURES,
  SPIN_MULTIPLIERS,
  BOUNTY_PRESETS,
  SPIN_BLIND_STRUCTURE,
  tournamentService,
} from '../../src/services/TournamentService';

describe('TournamentService', () => {
  beforeEach(() => vi.clearAllMocks());

  // ─────────────────────────────────────────────────────────────────────────
  // BLIND STRUCTURES
  // ─────────────────────────────────────────────────────────────────────────

  describe('BLIND_STRUCTURES', () => {
    it('should have turbo, regular, and deepStack', () => {
      expect(BLIND_STRUCTURES.turbo).toBeDefined();
      expect(BLIND_STRUCTURES.regular).toBeDefined();
      expect(BLIND_STRUCTURES.deepStack).toBeDefined();
    });

    it('turbo should have 30 levels', () => {
      expect(BLIND_STRUCTURES.turbo).toHaveLength(30);
      // Check durations (3m or 5m break periods)
      const turboLevels = BLIND_STRUCTURES.turbo;
      for (const lvl of turboLevels) {
        expect([3, 5]).toContain(lvl.durationMinutes);
      }
    });

    it('regular should have 30 levels', () => {
      expect(BLIND_STRUCTURES.regular).toHaveLength(30);
      const regularLevels = BLIND_STRUCTURES.regular;
      for (const lvl of regularLevels) {
        expect([5, 8]).toContain(lvl.durationMinutes);
      }
    });

    it('deepStack should have 30 levels', () => {
      expect(BLIND_STRUCTURES.deepStack).toHaveLength(30);
      const deepStackLevels = BLIND_STRUCTURES.deepStack;
      for (const lvl of deepStackLevels) {
        expect([5, 15]).toContain(lvl.durationMinutes);
      }
    });

    it('blinds should increase monotonically per structure (excluding break levels)', () => {
      for (const struct of Object.values(BLIND_STRUCTURES)) {
        for (let i = 1; i < struct.length; i++) {
          // Breaks have 0 blinds, so skip comparisons involving breaks
          if (!struct[i].isBreak && !struct[i - 1].isBreak) {
            expect(struct[i].bigBlind).toBeGreaterThanOrEqual(struct[i - 1].bigBlind);
          }
        }
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PAYOUT STRUCTURES
  // ─────────────────────────────────────────────────────────────────────────

  describe('PAYOUT_STRUCTURES', () => {
    it('should have sng6, sng9, mtt10, mtt20, mtt50', () => {
      expect(PAYOUT_STRUCTURES.sng6).toBeDefined();
      expect(PAYOUT_STRUCTURES.sng9).toBeDefined();
      expect(PAYOUT_STRUCTURES.mtt10).toBeDefined();
      expect(PAYOUT_STRUCTURES.mtt20).toBeDefined();
      expect(PAYOUT_STRUCTURES.mtt50).toBeDefined();
    });

    it('each structure should sum to 100%', () => {
      for (const [name, struct] of Object.entries(PAYOUT_STRUCTURES)) {
        const total = struct.reduce((sum, p) => sum + p.percentage, 0);
        expect(total).toBeCloseTo(100, 1);
      }
    });

    it('sng6 should pay 2 places', () => {
      expect(PAYOUT_STRUCTURES.sng6).toHaveLength(2);
    });

    it('sng9 should pay 3 places', () => {
      expect(PAYOUT_STRUCTURES.sng9).toHaveLength(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SPIN MULTIPLIERS
  // ─────────────────────────────────────────────────────────────────────────

  describe('SPIN_MULTIPLIERS', () => {
    it('should have standard and hyper profiles', () => {
      expect(SPIN_MULTIPLIERS.standard).toBeDefined();
      expect(SPIN_MULTIPLIERS.hyper).toBeDefined();
    });

    it('standard probabilities should sum to ≈100%', () => {
      const total = SPIN_MULTIPLIERS.standard.reduce((sum, s) => sum + s.probability, 0);
      expect(total).toBeCloseTo(100, 0);
    });

    it('standard EV should be < 3.0 (profitable for house)', () => {
      const ev = SPIN_MULTIPLIERS.standard.reduce(
        (sum, s) => sum + s.multiplier * (s.probability / 100),
        0
      );
      expect(ev).toBeLessThan(3.0);
    });

    it('hyper EV should be < 3.0 (profitable for house)', () => {
      const ev = SPIN_MULTIPLIERS.hyper.reduce(
        (sum, s) => sum + s.multiplier * (s.probability / 100),
        0
      );
      expect(ev).toBeLessThan(3.0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BOUNTY PRESETS
  // ─────────────────────────────────────────────────────────────────────────

  describe('BOUNTY_PRESETS', () => {
    it('should have fixed, progressive, mystery', () => {
      expect(BOUNTY_PRESETS.fixed).toBeDefined();
      expect(BOUNTY_PRESETS.progressive).toBeDefined();
      expect(BOUNTY_PRESETS.mystery).toBeDefined();
    });

    it('fixed should have bountyType = fixed', () => {
      expect(BOUNTY_PRESETS.fixed.bountyType).toBe('fixed');
    });

    // REPLACED 2026-08-25. These two used to assert that the mystery preset
    // carried a client-side multiplier ladder whose probabilities summed to
    // 100. That ladder is gone: it was never sent to the server, nothing ever
    // read it, and the tier sizes are now derived server-side from the funded
    // pool (server/src/config/mysteryBountySpec.ts). The preset's job is to
    // name the format and its base bounty, and that is what is pinned here.
    it('mystery should name the format and a whole-chip base bounty', () => {
      expect(BOUNTY_PRESETS.mystery.bountyType).toBe('mystery');
      expect(BOUNTY_PRESETS.mystery.baseBounty).toBeGreaterThan(0);
      expect(Number.isInteger(BOUNTY_PRESETS.mystery.baseBounty)).toBe(true);
    });

    it('no preset carries a client-side tier ladder', () => {
      for (const preset of Object.values(BOUNTY_PRESETS)) {
        expect(preset).not.toHaveProperty('mysteryTiers');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SPIN BLIND STRUCTURE
  // ─────────────────────────────────────────────────────────────────────────

  describe('SPIN_BLIND_STRUCTURE', () => {
    // 2026-08-30 audit: the ladder is DERIVED from spinSpec SPIN_BLINDS now
    // (one source of truth; the old hand-typed 15-level 2-minute ladder
    // diverged from what the engine actually plays). Pin the derivation.
    it('mirrors spinSpec SPIN_BLINDS at 3 minutes per level', async () => {
      const { SPIN_BLINDS } = await import('../../src/config/spinSpec');
      expect(SPIN_BLIND_STRUCTURE).toHaveLength(SPIN_BLINDS.length);
      SPIN_BLIND_STRUCTURE.forEach((lvl, i) => {
        expect(lvl.smallBlind).toBe(SPIN_BLINDS[i].small);
        expect(lvl.bigBlind).toBe(SPIN_BLINDS[i].big);
        expect(lvl.ante).toBe(0);
        expect(lvl.durationMinutes).toBe(3);
        expect(lvl.level).toBe(i + 1);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // QUERIES
  // ─────────────────────────────────────────────────────────────────────────

  describe('getTournament', () => {
    it('should return null when tournament not found', async () => {
      const result = await tournamentService.getTournament('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getTournaments', () => {
    it('should return empty array when no tournaments', async () => {
      const result = await tournamentService.getTournaments('club-1');
      expect(result).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT M19 — tournament money is server-owned
  // ───────────────────────────────────────────────────────────────────────────

  describe('unregisterPlayer (AUDIT M19)', () => {
    beforeEach(() => {
      mockRpc.mockReset();
      mockEmit.mockReset();
    });

    it('sends only the tournament and request ids — no target user, no amount', async () => {
      // No user parameter is the authorization model: a player may only
      // unregister themselves, and the way to guarantee that is to never accept
      // a target. No amount is the anti-mint rule: the refund is read from
      // immutable entry entitlements server-side. The request id identifies
      // one intent so a lost response can replay only that receipt.
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          request_id: '00000000-0000-4000-8000-000000000001',
          registration_id: 'registration-1',
          refunded_chips: 110,
          returned_ticket_value: 0,
          wallet_chips_from_satellite_entitlements: 0,
        },
        error: null,
      });

      await tournamentService.unregisterPlayer('t-1', 'u-1');

      expect(mockRpc).toHaveBeenCalledTimes(1);
      const [name, args] = mockRpc.mock.calls[0];
      expect(name).toBe('fn_unregister_from_tournament');
      expect(args).toEqual({
        p_tournament_id: 't-1',
        p_request_id: '00000000-0000-4000-8000-000000000001',
      });
      expect(Object.keys(args)).toHaveLength(2);
    });

    it('emits a balance update only when something was actually refunded', async () => {
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          request_id: '00000000-0000-4000-8000-000000000001',
          registration_id: 'registration-1',
          refunded_chips: 0,
          returned_ticket_value: 110,
          wallet_chips_from_satellite_entitlements: 0,
        },
        error: null,
      });
      await tournamentService.unregisterPlayer('t-1', 'u-1');
      expect(mockEmit).not.toHaveBeenCalled();

      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          request_id: '00000000-0000-4000-8000-000000000001',
          registration_id: 'registration-2',
          refunded_chips: 110,
          returned_ticket_value: 0,
          wallet_chips_from_satellite_entitlements: 0,
        },
        error: null,
      });
      await tournamentService.unregisterPlayer('t-1', 'u-1');
      expect(mockEmit).toHaveBeenCalledWith('BALANCE_UPDATED', {
        source: 'tournament_unregister_refund',
        userId: 'u-1',
      });
    });

    it('surfaces the server refusal reason rather than a generic failure', async () => {
      mockRpc.mockResolvedValue({
        data: { ok: false, reason: 'tournament_started' },
        error: null,
      });

      await expect(tournamentService.unregisterPlayer('t-1', 'u-1')).rejects.toThrow(
        /only unregister before it starts/i
      );
    });

    it('reports an unrecognised reason as itself', async () => {
      mockRpc.mockResolvedValue({ data: { ok: false, reason: 'brand_new_rule' }, error: null });
      await expect(tournamentService.unregisterPlayer('t-1', 'u-1')).rejects.toThrow(
        /brand_new_rule/
      );
    });

    it('retries one unknown outcome and then fails closed', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
      await expect(tournamentService.unregisterPlayer('t-1', 'u-1')).rejects.toThrow(
        /could not confirm tournament unregistration/i
      );
      expect(mockRpc).toHaveBeenCalledTimes(2);
      expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
    });
  });

  describe('no client-side tournament payouts (AUDIT M19 regression guard)', () => {
    it('never calls a wallet-credit RPC while unregistering', async () => {
      // credit_player_wallet's third parameter is an idempotency key that
      // defaults to NULL. The old client passed two arguments, so every call
      // was un-deduplicated — a double-payout on top of the engine's own
      // credit, had the grant ever been widened.
      const forbidden = [
        'credit_player_wallet',
        'atomic_credit_wallet_and_log',
        'fn_idempotent_credit_wallet',
        'atomic_tournament_unregister',
      ];

      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          request_id: '00000000-0000-4000-8000-000000000001',
          registration_id: 'registration-1',
          refunded_chips: 110,
          returned_ticket_value: 0,
          wallet_chips_from_satellite_entitlements: 0,
        },
        error: null,
      });
      await tournamentService.unregisterPlayer('t-1', 'u-1');

      for (const [name] of mockRpc.mock.calls) {
        expect(forbidden).not.toContain(name);
      }
    });

    it('no longer exposes eliminatePlayer, eliminatePlayerAuto or collectBounty', () => {
      // All three were client duplicates of TournamentManagerEliminations, which
      // computes prizes and bounties server-side and credits them idempotently.
      // Deleting them removed duplicate money paths, not features.
      const svc = tournamentService as unknown as Record<string, unknown>;
      expect(svc.eliminatePlayer).toBeUndefined();
      expect(svc.eliminatePlayerAuto).toBeUndefined();
      expect(svc.collectBounty).toBeUndefined();
    });

    it('keeps calculatePayout, which is display-only', () => {
      // Pure function used to show projected payouts in the lobby. Legitimate
      // client concern; must never be wired back into a credit.
      expect(typeof tournamentService.calculatePayout).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  // getCurrentLevelState - THE BASE OF `tournaments.current_level`
  // ---------------------------------------------------------------------------
  //
  // `tournaments.current_level` is a 0-BASED ARRAY INDEX. Verified three ways
  // on 2026-08-25:
  //
  //   1. the engine writes `this.currentLevel`, which it uses as
  //      `blindStructure[this.currentLevel]` (TournamentManagerBase);
  //   2. production agrees - for every RUNNING event with a uniform structure,
  //      current_level == floor(elapsed / level_duration), and
  //      blind_structure[current_level].level == current_level + 1;
  //   3. process_tournament_rebuy reads the column into v_level and closes the
  //      window on `v_level >= v_cap`, which is the comparison this file makes
  //      against `levelIndex`.
  //
  // These tests pin the blinds a player at a given level actually faces, so
  // that a future "1-indexed for display" +1 cannot be reintroduced silently
  // on either side of the read.

  describe('getCurrentLevelState - level indexing', () => {
    // Four levels, each distinguishable by every field.
    const structure = [
      { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 },
      { level: 2, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 10 },
      { level: 3, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 10 },
      { level: 4, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 10 },
    ];

    const running = (currentLevel: number | null) =>
      ({
        id: 't-lvl',
        status: 'RUNNING',
        started_at: new Date(Date.now() - 60_000).toISOString(),
        level_started_at: new Date(Date.now() - 60_000).toISOString(),
        blind_structure: structure,
        current_level: currentLevel,
      }) as never;

    it('reads the OPENING level from current_level = 0, not the second one', () => {
      // The one case the old code got right by accident under either reading.
      const s = tournamentService.getCurrentLevelState(running(0));
      expect(s.levelIndex).toBe(0);
      expect(s.currentLevel.smallBlind).toBe(25);
      expect(s.currentLevel.bigBlind).toBe(50);
      expect(s.currentLevel.ante).toBe(0);
      expect(s.nextLevel?.bigBlind).toBe(100);
    });

    it('reads level 1 as the SECOND row - 50/100 ante 10', () => {
      // If current_level were treated as 1-based this would return 100/200.
      const s = tournamentService.getCurrentLevelState(running(1));
      expect(s.levelIndex).toBe(1);
      expect(s.currentLevel.smallBlind).toBe(50);
      expect(s.currentLevel.bigBlind).toBe(100);
      expect(s.currentLevel.ante).toBe(10);
      expect(s.nextLevel?.bigBlind).toBe(200);
    });

    it('reads a mid-structure level without drifting one ahead', () => {
      const s = tournamentService.getCurrentLevelState(running(2));
      expect(s.levelIndex).toBe(2);
      expect(s.currentLevel.smallBlind).toBe(100);
      expect(s.currentLevel.bigBlind).toBe(200);
      expect(s.currentLevel.ante).toBe(25);
      // The structure's own label is index + 1.
      expect(s.currentLevel.level).toBe(3);
    });

    it('returns the REAL final level, not a wall-clock guess', () => {
      // index 3 is the last row of a 4-row structure. The guard used to be
      // `serverLevel < blinds.length`; anything that reads current_level as
      // 1-based makes the final level fail that test and silently fall through
      // to a wall-clock derivation the code itself documents as drifting.
      const s = tournamentService.getCurrentLevelState(running(3));
      expect(s.levelIndex).toBe(3);
      expect(s.currentLevel.smallBlind).toBe(200);
      expect(s.currentLevel.bigBlind).toBe(400);
      expect(s.currentLevel.ante).toBe(50);
      expect(s.nextLevel).toBeNull();
    });

    it('keeps the TRUE level past the end of the structure (auto-escalation)', () => {
      // The engine keeps incrementing current_level past the structure and
      // doubles the last playable level's blinds in memory. 3079 production
      // rows sat in this state. The array cannot describe those levels, so the
      // lookup clamps to the last row - but levelIndex must stay truthful,
      // because that is the number the money gates and the SQL RPC compare.
      const s = tournamentService.getCurrentLevelState(running(9));
      expect(s.levelIndex).toBe(9);
      expect(s.currentLevel.bigBlind).toBe(400); // last known row
      expect(s.nextLevel).toBeNull();
    });

    it('falls back to wall-clock only when current_level is absent', () => {
      // A select that omitted the column. 60s elapsed into 10-minute levels.
      const s = tournamentService.getCurrentLevelState(running(null));
      expect(s.levelIndex).toBe(0);
      expect(s.currentLevel.bigBlind).toBe(50);
    });

    it('reports the opening level before the tournament starts', () => {
      const s = tournamentService.getCurrentLevelState({
        id: 't-lvl',
        status: 'REGISTERING',
        started_at: null,
        blind_structure: structure,
        current_level: 0,
      } as never);
      expect(s.levelIndex).toBe(0);
      expect(s.currentLevel.bigBlind).toBe(50);
    });
  });

  // ---------------------------------------------------------------------------
  // MONEY GATES - the two that read levelIndex
  // ---------------------------------------------------------------------------
  //
  // RULE 11.5: process_tournament_rebuy moves chips, so it is NOT called
  // against production here. The RPC is mocked; what is asserted is the level
  // number this client hands it and the gate it applies before doing so. The
  // live path was reasoned about (and its source read out of pg_proc
  // read-only), not executed.

  describe('rebuy / re-entry gate reads a 0-based level', () => {
    const structure = [
      { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 },
      { level: 2, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 10 },
      { level: 3, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 10 },
    ];

    const at = (currentLevel: number) =>
      tournamentService.getCurrentLevelState({
        id: 't-gate',
        status: 'RUNNING',
        started_at: new Date(Date.now() - 60_000).toISOString(),
        level_started_at: new Date(Date.now() - 60_000).toISOString(),
        blind_structure: structure,
        current_level: currentLevel,
      } as never);

    it('matches the SQL gate `v_level >= v_cap` exactly', () => {
      // canRebuy closes on `levelIndex >= cap`; process_tournament_rebuy closes
      // on `v_level >= v_cap` reading the same column. With a cap of 2 that is
      // open at 0 and 1, closed from 2 - two levels of rebuys, as advertised.
      const cap = 2;
      expect(at(0).levelIndex >= cap).toBe(false);
      expect(at(1).levelIndex >= cap).toBe(false);
      expect(at(2).levelIndex >= cap).toBe(true);
    });

    it('does not close the window a level early', () => {
      // A 1-based reading would make the last level of the window (index
      // cap - 1) compare as cap and shut rebuys one level ahead of the
      // database, which would still have accepted them.
      const cap = 8;
      expect(at(7).levelIndex).toBe(7);
      expect(at(7).levelIndex >= cap).toBe(false);
    });
  });
});

describe('Tournament Purchase Confirmation', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('navigator', { locks: { request: (_key: string, fn: () => unknown) => fn() } });

    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(tournamentService, 'canRebuy').mockResolvedValue({ allowed: true });
    vi.spyOn(tournamentService, 'canAddOn').mockResolvedValue({ allowed: true });
    vi.spyOn(tournamentService, 'getCurrentLevelState').mockReturnValue({ levelIndex: 3 } as never);
  });

  const kinds = ['rebuy', 'reentry', 'addon'] as const;
  function purchase(kind: (typeof kinds)[number]) {
    vi.spyOn(tournamentService, 'getTournament').mockResolvedValue({
      id: 'event',
      starting_chips: 1000,
      rebuy_chips: 1000,
      addon_chips: 2000,
      buy_in_amount: 10,
      rebuy_cost: 10,
      addon_cost: 10,
      is_reentry: kind === 'reentry',
      is_rebuy: kind !== 'reentry',
    } as never);
    return kind === 'addon'
      ? tournamentService.processAddOn('event', 'player')
      : tournamentService.processRebuy('event', 'player', 'original-prompt');
  }

  for (const kind of kinds) {
    it.each([
      null,
      {},
      [],
      { success: false, new_stack: 1000, rebuy_type: kind },
      { success: 'true', new_stack: 1000, rebuy_type: kind },
      { success: true, rebuy_type: kind },
      { success: true, new_stack: '1000', rebuy_type: kind },
      { success: true, new_stack: NaN, rebuy_type: kind },
      { success: true, new_stack: Infinity, rebuy_type: kind },
      { success: true, new_stack: -1, rebuy_type: kind },
      { success: true, new_stack: 1000, rebuy_type: 'wrong-purchase' },
    ])('rejects an unconfirmed ' + kind + ' response %#', async (data) => {
      mockRpc.mockResolvedValue({ data, error: null });
      await expect(purchase(kind)).rejects.toThrow(/confirm/i);
      expect(mockEmit).not.toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalledTimes(1);
    });

    it.each([0, 2500])('returns the exact confirmed ' + kind + ' stack %s', async (stack) => {
      mockRpc.mockResolvedValue({
        data: { success: true, new_stack: stack, rebuy_type: kind, idempotent: true },
        error: null,
      });
      await expect(purchase(kind)).resolves.toEqual({ success: true, newStack: stack });
      expect(mockEmit).toHaveBeenCalledExactlyOnceWith('BALANCE_UPDATED', {
        source: kind === 'addon' ? 'tournament_addon' : 'tournament_rebuy',
        userId: 'player',
      });
    });

    it('replays the exact ' + kind + ' purchase after eligibility and level change', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: new Error('Lost Response') });
      await expect(purchase(kind)).rejects.toThrow('Lost Response');
      const original = mockRpc.mock.calls[0][1];
      vi.mocked(tournamentService.canRebuy).mockRejectedValue(new Error('Window Closed'));
      vi.mocked(tournamentService.canAddOn).mockRejectedValue(new Error('Window Closed'));
      vi.mocked(tournamentService.getCurrentLevelState).mockReturnValue({
        levelIndex: 99,
      } as never);
      mockRpc.mockResolvedValueOnce({
        data: { success: true, new_stack: 0, rebuy_type: kind, idempotent: true },
        error: null,
      });
      const result =
        kind === 'addon'
          ? await tournamentService.processAddOn('event', 'player')
          : await tournamentService.processRebuy('event', 'player', 'original-prompt');
      expect(result).toEqual({ success: true, newStack: 0 });
      expect(mockRpc.mock.calls[1][1]).toEqual(original);
      expect(mockEmit).toHaveBeenCalledTimes(1);
    });

    it('preserves an unknown transport outcome for ' + kind, async () => {
      const error = new Error('Response Lost');
      mockRpc.mockResolvedValue({ data: null, error });
      await expect(purchase(kind)).rejects.toBe(error);
      expect(mockEmit).not.toHaveBeenCalled();
    });
  }
});
