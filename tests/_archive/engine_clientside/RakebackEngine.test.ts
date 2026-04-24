/**
 * ♠ CLUB ARENA — RakebackEngine Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests rakeback tracking, tier determination, settlement, and bus emissions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), on: vi.fn(), subscribe: vi.fn(), subscribeDebounced: vi.fn() },
}));

import { rakebackEngine } from '../../src/engine/RakebackEngine';
import { masterBus } from '../../src/core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════

describe('RakebackEngine - Configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rakebackEngine.dispose('club-cfg');
  });

  it('should configure and check enabled state', () => {
    rakebackEngine.configure('club-cfg', { enabled: true });
    expect(rakebackEngine.isEnabled('club-cfg')).toBe(true);
  });

  it('should return false for unconfigured club', () => {
    expect(rakebackEngine.isEnabled('unconfigured-xyz')).toBe(false);
  });
});

describe('RakebackEngine - Rake Tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rakebackEngine.dispose('club-1');
    rakebackEngine.configure('club-1', { enabled: true });
  });

  it('should record hand rake for contributing players', () => {
    const contributions = new Map([
      ['p1', 50],
      ['p2', 30],
    ]);
    rakebackEngine.recordHandRake('club-1', 4, contributions, 80);

    const record = rakebackEngine.getPlayerRecord('club-1', 'p1');
    expect(record).not.toBeNull();
    expect(record!.rakeContributed).toBeGreaterThan(0);
    expect(record!.potsContributed).toBe(1);
  });

  it('should weight rake proportionally to pot contribution', () => {
    const contributions = new Map([
      ['p1', 60],
      ['p2', 40],
    ]);
    rakebackEngine.recordHandRake('club-1', 10, contributions, 100);

    const r1 = rakebackEngine.getPlayerRecord('club-1', 'p1')!;
    const r2 = rakebackEngine.getPlayerRecord('club-1', 'p2')!;

    // p1 contributed 60% → 6 rake, p2 contributed 40% → 4 rake
    expect(r1.rakeContributed).toBeCloseTo(6, 1);
    expect(r2.rakeContributed).toBeCloseTo(4, 1);
  });

  it('should not record when rake is 0', () => {
    const contributions = new Map([['p1', 50]]);
    rakebackEngine.recordHandRake('club-1', 0, contributions, 50);

    expect(rakebackEngine.getPlayerRecord('club-1', 'p1')).toBeNull();
  });

  it('should accumulate across multiple hands', () => {
    const contrib = new Map([['p1', 50]]);
    rakebackEngine.recordHandRake('club-1', 5, contrib, 50);
    rakebackEngine.recordHandRake('club-1', 5, contrib, 50);
    rakebackEngine.recordHandRake('club-1', 5, contrib, 50);

    const record = rakebackEngine.getPlayerRecord('club-1', 'p1')!;
    expect(record.potsContributed).toBe(3);
    expect(record.rakeContributed).toBeCloseTo(15, 1);
  });
});

describe('RakebackEngine - Tier Determination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rakebackEngine.dispose('club-tier');
    rakebackEngine.configure('club-tier', { enabled: true });
  });

  it('should start at Bronze tier', () => {
    const contrib = new Map([['p1', 50]]);
    rakebackEngine.recordHandRake('club-tier', 5, contrib, 50);

    const tier = rakebackEngine.getCurrentTier('club-tier', 'p1');
    expect(tier).not.toBeNull();
    expect(tier!.name).toBe('Bronze');
  });

  it('should upgrade tier as rake accumulates', () => {
    const contrib = new Map([['p1', 1000]]);
    // Record enough to pass 100 threshold (Silver)
    rakebackEngine.recordHandRake('club-tier', 150, contrib, 1000);

    const tier = rakebackEngine.getCurrentTier('club-tier', 'p1');
    expect(tier!.name).toBe('Silver');
  });
});

describe('RakebackEngine - Settlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rakebackEngine.dispose('club-settle');
    rakebackEngine.configure('club-settle', { enabled: true, minimumPayout: 0.5 });
  });

  it('should distribute pending rakeback', () => {
    const contrib = new Map([
      ['p1', 100],
      ['p2', 100],
    ]);
    rakebackEngine.recordHandRake('club-settle', 20, contrib, 200);

    const distribution = rakebackEngine.settleRakeback('club-settle');
    expect(distribution.size).toBeGreaterThan(0);
  });

  it('should emit RAKEBACK_DISTRIBUTED on settlement', () => {
    const contrib = new Map([['p1', 100]]);
    rakebackEngine.recordHandRake('club-settle', 20, contrib, 100);
    rakebackEngine.settleRakeback('club-settle');

    expect(masterBus.emit).toHaveBeenCalledWith(
      'RAKEBACK_DISTRIBUTED',
      expect.objectContaining({ totalDistributed: expect.any(Number) })
    );
  });

  it('should reset pending rakeback after settlement', () => {
    const contrib = new Map([['p1', 100]]);
    rakebackEngine.recordHandRake('club-settle', 20, contrib, 100);
    rakebackEngine.settleRakeback('club-settle');

    expect(rakebackEngine.getPendingRakeback('club-settle', 'p1')).toBe(0);
  });

  it('should not distribute below minimum payout', () => {
    rakebackEngine.configure('club-settle', { enabled: true, minimumPayout: 100 });
    const contrib = new Map([['p1', 50]]);
    rakebackEngine.recordHandRake('club-settle', 1, contrib, 50);

    const distribution = rakebackEngine.settleRakeback('club-settle');
    expect(distribution.size).toBe(0);
  });
});

describe('RakebackEngine - State Queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rakebackEngine.dispose('club-q');
    rakebackEngine.configure('club-q', { enabled: true });
  });

  it('should return null for untracked player', () => {
    expect(rakebackEngine.getPlayerRecord('club-q', 'unknown')).toBeNull();
  });

  it('should return all records for a club', () => {
    const contrib = new Map([
      ['p1', 50],
      ['p2', 50],
    ]);
    rakebackEngine.recordHandRake('club-q', 5, contrib, 100);

    const records = rakebackEngine.getAllRecords('club-q');
    expect(records).toHaveLength(2);
  });

  it('should return 0 pending for untracked player', () => {
    expect(rakebackEngine.getPendingRakeback('club-q', 'nobody')).toBe(0);
  });
});

describe('RakebackEngine - Cleanup', () => {
  it('should dispose all state for a club', () => {
    rakebackEngine.configure('club-disp', { enabled: true });
    const contrib = new Map([['p1', 50]]);
    rakebackEngine.recordHandRake('club-disp', 5, contrib, 50);

    rakebackEngine.dispose('club-disp');

    expect(rakebackEngine.isEnabled('club-disp')).toBe(false);
    expect(rakebackEngine.getPlayerRecord('club-disp', 'p1')).toBeNull();
  });
});
