/**
 * Rabbit hunt economy — Dan 2026-08-23:
 * "VIP users get 100 rabbit hunts free, then each hunt after that = 1 diamond."
 *
 * These pin the two client-side constants and, more importantly, the shape of
 * the reveal path. The AUTHORITATIVE rules live in the database
 * (fn_reveal_rabbit_hunt + feature_pricing); these tests exist so a future edit
 * to the client cannot silently disagree with it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VIP_GOLD_LIMITS, FEATURE_PRICING } from '../../src/services/VIPService';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('rabbit hunt economy', () => {
  it('gives VIP exactly 100 free hunts, not unlimited', () => {
    expect(VIP_GOLD_LIMITS.rabbitHunts).toBe(100);
    expect(Number.isFinite(VIP_GOLD_LIMITS.rabbitHunts)).toBe(true);
  });

  it('prices a hunt at 1 diamond', () => {
    expect(FEATURE_PRICING.rabbit_hunt.cost).toBe(1);
    expect(FEATURE_PRICING.rabbit_hunt.usageType).toBe('per_use');
  });

  it('no longer treats rabbit_hunt as an unlimited VIP feature', () => {
    // checkVIPQuota used to short-circuit rabbit_hunt to `return true`, which is
    // why the 100 could never deplete and a VIP was never asked to pay.
    const src = read('src/services/VIPService.ts');
    const shortCircuit = src.match(/\[([^\]]*)\]\.includes\(feature\)/);
    expect(shortCircuit).not.toBeNull();
    expect(shortCircuit![1]).not.toContain('rabbit_hunt');
    expect(src).toContain("case 'rabbit_hunt':");
  });
});

describe('rabbit hunt reveal is paid server-side', () => {
  it('TablePage reveals through fn_reveal_rabbit_hunt', () => {
    const src = read('src/pages/TablePage.tsx');
    expect(src).toContain('fn_reveal_rabbit_hunt');
  });

  it('the engine does not broadcast the cards', () => {
    // The cards used to ride on the rabbit_hunt_available event, so every client
    // at the table held them before anyone paid. They now go to
    // rabbit_hunt_offers and only leave via the paying RPC.
    const src = read('server/src/engine/ServerTableEngineSettlement.ts');
    expect(src).toContain('rabbit_hunt_offers');
    expect(src).toContain('rabbit_card_count');
    // No `rabbit_cards:` property on the emitted event any more.
    expect(src).not.toMatch(/^\s*rabbit_cards:/m);
  });

  it('the component does not charge a second time', () => {
    // handleReveal used to call vipService.useFeature() AFTER onReveal(), which
    // would now bill twice for one hunt because onReveal itself pays.
    const src = read('src/components/table/RabbitHunt.tsx');
    expect(src).not.toContain("useFeature(user.id, 'rabbit_hunt')");
  });
});
