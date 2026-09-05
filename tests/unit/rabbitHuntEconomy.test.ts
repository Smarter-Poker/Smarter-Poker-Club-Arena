import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VIP_MONTHLY_ALLOWANCES, FEATURE_PRICING } from '../../src/services/VIPService';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('rabbit hunt economy', () => {
  it('gives VIP exactly 100 free hunts, not unlimited', () => {
    expect(VIP_MONTHLY_ALLOWANCES.rabbitHunts).toBe(100);
    expect(Number.isFinite(VIP_MONTHLY_ALLOWANCES.rabbitHunts)).toBe(true);
  });

  it('prices a hunt at 5 diamonds', () => {
    expect(FEATURE_PRICING.rabbit_hunt.cost).toBe(5);
    expect(FEATURE_PRICING.rabbit_hunt.usageType).toBe('per_use');
  });
});

describe('rabbit hunt reveal is paid server-side', () => {
  it('the engine does not broadcast the cards directly in rabbit_hunt_available', () => {
    const src = read('server/src/engine/ServerTableEngineSettlement.ts');
    expect(src).toContain('rabbitHuntOffers');
    expect(src).not.toMatch(/^\s*rabbit_cards:/m);
  });
});
