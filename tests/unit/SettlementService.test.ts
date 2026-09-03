/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — SettlementService
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

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
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

import SettlementService from '../../src/services/SettlementService';

describe('SettlementService', () => {
  it('should export SettlementService object', () => {
    expect(SettlementService).toBeDefined();
    expect(typeof SettlementService).toBe('object');
  });

  it('should have getCurrentPeriod method', () => {
    expect(typeof SettlementService.getCurrentPeriod).toBe('function');
  });

  it('should have getPeriodHistory method', () => {
    expect(typeof SettlementService.getPeriodHistory).toBe('function');
  });

  it('should have closePeriod method', () => {
    expect(typeof SettlementService.closePeriod).toBe('function');
  });

  it('should have generateSettlements method', () => {
    expect(typeof SettlementService.generateSettlements).toBe('function');
  });

  it('should have calculateAgentSettlement method', () => {
    expect(typeof SettlementService.calculateAgentSettlement).toBe('function');
  });

  it('should have executeMondayPayouts method', () => {
    expect(typeof SettlementService.executeMondayPayouts).toBe('function');
  });

  it('should have getClubReport method', () => {
    expect(typeof SettlementService.getClubReport).toBe('function');
  });

  it('should have getAgentReport method', () => {
    expect(typeof SettlementService.getAgentReport).toBe('function');
  });

  it('should have executeUnionRakeBack method', () => {
    expect(typeof SettlementService.executeUnionRakeBack).toBe('function');
  });
});
